// Shared helpers for the mend script tests. Each test gets its own throwaway git repository under the OS temp dir.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SCRIPTS = {
  scan: resolve(here, '../skills/audit/scripts/ducttape-scan.mjs'),
  trace: resolve(here, '../skills/audit/scripts/trace-check.mjs'),
  vet: resolve(here, '../skills/research/scripts/vet-package.mjs'),
  checkpoint: resolve(here, '../skills/execute/scripts/checkpoint.mjs'),
};
export const MOCK_FETCH = resolve(here, 'fixtures/mock-fetch.mjs');

export function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// A fresh repository with one commit on `branch`. Returns { dir, write, commit, cleanup }.
export function makeRepo(branch = 'main') {
  const dir = mkdtempSync(join(tmpdir(), 'mend-test-'));
  git(dir, 'init', '-q', '-b', branch);
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'mend test');
  git(dir, 'config', 'core.autocrlf', 'false');
  const write = (path, content) => {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  const commit = (message = 'commit') => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--allow-empty', '-m', message); };
  write('README.md', '# test\n');
  commit('base');
  return { dir, write, commit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function run(script, args, { cwd, env = {}, preload } = {}) {
  const nodeArgs = preload ? ['--import', new URL(`file:///${preload.replace(/\\/g, '/')}`).href, script, ...args] : [script, ...args];
  return spawnSync(process.execPath, nodeArgs, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}

export function scanJson(cwd, args) {
  const r = run(SCRIPTS.scan, ['--json', ...args], { cwd });
  if (r.status === 2) throw new Error(`scanner error: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  return { status: r.status, all: [...out.blocking, ...out.warnings], waived: out.waived, out };
}
