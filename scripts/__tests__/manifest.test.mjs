import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatRepos, parseRemoteUrl, renameRepoInUrl } from '../manifest.mjs';

describe('formatRepos', () => {
  it('round-trips to valid JSON ending in a single newline', () => {
    const m = { meta_repo: 'acme-workspace', repos: [{ name: 'backend', tags: ['core'] }] };
    const out = formatRepos(m);
    assert.equal(out.endsWith('}\n'), true);
    assert.deepEqual(JSON.parse(out), m);
  });

  it('re-inlines short all-string arrays onto one line', () => {
    const m = { repos: [{ name: 'backend', tags: ['core', 'service'] }] };
    const out = formatRepos(m);
    assert.match(out, /"tags": \["core", "service"\]/);
  });

  it('keeps a long string array expanded across lines', () => {
    const long = Array.from({ length: 12 }, (_, i) => `tag-number-${i}`);
    const m = { repos: [{ name: 'backend', tags: long }] };
    const out = formatRepos(m);
    // Too wide to inline under 80 cols — stays multi-line.
    assert.doesNotMatch(out, /"tags": \[".*".*".*"\]/);
    assert.match(out, /"tags": \[\n/);
  });

  it('does not split on commas inside string contents', () => {
    const m = { repos: [{ name: 'x', tags: ['a, b', 'c'] }] };
    const out = formatRepos(m);
    assert.match(out, /\["a, b", "c"\]/);
  });
});

describe('parseRemoteUrl (re-exported from manifest)', () => {
  it('parses both SSH and HTTPS GitHub URLs', () => {
    assert.equal(parseRemoteUrl('git@github.com:Acme-Org/backend.git'), 'Acme-Org/backend');
    assert.equal(parseRemoteUrl('https://github.com/Acme-Org/backend'), 'Acme-Org/backend');
  });
});

describe('renameRepoInUrl', () => {
  it('rewrites an SSH URL with a .git suffix', () => {
    assert.equal(
      renameRepoInUrl('git@github.com:Acme-Org/backend.git', 'backend', 'api'),
      'git@github.com:Acme-Org/api.git',
    );
  });

  it('rewrites an HTTPS URL with a .git suffix', () => {
    assert.equal(
      renameRepoInUrl('https://github.com/Acme-Org/backend.git', 'backend', 'api'),
      'https://github.com/Acme-Org/api.git',
    );
  });

  it('rewrites a URL with no .git suffix (the reviewer regression case)', () => {
    assert.equal(
      renameRepoInUrl('https://github.com/Acme-Org/backend', 'backend', 'api'),
      'https://github.com/Acme-Org/api',
    );
    assert.equal(
      renameRepoInUrl('git@github.com:Acme-Org/backend', 'backend', 'api'),
      'git@github.com:Acme-Org/api',
    );
  });

  it('only touches the trailing segment, not an org that shares the name', () => {
    assert.equal(
      renameRepoInUrl('git@github.com:Some-foo-Org/foo.git', 'foo', 'bar'),
      'git@github.com:Some-foo-Org/bar.git',
    );
  });

  it('does not match when the name is only a prefix of the trailing segment', () => {
    assert.equal(
      renameRepoInUrl('git@github.com:Acme-Org/api-helper.git', 'api', 'gateway'),
      'git@github.com:Acme-Org/api-helper.git',
    );
  });

  it('escapes regex metacharacters in the old name', () => {
    assert.equal(
      renameRepoInUrl('git@github.com:Acme-Org/a.b.git', 'a.b', 'c'),
      'git@github.com:Acme-Org/c.git',
    );
    // A literal-dot name must not match a different char in that position.
    assert.equal(
      renameRepoInUrl('git@github.com:Acme-Org/axb.git', 'a.b', 'c'),
      'git@github.com:Acme-Org/axb.git',
    );
  });

  it('returns url-less values untouched', () => {
    assert.equal(renameRepoInUrl(undefined, 'a', 'b'), undefined);
    assert.equal(renameRepoInUrl('', 'a', 'b'), '');
  });
});
