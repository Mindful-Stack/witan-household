import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseRemoteUrl } from '../scripts/repos-sync-names.mjs';
import { validateName } from '../scripts/new-repo.mjs';

// Loads the real household.json and asserts its shape. Catches hand-edits that
// the pure-function unit tests can't (since the manifest is mostly curated by
// humans). Optional fields (url, tags, description, branchProtection) are only
// validated when present — url-less entries are inline directories by design.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOUSEHOLD_JSON = path.join(__dirname, '..', 'household.json');
const manifest = JSON.parse(readFileSync(HOUSEHOLD_JSON, 'utf8'));

describe('household.json (top level)', () => {
  it('has a "repos" array', () => {
    assert.ok(Array.isArray(manifest.repos), 'repos must be an array');
    assert.ok(manifest.repos.length > 0, 'repos must not be empty');
  });

  it('declares a meta_repo that matches a repo name', () => {
    assert.equal(typeof manifest.meta_repo, 'string');
    const names = new Set(manifest.repos.map(r => r.name));
    assert.ok(
      names.has(manifest.meta_repo),
      `meta_repo="${manifest.meta_repo}" must match a repo in repos[]`,
    );
  });

  it('knowledge_base (if set) maps to a repo entry', () => {
    if (manifest.knowledge_base === undefined) return; // optional field
    const names = new Set(manifest.repos.map(r => r.name));
    assert.ok(
      names.has(manifest.knowledge_base),
      `knowledge_base="${manifest.knowledge_base}" is not in repos[]`,
    );
  });

  it('branchProtection.bypassTeam (if set) has a slug, and id is numeric once cached', () => {
    const bp = manifest.branchProtection?.bypassTeam;
    if (!bp) return; // optional — repo-policy.mjs works without a bypass team
    assert.equal(typeof bp.slug, 'string');
    assert.ok(bp.slug.length > 0, 'bypassTeam.slug must not be empty');
    if ('id' in bp) {
      assert.equal(typeof bp.id, 'number', 'bypassTeam.id should be cached as a number');
    }
  });

  it('repo names are unique', () => {
    const names = manifest.repos.map(r => r.name);
    assert.equal(new Set(names).size, names.length, 'duplicate repo names in repos[]');
  });
});

describe('household.json (per-repo shape)', () => {
  for (const repo of manifest.repos) {
    describe(repo.name || '(unnamed)', () => {
      it('has a valid name', () => {
        assert.equal(typeof repo.name, 'string');
        assert.equal(validateName(repo.name), null, `name "${repo.name}" failed validation`);
      });

      it('url (if set) parses as a GitHub URL whose repo part matches the name', () => {
        if (repo.url === undefined) return; // inline entry
        assert.equal(typeof repo.url, 'string');
        const p = parseRemoteUrl(repo.url);
        assert.ok(p, `url "${repo.url}" did not parse as a GitHub URL`);
        assert.ok(p.endsWith(`/${repo.name}`),
          `url "${repo.url}" must point at <org>/${repo.name}`);
      });

      it('description (if set) is non-empty', () => {
        if (repo.description === undefined) return;
        assert.equal(typeof repo.description, 'string');
        assert.ok(repo.description.trim().length > 0, 'description must not be empty');
      });

      it('tags (if set) is an array of non-empty strings', () => {
        if (repo.tags === undefined) return;
        assert.ok(Array.isArray(repo.tags), 'tags must be an array');
        for (const t of repo.tags) {
          assert.equal(typeof t, 'string', `tag "${t}" should be a string`);
          assert.ok(t.length > 0, 'tags must not be empty strings');
        }
      });

      it('branchProtection (if set) has requiredStatusCheck as string or null', () => {
        if (repo.branchProtection === undefined) return;
        assert.ok(
          'requiredStatusCheck' in repo.branchProtection,
          'branchProtection.requiredStatusCheck must be explicitly set (string or null)',
        );
        const v = repo.branchProtection.requiredStatusCheck;
        assert.ok(
          v === null || (typeof v === 'string' && v.length > 0),
          `requiredStatusCheck must be null or a non-empty string (got ${JSON.stringify(v)})`,
        );
      });
    });
  }
});
