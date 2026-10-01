import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { worktreeCommands, pickBaseRef, isLinkedWorktree, shouldDeleteBranch } from './manifest-worktree.mjs';

describe('worktreeCommands', () => {
  const plan = worktreeCommands({
    workspace: '/ws',
    worktreePath: '/tmp/household-create-abc',
    branch: 'chore/repos-create-svc',
    base: 'origin/main',
    commitMsg: 'chore(manifest): register svc',
  });

  it('never checks out a branch anywhere', () => {
    // `git -C <workspace> checkout -b` would switch the shared meta-repo
    // checkout's branch under any concurrent session, and leave the caller
    // parked on the manifest branch afterwards.
    for (const { args } of plan) {
      assert.ok(!args.includes('checkout'), `unexpected checkout in: ${args.join(' ')}`);
    }
  });

  it('only names the workspace to add the worktree', () => {
    const touchingWorkspace = plan.filter(({ args }) => args[1] === '/ws');
    assert.equal(touchingWorkspace.length, 1);
    assert.deepEqual(touchingWorkspace[0].args.slice(2, 4), ['worktree', 'add']);
  });

  it('runs every mutating command inside the worktree', () => {
    const mutating = plan.filter(({ args }) => ['add', 'commit', 'push'].includes(args[2]));
    assert.equal(mutating.length, 3);
    for (const { args } of mutating) assert.equal(args[1], '/tmp/household-create-abc');
  });

  it('branches from the given base ref', () => {
    assert.deepEqual(plan[0].args, [
      '-C', '/ws', 'worktree', 'add', '-b', 'chore/repos-create-svc',
      '/tmp/household-create-abc', 'origin/main',
    ]);
  });

  it('commits only the manifest, with the given message', () => {
    assert.deepEqual(plan[1].args.slice(2), ['add', 'household.json']);
    assert.deepEqual(plan[2].args.slice(2), ['commit', '-m', 'chore(manifest): register svc']);
  });

  it('pushes the branch with upstream tracking', () => {
    assert.deepEqual(plan[3].args.slice(2), ['push', '-u', 'origin', 'chore/repos-create-svc']);
  });
});


describe('pickBaseRef', () => {
  it('prefers origin/main', () => {
    assert.equal(pickBaseRef(['origin/main', 'main']), 'origin/main');
  });

  it('falls back to local main when origin/main is unavailable', () => {
    assert.equal(pickBaseRef(['main']), 'main');
  });

  it('refuses rather than silently forking from HEAD', () => {
    // Forking from HEAD on a master-default household, or a clone where fetch
    // failed, would branch off whatever feature branch is checked out — and
    // since `gh pr create` targets the default branch, the PR would carry every
    // unmerged commit on it.
    assert.throws(() => pickBaseRef([]), /neither origin\/main nor main exists/);
  });

  it('ignores refs it does not know about', () => {
    assert.throws(() => pickBaseRef(['master', 'develop']), /Cannot resolve a base ref/);
  });
});

describe('isLinkedWorktree', () => {
  it('is false in the primary checkout, where both dirs agree', () => {
    assert.equal(isLinkedWorktree('/ws/.git', '/ws/.git'), false);
  });

  it('is true in a linked worktree', () => {
    assert.equal(isLinkedWorktree('/ws/.git/worktrees/wt-x', '/ws/.git'), true);
  });

  it('normalises before comparing', () => {
    assert.equal(isLinkedWorktree('/ws/./.git', '/ws/.git'), false);
  });
});

describe('shouldDeleteBranch', () => {
  it('deletes the branch this run created when no PR was opened', () => {
    assert.equal(shouldDeleteBranch({ worktreeAdded: true, prOpened: false }), true);
  });

  it('keeps the branch once its PR is open', () => {
    assert.equal(shouldDeleteBranch({ worktreeAdded: true, prOpened: true }), false);
  });

  it('never deletes a branch this run did not create', () => {
    // `worktree add -b` fails when the branch already exists, e.g. kept by an
    // earlier successful run whose PR has not merged. That branch is not ours.
    assert.equal(shouldDeleteBranch({ worktreeAdded: false, prOpened: false }), false);
  });
});
