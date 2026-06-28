import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateRename,
  applyRenameToManifest,
  resolveOrg,
  renameRepoInUrl,
  deriveGithubTarget,
  validateNewName,
} from './repo-rename.mjs';

const manifest = {
  meta_repo: 'acme-household',
  knowledge_base: 'lore',
  repos: [
    { name: 'acme-household', url: 'git@github.com:acme-org/acme-household.git', description: 'The household meta-repo', tags: ['core'] },
    { name: 'acme-foo', url: 'git@github.com:acme-org/acme-foo.git', description: 'Foo', tags: ['core'] },
    { name: 'acme-bar', url: 'git@github.com:acme-org/acme-bar.git', description: 'Bar', tags: [] },
    { name: 'lore', description: 'Inline knowledge base (no url)' },
  ],
};

// Manifest where the manifest name differs from the GitHub repo name.
const manifestMismatch = {
  meta_repo: 'acme-household',
  knowledge_base: 'lore',
  repos: [
    { name: 'acme-household', url: 'git@github.com:acme-org/acme-household.git', description: 'The meta-repo', tags: ['core'] },
    { name: 'file-extractor', url: 'git@github.com:acme-org/File-Extract-API.git', description: 'Extractor', tags: [] },
    { name: 'lore', description: 'Inline KB' },
  ],
};

describe('validateRename', () => {
  it('returns the matched entry on valid args', () => {
    const e = validateRename(manifest, 'acme-foo', 'acme-baz');
    assert.equal(e.name, 'acme-foo');
  });

  it('throws when OLD is missing from the manifest', () => {
    assert.throws(() => validateRename(manifest, 'acme-missing', 'acme-baz'), /No entry named "acme-missing"/);
  });

  it('throws when NEW collides with an existing entry', () => {
    assert.throws(() => validateRename(manifest, 'acme-foo', 'acme-bar'), /already has an entry named "acme-bar"/);
  });

  it('throws when OLD === NEW', () => {
    assert.throws(() => validateRename(manifest, 'acme-foo', 'acme-foo'), /identical/);
  });

  it('throws when either name is empty', () => {
    assert.throws(() => validateRename(manifest, '', 'acme-baz'), /required/);
    assert.throws(() => validateRename(manifest, 'acme-foo', ''), /required/);
  });
});

describe('validateNewName', () => {
  it('accepts a valid new name', () => {
    // Should not throw
    validateNewName('acme-baz', 'acme-foo', manifest);
  });

  it('rejects an empty new name', () => {
    assert.throws(() => validateNewName('', 'acme-foo', manifest), /required/);
  });

  it('rejects names with invalid chars', () => {
    assert.throws(() => validateNewName('acme foo', 'acme-bar', manifest), /valid repo name/);
    assert.throws(() => validateNewName('acme/foo', 'acme-bar', manifest), /valid repo name/);
    assert.throws(() => validateNewName('acme@foo', 'acme-bar', manifest), /valid repo name/);
  });

  it('rejects new name equal to old name', () => {
    assert.throws(() => validateNewName('acme-foo', 'acme-foo', manifest), /identical/);
  });

  it('rejects new name that collides with an existing manifest entry', () => {
    assert.throws(() => validateNewName('acme-bar', 'acme-foo', manifest), /already has an entry/);
  });

  it('allows dots and underscores in names', () => {
    // Should not throw
    validateNewName('acme.bar_v2', 'acme-foo', manifest);
  });
});

describe('deriveGithubTarget', () => {
  it('returns org and repo from an SSH url', () => {
    const entry = { name: 'file-extractor', url: 'git@github.com:acme-org/File-Extract-API.git' };
    const t = deriveGithubTarget(entry);
    assert.deepEqual(t, { org: 'acme-org', repo: 'File-Extract-API' });
  });

  it('returns org and repo from an HTTPS url', () => {
    const entry = { name: 'backend', url: 'https://github.com/Acme-Org/backend-api.git' };
    const t = deriveGithubTarget(entry);
    assert.deepEqual(t, { org: 'Acme-Org', repo: 'backend-api' });
  });

  it('returns null when entry has no url', () => {
    const entry = { name: 'lore' };
    assert.equal(deriveGithubTarget(entry), null);
  });

  it('returns null for a non-GitHub url', () => {
    const entry = { name: 'foo', url: 'git@gitlab.com:org/foo.git' };
    assert.equal(deriveGithubTarget(entry), null);
  });

  it('repo segment reflects the real GitHub repo name, not the manifest name', () => {
    const entry = { name: 'file-extractor', url: 'git@github.com:acme-org/File-Extract-API.git' };
    const t = deriveGithubTarget(entry);
    assert.equal(t.repo, 'File-Extract-API');
    assert.notEqual(t.repo, entry.name);
  });
});

describe('applyRenameToManifest', () => {
  it('updates name and url for the matching entry', () => {
    const updated = applyRenameToManifest(manifest, 'acme-foo', 'acme-baz');
    const entry = updated.repos.find(r => r.name === 'acme-baz');
    assert.equal(entry.url, 'git@github.com:acme-org/acme-baz.git');
  });

  it('preserves description, tags, and other fields on the renamed entry', () => {
    const updated = applyRenameToManifest(manifest, 'acme-foo', 'acme-baz');
    const entry = updated.repos.find(r => r.name === 'acme-baz');
    assert.equal(entry.description, 'Foo');
    assert.deepEqual(entry.tags, ['core']);
  });

  it('leaves other entries untouched', () => {
    const updated = applyRenameToManifest(manifest, 'acme-foo', 'acme-baz');
    const other = updated.repos.find(r => r.name === 'acme-bar');
    assert.equal(other.url, 'git@github.com:acme-org/acme-bar.git');
    assert.equal(other.description, 'Bar');
  });

  it('does not mutate the input manifest', () => {
    const original = JSON.parse(JSON.stringify(manifest));
    applyRenameToManifest(manifest, 'acme-foo', 'acme-baz');
    assert.deepEqual(manifest, original);
  });

  it('preserves top-level manifest keys (meta_repo, etc.)', () => {
    const updated = applyRenameToManifest(manifest, 'acme-foo', 'acme-baz');
    assert.equal(updated.meta_repo, 'acme-household');
    assert.equal(updated.knowledge_base, 'lore');
  });

  it('only replaces the URL basename, not other occurrences of the name in URL parts', () => {
    // Edge case: org name shouldn't be touched even if it happens to contain
    // a substring of the old name.
    const m = {
      meta_repo: 'acme-household',
      repos: [{ name: 'foo', url: 'git@github.com:Some-foo-Org/foo.git', description: '', tags: [] }],
    };
    const updated = applyRenameToManifest(m, 'foo', 'bar');
    const entry = updated.repos.find(r => r.name === 'bar');
    assert.equal(entry.url, 'git@github.com:Some-foo-Org/bar.git');
  });

  it('rewrites a url with no .git suffix (keeps name and url consistent)', () => {
    // Regression for the suffix-less HTTPS remote case: parseRemoteUrl accepts
    // `https://github.com/org/repo` (no `.git`), so applyRename must rewrite it
    // too — otherwise the entry name and url diverge after a rename.
    const m = {
      meta_repo: 'acme-household',
      repos: [{ name: 'backend', url: 'https://github.com/Acme-Org/backend', description: '', tags: [] }],
    };
    const updated = applyRenameToManifest(m, 'backend', 'api');
    const entry = updated.repos.find(r => r.name === 'api');
    assert.equal(entry.url, 'https://github.com/Acme-Org/api');
  });

  it('does not bleed into entries whose name has the old name as a prefix', () => {
    // Renaming "acme-foo" must not touch "acme-foo-helper" — the match is exact.
    const m = {
      repos: [
        { name: 'acme-foo', url: 'git@github.com:acme-org/acme-foo.git', description: 'F', tags: [] },
        { name: 'acme-foo-helper', url: 'git@github.com:acme-org/acme-foo-helper.git', description: 'H', tags: [] },
      ],
    };
    const updated = applyRenameToManifest(m, 'acme-foo', 'acme-baz');
    const helper = updated.repos.find(r => r.name === 'acme-foo-helper');
    assert.ok(helper, 'acme-foo-helper must remain in the manifest under its original name');
    assert.equal(helper.url, 'git@github.com:acme-org/acme-foo-helper.git');
  });

  it('renames a url-less entry by name only, without adding a url', () => {
    const updated = applyRenameToManifest(manifest, 'lore', 'wisdom');
    const entry = updated.repos.find(r => r.name === 'wisdom');
    assert.ok(entry, 'renamed url-less entry must exist');
    assert.equal(entry.description, 'Inline knowledge base (no url)');
    assert.ok(!('url' in entry), 'url-less entry must not gain a url field');
  });

  it('updates top-level knowledge_base when the knowledge base is renamed', () => {
    const updated = applyRenameToManifest(manifest, 'lore', 'wisdom');
    assert.equal(updated.knowledge_base, 'wisdom');
  });

  it('updates top-level meta_repo (and the entry url) when the meta-repo itself is renamed', () => {
    const updated = applyRenameToManifest(manifest, 'acme-household', 'acme-home');
    assert.equal(updated.meta_repo, 'acme-home');
    const entry = updated.repos.find(r => r.name === 'acme-home');
    assert.equal(entry.url, 'git@github.com:acme-org/acme-home.git');
  });

  it('leaves meta_repo and knowledge_base alone when an unrelated entry is renamed', () => {
    const updated = applyRenameToManifest(manifest, 'acme-bar', 'acme-qux');
    assert.equal(updated.meta_repo, 'acme-household');
    assert.equal(updated.knowledge_base, 'lore');
  });
});

describe('applyRenameToManifest with mismatched name/github-repo', () => {
  it('updates the entry name to NEW when manifest name differs from github repo name', () => {
    const updated = applyRenameToManifest(manifestMismatch, 'file-extractor', 'file-extractor-v2');
    const entry = updated.repos.find(r => r.name === 'file-extractor-v2');
    assert.ok(entry, 'renamed entry must exist under new name');
  });

  it('rewrites the url repo segment to NEW using the current github repo name (not manifest name)', () => {
    // manifest name: 'file-extractor', github repo: 'File-Extract-API'
    // After rename to 'file-extractor-v2', the url should end in /file-extractor-v2.git
    const updated = applyRenameToManifest(manifestMismatch, 'file-extractor', 'file-extractor-v2');
    const entry = updated.repos.find(r => r.name === 'file-extractor-v2');
    assert.equal(entry.url, 'git@github.com:acme-org/file-extractor-v2.git');
  });

  it('leaves other entries in the mismatch manifest untouched', () => {
    const updated = applyRenameToManifest(manifestMismatch, 'file-extractor', 'file-extractor-v2');
    const household = updated.repos.find(r => r.name === 'acme-household');
    assert.equal(household.url, 'git@github.com:acme-org/acme-household.git');
  });

  it('does not mutate the mismatch manifest', () => {
    const original = JSON.parse(JSON.stringify(manifestMismatch));
    applyRenameToManifest(manifestMismatch, 'file-extractor', 'file-extractor-v2');
    assert.deepEqual(manifestMismatch, original);
  });
});

describe('resolveOrg', () => {
  it('derives the org from the meta_repo entry ssh url', () => {
    assert.equal(resolveOrg(manifest), 'acme-org');
  });

  it('derives the org from an https url too', () => {
    const m = {
      meta_repo: 'acme-household',
      repos: [{ name: 'acme-household', url: 'https://github.com/acme-org/acme-household.git' }],
    };
    assert.equal(resolveOrg(m), 'acme-org');
  });

  it('throws when there is no entry matching meta_repo', () => {
    const m = { meta_repo: 'acme-missing', repos: [{ name: 'acme-foo', url: 'git@github.com:acme-org/acme-foo.git' }] };
    assert.throws(() => resolveOrg(m), /Cannot resolve GitHub org/);
  });

  it('throws when the meta_repo entry has no url', () => {
    const m = { meta_repo: 'acme-household', repos: [{ name: 'acme-household' }] };
    assert.throws(() => resolveOrg(m), /Cannot resolve GitHub org/);
  });

  it('throws when the url is not a github.com url', () => {
    const m = {
      meta_repo: 'acme-household',
      repos: [{ name: 'acme-household', url: 'git@gitlab.com:acme-org/acme-household.git' }],
    };
    assert.throws(() => resolveOrg(m), /Cannot resolve GitHub org/);
  });

  it('throws when repos is missing entirely', () => {
    assert.throws(() => resolveOrg({ meta_repo: 'x' }), /Cannot resolve GitHub org/);
  });
});

describe('renameRepoInUrl', () => {
  it('rewrites an SSH url with a .git suffix', () => {
    assert.equal(
      renameRepoInUrl('git@github.com:Acme-Org/backend.git', 'backend', 'api'),
      'git@github.com:Acme-Org/api.git',
    );
  });

  it('rewrites an HTTPS url with a .git suffix', () => {
    assert.equal(
      renameRepoInUrl('https://github.com/Acme-Org/backend.git', 'backend', 'api'),
      'https://github.com/Acme-Org/api.git',
    );
  });

  it('rewrites a suffix-less HTTPS url', () => {
    assert.equal(
      renameRepoInUrl('https://github.com/Acme-Org/backend', 'backend', 'api'),
      'https://github.com/Acme-Org/api',
    );
  });

  it('rewrites a suffix-less SSH url', () => {
    assert.equal(
      renameRepoInUrl('git@github.com:Acme-Org/backend', 'backend', 'api'),
      'git@github.com:Acme-Org/api',
    );
  });

  it('never touches an org segment that shares the name', () => {
    assert.equal(
      renameRepoInUrl('git@github.com:Some-foo-Org/foo.git', 'foo', 'bar'),
      'git@github.com:Some-foo-Org/bar.git',
    );
  });

  it('returns falsy input unchanged', () => {
    assert.equal(renameRepoInUrl(undefined, 'a', 'b'), undefined);
    assert.equal(renameRepoInUrl('', 'a', 'b'), '');
  });
});
