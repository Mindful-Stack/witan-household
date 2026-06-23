import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  parseRemoteUrl,
  manifestOrgs,
  planActions,
  cwdInsideRename,
  describeAction,
} from '../repos-sync-names.mjs';

// === parseRemoteUrl ===

describe('parseRemoteUrl', () => {
  it('parses SSH URLs with .git suffix', () => {
    assert.equal(
      parseRemoteUrl('git@github.com:Acme-Org/backend.git'),
      'Acme-Org/backend',
    );
  });

  it('parses SSH URLs without .git suffix', () => {
    assert.equal(
      parseRemoteUrl('git@github.com:Acme-Org/backend'),
      'Acme-Org/backend',
    );
  });

  it('parses HTTPS URLs with and without .git suffix', () => {
    assert.equal(
      parseRemoteUrl('https://github.com/Acme-Org/backend.git'),
      'Acme-Org/backend',
    );
    assert.equal(
      parseRemoteUrl('https://github.com/Acme-Org/backend'),
      'Acme-Org/backend',
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

// === manifestOrgs ===

describe('manifestOrgs', () => {
  it('collects the distinct orgs across all repo URLs', () => {
    const m = {
      repos: [
        { name: 'a', url: 'git@github.com:Acme-Org/a.git' },
        { name: 'b', url: 'https://github.com/Acme-Org/b.git' },
        { name: 'c', url: 'git@github.com:Other-Org/c.git' },
      ],
    };
    const orgs = manifestOrgs(m);
    assert.deepEqual([...orgs].sort(), ['Acme-Org', 'Other-Org']);
  });

  it('ignores entries with no parseable URL', () => {
    const m = {
      repos: [
        { name: 'a', url: 'git@github.com:Acme-Org/a.git' },
        { name: 'lore' },
        { name: 'x', url: 'git@gitlab.com:org/x.git' },
      ],
    };
    assert.deepEqual([...manifestOrgs(m)], ['Acme-Org']);
  });
});

// === planActions ===

describe('planActions', () => {
  const manifest = {
    repos: [
      { name: 'backend', url: 'git@github.com:Acme-Org/backend.git' },
      { name: 'platform', url: 'git@github.com:Acme-Org/platform.git' },
      { name: 'web-fe', url: 'git@github.com:Acme-Org/web-fe.git' },
    ],
  };

  it('proposes rename when URL matches and dir name differs', () => {
    const plan = planActions(manifest, [
      { dirName: 'be', remoteUrl: 'git@github.com:Acme-Org/backend.git' },
    ]);
    assert.equal(plan.actions.length, 1);
    const a = plan.actions[0];
    assert.equal(a.dirName, 'be');
    assert.equal(a.targetName, 'backend');
    assert.equal(a.targetUrl, 'git@github.com:Acme-Org/backend.git');
    assert.equal(a.needsRename, true);
    assert.equal(a.needsUrlUpdate, false);
  });

  it('marks dir as already canonical when URL and name both match', () => {
    const plan = planActions(manifest, [
      { dirName: 'backend', remoteUrl: 'git@github.com:Acme-Org/backend.git' },
    ]);
    assert.deepEqual(plan.actions, []);
    assert.deepEqual(plan.alreadyCanonical, ['backend']);
  });

  it('proposes URL update only when redirect resolves to current dir name', () => {
    // The repo was renamed on GitHub (frontend → web-fe). The local dir was
    // already renamed; only the remote URL is stale.
    const plan = planActions(manifest, [{
      dirName: 'web-fe',
      remoteUrl: 'git@github.com:Acme-Org/frontend.git',
      resolvedGithubPath: 'Acme-Org/web-fe',
    }]);
    assert.equal(plan.actions.length, 1);
    const a = plan.actions[0];
    assert.equal(a.dirName, 'web-fe');
    assert.equal(a.targetName, 'web-fe');
    assert.equal(a.targetUrl, 'git@github.com:Acme-Org/web-fe.git');
    assert.equal(a.needsRename, false);
    assert.equal(a.needsUrlUpdate, true);
  });

  it('proposes both rename and URL update when redirect resolves and dir name is stale', () => {
    // Repo renamed on GitHub; local dir AND local remote URL are both stale.
    const plan = planActions(manifest, [{
      dirName: 'frontend',
      remoteUrl: 'git@github.com:Acme-Org/frontend.git',
      resolvedGithubPath: 'Acme-Org/web-fe',
    }]);
    assert.equal(plan.actions.length, 1);
    const a = plan.actions[0];
    assert.equal(a.dirName, 'frontend');
    assert.equal(a.targetName, 'web-fe');
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
      remoteUrl: 'git@github.com:Acme-Org/old-thing.git',
      resolvedGithubPath: 'Acme-Org/team-private-thing',
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

  it('handles HTTPS URLs in manifest equally to SSH siblings', () => {
    const httpsManifest = {
      repos: [{ name: 'backend', url: 'https://github.com/Acme-Org/backend.git' }],
    };
    const plan = planActions(httpsManifest, [
      { dirName: 'be', remoteUrl: 'git@github.com:Acme-Org/backend.git' },
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
    { dirName: 'be', targetName: 'platform', needsRename: true, needsUrlUpdate: false },
    { dirName: 'web-fe', targetName: 'web-fe', needsRename: false, needsUrlUpdate: true },
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
    assert.equal(cwdInsideRename('/ws/web-fe/src', workspace, actions), null);
  });

  it('returns null when cwd is the workspace root', () => {
    assert.equal(cwdInsideRename('/ws', workspace, actions), null);
  });

  it('returns null when cwd is a sibling not being renamed', () => {
    assert.equal(cwdInsideRename('/ws/workflows', workspace, actions), null);
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
      targetName: 'platform',
      needsRename: true,
      needsUrlUpdate: true,
    });
    assert.equal(s, 'be  →  platform  (+ update remote URL)');
  });

  it('describes rename only', () => {
    const s = describeAction({
      dirName: 'be',
      targetName: 'platform',
      needsRename: true,
      needsUrlUpdate: false,
    });
    assert.equal(s, 'be  →  platform');
  });

  it('describes URL update only', () => {
    const s = describeAction({
      dirName: 'web-fe',
      targetName: 'web-fe',
      needsRename: false,
      needsUrlUpdate: true,
    });
    assert.equal(s, 'web-fe  (update remote URL)');
  });
});
