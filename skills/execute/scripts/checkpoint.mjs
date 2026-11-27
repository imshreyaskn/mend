#!/usr/bin/env node
// checkpoint: snapshot the whole working tree (tracked changes plus untracked files, honouring .gitignore)
// as a commit object, without touching the index, the current branch or any file.
//
// Why: mend phases and audits need a fixed point to diff against ("what changed since the audit?") and
// to roll back to, even when the user has not asked for commits.
//
// Usage:
//   node checkpoint.mjs <label>                create refs/mend/<label> and print its sha (labels like slug/P1)
//   node checkpoint.mjs --diff <label> [--stat] everything changed since <label>, untracked files included
//   node checkpoint.mjs --list                  list existing checkpoints
// Restore one file to its checkpoint state without touching the index:
//   git restore --source <sha> --worktree -- <path>
// (Plain `git diff <sha>` is misleading here: it shows files untracked in the working tree as deleted.)
// Exit codes: 0 ok, 2 usage or git error.

import { execFileSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';

const LABEL = /^[A-Za-z0-9][\w.-]*(\/[\w.-]+){0,3}$/;

function fail(message) {
  process.stderr.write(`checkpoint: ${message}\n`);
  process.exit(2);
}

function git(args, { cwd, env, allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
  } catch (error) {
    if (allowFail) return null;
    fail(`git ${args.join(' ')} failed: ${error.stderr?.toString().trim() || error.message}`);
  }
}

// Build a commit object for the current working tree using a throwaway index file.
function snapshot(root, message) {
  const gitPath = git(['rev-parse', '--git-path', 'mend-checkpoint-index'], { cwd: root });
  const indexFile = isAbsolute(gitPath) ? gitPath : join(root, gitPath);
  const env = { GIT_INDEX_FILE: indexFile };
  const head = git(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root, allowFail: true });
  try {
    if (head) git(['read-tree', head], { cwd: root, env });
    git(['add', '-A', '--', '.'], { cwd: root, env });
    const tree = git(['write-tree'], { cwd: root, env });
    const sha = git(['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message], { cwd: root });
    return { sha, head };
  } finally {
    if (existsSync(indexFile)) unlinkSync(indexFile);
  }
}

function resolveLabel(root, label) {
  const sha = git(['rev-parse', '--verify', '--quiet', `refs/mend/${label}`], { cwd: root, allowFail: true });
  if (!sha) fail(`no checkpoint named "${label}" (see --list)`);
  return sha;
}

function main() {
  const args = process.argv.slice(2);
  const root = git(['rev-parse', '--show-toplevel'], { allowFail: true });
  if (!root) fail('not inside a git repository');
  const [command, label] = args;
  if (!command) fail('usage: node checkpoint.mjs <label> | --diff <label> [--stat] | --list');

  if (command === '--list') {
    const refs = git(['for-each-ref', '--format=%(refname:short) %(objectname:short) %(creatordate:iso)', 'refs/mend/'], { cwd: root });
    process.stdout.write((refs || 'no checkpoints yet') + '\n');
    return;
  }

  if (command === '--diff') {
    if (!label) fail('--diff needs a checkpoint label');
    const from = resolveLabel(root, label);
    const now = snapshot(root, 'mend checkpoint (diff target)').sha; // Unreferenced: git gc collects it later.
    const out = git(['diff', '--no-color', ...(args.includes('--stat') ? ['--stat'] : []), from, now], { cwd: root });
    process.stdout.write((out || `no changes since ${label}`) + '\n');
    return;
  }

  if (!LABEL.test(command)) fail(`invalid label "${command}" (letters, digits, . _ - and up to three / separators)`);
  const { sha, head } = snapshot(root, `mend checkpoint ${command}`);
  git(['update-ref', `refs/mend/${command}`, sha], { cwd: root });
  const changed = head ? git(['diff', '--name-only', head, sha], { cwd: root }).split('\n').filter(Boolean).length : null;
  process.stdout.write(`checkpoint ${command} = ${sha}${changed === null ? '' : ` (${changed} files differ from HEAD)`}\n`);
  process.stdout.write(`  later: node checkpoint.mjs --diff ${command}\n  restore a file: git restore --source ${sha.slice(0, 12)} --worktree -- <path>\n`);
}

main();
