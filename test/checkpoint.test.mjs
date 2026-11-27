// checkpoint: snapshots include untracked files and never touch the index.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCRIPTS, git, makeRepo, run } from './helpers.mjs';

test('checkpoint captures untracked files, leaves the index alone, and --diff shows later changes', () => {
  const repo = makeRepo();
  try {
    repo.write('src/new.ts', 'export const a = 1;\n');
    const made = run(SCRIPTS.checkpoint, ['demo/P1'], { cwd: repo.dir });
    assert.equal(made.status, 0, made.stderr);
    assert.equal(git(repo.dir, 'diff', '--cached', '--name-only'), '');
    const sha = git(repo.dir, 'rev-parse', 'refs/mend/demo/P1');
    assert.match(git(repo.dir, 'ls-tree', '-r', '--name-only', sha), /src\/new\.ts/);

    assert.match(run(SCRIPTS.checkpoint, ['--diff', 'demo/P1'], { cwd: repo.dir }).stdout, /no changes since demo\/P1/);
    repo.write('src/later.ts', 'x\n');
    assert.match(run(SCRIPTS.checkpoint, ['--diff', 'demo/P1', '--stat'], { cwd: repo.dir }).stdout, /src\/later\.ts/);
  } finally { repo.cleanup(); }
});

test('an invalid label or unknown checkpoint exits 2', () => {
  const repo = makeRepo();
  try {
    assert.equal(run(SCRIPTS.checkpoint, ['../bad'], { cwd: repo.dir }).status, 2);
    assert.equal(run(SCRIPTS.checkpoint, ['--diff', 'nope'], { cwd: repo.dir }).status, 2);
  } finally { repo.cleanup(); }
});
