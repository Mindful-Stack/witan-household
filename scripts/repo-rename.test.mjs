import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateRename, applyRenameToManifest, resolveOrg, renameRepoInUrl } from './repo-rename.mjs';

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
