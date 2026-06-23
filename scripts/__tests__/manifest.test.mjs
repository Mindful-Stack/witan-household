import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatRepos, parseRemoteUrl } from '../manifest.mjs';

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
