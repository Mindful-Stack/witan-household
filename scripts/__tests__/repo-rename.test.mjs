import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateRename, applyRenameToManifest } from '../repo-rename.mjs';

const manifest = {
  meta_repo: 'acme-workspace',
  repos: [
    { name: 'backend', url: 'git@github.com:Acme-Org/backend.git', description: 'Backend', tags: ['core'] },
    { name: 'frontend', url: 'git@github.com:Acme-Org/frontend.git', description: 'Frontend', tags: [] },
  ],
};

describe('validateRename', () => {
  it('returns the matched entry on valid args', () => {
    const e = validateRename(manifest, 'backend', 'api');
    assert.equal(e.name, 'backend');
  });

  it('throws when OLD is missing from the manifest', () => {
    assert.throws(() => validateRename(manifest, 'missing', 'api'), /No entry named "missing"/);
  });

  it('throws when NEW collides with an existing entry', () => {
    assert.throws(() => validateRename(manifest, 'backend', 'frontend'), /already has an entry named "frontend"/);
  });

  it('throws when OLD === NEW', () => {
    assert.throws(() => validateRename(manifest, 'backend', 'backend'), /identical/);
  });

  it('throws when either name is empty', () => {
    assert.throws(() => validateRename(manifest, '', 'api'), /required/);
    assert.throws(() => validateRename(manifest, 'backend', ''), /required/);
  });
});

describe('applyRenameToManifest', () => {
  it('updates name and url for the matching entry', () => {
    const updated = applyRenameToManifest(manifest, 'backend', 'api');
    const entry = updated.repos.find(r => r.name === 'api');
    assert.equal(entry.url, 'git@github.com:Acme-Org/api.git');
  });

  it('preserves description, tags, and other fields on the renamed entry', () => {
    const updated = applyRenameToManifest(manifest, 'backend', 'api');
    const entry = updated.repos.find(r => r.name === 'api');
    assert.equal(entry.description, 'Backend');
    assert.deepEqual(entry.tags, ['core']);
  });

  it('leaves other entries untouched', () => {
    const updated = applyRenameToManifest(manifest, 'backend', 'api');
    const other = updated.repos.find(r => r.name === 'frontend');
    assert.equal(other.url, 'git@github.com:Acme-Org/frontend.git');
    assert.equal(other.description, 'Frontend');
  });

  it('does not mutate the input manifest', () => {
    const original = JSON.parse(JSON.stringify(manifest));
    applyRenameToManifest(manifest, 'backend', 'api');
    assert.deepEqual(manifest, original);
  });

  it('preserves top-level manifest keys (meta_repo, etc.)', () => {
    const updated = applyRenameToManifest(manifest, 'backend', 'api');
    assert.equal(updated.meta_repo, 'acme-workspace');
  });

  it('renames an inline entry that has no url (name only, url stays absent)', () => {
    const m = {
      meta_repo: 'acme-workspace',
      repos: [{ name: 'lore', description: 'KB', tags: ['docs'] }],
    };
    const updated = applyRenameToManifest(m, 'lore', 'knowledge');
    const entry = updated.repos.find(r => r.name === 'knowledge');
    assert.ok(entry);
    assert.equal(entry.url, undefined);
  });

  it('only replaces the URL basename, not other occurrences of the name in URL parts', () => {
    // Edge case: org name shouldn't be touched even if it happens to contain
    // a substring of the old name.
    const m = {
      meta_repo: 'acme-workspace',
      repos: [{ name: 'foo', url: 'git@github.com:Some-foo-Org/foo.git', description: '', tags: [] }],
    };
    const updated = applyRenameToManifest(m, 'foo', 'bar');
    const entry = updated.repos.find(r => r.name === 'bar');
    assert.equal(entry.url, 'git@github.com:Some-foo-Org/bar.git');
  });

  it('does not bleed into entries whose name has the old name as a prefix', () => {
    // Renaming "api" must not touch "api-helper" — the match is exact.
    const m = {
      repos: [
        { name: 'api', url: 'git@github.com:Acme-Org/api.git', description: 'A', tags: [] },
        { name: 'api-helper', url: 'git@github.com:Acme-Org/api-helper.git', description: 'H', tags: [] },
      ],
    };
    const updated = applyRenameToManifest(m, 'api', 'gateway');
    const helper = updated.repos.find(r => r.name === 'api-helper');
    assert.ok(helper, 'api-helper must remain in the manifest under its original name');
    assert.equal(helper.url, 'git@github.com:Acme-Org/api-helper.git');
  });
});
