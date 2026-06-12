import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { parseRemoteUrl, resolveOrg, planActions, cwdInsideRename, describeAction } from './repos-sync-names.mjs';

// === parseRemoteUrl ===

describe('parseRemoteUrl', () => {
  it('parses SSH URLs with .git suffix', () => {
    assert.equal(
      parseRemoteUrl('git@github.com:acme-org/acme-foo.git'),
      'acme-org/acme-foo',
    );
  });

  it('parses SSH URLs without .git suffix', () => {
    assert.equal(
      parseRemoteUrl('git@github.com:acme-org/acme-foo'),
      'acme-org/acme-foo',
    );
  });

  it('parses HTTPS URLs with and without .git suffix', () => {
    assert.equal(
      parseRemoteUrl('https://github.com/acme-org/acme-foo.git'),
      'acme-org/acme-foo',
    );
    assert.equal(
      parseRemoteUrl('https://github.com/acme-org/acme-foo'),
      'acme-org/acme-foo',
    );
  });

  it('returns null for non-GitHub URLs', () => {
    assert.equal(parseRemoteUrl('git@gitlab.com:org/repo.git'), null);
    assert.equal(parseRemoteUrl('https://bitbucket.org/org/repo'), null);
  });

  it('returns null for empty/missing input', () => {
    assert.equal(parseRemoteUrl(''), null);
    assert.equal(parseRemoteUrl(null), null);
    assert.equal(parseRemoteUrl(undefined), null);
  });
});

// === resolveOrg ===

describe('resolveOrg', () => {
  it('derives the org from the meta_repo entry\'s SSH URL', () => {
    const org = resolveOrg({
      meta_repo: 'my-household',
      repos: [{ name: 'my-household', url: 'git@github.com:acme-org/my-household.git' }],
    });
    assert.equal(org, 'acme-org');
  });

  it('derives the org from the meta_repo entry\'s HTTPS URL', () => {
    const org = resolveOrg({
      meta_repo: 'my-household',
      repos: [{ name: 'my-household', url: 'https://github.com/acme-org/my-household.git' }],
    });
    assert.equal(org, 'acme-org');
  });

  it('throws when the meta_repo entry has no url', () => {
    assert.throws(
      () => resolveOrg({ meta_repo: 'my-household', repos: [{ name: 'my-household' }] }),
      /Cannot resolve GitHub org/,
    );
  });

  it('throws when no repos entry matches meta_repo', () => {
    assert.throws(
      () => resolveOrg({ meta_repo: 'my-household', repos: [] }),
      /Cannot resolve GitHub org/,
    );
    assert.throws(() => resolveOrg({}), /Cannot resolve GitHub org/);
  });
});

// === planActions ===

describe('planActions', () => {
  const manifest = {
    meta_repo: 'my-household',
    knowledge_base: 'lore',
    repos: [
      { name: 'my-household', url: 'git@github.com:acme-org/my-household.git' },
      { name: 'lore', description: 'inline knowledge base, no url' },
      { name: 'acme-foo', url: 'git@github.com:acme-org/acme-foo.git' },
      { name: 'acme-platform', url: 'git@github.com:acme-org/acme-platform.git' },
      { name: 'acme-fe', url: 'git@github.com:acme-org/acme-fe.git' },
    ],
  };

  it('proposes rename when URL matches and dir name differs', () => {
    const plan = planActions(manifest, [
      { dirName: 'foo', remoteUrl: 'git@github.com:acme-org/acme-foo.git' },
    ]);
    assert.equal(plan.actions.length, 1);
    const a = plan.actions[0];
    assert.equal(a.dirName, 'foo');
    assert.equal(a.targetName, 'acme-foo');
    assert.equal(a.targetUrl, 'git@github.com:acme-org/acme-foo.git');
    assert.equal(a.needsRename, true);
    assert.equal(a.needsUrlUpdate, false);
  });

  it('marks dir as already canonical when URL and name both match', () => {
    const plan = planActions(manifest, [
      { dirName: 'acme-foo', remoteUrl: 'git@github.com:acme-org/acme-foo.git' },
    ]);
    assert.deepEqual(plan.actions, []);
    assert.deepEqual(plan.alreadyCanonical, ['acme-foo']);
  });

  it('proposes URL update only when redirect resolves to current dir name', () => {
    // The repo was renamed on GitHub (acme-platform-frontend → acme-fe).
    // The local dir was already renamed; only the remote URL is stale.
    const plan = planActions(manifest, [{
      dirName: 'acme-fe',
      remoteUrl: 'git@github.com:acme-org/acme-platform-frontend.git',
      resolvedGithubPath: 'acme-org/acme-fe',
    }]);
    assert.equal(plan.actions.length, 1);
    const a = plan.actions[0];
    assert.equal(a.dirName, 'acme-fe');
    assert.equal(a.targetName, 'acme-fe');
    assert.equal(a.targetUrl, 'git@github.com:acme-org/acme-fe.git');
    assert.equal(a.needsRename, false);
    assert.equal(a.needsUrlUpdate, true);
  });

  it('proposes both rename and URL update when redirect resolves and dir name is stale', () => {
    // Repo renamed on GitHub; local dir AND local remote URL are both stale.
    const plan = planActions(manifest, [{
      dirName: 'acme-platform-frontend',
      remoteUrl: 'git@github.com:acme-org/acme-platform-frontend.git',
      resolvedGithubPath: 'acme-org/acme-fe',
    }]);
    assert.equal(plan.actions.length, 1);
    const a = plan.actions[0];
    assert.equal(a.dirName, 'acme-platform-frontend');
    assert.equal(a.targetName, 'acme-fe');
    assert.equal(a.needsRename, true);
    assert.equal(a.needsUrlUpdate, true);
  });

  it('keeps dirs unmatched when neither raw URL nor redirect lands in the manifest', () => {
    const plan = planActions(manifest, [{
      dirName: 'other',
      remoteUrl: 'git@github.com:Other-Org/something.git',
    }]);
    assert.equal(plan.actions.length, 0);
    assert.equal(plan.notInManifest.length, 1);
    assert.equal(plan.notInManifest[0].dirName, 'other');
  });

  it('keeps dirs unmatched when redirect resolved to a non-manifest repo', () => {
    // gh resolution succeeded but the resolved name isn't ours
    const plan = planActions(manifest, [{
      dirName: 'something',
      remoteUrl: 'git@github.com:acme-org/old-thing.git',
      resolvedGithubPath: 'acme-org/team-private-thing',
    }]);
    assert.equal(plan.actions.length, 0);
    assert.equal(plan.notInManifest.length, 1);
  });

  it('reports non-git dirs separately', () => {
    const plan = planActions(manifest, [
      { dirName: 'notes', remoteUrl: null },
      { dirName: 'docs', remoteUrl: null },
    ]);
    assert.deepEqual(plan.noGit.sort(), ['docs', 'notes']);
    assert.deepEqual(plan.actions, []);
  });

  it('ignores url-less manifest entries (inline dirs like lore/)', () => {
    // lore/ is tracked inside the meta-repo: no own .git, no url in the
    // manifest. It must land in noGit and never produce an action.
    const plan = planActions(manifest, [
      { dirName: 'lore', remoteUrl: null },
    ]);
    assert.deepEqual(plan.noGit, ['lore']);
    assert.deepEqual(plan.actions, []);
    assert.deepEqual(plan.notInManifest, []);
  });

  it('never treats the meta-repo entry as a rename target', () => {
    // A nested clone of the meta-repo itself must not be renamed onto the
    // household root's manifest entry — it stays unmatched.
    const plan = planActions(manifest, [{
      dirName: 'nested-clone',
      remoteUrl: 'git@github.com:acme-org/my-household.git',
    }]);
    assert.equal(plan.actions.length, 0);
    assert.equal(plan.notInManifest.length, 1);
    assert.equal(plan.notInManifest[0].dirName, 'nested-clone');
  });

  it('handles HTTPS URLs in manifest equally to SSH siblings', () => {
    const httpsManifest = {
      meta_repo: 'my-household',
      repos: [{ name: 'acme-foo', url: 'https://github.com/acme-org/acme-foo.git' }],
    };
    const plan = planActions(httpsManifest, [
      { dirName: 'foo', remoteUrl: 'git@github.com:acme-org/acme-foo.git' },
    ]);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].needsRename, true);
    assert.equal(plan.actions[0].needsUrlUpdate, false);
  });
});

// === cwdInsideRename ===

describe('cwdInsideRename', () => {
  const workspace = '/ws';
  const actions = [
    { dirName: 'be', targetName: 'acme-platform', needsRename: true, needsUrlUpdate: false },
    { dirName: 'acme-fe', targetName: 'acme-fe', needsRename: false, needsUrlUpdate: true },
  ];

  it('returns the action when cwd is the renamed dir itself', () => {
    const r = cwdInsideRename('/ws/be', workspace, actions);
    assert.equal(r?.dirName, 'be');
  });

  it('returns the action when cwd is nested inside the renamed dir', () => {
    const r = cwdInsideRename('/ws/be/src/api', workspace, actions);
    assert.equal(r?.dirName, 'be');
  });

  it('does not flag URL-only updates (no rename, cwd stays valid)', () => {
    assert.equal(cwdInsideRename('/ws/acme-fe/src', workspace, actions), null);
  });

  it('returns null when cwd is the household root', () => {
    assert.equal(cwdInsideRename('/ws', workspace, actions), null);
  });

  it('returns null when cwd is a sibling not being renamed', () => {
    assert.equal(cwdInsideRename('/ws/acme-workflows', workspace, actions), null);
  });

  it('does not match on prefix-but-not-path-separator boundary', () => {
    // /ws/before should not match a rename of /ws/be
    assert.equal(cwdInsideRename(path.join(workspace, 'before'), workspace, actions), null);
  });
});

// === describeAction ===

describe('describeAction', () => {
  it('describes rename + URL update', () => {
    const s = describeAction({
      dirName: 'be',
      targetName: 'acme-platform',
      needsRename: true,
      needsUrlUpdate: true,
    });
    assert.equal(s, 'be  →  acme-platform  (+ update remote URL)');
  });

  it('describes rename only', () => {
    const s = describeAction({
      dirName: 'be',
      targetName: 'acme-platform',
      needsRename: true,
      needsUrlUpdate: false,
    });
    assert.equal(s, 'be  →  acme-platform');
  });

  it('describes URL update only', () => {
    const s = describeAction({
      dirName: 'acme-fe',
      targetName: 'acme-fe',
      needsRename: false,
      needsUrlUpdate: true,
    });
    assert.equal(s, 'acme-fe  (update remote URL)');
  });
});
