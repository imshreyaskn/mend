// ducttape-scan: every rule has a case that must fire and a case that must stay quiet, plus regressions.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { SCRIPTS, makeRepo, run, scanJson } from './helpers.mjs';

// [rule, path, should-fire content, should-stay-quiet content, optional path for the quiet case]
const LINE_CASES = [
  ['ts-suppress', 'src/a.ts', '// @ts-ignore\n', '// @ts-expect-error upstream type is wrong, see #12\n'],
  ['ts-expect-error-bare', 'src/a.ts', '// @ts-expect-error\n', '// @ts-expect-error wrong upstream type, issue #12\n'],
  ['lint-disable-bare', 'src/a.ts', '// eslint-disable-next-line no-console\n', '// eslint-disable-next-line no-console -- CLI output\n'],
  ['double-cast', 'src/a.ts', 'const x = y as unknown as T;\n', 'const x = y as T;\n'],
  ['any-type', 'src/a.ts', 'let x: any = 1;\n', 'const s = AbortSignal.any([a, b]); // any reader can follow\n'],
  ['non-null-assertion', 'src/a.ts', 'foo!.bar();\n', 'if (a !== b) run("done!");\n'],
  ['log-and-swallow', 'src/a.ts', 'try { f(); } catch (e) { console.error(e); }\n', "try { f(); } catch (e) { throw new Error('f', { cause: e }); }\n"],
  ['py-bare-except', 'src/a.py', 'except:\n', 'except ValueError as e:\n'],
  ['focused-or-skipped-test', 'src/a.test.ts', "it.only('x', () => {});\n", "it('x', () => {});\n"],
  ['sleep-in-test', 'src/a.test.ts', 'await sleep(500);\n', 'await waitFor(() => ready());\n'],
  ['timer-as-sync', 'src/a.ts', 'setTimeout(() => done(), 0);\n', 'setTimeout(() => done(), 5000);\n'],
  ['unbounded-loop', 'src/a.ts', 'while (true) { poll(); }\n', 'while (attempts < max) { poll(); }\n'],
  ['debugger-statement', 'src/a.ts', 'debugger;\n', 'const debuggerEnabled = false;\n'],
  ['debug-log', 'src/a.ts', "console.log('x');\n", "console.log('x');\n", 'scripts/a.ts'],
  ['todo-without-ticket', 'src/a.ts', '// TODO fix this\n', '// TODO TAP-137 handle offline\n'],
  ['shortcut-incomplete', 'src/a.ts', '// shortcut: linear scan\n', '// shortcut: linear scan of the list, switch to a Map past 1000 items\n'],
  ['json-parse-unvalidated', 'src/a.ts', 'const d = JSON.parse(raw);\n', 'const d = Schema.safeParse(JSON.parse(raw));\n'],
  ['wall-clock-duration', 'src/a.ts', 'const ms = Date.now() - startedAt;\n', 'const left = expiresAt - Date.now();\n'],
  ['insecure-random', 'src/a.ts', 'const id = Math.random();\n', 'const id = crypto.randomUUID();\n'],
  ['bitwise-truncation', 'src/a.ts', 'const s = (Date.now() / 1000) | 0;\n', 'const ok = a || 0;\n'],
  ['date-field-arithmetic', 'src/a.ts', 'd.setFullYear(d.getFullYear() + 1);\n', 'const next = addYears(d, 1);\n'],
  ['nested-quantifier-regex', 'src/a.ts', 'const re = /^(a+)+$/;\n', 'const re = /^a+$/;\n'],
  ['dynamic-code', 'src/a.ts', 'eval(code);\n', 'evaluate(code);\n'],
  ['raw-html', 'src/a.ts', 'el.innerHTML = html;\n', 'el.textContent = text;\n'],
  ['index-as-key', 'src/a.tsx', 'items.map((x, i) => <Row key={i} />);\n', 'items.map((x) => <Row key={x.id} />);\n'],
  ['hardcoded-secret', 'src/a.ts', 'const apiKey = "abcdefghijklmnop1234";\n', 'const apiKey = "your_api_key_here_123";\n'],
  ['hardcoded-secret-env', 'config/app.env', 'API_KEY=abcd1234efgh5678ijkl\n', 'API_KEY=${API_KEY}\n'],
  ['secret-in-test', 'src/a.test.ts', 'const t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n', 'const t = "fake-token";\n'],
  ['gate-bypass', 'tools/release.sh', 'git commit --no-verify -m release\n', 'git commit -m release\n'],
  ['shell-error-suppressed', 'tools/clean.sh', 'rm -rf dist || true\n', 'rm -rf dist\n'],
  ['type-config-weakened', 'tsconfig.json', '{ "compilerOptions": { "strict": false } }\n', '{ "compilerOptions": { "strict": true } }\n'],
  ['lint-rule-turned-off', 'eslint.config.js', "export default [{ rules: { 'no-console': 'off' } }];\n", "export default [{ rules: { 'no-console': 'error' } }];\n"],
  ['rust-unwrap', 'src/a.rs', 'let v = x.unwrap();\n', 'let v = x?;\n'],
  ['go-ignored-error', 'src/a.go', 'v, _ := f()\n', 'v, err := f()\n'],
  ['py-suppress-bare', 'src/a.py', 'x = f()  # type: ignore\n', 'x = f()  # type: ignore[arg-type]\n'],
  ['empty-catch', 'src/a.ts', 'try { f(); } catch (e) {}\n', 'try { f(); } catch (e) { handle(e); }\n'],
  ['swallowed-promise', 'src/a.ts', 'p.catch(() => {});\n', 'p.catch((e) => report(e));\n'],
  ['py-except-pass', 'src/a.py', 'try:\n    f()\nexcept ValueError:\n    pass\n', 'try:\n    f()\nexcept ValueError as e:\n    log(e)\n'],
];

// Rules that only fire on a diff (removed lines, changed paths) are covered in DIFF_RULES below.
const DIFF_RULES = ['type-config-removed', 'assertion-removed', 'test-removed', 'patch-package', 'snapshot-changed'];

describe('ducttape-scan line rules', () => {
  let repo;
  const results = new Map();
  before(() => {
    repo = makeRepo();
    const files = [];
    LINE_CASES.forEach(([rule, path, fire, quiet, quietPath], i) => {
      const firePath = `cases/${i}-fire/${path}`;
      const quietFile = `cases/${i}-quiet/${quietPath ?? path}`;
      repo.write(firePath, fire);
      repo.write(quietFile, quiet);
      files.push(firePath, quietFile);
      results.set(rule, { firePath, quietFile });
    });
    const { all } = scanJson(repo.dir, ['--files', ...files]);
    for (const value of results.values()) {
      value.fired = all.filter((f) => f.file === value.firePath).map((f) => f.rule);
      value.quietHits = all.filter((f) => f.file === value.quietFile).map((f) => f.rule);
    }
  });
  after(() => repo.cleanup());

  for (const [rule] of LINE_CASES) {
    test(`${rule} fires on its bad case`, () => {
      assert.ok(results.get(rule).fired.includes(rule), `expected ${rule}, got [${results.get(rule).fired}]`);
    });
    test(`${rule} stays quiet on its good case`, () => {
      assert.ok(!results.get(rule).quietHits.includes(rule), `${rule} fired on the good case`);
    });
  }

  test('every rule in the scanner has a test case', () => {
    const source = readFileSync(SCRIPTS.scan, 'utf8');
    const ids = [...source.matchAll(/\{ id: '([a-z0-9-]+)'/g)].map((m) => m[1]);
    const covered = new Set([...LINE_CASES.map((c) => c[0]), ...DIFF_RULES]);
    const missing = ids.filter((id) => !covered.has(id));
    assert.deepEqual(missing, [], `rules without tests: ${missing.join(', ')}`);
  });
});

describe('ducttape-scan diff behaviour', () => {
  test('regression: a secret next to process.env still blocks', () => {
    const repo = makeRepo();
    try {
      repo.write('src/a.ts', 'const k = process.env.KEY || "sk_live_abcdefghijklmnopqrstu";\n');
      const { all, status } = scanJson(repo.dir, ['--base', 'main']);
      assert.ok(all.some((f) => f.rule === 'hardcoded-secret'));
      assert.equal(status, 1);
    } finally { repo.cleanup(); }
  });

  test('regression: emptying an existing catch by deleting its body is caught', () => {
    const repo = makeRepo();
    try {
      repo.write('src/a.ts', 'try {\n  f();\n} catch (e) {\n  handle(e);\n}\n');
      repo.commit();
      repo.write('src/a.ts', 'try {\n  f();\n} catch (e) {\n}\n');
      const { all } = scanJson(repo.dir, ['--base', 'HEAD']);
      assert.ok(all.some((f) => f.rule === 'empty-catch' && f.line === 3), JSON.stringify(all));
    } finally { repo.cleanup(); }
  });

  test('an untouched empty catch elsewhere in the file is not reported', () => {
    const repo = makeRepo();
    try {
      repo.write('src/a.ts', 'try { a(); } catch {}\nconst x = 1;\n');
      repo.commit();
      repo.write('src/a.ts', 'try { a(); } catch {}\nconst x = 2;\n');
      const { all } = scanJson(repo.dir, ['--base', 'HEAD']);
      assert.ok(!all.some((f) => f.rule === 'empty-catch'), JSON.stringify(all));
    } finally { repo.cleanup(); }
  });

  test('deleting tests and assertions is reported, including a deleted test file', () => {
    const repo = makeRepo();
    try {
      repo.write('src/a.test.ts', "it('works', () => {\n  expect(a).toBe(1);\n  expect(b).toBe(2);\n});\n");
      repo.write('src/old.test.ts', "it('old', () => { expect(1).toBe(1); });\n");
      repo.commit();
      repo.write('src/a.test.ts', "it('works', () => {\n  expect(a).toBe(1);\n});\n");
      repo.write('src/old.test.ts', '');
      const { all } = scanJson(repo.dir, ['--base', 'HEAD']);
      assert.ok(all.some((f) => f.rule === 'assertion-removed' && f.file === 'src/a.test.ts'));
      assert.ok(all.some((f) => f.rule === 'test-removed' && f.file === 'src/old.test.ts'));
    } finally { repo.cleanup(); }
  });

  test('removing a strict flag blocks, reformatting it does not', () => {
    const repo = makeRepo();
    try {
      repo.write('tsconfig.json', '{\n  "compilerOptions": {\n    "strict": true,\n    "noEmit": true\n  }\n}\n');
      repo.write('other/tsconfig.json', '{\n  "compilerOptions": {\n    "strict": true\n  }\n}\n');
      repo.commit();
      repo.write('tsconfig.json', '{\n  "compilerOptions": {\n    "noEmit": true\n  }\n}\n');
      repo.write('other/tsconfig.json', '{\n  "compilerOptions": { "strict": true }\n}\n');
      const { all } = scanJson(repo.dir, ['--base', 'HEAD']);
      assert.ok(all.some((f) => f.rule === 'type-config-removed' && f.file === 'tsconfig.json'));
      assert.ok(!all.some((f) => f.rule === 'type-config-removed' && f.file === 'other/tsconfig.json'));
    } finally { repo.cleanup(); }
  });

  test('patches and snapshots are flagged by path; docs are not', () => {
    const repo = makeRepo();
    try {
      repo.write('patches/lib+1.0.0.patch', 'diff\n');
      repo.write('src/__snapshots__/a.test.ts.snap', 'exports[`x`] = `y`;\n');
      repo.write('docs/notes.md', 'notes\n');
      const { all } = scanJson(repo.dir, ['--base', 'main']);
      assert.ok(all.some((f) => f.rule === 'patch-package'));
      assert.ok(all.some((f) => f.rule === 'snapshot-changed'));
      assert.ok(!all.some((f) => f.file === 'docs/notes.md'));
    } finally { repo.cleanup(); }
  });

  test('inline waivers work on waivable rules and are ignored on non-waivable ones', () => {
    const repo = makeRepo();
    try {
      repo.write('src/a.ts', 'const r = Math.random(); // mend-waiver: insecure-random jitter only\n');
      repo.write('src/a.test.ts', "it.only('x', () => {}); // mend-waiver: focused-or-skipped-test debugging\n");
      const { all, waived } = scanJson(repo.dir, ['--base', 'main']);
      assert.ok(waived.some((f) => f.rule === 'insecure-random'));
      assert.ok(all.some((f) => f.rule === 'focused-or-skipped-test' && f.waiverIgnored));
    } finally { repo.cleanup(); }
  });

  test('a branch with no recognisable base exits 2 instead of scanning only uncommitted work', () => {
    const repo = makeRepo('mobile-dev');
    try {
      const r = run(SCRIPTS.scan, [], { cwd: repo.dir });
      assert.equal(r.status, 2);
      assert.match(r.stderr, /--base/);
    } finally { repo.cleanup(); }
  });

  test('paths with spaces and non-ASCII characters are scanned', () => {
    const repo = makeRepo();
    try {
      repo.write('src/my file.ts', '// @ts-ignore\n');
      repo.write('src/café.ts', '// @ts-ignore\n');
      const { all } = scanJson(repo.dir, ['--base', 'main']);
      assert.ok(all.some((f) => f.file === 'src/my file.ts'));
      assert.ok(all.some((f) => f.file === 'src/café.ts'));
    } finally { repo.cleanup(); }
  });
});
