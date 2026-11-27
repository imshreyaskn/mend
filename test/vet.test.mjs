// vet-package, offline via a fetch mock: exit 0 OK, 1 REJECT, 3 REVIEW; unknown never passes.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { MOCK_FETCH, SCRIPTS, run } from './helpers.mjs';

const cwd = mkdtempSync(join(tmpdir(), 'mend-vet-')); // No package.json, so React Native checks stay off.
after(() => rmSync(cwd, { recursive: true, force: true }));
const vet = (args, env = {}) => run(SCRIPTS.vet, [...args, '--no-rn'], { cwd, env, preload: MOCK_FETCH });

describe('vet-package', () => {
  test('bare name resolves to latest and passes', () => {
    const r = vet(['demo']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /demo@2\.0\.0 {2}OK/);
  });

  test('regression: @latest and other dist-tags resolve before the existence check', () => {
    assert.match(vet(['demo@latest']).stdout, /demo@2\.0\.0 {2}OK/);
    assert.match(vet(['demo@next']).stdout, /demo@3\.0\.0-beta\.1/);
  });

  test('a range is rejected with a clear message, not as "does not exist"', () => {
    const r = vet(['demo@^2']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /neither an exact version nor a dist-tag/);
  });

  test('a missing version and a missing package are rejected', () => {
    assert.equal(vet(['demo@9.9.9']).status, 1);
    const r = vet(['no-such-package-x9q2']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /does not exist on npm/);
  });

  test('a failed vulnerability lookup is REVIEW (exit 3), never OK', () => {
    const r = vet(['demo'], { MOCK_FAIL: 'api.osv.dev' });
    assert.equal(r.status, 3);
    assert.match(r.stdout, /unknown OSV/);
  });

  test('a registry outage verifies nothing and exits 3', () => {
    assert.equal(vet(['demo'], { MOCK_FAIL: 'ALL' }).status, 3);
  });
});
