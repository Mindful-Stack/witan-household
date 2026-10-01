// Shared plumbing for scripts that land a household.json change as a PR.
//
// The meta-repo checkout is shared: other sessions, and the user, may have work
// in progress there. So a manifest change is never committed in place. It is
// written, committed and pushed inside a throwaway `git worktree` built on the
// base ref, and the checkout's HEAD, index and files are left alone.
//
// Used by new-repo.mjs; repo-rename.mjs shares the small file/git helpers.

import { writeFile, rename as fsRename, unlink, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileP = promisify(execFile);

// === Pure functions ============================================================

/**
 * Pick the ref a manifest branch forks from: origin/main, else local main.
 * Throws rather than falling back to HEAD, which would carry whatever feature
 * branch is checked out into the PR.
 *
 * @param {string[]} available - refs that resolve in the checkout
 * @returns {string}
 */
export function pickBaseRef(available) {
  for (const ref of ['origin/main', 'main']) {
    if (available.includes(ref)) return ref;
  }
  throw new Error(
    'Cannot resolve a base ref: neither origin/main nor main exists. Fetch first, or check out main.');
}

/**
 * True when `dir` is a linked worktree rather than the primary checkout.
 *
 * These targets are only meaningful from the workspace root: sibling repos live
 * there and nowhere else, and household.json is the workspace's own file. Run
 * from a worktree, a new ./<name>/ would be scaffolded inside the worktree.
 */
export function isLinkedWorktree(gitDir, gitCommonDir) {
  return path.resolve(gitDir) !== path.resolve(gitCommonDir);
}

/**
 * The git commands that land the manifest change on its own branch.
 *
 * Everything that mutates a working tree targets `worktreePath`, never
 * `workspace`. Only `worktree add` names the workspace, and it does not touch
 * the workspace's HEAD, index, or files.
 *
 * Returned as data rather than executed so the invariant can be asserted in a
 * unit test instead of trusted.
 *
 * @returns {{cmd: string, args: string[], cwd?: string}[]}
 */
export function worktreeCommands({ workspace, worktreePath, branch, base, commitMsg }) {
  return [
    { cmd: 'git', args: ['-C', workspace, 'worktree', 'add', '-b', branch, worktreePath, base] },
    { cmd: 'git', args: ['-C', worktreePath, 'add', 'household.json'] },
    { cmd: 'git', args: ['-C', worktreePath, 'commit', '-m', commitMsg] },
    { cmd: 'git', args: ['-C', worktreePath, 'push', '-u', 'origin', branch] },
  ];
}

// === I/O =======================================================================

export async function isWorkingTreeClean(dir) {
  const { stdout } = await execFileP('git', ['-C', dir, 'status', '--porcelain']);
  return stdout.trim() === '';
}

/**
 * What the manifest branch should fork from.
 *
 * Prefers origin/main so the PR is not built on a stale local main, but never
 * requires the network: a failed fetch falls back to local main.
 */
export async function resolveBaseRef(dir) {
  await execFileP('git', ['-C', dir, 'fetch', 'origin', '--quiet']).catch(() => {});
  const available = [];
  for (const ref of ['origin/main', 'main']) {
    try {
      await execFileP('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', ref]);
      available.push(ref);
    } catch { /* not present */ }
  }
  const ref = pickBaseRef(available);   // throws rather than falling back to HEAD
  if (ref !== 'origin/main') {
    console.error(`Warning: origin/main unavailable — branching from local "${ref}", which may be stale.`);
  }
  return ref;
}

/** Refuse to run anywhere but the primary checkout. See isLinkedWorktree. */
export async function assertPrimaryCheckout(dir) {
  const [{ stdout: gitDir }, { stdout: commonDir }] = await Promise.all([
    execFileP('git', ['-C', dir, 'rev-parse', '--absolute-git-dir']),
    execFileP('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir']),
  ]);
  if (isLinkedWorktree(gitDir.trim(), commonDir.trim())) {
    console.error('Error: this command must be run from the workspace root, not from a git worktree.');
    console.error(`  Detected worktree: ${dir}`);
    console.error('  Sibling repos and household.json live in the workspace root only.');
    process.exit(1);
  }
}

export async function currentBranch(dir) {
  const { stdout } = await execFileP('git', ['-C', dir, 'branch', '--show-current']);
  return stdout.trim();
}

export async function writeFileAtomic(filePath, content) {
  const tmp = filePath + '.tmp';
  try {
    await writeFile(tmp, content);
    await fsRename(tmp, filePath);
  } catch (e) {
    await unlink(tmp).catch(() => {});   // best-effort cleanup; ignore if absent
    throw e;
  }
}

/**
 * Remove the throwaway worktree, and its branch too unless a PR was opened.
 *
 * Best-effort: must never mask the real error from the caller's try block.
 * `worktree add -b` creates the branch as a side effect and `worktree remove`
 * leaves it behind, so without the branch delete any failure after `add` would
 * block the retry.
 */
export async function cleanupWorktree({ workspace, worktreePath, branch, keepBranch }) {
  await execFileP('git', ['-C', workspace, 'worktree', 'remove', '--force', worktreePath])
    .catch(async () => {
      // `worktree add` may never have run, in which case git has no record of
      // this path and only the bare mkdtemp directory is left behind.
      await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
      console.error(`Note: could not remove worktree ${worktreePath} — if it persists, run \`git worktree remove --force ${worktreePath}\`.`);
    });
  if (!keepBranch) {
    await execFileP('git', ['-C', workspace, 'branch', '-D', branch]).catch(() => {});
  }
}
