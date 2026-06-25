import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateName, validateSegment, resolveOrg, buildRepoEntry, parseFlags, defaultMode, resolveModeFromFlags } from './new-repo.mjs';

describe('validateName', () => {
  it('accepts any lowercase prefix with a hyphen', () => {
    assert.equal(validateName('acme-foo'), null);
    assert.equal(validateName('multi-word-foo'), null);
    assert.equal(validateName('data-knowledge-base'), null);
    assert.equal(validateName('rnb-tracker'), null);
  });

  it('accepts single-word names', () => {
    assert.equal(validateName('lore'), null);
    assert.equal(validateName('backend'), null);
    assert.equal(validateName('foo'), null);
  });

  it('accepts digits', () => {
    assert.equal(validateName('acme-foo2'), null);
    assert.equal(validateName('acme-v2-api'), null);
    assert.equal(validateName('team42-svc'), null);
  });

  it('rejects missing or empty name', () => {
    assert.match(validateName(''), /required/);
    assert.match(validateName(undefined), /required/);
  });

  it('rejects uppercase characters', () => {
    assert.match(validateName('acme-Foo'), /lowercase/);
    assert.match(validateName('ACME-foo'), /lowercase/);
  });

  it('rejects underscores and other punctuation', () => {
    assert.match(validateName('acme_foo'), /lowercase/);
    assert.match(validateName('acme-foo.bar'), /lowercase/);
  });

  it('rejects leading, trailing, and doubled hyphens', () => {
    assert.match(validateName('-acme-foo'), /lowercase/);
    assert.match(validateName('acme-foo-'), /lowercase/);
    assert.match(validateName('acme--foo'), /lowercase/);
  });
});

describe('validateSegment', () => {
  it('accepts single-word segments', () => {
    assert.equal(validateSegment('acme', 'name prefix'), null);
    assert.equal(validateSegment('data', 'name prefix'), null);
    assert.equal(validateSegment('foo', 'repo suffix'), null);
  });

  it('accepts multi-word segments with internal hyphens', () => {
    assert.equal(validateSegment('multi-word', 'name prefix'), null);
    assert.equal(validateSegment('knowledge-base', 'repo suffix'), null);
  });

  it('rejects empty input with the label', () => {
    assert.match(validateSegment('', 'name prefix'), /name prefix is required/);
    assert.match(validateSegment(undefined, 'repo suffix'), /repo suffix is required/);
  });

  it('rejects uppercase and bad characters', () => {
    assert.match(validateSegment('ACME', 'name prefix'), /lowercase/);
    assert.match(validateSegment('foo_bar', 'repo suffix'), /lowercase/);
  });

  it('rejects leading hyphen', () => {
    assert.match(validateSegment('-foo', 'name prefix'), /lowercase/);
  });
});

describe('resolveOrg', () => {
  it('resolves the org from the meta_repo entry url (ssh form)', () => {
    const manifest = {
      meta_repo: 'my-workspace',
      repos: [
        { name: 'my-workspace', url: 'git@github.com:acme-org/my-workspace.git' },
        { name: 'lore' },
      ],
    };
    assert.equal(resolveOrg(manifest), 'acme-org');
  });

  it('resolves the org from an https url', () => {
    const manifest = {
      meta_repo: 'my-workspace',
      repos: [{ name: 'my-workspace', url: 'https://github.com/acme-org/my-workspace.git' }],
    };
    assert.equal(resolveOrg(manifest), 'acme-org');
  });

  it('throws when the meta_repo entry has no url', () => {
    const manifest = { meta_repo: 'lore', repos: [{ name: 'lore' }] };
    assert.throws(() => resolveOrg(manifest), /Cannot resolve GitHub org/);
  });

  it('throws when no entry matches meta_repo', () => {
    const manifest = {
      meta_repo: 'missing',
      repos: [{ name: 'other', url: 'git@github.com:acme-org/other.git' }],
    };
    assert.throws(() => resolveOrg(manifest), /Cannot resolve GitHub org/);
  });

  it('throws when repos is missing entirely', () => {
    assert.throws(() => resolveOrg({ meta_repo: 'x' }), /Cannot resolve GitHub org/);
  });
});

describe('buildRepoEntry', () => {
  it('builds an entry with the correct shape', () => {
    const entry = buildRepoEntry({
      name: 'acme-foo',
      description: 'Test service',
      tags: ['backend', 'service'],
    }, 'acme-org');
    assert.deepEqual(entry, {
      name: 'acme-foo',
      url: 'git@github.com:acme-org/acme-foo.git',
      description: 'Test service',
      tags: ['backend', 'service'],
    });
  });

  it('defaults tags to empty array', () => {
    const entry = buildRepoEntry({ name: 'acme-foo', description: 'T' }, 'acme-org');
    assert.deepEqual(entry.tags, []);
  });

  it('threads the org into the url', () => {
    const entry = buildRepoEntry({ name: 'lore', description: 'T' }, 'other-org');
    assert.equal(entry.url, 'git@github.com:other-org/lore.git');
  });
});

describe('defaultMode', () => {
  it('returns "new" when cwd is the household root', () => {
    assert.equal(defaultMode('/home/x/household', '/home/x/household'), 'new');
  });

  it('returns "here" when cwd is somewhere else', () => {
    assert.equal(defaultMode('/home/x/household/some-repo', '/home/x/household'), 'here');
    assert.equal(defaultMode('/tmp/foo', '/home/x/household'), 'here');
  });

  it('normalises paths before comparing', () => {
    assert.equal(defaultMode('/home/x/household/.', '/home/x/household'), 'new');
    assert.equal(defaultMode('/home/x/household/sub/..', '/home/x/household'), 'new');
  });
});

describe('resolveModeFromFlags', () => {
  it('returns "here" when only --here is set', () => {
    assert.equal(resolveModeFromFlags({ here: true }), 'here');
  });

  it('returns "new" when only --new is set', () => {
    assert.equal(resolveModeFromFlags({ new: true }), 'new');
  });

  it('returns null when neither flag is set', () => {
    assert.equal(resolveModeFromFlags({}), null);
    assert.equal(resolveModeFromFlags({ name: 'acme-foo' }), null);
  });

  it('throws when both --here and --new are set', () => {
    assert.throws(
      () => resolveModeFromFlags({ here: true, new: true }),
      /mutually exclusive/,
    );
  });
});

describe('parseFlags', () => {
  it('parses --key=value', () => {
    assert.deepEqual(parseFlags(['--name=acme-foo']), { name: 'acme-foo' });
  });

  it('parses --flag without a value as boolean true', () => {
    assert.deepEqual(parseFlags(['--yes']), { yes: true });
  });

  it('parses multiple flags', () => {
    assert.deepEqual(
      parseFlags(['--name=acme-foo', '--description=Test', '--tags=a,b']),
      { name: 'acme-foo', description: 'Test', tags: 'a,b' },
    );
  });

  it('preserves = inside values', () => {
    assert.deepEqual(parseFlags(['--description=a=b=c']), { description: 'a=b=c' });
  });

  it('treats --key= (empty value) as an empty string', () => {
    assert.deepEqual(parseFlags(['--tags=']), { tags: '' });
  });

  it('ignores non-flag arguments', () => {
    assert.deepEqual(parseFlags(['positional', '--name=acme-foo']), { name: 'acme-foo' });
  });
});
