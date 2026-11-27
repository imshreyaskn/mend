#!/usr/bin/env node
// trace-check: proves the plan, the tests and the evidence agree.
//
// Reads a mend plan (.mend/<slug>/plan.md) and checks, deterministically:
//   1. Every requirement whose verification method includes T is named in the title of a real test
//      (it/test, including .each/.prop/.concurrent). Comments, describe titles, .todo, .skip, x-prefixed
//      tests and snapshot files do not count.
//   2. Every requirement verified by A, I or D has a structured EVIDENCE line in log.md:
//        EVIDENCE REQ-PLAY-007 [D]: <what was done> -> <what was observed>
//   3. Every hazard names at least one mitigating requirement in its "Mitigated by" column, and each exists.
//   4. IDs are unique, share the plan's key, have a valid method and phase, and every ID the plan mentions is
//      defined by a row (so a malformed row cannot silently disappear).
//   5. Class 3 and 4 plans have hazard rows.
//
// IDs carry a per-plan key so plans in one repo never collide: REQ-PLAY-001, HAZ-PLAY-001, INV-PLAY-001.
//
// Usage:
//   node trace-check.mjs <plan.md> [--root <repo dir>] [--log <log.md>] [--through P2] [--strict] [--structure-only]
// --through Pn     check only requirements delivered in phases P1..Pn (phase exit)
// --strict         also fail on orphan test references and Class 3+ plans without invariants (audit)
// --structure-only check the plan alone, before any tests exist
// Exit codes: 0 consistent, 1 gaps found, 2 usage or input error.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import process from 'node:process';

const MAX_FILES_VISITED = 50_000;
const MAX_DEPTH = 25;
const MAX_FILE_BYTES = 1_000_000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.expo', 'coverage', 'Pods', 'vendor',
  '.mend', '.next', '.gradle', 'target', '__pycache__', '.venv', '__snapshots__']);
const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|[\\/])__tests__[\\/].+\.[cm]?[jt]sx?$|(^|[\\/])test_[^\\/]+\.py$|_test\.(go|py)$|(^|[\\/])(\.maestro|e2e)[\\/].+\.(ya?ml|[cm]?[jt]sx?)$/;
const JS_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const ID = '(REQ|HAZ|INV|ASM)-([A-Z][A-Z0-9]{1,7})-(\\d{3})';
const ID_RE = new RegExp(`\\b${ID}\\b`, 'g');
const ID_EXACT = new RegExp(`^${ID}$`);
const METHOD_CELL = /^[TAID](\s*[+,/]\s*[TAID])*$/;
const PHASE_CELL = /^P\d+(\s*[,/+-]\s*P\d+)*$/;
// A test title: it(...) / test(...) with optional .each(...)/.prop(...)/.concurrent/.failing modifiers.
const TEST_TITLE = /\b(?:it|test)(?:\.(?:each|prop|concurrent|failing)(?:\s*\((?:[^()]|\([^()]*\))*\))?)*\s*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
const EVIDENCE = /^\s*[-*]?\s*EVIDENCE\s+(REQ-[A-Z][A-Z0-9]{1,7}-\d{3})\s+\[([TAID\s+,/]+)\]\s*:\s*(.*?)\s*->\s*(.*?)\s*$/;
const NOT_DONE = /\b(pending|not yet|todo|tbd|n\/?a|to be done|later|unverified|not verified)\b/i;

function fail(message) {
  process.stderr.write(`trace-check: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { plan: null, root: process.cwd(), log: null, strict: false, structureOnly: false, through: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--strict') opts.strict = true;
    else if (arg === '--structure-only') opts.structureOnly = true;
    else if (arg === '--root' || arg === '--log' || arg === '--through') {
      const value = argv[i + 1];
      if (!value) fail(`${arg} needs a value`);
      opts[arg.slice(2)] = value;
      i += 1;
    } else if (!opts.plan && !arg.startsWith('--')) opts.plan = arg;
    else fail(`unexpected argument: ${arg}`);
  }
  if (!opts.plan) fail('usage: node trace-check.mjs <plan.md> [--root <dir>] [--log <log.md>] [--through Pn] [--strict] [--structure-only]');
  if (!existsSync(opts.plan)) fail(`plan not found: ${opts.plan}`);
  if (opts.through !== null) {
    const m = /^P(\d+)$/i.exec(opts.through);
    if (!m) fail('--through needs a phase like P2');
    opts.through = Number(m[1]);
  }
  opts.log = opts.log ?? join(dirname(opts.plan), 'log.md');
  return opts;
}

// Split a markdown table row on unescaped pipes; tolerate rows with or without outer pipes.
function splitRow(line) {
  let cells = line.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
  if (cells[0] === '') cells = cells.slice(1);
  if (cells.length > 0 && cells[cells.length - 1] === '') cells = cells.slice(0, -1);
  return cells;
}

const cleanCell = (cell) => cell.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*`_]/g, '').trim();
const isSeparator = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
const isTableLine = (line) => /(?<!\\)\|/.test(line);

function parsePlan(text) {
  const lines = text.split(/\r?\n/);
  const reqs = new Map();
  const hazards = new Map();
  const invariants = new Map();
  const assumptions = new Map();
  const problems = [];
  const keys = new Set();
  const classMatch = /Class:\s*\**\s*([0-4])\b/.exec(text);
  let header = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!isTableLine(line)) { header = null; continue; }
    if (isSeparator(line)) continue;
    const cells = splitRow(line).map(cleanCell);
    if (i + 1 < lines.length && isSeparator(lines[i + 1])) { header = cells.map((c) => c.toLowerCase()); continue; }
    const id = ID_EXACT.exec(cells[0] ?? '');
    if (!id) continue;
    const [full, kind, key] = id;
    keys.add(key);
    const col = (names, fallback) => {
      const idx = header ? header.findIndex((h) => names.some((n) => h.startsWith(n))) : -1;
      return cells[idx >= 0 ? idx : fallback] ?? '';
    };
    const table = { REQ: reqs, HAZ: hazards, INV: invariants, ASM: assumptions }[kind];
    if (table.has(full)) problems.push(`duplicate ID ${full}`);
    if (kind === 'REQ') {
      const method = col(['verif', 'method'], 2).toUpperCase();
      const phase = col(['phase'], 3).toUpperCase();
      const validMethod = METHOD_CELL.test(method);
      if (!validMethod) problems.push(`${full}: verification method "${method}" is not T, A, I, D or a combination like "T+D"`);
      if (!PHASE_CELL.test(phase)) problems.push(`${full}: phase "${phase}" is not like P1`);
      const phases = (phase.match(/P(\d+)/g) ?? []).map((p) => Number(p.slice(1)));
      reqs.set(full, { methods: new Set(validMethod ? method.match(/[TAID]/g) : []), phase: phases.length ? Math.min(...phases) : null, text: col(['requirement'], 1) });
    } else if (kind === 'HAZ') {
      const mitigation = col(['mitigat'], cells.length - 1);
      hazards.set(full, { mitigations: [...new Set(mitigation.match(new RegExp(`REQ-[A-Z][A-Z0-9]{1,7}-\\d{3}`, 'g')) ?? [])] });
    } else {
      table.set(full, {});
    }
  }

  if (keys.size > 1) problems.push(`plan mixes ID keys (${[...keys].join(', ')}); one plan uses one key`);
  const defined = new Set([...reqs.keys(), ...hazards.keys(), ...invariants.keys(), ...assumptions.keys()]);
  for (const mention of new Set(text.match(ID_RE) ?? [])) {
    if (!defined.has(mention) && keys.has(mention.split('-')[1])) problems.push(`${mention} is mentioned but no table row defines it (malformed row?)`);
  }
  return { reqs, hazards, invariants, problems, key: [...keys][0] ?? null, cls: classMatch ? Number(classMatch[1]) : null };
}

function hazardErrors(plan) {
  const errors = [];
  for (const [id, haz] of plan.hazards) {
    if (haz.mitigations.length === 0) errors.push(`${id} has no mitigating requirement in its "Mitigated by" column`);
    for (const reqId of haz.mitigations) if (!plan.reqs.has(reqId)) errors.push(`${id} is mitigated by ${reqId}, which the plan does not define`);
  }
  if (plan.cls !== null && plan.cls >= 3 && plan.hazards.size === 0) errors.push(`Class ${plan.cls} plan has no hazard rows`);
  if (plan.cls === null) errors.push('plan header has no "Class: <0-4>" line');
  return errors;
}

// Bounded, iterative walk (no recursion) collecting test files.
function findTestFiles(root) {
  const found = [];
  const stack = [{ dir: root, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const { dir, depth } = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; } // Unreadable dir: skip, not fatal.
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_FILES_VISITED) fail(`visited more than ${MAX_FILES_VISITED} entries; pass a narrower --root`);
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && depth < MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile() && TEST_FILE.test(relative(root, full))) found.push(full);
    }
  }
  return found;
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

// IDs named by real tests in one file. JS/TS: only it/test titles. Python/Go: only test definition lines.
// E2E flow files (Maestro YAML) are whole tests, so any ID in them counts.
function idsInTestFile(file, source) {
  const ext = extname(file).toLowerCase();
  const ids = new Set();
  if (JS_EXT.has(ext)) {
    const code = stripComments(source);
    for (const m of code.matchAll(TEST_TITLE)) for (const id of m[2].match(ID_RE) ?? []) ids.add(id);
  } else if (ext === '.py' || ext === '.go') {
    for (const line of source.split(/\r?\n/)) {
      if (!/^\s*(def\s+test|func\s+Test)/.test(line)) continue;
      for (const m of line.matchAll(/\b(req|REQ)[-_]([A-Za-z][A-Za-z0-9]{1,7})[-_](\d{3})\b/g)) ids.add(`REQ-${m[2].toUpperCase()}-${m[3]}`);
    }
  } else {
    for (const id of source.match(ID_RE) ?? []) ids.add(id);
  }
  return ids;
}

function collectTestRefs(root, files) {
  const refs = new Map();
  for (const file of files) {
    if (statSync(file).size > MAX_FILE_BYTES) continue;
    for (const id of idsInTestFile(file, readFileSync(file, 'utf8'))) {
      if (!refs.has(id)) refs.set(id, new Set());
      refs.get(id).add(relative(root, file).replace(/\\/g, '/'));
    }
  }
  return refs;
}

function collectEvidence(logText) {
  const evidence = new Map();
  const malformed = [];
  for (const line of logText.split(/\r?\n/)) {
    if (!/^\s*[-*]?\s*EVIDENCE\b/.test(line)) continue;
    const m = EVIDENCE.exec(line);
    if (!m || !m[3] || !m[4] || NOT_DONE.test(m[4])) { malformed.push(line.trim().slice(0, 120)); continue; }
    if (!evidence.has(m[1])) evidence.set(m[1], new Set());
    for (const method of m[2].match(/[TAID]/g) ?? []) evidence.get(m[1]).add(method);
  }
  return { evidence, malformed };
}

function render(header, errors, warnings, traced) {
  const out = [...header, `  ${errors.length} errors, ${warnings.length} warnings`];
  if (errors.length > 0) out.push('', 'ERRORS', ...errors.map((e) => `  - ${e}`));
  if (warnings.length > 0) out.push('', 'WARNINGS', ...warnings.map((w) => `  - ${w}`));
  if (traced.length > 0) out.push('', 'TRACE', ...traced.map((t) => `  ${t}`));
  process.stdout.write(out.join('\n') + '\n');
  return errors.length > 0 ? 1 : 0;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const plan = parsePlan(readFileSync(opts.plan, 'utf8'));
  if (plan.reqs.size === 0) fail('no requirement rows found (expected table rows like "| REQ-PLAY-001 | ... | T | P1 |")');
  const structural = [...plan.problems, ...hazardErrors(plan)];

  if (opts.structureOnly) {
    const counts = { T: 0, A: 0, I: 0, D: 0 };
    for (const req of plan.reqs.values()) for (const m of req.methods) counts[m] += 1;
    process.exitCode = render([`trace-check (structure only): key ${plan.key}, class ${plan.cls ?? '?'}, ${plan.reqs.size} requirements, ${plan.hazards.size} hazards, ${plan.invariants.size} invariants`,
      `  verification methods: T=${counts.T} A=${counts.A} I=${counts.I} D=${counts.D}`], structural, [], []);
    return;
  }

  const testFiles = findTestFiles(opts.root);
  const refs = collectTestRefs(opts.root, testFiles);
  const { evidence, malformed } = collectEvidence(existsSync(opts.log) ? readFileSync(opts.log, 'utf8') : '');
  const errors = [...structural];
  const warnings = malformed.map((l) => `EVIDENCE line ignored (needs "<method> -> <observed result>", and no "pending"/"not yet"): ${l}`);
  const traced = [];
  const inScope = (req) => opts.through === null || (req.phase !== null && req.phase <= opts.through);

  for (const [id, req] of plan.reqs) {
    if (!inScope(req)) continue;
    if (req.methods.has('T')) {
      const tests = refs.get(id);
      if (tests) traced.push(`${id}  ->  ${[...tests].join(', ')}`);
      else errors.push(`${id} is verified by test (T) but no test title names it: "${req.text.slice(0, 90)}"`);
    }
    const missing = [...req.methods].filter((m) => m !== 'T' && !evidence.get(id)?.has(m));
    if (missing.length > 0) errors.push(`${id} needs an EVIDENCE line in the log for ${missing.join('/')}`);
  }
  for (const [id, files] of refs) {
    if (id.startsWith('REQ-') && id.split('-')[1] === plan.key && !plan.reqs.has(id)) {
      (opts.strict ? errors : warnings).push(`tests name ${id}, which this plan does not define: ${[...files].join(', ')}`);
    }
  }
  if (plan.cls !== null && plan.cls >= 3 && plan.invariants.size === 0) {
    (opts.strict ? errors : warnings).push(`Class ${plan.cls} plan has no invariant rows`);
  }

  const scope = opts.through === null ? 'all phases' : `phases P1-P${opts.through}`;
  process.exitCode = render([`trace-check: key ${plan.key}, class ${plan.cls ?? '?'}, ${scope}: ${plan.reqs.size} requirements, ${plan.hazards.size} hazards, ${testFiles.length} test files scanned`,
    `  ${traced.length} requirements traced to tests`], errors, warnings, traced);
}

main();
