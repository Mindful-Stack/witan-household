import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  validateName, validateSegment, resolveOrg, buildRepoEntry, parseFlags, defaultMode,
  resolveModeFromFlags, resolveMode, normalizeOpts, missingInputs, parseTags,
  defaultTeamAccess, addRepoToManifest, manifestPrPlan, buildPrBody,
} from './new-repo.mjs';

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
      branchProtection: { requiredStatusCheck: null },
    });
  });

  it('carries the given teamAccess default so the repo is managed from day one', () => {
    const entry = buildRepoEntry(
      { name: 'acme-foo', description: 'T' }, 'acme-org', { teamAccess: { core: 'maintain' } });
    assert.deepEqual(entry.teamAccess, { core: 'maintain' });
  });

  it('omits teamAccess (unmanaged) when there is no default', () => {
    const entry = buildRepoEntry({ name: 'acme-foo', description: 'T' }, 'acme-org', { teamAccess: null });
    assert.equal('teamAccess' in entry, false);
  });

  it('always declares branch protection with no required status check (a new repo has no CI)', () => {
    const entry = buildRepoEntry({ name: 'acme-foo', description: 'T' }, 'acme-org');
    assert.deepEqual(entry.branchProtection, { requiredStatusCheck: null });
  });

  it('does not share the teamAccess object with the caller', () => {
    const teamAccess = { core: 'maintain' };
    const entry = buildRepoEntry({ name: 'acme-foo', description: 'T' }, 'acme-org', { teamAccess });
    entry.teamAccess.other = 'read';
    assert.deepEqual(teamAccess, { core: 'maintain' });
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

describe('resolveMode', () => {
  const root = '/home/x/household';

  it('scaffolds a new subdirectory when run from the household root, without asking', () => {
    assert.equal(resolveMode({}, root, root), 'new');
  });

  it('publishes the current checkout when run from anywhere else', () => {
    assert.equal(resolveMode({}, `${root}/some-repo`, root), 'here');
  });

  it('lets --here override the household-root default', () => {
    assert.equal(resolveMode({ here: true }, root, root), 'here');
  });

  it('lets --new override the inside-a-checkout default', () => {
    assert.equal(resolveMode({ new: true }, `${root}/some-repo`, root), 'new');
  });

  it('rejects --here together with --new', () => {
    assert.throws(() => resolveMode({ here: true, new: true }, root, root), /mutually exclusive/);
  });
});

describe('normalizeOpts', () => {
  it('treats an empty name or description as missing', () => {
    assert.deepEqual(normalizeOpts({ name: '', description: '' }), {});
  });

  it('keeps an explicitly empty --tags= as "no tags" rather than "ask"', () => {
    // `make repos-create NAME=… DESCRIPTION=…` forwards --tags=, empty when TAGS is unset.
    assert.deepEqual(normalizeOpts({ name: 'a', description: 'd', tags: '' }), { name: 'a', description: 'd', tags: '' });
  });

  it('does not mutate its input', () => {
    const opts = { name: '' };
    normalizeOpts(opts);
    assert.deepEqual(opts, { name: '' });
  });
});

describe('missingInputs', () => {
  it('needs nothing for the scripted make call (name, description, empty tags)', () => {
    const opts = normalizeOpts(parseFlags(['--name=acme-foo', '--description=Svc', '--tags=']));
    assert.deepEqual(missingInputs(opts), []);
  });

  it('asks for tags only when --tags is absent altogether', () => {
    assert.deepEqual(missingInputs({ name: 'a', description: 'd' }), ['tags']);
  });

  it('asks for a missing description', () => {
    assert.deepEqual(missingInputs({ name: 'a', tags: '' }), ['description']);
  });

  it('never asks where the repo should live', () => {
    assert.deepEqual(missingInputs({ name: 'a' }), ['description', 'tags']);
  });
});

describe('parseTags', () => {
  it('splits, trims, and drops empties', () => {
    assert.deepEqual(parseTags('a, b,,c '), ['a', 'b', 'c']);
  });

  it('returns [] for empty or absent input', () => {
    assert.deepEqual(parseTags(''), []);
    assert.deepEqual(parseTags(undefined), []);
  });
});

describe('defaultTeamAccess', () => {
  it('returns the grants every managed repo shares at the same level', () => {
    const manifest = { repos: [
      { name: 'a', teamAccess: { core: 'maintain', docs: 'write' } },
      { name: 'b', teamAccess: { core: 'maintain' } },
      { name: 'c', teamAccess: { core: 'maintain', ops: 'read' } },
    ] };
    assert.deepEqual(defaultTeamAccess(manifest), { core: 'maintain' });
  });

  it('drops a team whose level differs between repos', () => {
    const manifest = { repos: [
      { name: 'a', teamAccess: { core: 'maintain', ops: 'read' } },
      { name: 'b', teamAccess: { core: 'maintain', ops: 'maintain' } },
    ] };
    assert.deepEqual(defaultTeamAccess(manifest), { core: 'maintain' });
  });

  it('ignores unmanaged repos (no teamAccess key) and inline directories', () => {
    const manifest = { repos: [
      { name: 'kb' },
      { name: 'a', url: 'x', teamAccess: { core: 'maintain' } },
    ] };
    assert.deepEqual(defaultTeamAccess(manifest), { core: 'maintain' });
  });

  it('returns null when no repo declares teamAccess, so the new entry stays unmanaged', () => {
    assert.equal(defaultTeamAccess({ repos: [{ name: 'a' }] }), null);
    assert.equal(defaultTeamAccess({}), null);
  });

  it('returns null rather than {} when the managed repos share nothing', () => {
    // {} would mean "no teams" and access-apply would revoke everything.
    const manifest = { repos: [
      { name: 'a', teamAccess: { core: 'maintain' } },
      { name: 'b', teamAccess: { other: 'write' } },
    ] };
    assert.equal(defaultTeamAccess(manifest), null);
  });
});

describe('addRepoToManifest', () => {
  const manifest = { meta_repo: 'ws', repos: [{ name: 'ws', url: 'git@github.com:o/ws.git' }] };
  const entry = { name: 'svc', url: 'git@github.com:o/svc.git' };

  it('appends the entry without mutating the input', () => {
    const updated = addRepoToManifest(manifest, entry);
    assert.deepEqual(updated.repos.map(r => r.name), ['ws', 'svc']);
    assert.equal(manifest.repos.length, 1);
    assert.equal(updated.meta_repo, 'ws');
  });

  it('refuses a name already in the manifest', () => {
    assert.throws(() => addRepoToManifest(manifest, { name: 'ws', url: 'git@github.com:o/other.git' }),
      /already has an entry named "ws"/);
  });

  it('refuses a url another entry already points at', () => {
    assert.throws(() => addRepoToManifest(manifest, { name: 'ws2', url: 'git@github.com:o/ws.git' }),
      /already points at/);
  });
});

describe('manifestPrPlan', () => {
  it('names the branch, commit, and PR after the new repo', () => {
    assert.deepEqual(manifestPrPlan('acme-foo'), {
      branch: 'chore/repos-create-acme-foo',
      commitMsg: 'chore(manifest): register acme-foo',
      prTitle: 'chore(manifest): register acme-foo',
    });
  });
});

describe('buildPrBody', () => {
  const entry = {
    name: 'acme-foo',
    url: 'git@github.com:acme-org/acme-foo.git',
    description: 'Test service',
    tags: ['backend'],
    teamAccess: { core: 'maintain' },
    branchProtection: { requiredStatusCheck: null },
  };
  const body = buildPrBody({ entry, org: 'acme-org', policy: { protection: 'applied', access: 'failed' } });

  it('explains what the new repo is and where it lives', () => {
    assert.match(body, /`acme-foo`/);
    assert.match(body, /Test service/);
    assert.match(body, /https:\/\/github\.com\/acme-org\/acme-foo/);
    assert.match(body, /backend/);
  });

  it('states the defaulted team access and branch protection', () => {
    assert.match(body, /core.*maintain/);
    assert.match(body, /required status check/i);
  });

  it('reports which policy steps applied and how to retry a failed one', () => {
    assert.match(body, /policy-apply REPO=acme-foo/);
    assert.match(body, /access-apply REPO=acme-foo/);
    assert.match(body, /failed/i);
  });

  it('says when the entry is unmanaged for team access', () => {
    const { teamAccess, ...unmanaged } = entry;
    const b = buildPrBody({ entry: unmanaged, org: 'acme-org', policy: { protection: 'applied', access: 'skipped' } });
    assert.match(b, /no `teamAccess`/);
  });
});

describe('make repos-create', () => {
  // `make -n` prints the recipe without running it.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const recipe = (...vars) =>
    execFileSync('make', ['-s', '-n', '-C', root, 'repos-create', ...vars], { encoding: 'utf8' });

  it('forwards an explicit empty --tags= once NAME is given, so the call never prompts for tags', () => {
    const out = recipe('NAME=svc', 'DESCRIPTION=d');
    assert.match(out, /--name="svc" --description="d" --tags=""/);
  });

  it('forwards TAGS when set', () => {
    assert.match(recipe('NAME=svc', 'DESCRIPTION=d', 'TAGS=a,b'), /--tags="a,b"/);
  });

  it('omits --tags with no vars, so the interactive mode still asks for them', () => {
    assert.doesNotMatch(recipe(), /--tags/);
  });
});
