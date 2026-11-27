#!/usr/bin/env node
// ducttape-scan: flags workaround patterns ("duct tape") in the lines a change adds or removes.
//
// A deterministic pre-pass for mend execute and mend audit. It is not a linter replacement:
// it targets the shortcuts agents take when lint is off, weakened, or blind to intent
// (silenced type errors, swallowed errors, deleted assertions, timers used as synchronisation).
// Only changed lines are scanned, so legacy code does not drown the signal.
//
// Usage:
//   node ducttape-scan.mjs --base <ref>             working tree (plus untracked files) vs merge-base with <ref>
//   node ducttape-scan.mjs                          same, with <ref> = origin/HEAD, main or master if one exists
//   node ducttape-scan.mjs --base HEAD              uncommitted changes only
//   node ducttape-scan.mjs [--json] --files a.ts b.ts   whole files (every line counts as added)
//
// Waive one finding by putting a reason on the same line or the line above:
//   // mend-waiver: <rule-id> <reason>
// Rules marked "not waivable inline" ignore such comments; they need the user's approval recorded in the mend log.
// Waivers are listed in the output so a reviewer sees every one of them.
//
// Exit codes: 0 no blocking findings, 1 blocking findings, 2 usage, environment or internal error.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';

const MAX_FILES = 5000;          // Bounded work: refuse absurd inputs instead of hanging.
const MAX_FILE_BYTES = 2_000_000;
const MAX_LINE_LENGTH = 2000;    // Longer lines are minified or generated; skip them.
const MAX_PRINTED = 300;
const MAX_FINDINGS = 5000;

const CODE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rs', '.go', '.kt', '.swift', '.java']);
const JS_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const TS_EXT = new Set(['.ts', '.tsx', '.mts', '.cts']);
const DOC_EXT = new Set(['.md', '.mdx', '.txt', '.rst']);
const TEST_PATH = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)(__tests__|tests?|e2e)\/|(^|\/)test_[^/]+\.py$|_test\.(go|py)$/;
const SCRIPT_PATH = /(^|\/)(scripts|bin|tools|cli)\//;
const SKIP_PATH = /(^|\/)(node_modules|\.git|\.expo|Pods|coverage|\.mend)\/|^(dist|build|vendor)\/|(^|\/)(android|ios)\/build\//;
const TEMPLATE_PATH = /\.(example|sample|template|dist)$/;
const TSCONFIG_PATH = /(^|\/)tsconfig[^/]*\.json$/;
const LINT_CONFIG_PATH = /(^|\/)(\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s|biome\.jsonc?|\.oxlintrc\.json)$/;
const WAIVER = /mend-waiver:\s*([\w-]+)\s+(\S.*)$/;
const STRICT_FLAGS = 'strict|strictNullChecks|noImplicitAny|noUncheckedIndexedAccess|exactOptionalPropertyTypes|noImplicitReturns|noFallthroughCasesInSwitch';
const SECRET_PLACEHOLDER = /your[_-]|xxx|changeme|placeholder|example|dummy|<[^>]*>|\$\{|process\.env|import\.meta\.env/i;
const SECRET_CODE = /(api[_-]?key|secret[_-]?key|client[_-]?secret|secret|passw(or)?d|access[_-]?token|auth[_-]?token|private[_-]?key)["']?\s*[:=]\s*["'][^"'\s]{12,}["']|\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}|\bsk-[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{40,}|\bAIza[0-9A-Za-z_-]{35}\b|\bxox[bap]-[A-Za-z0-9-]{10,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/i;
const SECRET_ENV = /^\s*(export\s+)?[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*["']?[^\s"'#]{12,}/;

// scope: which files a rule applies to. when: 'added' (default) or 'removed'.
// stripped: match against the line with comments, strings and JSX text removed (cuts false positives).
// waivable: false means inline waiver comments are ignored.
const RULES = [
  { id: 'ts-suppress', severity: 'block', scope: 'code', re: /@ts-(ignore|nocheck)\b/,
    why: 'Silences the type checker instead of fixing the type.',
    fix: 'Fix or narrow the type. If a library type is wrong, use @ts-expect-error with a reason and an upstream issue link.' },
  { id: 'ts-expect-error-bare', severity: 'warn', scope: 'code', re: /@ts-expect-error\s*(\*\/)?\s*$/,
    why: 'Type error expected with no recorded reason.',
    fix: 'Add the reason and an issue link after the directive.' },
  { id: 'lint-disable-bare', severity: 'block', scope: 'code', re: /eslint-disable(-next-line|-line)?\b(?!.*--\s*\S)/,
    why: 'Turns off a lint rule with no recorded reason.',
    fix: 'Fix the code. If the rule is genuinely wrong here, scope it to one line and add "-- <reason>".' },
  { id: 'double-cast', severity: 'block', scope: 'code', stripped: true, re: /\bas\s+unknown\s+as\b/,
    why: 'Forces an arbitrary type onto a value; the compiler can no longer help.',
    fix: 'Parse the value at the trust boundary with a schema, or fix the source type.' },
  { id: 'any-type', severity: 'warn', scope: 'code', ext: TS_EXT, stripped: true, re: /(?<![\w$.])any(?![\w$])/,
    why: '`any` switches off type checking for everything it touches.',
    fix: 'Use the real type, `unknown` plus narrowing, or a schema-parsed type.' },
  { id: 'non-null-assertion', severity: 'warn', scope: 'code', ext: TS_EXT, stripped: true, re: /[\w)\]]!(?=[.[)\],;])/,
    why: 'A `!` assertion claims a value exists without proving it.',
    fix: 'Narrow with a check, restructure so the value cannot be absent, or assert with a message.' },
  { id: 'log-and-swallow', severity: 'warn', scope: 'code', re: /catch\s*\([^)]*\)\s*\{\s*console\.\w+\([^)]*\);?\s*\}/,
    why: 'Logging and continuing hides the failure from the caller.',
    fix: 'Decide what the caller should see: retry, fallback with a reason, or rethrow with context.' },
  { id: 'py-bare-except', severity: 'block', scope: 'code', ext: new Set(['.py']), re: /^\s*except\s*:/,
    why: 'Catches everything, including bugs.', fix: 'Catch the specific exception and handle it.' },
  { id: 'focused-or-skipped-test', severity: 'block', scope: 'test', waivable: false,
    re: /\b(it|test|describe|context)\.(only|skip)\b|\b(xit|xtest|xdescribe|fit|fdescribe)\s*\(|@pytest\.mark\.skip|\bt\.Skip\(/,
    why: 'A focused or skipped test changes what the suite verifies.',
    fix: 'Remove .only/.skip. If a test is wrong, fix it against the requirement or stop and report it.' },
  { id: 'sleep-in-test', severity: 'warn', scope: 'test', stripped: true, re: /\bsetTimeout\(|\bsleep\(|waitForTimeout\(|time\.sleep\(/,
    why: 'Fixed waits make tests slow and flaky, and hide races.',
    fix: 'Use fake timers or wait for the observable condition (findBy*, waitFor).' },
  { id: 'timer-as-sync', severity: 'warn', scope: 'src', stripped: true, re: /setTimeout\([^;]*,\s*(0|[1-9]\d?)\s*\)/,
    why: 'A short timer used to "let things settle" papers over an ordering bug.',
    fix: 'Await the event, or model the state the code is actually waiting for.' },
  { id: 'unbounded-loop', severity: 'warn', scope: 'code', stripped: true, re: /\bwhile\s*\(\s*(true|1)\s*\)|\bfor\s*\(\s*;\s*;\s*\)|^\s*loop\s*\{|\bwhile\s+True\s*:/,
    why: 'Power of Ten rule 2: every loop needs a provable upper bound.',
    fix: 'Add an explicit iteration cap or deadline and handle hitting it.' },
  { id: 'debugger-statement', severity: 'block', scope: 'src', waivable: false, re: /^\s*debugger\s*;?\s*$/,
    why: 'Debugger statement left in shipped code.', fix: 'Remove it.' },
  { id: 'debug-log', severity: 'warn', scope: 'app', stripped: true, re: /\bconsole\.(log|debug)\(/,
    why: 'Debug logging left in shipped code.', fix: 'Remove it or route it through the app logger at the right level.' },
  { id: 'todo-without-ticket', severity: 'warn', scope: 'code', re: /\b(TODO|FIXME|HACK|XXX)\b(?!.*([A-Z][A-Z0-9]+-\d+|#\d+|https?:\/\/))/,
    why: 'Untracked debt: nobody owns this note.', fix: 'Do it now, or link a ticket.' },
  { id: 'json-parse-unvalidated', severity: 'warn', scope: 'src', stripped: true, re: /\bJSON\.parse\(/,
    unless: /\b(parse|safeParse|parseAsync|safeParseAsync|assert|decode|validate|is[A-Z]\w*)\([^()]*JSON\.parse\(/,
    why: 'Parsed data is untrusted input; trusting its shape is how a bad config/data file takes down a system (CrowdStrike 2024, Cloudflare 2025).',
    fix: 'Validate with a schema where it is parsed, without throwing on the launch path (safeParse).' },
  { id: 'wall-clock-duration', severity: 'warn', scope: 'src', stripped: true, re: /Date\.now\(\)\s*-\s*[\w.]*(start|begin|began|t0|then|before)\w*/i,
    why: 'Elapsed time measured on the wall clock can go negative when the clock moves (Cloudflare 2017 leap second).',
    fix: 'Measure elapsed time with performance.now() or another monotonic clock.' },
  { id: 'insecure-random', severity: 'warn', scope: 'src', stripped: true, re: /Math\.random\(\)/,
    why: 'Math.random is predictable and collision-prone for IDs and tokens.',
    fix: 'Use crypto.randomUUID() / crypto.getRandomValues() (React Native: expo-crypto randomUUID()). For jitter or animation, waive with that reason.' },
  { id: 'bitwise-truncation', severity: 'warn', scope: 'src', ext: JS_EXT, stripped: true, re: /[\w)\]]\s*\|\s*0\b(?!\.)|~~\s*[\w(]|>>>\s*0\b/,
    why: 'Bitwise tricks silently wrap values above 2^31 (FP-01 Ariane 5 narrowing, FP-27 Y2038).',
    fix: 'Use Math.trunc and assert the range, or keep the value as a full-width number.' },
  { id: 'date-field-arithmetic', severity: 'warn', scope: 'src', stripped: true, re: /\.set(UTC)?(FullYear|Month|Date)\([^;]*\.get(UTC)?(FullYear|Month|Date)\(\)\s*[+-]/,
    why: 'Field arithmetic rolls Feb 29 and month ends over silently (FP-23 Azure 2012 leap-day outage).',
    fix: 'Use a date library (addYears/addMonths) and test Feb 29, Dec 31 and DST changes.' },
  { id: 'nested-quantifier-regex', severity: 'warn', scope: 'code', re: /\([^()]*[+*]\)[+*]/,
    why: 'Nested quantifiers can backtrack catastrophically (Cloudflare 2019 global outage).',
    fix: 'Rewrite without nested quantifiers, anchor it, and bound the input length.' },
  { id: 'dynamic-code', severity: 'block', scope: 'src', stripped: true, re: /\beval\(|\bnew Function\(/,
    why: 'Executes strings as code.', fix: 'Replace with explicit logic or a lookup table.' },
  { id: 'raw-html', severity: 'warn', scope: 'src', stripped: true, re: /dangerouslySetInnerHTML|\.innerHTML\s*=|injectJavaScript\(/,
    why: 'Injects unescaped HTML or script.', fix: 'Render data as text, or sanitise with a vetted library; never interpolate data into injected script.' },
  { id: 'index-as-key', severity: 'warn', scope: 'src', ext: new Set(['.tsx', '.jsx']), re: /key=\{\s*(index|idx|i)\s*\}|key=\{`[^`]*\$\{\s*(index|idx|i)\s*\}[^`]*`\}/,
    why: 'Array index keys break state when items are inserted, removed or reordered.',
    fix: 'Use a stable ID from the data.' },
  { id: 'hardcoded-secret', severity: 'block', scope: 'nontest', waivable: false, re: SECRET_CODE, unless: SECRET_PLACEHOLDER,
    why: 'Credential committed to source.', fix: 'Move it to the platform secret store or env config, and rotate it.' },
  { id: 'hardcoded-secret-env', severity: 'block', scope: 'nontest', waivable: false, re: SECRET_ENV, unless: SECRET_PLACEHOLDER,
    why: 'Credential committed in an environment or config file.', fix: 'Keep real values out of git (gitignored .env, EAS secrets), and rotate this one.' },
  { id: 'secret-in-test', severity: 'warn', scope: 'test', re: SECRET_CODE, unless: SECRET_PLACEHOLDER,
    why: 'Credential-shaped value in a test.', fix: 'Confirm it is a fake fixture; if it is real, remove and rotate it.' },
  { id: 'gate-bypass', severity: 'block', scope: 'nondoc', waivable: false,
    re: /--no-verify\b|--legacy-peer-deps\b|\bnpm\s+(i|install|ci)\b[^\n]*\s--force\b|\bHUSKY=0\b/,
    why: 'Bypasses a hook or dependency check instead of fixing what it reports.',
    fix: 'Fix the underlying hook failure or peer-dependency conflict.' },
  { id: 'shell-error-suppressed', severity: 'warn', scope: 'nondoc', ext: new Set(['.sh', '.bash', '.yml', '.yaml', '.json', '.ps1']), re: /\|\|\s*true\b|2>\s*\/dev\/null|-ErrorAction\s+SilentlyContinue/,
    why: 'A failing step reports success (FP-34 GitLab 2017: five backup methods, none working).',
    fix: 'Let the step fail, or handle the specific expected failure explicitly.' },
  { id: 'type-config-weakened', severity: 'block', scope: 'tsconfig', waivable: false,
    re: new RegExp(`"(${STRICT_FLAGS})"\\s*:\\s*false`),
    why: 'Turns a compiler safety check off.', fix: 'Fix the code the check reports; do not lower the bar.' },
  { id: 'type-config-removed', severity: 'block', scope: 'tsconfig', when: 'removed', waivable: false,
    re: new RegExp(`"(${STRICT_FLAGS})"\\s*:\\s*true`),
    why: 'A compiler safety flag was deleted from tsconfig.', fix: 'Restore it; fix the code it reports.' },
  { id: 'lint-rule-turned-off', severity: 'warn', scope: 'lintconfig', re: /:\s*(["']off["']|0)\s*[,\]}]?/,
    why: 'A lint rule was switched off in config.', fix: 'Keep the rule; fix the code it reports. Record a reason if it truly does not apply.' },
  { id: 'rust-unwrap', severity: 'warn', scope: 'code', ext: new Set(['.rs']), re: /\.unwrap\(\)/,
    why: 'Panics on unexpected input (Cloudflare Nov 2025 outage started at an unwrap()).',
    fix: 'Handle the error case explicitly.' },
  { id: 'go-ignored-error', severity: 'warn', scope: 'code', ext: new Set(['.go']), re: /,\s*_\s*:?=\s*\w|^\s*_\s*=\s*[\w.]+\(/,
    why: 'Error value discarded.', fix: 'Check the error.' },
  { id: 'py-suppress-bare', severity: 'warn', scope: 'code', ext: new Set(['.py']), re: /#\s*type:\s*ignore(?!\[)|#\s*noqa(?!:)/,
    why: 'Blanket suppression of a type or lint error.', fix: 'Fix it, or name the exact code being ignored and why.' },
  // Removed lines: what was taken away matters as much as what was added.
  { id: 'assertion-removed', severity: 'warn', scope: 'test', when: 'removed', re: /\bexpect\(|\bassert\w*\(|^\s*assert\s/,
    why: 'An assertion was deleted or edited in a test. Agents delete assertions to make tests pass.',
    fix: 'Confirm the requirement changed and log a DISPOSITION naming it; otherwise restore it.' },
  { id: 'test-removed', severity: 'warn', scope: 'test', when: 'removed', re: /\b(it|test)\s*\(\s*['"`]|^\s*def test_\w+/,
    why: 'A test case was deleted or renamed.', fix: 'Confirm the behaviour it checked is gone on purpose and log a DISPOSITION naming the requirement.' },
];

// Multi-line rules run over each block of consecutive added lines, after comments are stripped.
const BLOCK_RULES = [
  { id: 'empty-catch', severity: 'block', scope: 'code', re: /catch\s*(\([^)]*\))?\s*\{\s*\}/g,
    why: 'The error is swallowed silently.',
    fix: 'Handle it, convert it to a typed result, or let it propagate with context (new Error(msg, { cause })).' },
  { id: 'swallowed-promise', severity: 'block', scope: 'code', re: /\.catch\(\s*(\(\s*[\w$]*\s*(:\s*[\w$<>[\]|. ]+)?\s*\)|[\w$]+)\s*=>\s*(\{\s*\}|undefined|null|void 0)\s*\)/g,
    why: 'A rejected promise is discarded with no handling.',
    fix: 'Handle the failure or surface it; if ignoring is truly correct, waive with the reason.' },
  { id: 'py-except-pass', severity: 'block', scope: 'code', ext: new Set(['.py']), re: /except[^:\n]*:\s*(#[^\n]*)?\n?\s*pass\b/g,
    why: 'An exception is caught and discarded.', fix: 'Handle it, or let it propagate.' },
];

// Path-level rules fire once per changed file.
const PATH_RULES = [
  { id: 'patch-package', severity: 'warn', re: /(^|\/)patches\/[^/]+\.patch$/,
    why: 'A patch to a dependency was added or changed.', fix: 'Link the upstream issue or PR in the patch header and plan its removal; log a DISPOSITION.' },
  { id: 'snapshot-changed', severity: 'warn', re: /\.snap$/,
    why: 'A snapshot changed. Running tests with -u accepts whatever the code now does.',
    fix: 'Review the snapshot diff line by line against the requirement; log a DISPOSITION.' },
];

class UsageError extends Error {}

function fail(message) {
  process.stderr.write(`ducttape-scan: ${message}\n`);
  process.exit(2);
}

function git(args, cwd) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args],
    { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function tryGit(args, cwd) {
  try { return git(args, cwd).trim(); } catch { return null; } // A missing ref is an expected outcome here.
}

function parseArgs(argv) {
  const opts = { base: null, files: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--base') { opts.base = argv[i + 1]; i += 1; if (!opts.base) throw new UsageError('--base needs a ref'); }
    else if (arg === '--files') {
      opts.files = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { opts.files.push(argv[i + 1]); i += 1; }
      if (opts.files.length === 0) throw new UsageError('--files needs at least one path');
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 22).join('\n') + '\n');
      process.exit(0);
    } else throw new UsageError(`unknown argument: ${arg}`);
  }
  if (opts.files && opts.files.length > MAX_FILES) throw new UsageError(`too many files (limit ${MAX_FILES})`);
  return opts;
}

function resolveBase(root, explicit) {
  if (explicit) {
    const sha = tryGit(['merge-base', 'HEAD', explicit], root) ?? tryGit(['rev-parse', '--verify', explicit], root);
    if (!sha) throw new UsageError(`cannot resolve base ref "${explicit}"`);
    return { label: explicit === 'HEAD' ? 'HEAD (uncommitted changes only)' : explicit, sha };
  }
  const originHead = tryGit(['rev-parse', '--abbrev-ref', 'origin/HEAD'], root);
  for (const ref of [originHead, 'origin/main', 'origin/master', 'main', 'master'].filter(Boolean)) {
    const sha = tryGit(['merge-base', 'HEAD', ref], root);
    if (sha) return { label: ref, sha };
  }
  throw new UsageError('cannot find the default branch; pass --base <the branch this work started from> (or --base HEAD for uncommitted changes only)');
}

// C-style unquoting for paths git quotes ("b/caf\303\251.ts").
function unquotePath(raw) {
  if (!raw.startsWith('"')) return raw;
  const bytes = [];
  for (let i = 1; i < raw.length - 1; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') { bytes.push(...Buffer.from(ch, 'utf8')); continue; }
    const next = raw[i + 1];
    if (/[0-7]/.test(next)) { bytes.push(parseInt(raw.slice(i + 1, i + 4), 8)); i += 3; continue; }
    const map = { n: 10, t: 9, '"': 34, '\\': 92, a: 7, b: 8, f: 12, r: 13, v: 11 };
    bytes.push(map[next] ?? next.charCodeAt(0));
    i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

function headerPath(line, prefix) {
  const raw = unquotePath(line.slice(4).replace(/\t$/, ''));
  if (raw === '/dev/null') return null;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

// Parse `git diff --unified=0` into per-file added and removed lines. Hunk line counts decide where a hunk
// ends, so added content that happens to start with "++" is never mistaken for a file header.
function parseDiff(text) {
  const files = new Map();
  let oldPath = null;
  let current = null;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of text.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('+')) { current?.added.push({ n: newLine, text: line.slice(1) }); newLine += 1; newLeft -= 1; continue; }
      if (line.startsWith('-')) { current?.removed.push({ n: oldLine, text: line.slice(1) }); oldLine += 1; oldLeft -= 1; continue; }
      if (line.startsWith(' ')) { oldLine += 1; newLine += 1; oldLeft -= 1; newLeft -= 1; continue; }
      if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    }
    if (line.startsWith('diff --git ')) { oldPath = null; current = null; continue; }
    if (line.startsWith('--- ')) { oldPath = headerPath(line, 'a/'); continue; }
    if (line.startsWith('+++ ')) {
      const newPath = headerPath(line, 'b/');
      current = getEntry(files, newPath ?? oldPath, newPath === null);
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]); oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLine = Number(hunk[3]); newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
    }
  }
  return files;
}

function getEntry(files, path, deleted = false) {
  if (!files.has(path)) files.set(path, { added: [], removed: [], deleted });
  return files.get(path);
}

function readLines(root, path) {
  const full = join(root, path);
  if (!existsSync(full)) return null;
  const st = statSync(full);
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
  return readFileSync(full, 'utf8').split(/\r?\n/);
}

function collectChanges(root, opts) {
  const files = new Map();
  if (opts.files) {
    for (const input of opts.files) {
      const abs = resolve(process.cwd(), input);
      const rel = relative(root, abs).replace(/\\/g, '/');
      if (rel.startsWith('..') || isAbsolute(rel)) throw new UsageError(`${input} is outside the repository`);
      const lines = readLines(root, rel);
      if (!lines) throw new UsageError(`cannot read ${input} (missing, not a file, or over ${MAX_FILE_BYTES} bytes)`);
      getEntry(files, rel).added = lines.map((text, i) => ({ n: i + 1, text }));
    }
    return { files, base: { label: 'files', sha: '' } };
  }
  const base = resolveBase(root, opts.base);
  const diff = git(['diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '--unified=0', '-M', base.sha], root);
  for (const [path, entry] of parseDiff(diff)) files.set(path, entry);
  const untracked = (git(['ls-files', '-z', '--others', '--exclude-standard'], root)).split('\0').filter(Boolean).filter((p) => !SKIP_PATH.test(p));
  if (files.size + untracked.length > MAX_FILES) throw new UsageError(`refusing to scan ${files.size + untracked.length} files (limit ${MAX_FILES}); narrow with --base or --files`);
  const unreadable = [];
  for (const path of untracked) {
    const lines = readLines(root, path);
    if (lines) getEntry(files, path).added = lines.map((text, i) => ({ n: i + 1, text }));
    else unreadable.push(path);
  }
  return { files, base, unreadable };
}

function scopeMatches(rule, path) {
  const ext = extname(path).toLowerCase();
  if (rule.ext && !rule.ext.has(ext)) return false;
  const isCode = CODE_EXT.has(ext);
  const isTest = TEST_PATH.test(path);
  switch (rule.scope) {
    case 'code': return isCode;
    case 'test': return isCode && isTest;
    case 'src': return isCode && !isTest;
    case 'app': return isCode && !isTest && !SCRIPT_PATH.test(path);
    case 'tsconfig': return TSCONFIG_PATH.test(path);
    case 'lintconfig': return LINT_CONFIG_PATH.test(path);
    case 'nondoc': return !DOC_EXT.has(ext);
    case 'nontest': return !isTest && !DOC_EXT.has(ext) && !TEMPLATE_PATH.test(path);
    case 'any': return true;
    default: throw new Error(`rule has unknown scope: ${rule.scope}`); // Programming error in RULES.
  }
}

// Remove comments, string contents and JSX text so prose cannot trigger code rules. Line-local and approximate:
// a string or comment spanning lines is only partly stripped, which errs towards reporting.
function stripLine(text, ext) {
  let s = text.replace(/\/\*.*?\*\//g, ' ');
  s = s.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '$1$1');
  s = s.replace(/\/\/.*$/, '');
  if (ext === '.py') s = s.replace(/#.*$/, '');
  if (ext === '.tsx' || ext === '.jsx') s = s.replace(/>[^<>{}]*</g, '><');
  return s;
}

function stripBlock(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '').replace(/(["'`])(?:\\.|(?!\1)[^\n])*\1/g, '$1$1');
}

function findWaiver(fileLines, lineNumber, ruleId) {
  if (!fileLines) return null;
  for (const n of [lineNumber, lineNumber - 1]) {
    const text = fileLines[n - 1];
    const match = text ? WAIVER.exec(text) : null;
    if (match && match[1] === ruleId) return match[2].trim();
  }
  return null;
}

function finding(rule, file, line, extra = {}) {
  return { rule: rule.id, severity: rule.severity, why: rule.why, fix: rule.fix, file, line, waived: null, ...extra };
}

function applyWaiver(rule, fileLines, line) {
  const reason = findWaiver(fileLines, line, rule.id);
  if (!reason) return { waived: null };
  if (rule.waivable === false) return { waived: null, waiverIgnored: true };
  return { waived: reason };
}

// Group consecutive added lines into blocks so multi-line patterns (an empty catch over three lines) are seen.
function addedBlocks(added) {
  const blocks = [];
  for (const entry of added) {
    const last = blocks[blocks.length - 1];
    if (last && entry.n === last.end + 1) { last.lines.push(entry.text); last.end = entry.n; }
    else blocks.push({ start: entry.n, end: entry.n, lines: [entry.text] });
  }
  return blocks;
}

function scanFile(path, change, fileLines) {
  const out = [];
  const ext = extname(path).toLowerCase();
  for (const rule of PATH_RULES) if (rule.re.test(path)) out.push(finding(rule, path, 0));
  for (const when of ['added', 'removed']) {
    const rules = RULES.filter((r) => (r.when ?? 'added') === when && scopeMatches(r, path));
    if (rules.length === 0) continue;
    for (const { n, text } of change[when]) {
      if (text.length > MAX_LINE_LENGTH || /^\s*(\/\/|#)\s*mend-waiver:/.test(text)) continue;
      const stripped = stripLine(text, ext);
      for (const rule of rules) {
        const subject = rule.stripped ? stripped : text;
        if (!rule.re.test(subject) || (rule.unless && rule.unless.test(text))) continue;
        const waiver = when === 'added' ? applyWaiver(rule, fileLines, n) : { waived: null };
        out.push(finding(rule, path, n, { removed: when === 'removed', ...waiver, text: text.trim().slice(0, 160) }));
      }
    }
  }
  const blockRules = BLOCK_RULES.filter((r) => scopeMatches(r, path));
  for (const block of blockRules.length > 0 ? addedBlocks(change.added) : []) {
    const joined = block.lines.join('\n');
    const subject = ext === '.py' ? joined : stripBlock(joined);
    for (const rule of blockRules) {
      rule.re.lastIndex = 0;
      for (let m = rule.re.exec(subject), guard = 0; m && guard < 1000; m = rule.re.exec(subject), guard += 1) {
        const line = block.start + subject.slice(0, m.index).split('\n').length - 1;
        out.push(finding(rule, path, line, { ...applyWaiver(rule, fileLines, line), text: (block.lines[line - block.start] ?? '').trim().slice(0, 160) }));
      }
    }
  }
  // A strict flag "removed" and re-added (reformatting) is not a weakening.
  const readded = new Set(change.added.map((a) => new RegExp(`"(${STRICT_FLAGS})"\\s*:\\s*true`).exec(a.text)?.[1]).filter(Boolean));
  return out.filter((f) => f.rule !== 'type-config-removed' || !readded.has(new RegExp(`"(${STRICT_FLAGS})"`).exec(f.text ?? '')?.[1]));
}

function scan(root, files) {
  const findings = [];
  for (const [path, change] of files) {
    if (SKIP_PATH.test(path)) continue;
    const fileLines = change.added.length > 0 ? readLines(root, path) : null;
    findings.push(...scanFile(path, change, fileLines));
    if (findings.length > MAX_FINDINGS) return { findings: findings.slice(0, MAX_FINDINGS), truncated: true };
  }
  return { findings, truncated: false };
}

function report({ findings, truncated }, base, unreadable, json) {
  const active = findings.filter((f) => !f.waived);
  const blocking = active.filter((f) => f.severity === 'block');
  const warnings = active.filter((f) => f.severity === 'warn');
  const waived = findings.filter((f) => f.waived);
  const ignoredWaivers = findings.filter((f) => f.waiverIgnored);
  if (json) {
    process.stdout.write(JSON.stringify({ base: base.label, truncated, unreadable, blocking, warnings, waived }, null, 2) + '\n');
    return blocking.length;
  }
  const out = [`ducttape-scan: ${blocking.length} blocking, ${warnings.length} warnings, ${waived.length} waived (base: ${base.label}${base.sha ? ` @ ${base.sha.slice(0, 8)}` : ''})`];
  if (truncated) out.push(`  output truncated at ${MAX_FINDINGS} findings`);
  if (unreadable.length > 0) out.push(`  not scanned (not a file or over ${MAX_FILE_BYTES} bytes): ${unreadable.slice(0, 20).join(', ')}${unreadable.length > 20 ? ', ...' : ''}`);
  let printed = 0;
  for (const f of [...blocking, ...warnings]) {
    if (printed >= MAX_PRINTED) { out.push(`... ${blocking.length + warnings.length - printed} more (use --json)`); break; }
    const where = f.line ? `${f.file}:${f.line}` : f.file;
    out.push('', `${f.severity === 'block' ? 'BLOCK' : 'WARN '}  ${where}${f.removed ? ' (removed line)' : ''}  [${f.rule}] ${f.why}`);
    if (f.text) out.push(`       > ${f.text}`);
    out.push(`       fix: ${f.fix}`);
    if (f.waiverIgnored) out.push('       note: this rule cannot be waived inline; it needs the user\'s approval in the mend log');
    printed += 1;
  }
  if (waived.length > 0) {
    out.push('', 'Waivers (each needs a reviewer to accept the reason):');
    for (const f of waived) out.push(`  ${f.file}:${f.line}  [${f.rule}] ${f.waived}`);
  }
  if (ignoredWaivers.length > 0) out.push('', `${ignoredWaivers.length} inline waiver(s) ignored on non-waivable rules.`);
  process.stdout.write(out.join('\n') + '\n');
  return blocking.length;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = tryGit(['rev-parse', '--show-toplevel'], process.cwd());
  if (!root) throw new UsageError('not inside a git repository');
  const { files, base, unreadable = [] } = collectChanges(root, opts);
  const blocking = report(scan(root, files), base, unreadable, opts.json);
  process.exitCode = blocking > 0 ? 1 : 0;
}

try {
  main();
} catch (error) {
  // Exit 2 for every non-finding failure, so callers never read a crash as "blocking findings".
  fail(error instanceof UsageError ? error.message : `internal error: ${error?.code === 'ENOBUFS' ? 'diff too large; narrow with --base or --files' : (error?.stack ?? error)}`);
}
