import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveOrg,
  buildRuleset,
  diffRulesets,
  diffRepoMeta,
  summarizeState,
  formatRepos,
  formatBypassActor,
  formatBypassActors,
  resolveBypassTeamFromManifest,
  githubTargetFor,
  normalizeTeamPermission,
  PERMISSION_API,
  diffTeamAccess,
  validateTeamAccessShape,
} from './repo-policy.mjs';

// === resolveOrg ===

describe('resolveOrg', () => {
  it('derives the org from the meta_repo entry\'s SSH url', () => {
    const org = resolveOrg({
      meta_repo: 'acme-household',
      repos: [
        { name: 'acme-foo', url: 'git@github.com:somewhere-else/acme-foo.git' },
        { name: 'acme-household', url: 'git@github.com:acme/acme-household.git' },
      ],
    });
    assert.equal(org, 'acme');
  });

  it('derives the org from an HTTPS url too', () => {
    const org = resolveOrg({
      meta_repo: 'acme-household',
      repos: [{ name: 'acme-household', url: 'https://github.com/acme/acme-household.git' }],
    });
    assert.equal(org, 'acme');
  });

  it('throws when no repos entry matches meta_repo', () => {
    assert.throws(
      () => resolveOrg({ meta_repo: 'missing', repos: [{ name: 'other', url: 'git@github.com:acme/other.git' }] }),
      /Cannot resolve GitHub org/,
    );
  });

  it('throws when the meta_repo entry has no url (inline)', () => {
    assert.throws(
      () => resolveOrg({ meta_repo: 'acme-household', repos: [{ name: 'acme-household' }] }),
      /Cannot resolve GitHub org/,
    );
  });

  it('throws when the url is not a github.com url', () => {
    assert.throws(
      () => resolveOrg({
        meta_repo: 'acme-household',
        repos: [{ name: 'acme-household', url: 'git@gitlab.com:acme/acme-household.git' }],
      }),
      /Cannot resolve GitHub org/,
    );
  });

  it('throws when repos is absent entirely', () => {
    assert.throws(() => resolveOrg({}), /Cannot resolve GitHub org/);
  });
});

// === buildRuleset ===

describe('buildRuleset', () => {
  it('produces a ruleset with the three standard rules and a team bypass', () => {
    const r = buildRuleset({ bypassTeamId: 9395036 });
    assert.equal(r.name, 'main protection');
    assert.equal(r.target, 'branch');
    assert.equal(r.enforcement, 'active');
    assert.deepEqual(r.conditions.ref_name, { include: ['~DEFAULT_BRANCH'], exclude: [] });

    const types = r.rules.map(x => x.type).sort();
    assert.deepEqual(types, ['deletion', 'non_fast_forward', 'pull_request']);

    const pr = r.rules.find(x => x.type === 'pull_request').parameters;
    assert.equal(pr.required_approving_review_count, 1);
    assert.equal(pr.required_review_thread_resolution, true);
    assert.deepEqual(pr.allowed_merge_methods, ['squash']);
    assert.equal(pr.require_code_owner_review, false);

    assert.deepEqual(r.bypass_actors, [
      { actor_id: 9395036, actor_type: 'Team', bypass_mode: 'pull_request' },
    ]);
  });

  it('emits empty bypass_actors when no bypass team is configured', () => {
    for (const r of [
      buildRuleset({}),
      buildRuleset({ bypassTeamId: null }),
      buildRuleset({ bypassTeamId: undefined, requiredStatusCheck: 'Build & Test' }),
    ]) {
      assert.deepEqual(r.bypass_actors, [], 'no bypass team → no bypass actors');
    }
  });

  it('appends required_status_checks when requiredStatusCheck is provided', () => {
    const r = buildRuleset({ bypassTeamId: 1, requiredStatusCheck: 'Build & Test' });
    const sc = r.rules.find(x => x.type === 'required_status_checks');
    assert.ok(sc, 'should include status check rule');
    assert.equal(sc.parameters.strict_required_status_checks_policy, true);
    assert.deepEqual(sc.parameters.required_status_checks, [{ context: 'Build & Test' }]);
  });

  it('omits required_status_checks when requiredStatusCheck is null or absent', () => {
    const a = buildRuleset({ bypassTeamId: 1 });
    const b = buildRuleset({ bypassTeamId: 1, requiredStatusCheck: null });
    for (const r of [a, b]) {
      assert.equal(r.rules.find(x => x.type === 'required_status_checks'), undefined);
    }
  });

  it('does not mutate the shared STANDARD_RULES across calls', () => {
    const a = buildRuleset({ bypassTeamId: 1, requiredStatusCheck: 'A' });
    const b = buildRuleset({ bypassTeamId: 2 });
    assert.equal(b.rules.find(x => x.type === 'required_status_checks'), undefined,
      'second call should not inherit status check from first');
  });
});

// === diffRulesets ===

describe('diffRulesets', () => {
  function desired() {
    return buildRuleset({ bypassTeamId: 9395036, requiredStatusCheck: 'Build & Test' });
  }

  it('returns "no existing ruleset" when existing is null', () => {
    const diffs = diffRulesets(null, desired());
    assert.deepEqual(diffs, ['no existing ruleset (will create)']);
  });

  it('returns empty array when existing matches desired exactly', () => {
    const d = desired();
    // Existing typically has additional metadata fields (id, timestamps); we strip
    // those out by matching shape only — diffRulesets ignores them.
    const existing = { ...d, id: 12345, created_at: 'x', updated_at: 'y' };
    assert.deepEqual(diffRulesets(existing, d), []);
  });

  it('flags missing rules', () => {
    const d = desired();
    const existing = { ...d, rules: d.rules.filter(r => r.type !== 'non_fast_forward') };
    const diffs = diffRulesets(existing, d);
    assert.ok(diffs.some(s => s.includes('missing rule: non_fast_forward')), diffs.join(' | '));
  });

  it('flags extra rules', () => {
    const d = desired();
    const existing = {
      ...d,
      rules: [...d.rules, { type: 'creation' }],
    };
    const diffs = diffRulesets(existing, d);
    assert.ok(diffs.some(s => s.includes('extra rule: creation')), diffs.join(' | '));
  });

  it('flags differing pull_request parameters', () => {
    const d = desired();
    const existing = structuredClone(d);
    const epr = existing.rules.find(r => r.type === 'pull_request');
    epr.parameters.required_review_thread_resolution = false;
    epr.parameters.required_approving_review_count = 2;
    const diffs = diffRulesets(existing, d);
    assert.ok(diffs.some(s => s.includes('required_review_thread_resolution')), diffs.join(' | '));
    assert.ok(diffs.some(s => s.includes('required_approving_review_count')), diffs.join(' | '));
  });

  it('flags differing status-check contexts', () => {
    const d = buildRuleset({ bypassTeamId: 1, requiredStatusCheck: 'Build & Test' });
    const existing = buildRuleset({ bypassTeamId: 1, requiredStatusCheck: 'PR Review' });
    const diffs = diffRulesets(existing, d);
    assert.ok(
      diffs.some(s => s.startsWith('status_checks:') && s.includes('PR Review') && s.includes('Build & Test')),
      diffs.join(' | '),
    );
  });

  it('flags differing bypass actors', () => {
    const d = buildRuleset({ bypassTeamId: 1 });
    const existing = buildRuleset({ bypassTeamId: 999 });
    const diffs = diffRulesets(existing, d);
    assert.ok(diffs.some(s => s.startsWith('bypass_actors:')), diffs.join(' | '));
  });

  it('flags an existing bypass team when no bypass team is desired', () => {
    const d = buildRuleset({ bypassTeamId: null });
    const existing = buildRuleset({ bypassTeamId: 999 });
    const diffs = diffRulesets(existing, d);
    assert.ok(diffs.some(s => s.startsWith('bypass_actors:')), diffs.join(' | '));
  });

  it('treats matching empty bypass_actors as no drift', () => {
    const d = buildRuleset({ bypassTeamId: null });
    const existing = structuredClone(d);
    assert.deepEqual(diffRulesets(existing, d), []);
  });

  it('treats bypass_actors as order-insensitive', () => {
    const d = buildRuleset({ bypassTeamId: 1 });
    d.bypass_actors = [
      { actor_id: 1, actor_type: 'Team', bypass_mode: 'pull_request' },
      { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
    ];
    const existing = structuredClone(d);
    existing.bypass_actors = [
      { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
      { actor_id: 1, actor_type: 'Team', bypass_mode: 'pull_request' },
    ];
    assert.deepEqual(diffRulesets(existing, d), [], 'reordered bypass actors should not count as drift');
  });

  it('treats existing rules with extra fields (id, parameters) as equivalent if relevant params match', () => {
    const d = desired();
    // Simulate the existing ruleset having additional parameters GitHub adds back,
    // which buildRuleset doesn't emit. We only compare the keys we set.
    const existing = structuredClone(d);
    const epr = existing.rules.find(r => r.type === 'pull_request');
    epr.parameters.automatic_copilot_code_review_enabled = false; // not in desired
    const diffs = diffRulesets(existing, d);
    assert.deepEqual(diffs, [], 'unknown extra params should not be flagged');
  });
});

// === summarizeState ===

describe('summarizeState', () => {
  it('reports "none" when there are no rulesets and no classic protection', () => {
    const s = summarizeState([], null);
    assert.equal(s.state, 'none');
    assert.equal(s.statusCheck, null);
  });

  it('reports "classic" for classic-only protection', () => {
    const s = summarizeState([], { required_status_checks: { contexts: [] } });
    assert.equal(s.state, 'classic');
  });

  it('reports "ruleset" for one ruleset, no classic', () => {
    const s = summarizeState([{ rules: [], bypass_actors: [] }], null);
    assert.equal(s.state, 'ruleset');
  });

  it('reports "multiple-rulesets" when there are 2+ rulesets', () => {
    const s = summarizeState([{ rules: [] }, { rules: [] }], null);
    assert.equal(s.state, 'multiple-rulesets');
  });

  it('reports "ruleset+classic" for one ruleset plus classic', () => {
    const s = summarizeState([{ rules: [] }], { required_status_checks: { contexts: [] } });
    assert.equal(s.state, 'ruleset+classic');
  });

  it('reports "multiple-rulesets+classic" when there are 2+ rulesets plus classic', () => {
    const s = summarizeState(
      [{ rules: [] }, { rules: [] }],
      { required_status_checks: { contexts: [] } },
    );
    assert.equal(s.state, 'multiple-rulesets+classic');
  });

  it('extracts the status-check context from a ruleset', () => {
    const ruleset = {
      rules: [
        { type: 'deletion' },
        {
          type: 'required_status_checks',
          parameters: {
            required_status_checks: [{ context: 'Build & Test', integration_id: 15368 }],
          },
        },
      ],
    };
    const s = summarizeState([ruleset], null);
    assert.equal(s.statusCheck, 'Build & Test');
  });

  it('extracts the status-check context from classic protection if no ruleset has one', () => {
    const classic = { required_status_checks: { contexts: ['Legacy Build'] } };
    const s = summarizeState([{ rules: [{ type: 'deletion' }] }], classic);
    assert.equal(s.statusCheck, 'Legacy Build');
  });

  it('extracts review count, squash-only, threads, and code-owner from the primary ruleset', () => {
    const ruleset = {
      name: 'main protection',
      rules: [
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 2,
            allowed_merge_methods: ['squash'],
            required_review_thread_resolution: true,
            require_code_owner_review: true,
          },
        },
      ],
      bypass_actors: [{ actor_id: 9395036, actor_type: 'Team', bypass_mode: 'pull_request' }],
    };
    const s = summarizeState([ruleset], null);
    assert.equal(s.requiredReviews, 2);
    assert.equal(s.squashOnly, true);
    assert.equal(s.threadResolution, true);
    assert.equal(s.codeOwnerReview, true);
    assert.deepEqual(s.bypassActors, [{ actor_id: 9395036, actor_type: 'Team', bypass_mode: 'pull_request' }]);
  });

  it('reports squashOnly=false when other merge methods are also allowed', () => {
    const ruleset = {
      name: 'main protection',
      rules: [{ type: 'pull_request', parameters: { allowed_merge_methods: ['squash', 'merge'] } }],
    };
    assert.equal(summarizeState([ruleset], null).squashOnly, false);
  });

  it('reports squashOnly=null when the pull_request rule omits allowed_merge_methods', () => {
    const ruleset = {
      name: 'main protection',
      rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }],
    };
    assert.equal(summarizeState([ruleset], null).squashOnly, null);
  });

  it('reports squashOnly=false when allowed_merge_methods is an empty array', () => {
    const ruleset = {
      name: 'main protection',
      rules: [{ type: 'pull_request', parameters: { allowed_merge_methods: [] } }],
    };
    assert.equal(summarizeState([ruleset], null).squashOnly, false);
  });

  it('prefers the RULESET_NAME-matching ruleset over other actives when extracting details', () => {
    const other = {
      name: 'something else',
      rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 99 } }],
    };
    const primary = {
      name: 'main protection',
      rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }],
    };
    const s = summarizeState([other, primary], null);
    assert.equal(s.requiredReviews, 1, 'should pick the name-matching ruleset');
  });

  it('falls back to classic protection for review count and threads when no ruleset', () => {
    const classic = {
      required_pull_request_reviews: {
        required_approving_review_count: 1,
        require_code_owner_reviews: false,
      },
      required_conversation_resolution: { enabled: true },
    };
    const s = summarizeState([], classic);
    assert.equal(s.requiredReviews, 1);
    assert.equal(s.threadResolution, true);
    assert.equal(s.codeOwnerReview, false);
    assert.equal(s.squashOnly, null, 'classic protection does not constrain merge methods');
  });

  it('returns null for detail fields when there are no rulesets and no classic protection', () => {
    const s = summarizeState([], null);
    assert.equal(s.requiredReviews, null);
    assert.equal(s.squashOnly, null);
    assert.equal(s.threadResolution, null);
    assert.equal(s.codeOwnerReview, null);
    assert.deepEqual(s.bypassActors, []);
    assert.equal(s.deleteBranchOnMerge, null, 'absent repoMeta means null, not false');
  });

  it('reads deleteBranchOnMerge from the repo object when provided', () => {
    const s = summarizeState([], null, { delete_branch_on_merge: true });
    assert.equal(s.deleteBranchOnMerge, true);
  });

  it('reads deleteBranchOnMerge=false correctly (not coerced to null)', () => {
    const s = summarizeState([], null, { delete_branch_on_merge: false });
    assert.equal(s.deleteBranchOnMerge, false);
  });
});

// === diffRepoMeta ===

describe('diffRepoMeta', () => {
  it('returns empty when delete_branch_on_merge is already true', () => {
    assert.deepEqual(diffRepoMeta({ delete_branch_on_merge: true }), []);
  });

  it('flags drift when delete_branch_on_merge is false', () => {
    const diffs = diffRepoMeta({ delete_branch_on_merge: false });
    assert.equal(diffs.length, 1);
    assert.match(diffs[0], /delete_branch_on_merge: false → true/);
  });

  it('flags drift when delete_branch_on_merge is missing/undefined', () => {
    const diffs = diffRepoMeta({});
    assert.equal(diffs.length, 1);
    assert.match(diffs[0], /delete_branch_on_merge: undefined → true/);
  });

  it('returns empty when current is null (no repo meta available)', () => {
    assert.deepEqual(diffRepoMeta(null), []);
  });
});

// === formatBypassActor / formatBypassActors ===

describe('formatBypassActor', () => {
  const teams = new Map([[9395036, 'my-team'], [11901855, 'other-team']]);

  it('renders a known team in PR mode as just the slug', () => {
    const out = formatBypassActor({ actor_id: 9395036, actor_type: 'Team', bypass_mode: 'pull_request' }, teams);
    assert.equal(out, 'my-team');
  });

  it('renders the Admin RepositoryRole as "admin"', () => {
    const out = formatBypassActor({ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }, teams);
    assert.equal(out, 'admin (always)');
  });

  it('appends mode for non-PR bypass modes', () => {
    const out = formatBypassActor({ actor_id: 9395036, actor_type: 'Team', bypass_mode: 'always' }, teams);
    assert.equal(out, 'my-team (always)');
  });

  it('falls back to actor_type:id when team id is unknown', () => {
    const out = formatBypassActor({ actor_id: 999, actor_type: 'Team', bypass_mode: 'pull_request' }, teams);
    assert.equal(out, 'team:999');
  });

  it('falls back to actor_type:id for unknown types', () => {
    const out = formatBypassActor({ actor_id: 42, actor_type: 'Integration', bypass_mode: 'pull_request' }, teams);
    assert.equal(out, 'Integration:42');
  });

  it('renders OrganizationAdmin as "org-admin" (actor_id is null in this type)', () => {
    const out = formatBypassActor({ actor_id: null, actor_type: 'OrganizationAdmin', bypass_mode: 'always' }, teams);
    assert.equal(out, 'org-admin (always)');
  });
});

describe('formatBypassActors', () => {
  const teams = new Map([[9395036, 'my-team']]);

  it('renders an empty list as "—"', () => {
    assert.equal(formatBypassActors([], teams), '—');
    assert.equal(formatBypassActors(null, teams), '—');
    assert.equal(formatBypassActors(undefined, teams), '—');
  });

  it('comma-separates multiple actors', () => {
    const out = formatBypassActors(
      [
        { actor_id: 9395036, actor_type: 'Team', bypass_mode: 'pull_request' },
        { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
      ],
      teams,
    );
    assert.equal(out, 'my-team, admin (always)');
  });
});

// === formatRepos ===

describe('formatRepos', () => {
  it('keeps short string arrays inline (matches hand-authored style)', () => {
    const out = formatRepos({
      repos: [{ name: 'foo', tags: ['a', 'b', 'c'] }],
    });
    assert.match(out, /"tags": \["a", "b", "c"\]/);
  });

  it('does not inline non-string arrays', () => {
    const out = formatRepos({
      repos: [{ name: 'foo', nested: [{ k: 'v' }] }],
    });
    // Objects in arrays stay on their own lines
    assert.ok(out.includes('"nested": [\n'));
  });

  it('falls back to multi-line for arrays that would exceed 80 chars inline', () => {
    const long = 'x'.repeat(40);
    const out = formatRepos({
      repos: [{ name: 'foo', tags: [long, long] }],
    });
    // Should NOT be inlined since collapsed form > 80 chars
    assert.ok(out.includes(`"${long}",\n`));
  });

  it('ends with a trailing newline', () => {
    assert.ok(formatRepos({}).endsWith('\n'));
  });

  it('preserves commas inside string values', () => {
    const out = formatRepos({ repos: [{ tags: ['a,b', 'c,d', 'e'] }] });
    assert.match(out, /"tags": \["a,b", "c,d", "e"\]/);
  });

  it('preserves escaped quotes inside string values', () => {
    const out = formatRepos({ repos: [{ tags: ['has "quote"', 'plain'] }] });
    assert.match(out, /"tags": \["has \\"quote\\"", "plain"\]/);
  });
});

// === githubTargetFor ===

describe('githubTargetFor', () => {
  it('parses an SSH url with .git', () => {
    const t = githubTargetFor({ url: 'git@github.com:Grantigo/File-Extract-API.git' });
    assert.deepEqual(t, { org: 'Grantigo', repo: 'File-Extract-API' });
  });

  it('parses an SSH url without .git', () => {
    const t = githubTargetFor({ url: 'git@github.com:acme/my-repo' });
    assert.deepEqual(t, { org: 'acme', repo: 'my-repo' });
  });

  it('parses an HTTPS url with .git', () => {
    const t = githubTargetFor({ url: 'https://github.com/acme/my-repo.git' });
    assert.deepEqual(t, { org: 'acme', repo: 'my-repo' });
  });

  it('parses an HTTPS url without .git', () => {
    const t = githubTargetFor({ url: 'https://github.com/acme/my-repo' });
    assert.deepEqual(t, { org: 'acme', repo: 'my-repo' });
  });

  it('handles a repo name that differs from the manifest name (File-Extract-API)', () => {
    const t = githubTargetFor({ name: 'file-extractor', url: 'git@github.com:Grantigo/File-Extract-API.git' });
    assert.deepEqual(t, { org: 'Grantigo', repo: 'File-Extract-API' });
  });

  it('returns null when there is no url', () => {
    assert.equal(githubTargetFor({ name: 'inline-dir' }), null);
    assert.equal(githubTargetFor({}), null);
    assert.equal(githubTargetFor(null), null);
  });

  it('returns null for a non-GitHub url (GitLab, Bitbucket, etc.)', () => {
    assert.equal(githubTargetFor({ url: 'git@gitlab.com:acme/my-repo.git' }), null);
    assert.equal(githubTargetFor({ url: 'https://bitbucket.org/acme/my-repo.git' }), null);
  });
});

// === resolveBypassTeamFromManifest ===

describe('resolveBypassTeamFromManifest', () => {
  it('returns id + slug as cached when both are present', () => {
    const r = resolveBypassTeamFromManifest({
      branchProtection: { bypassTeam: { slug: 'my-team', id: 42 } },
      repos: [],
    });
    assert.deepEqual(r, { id: 42, slug: 'my-team', cached: true });
  });

  it('returns id=null cached=false when only slug is present', () => {
    const r = resolveBypassTeamFromManifest({
      branchProtection: { bypassTeam: { slug: 'my-team' } },
      repos: [],
    });
    assert.deepEqual(r, { id: null, slug: 'my-team', cached: false });
  });

  it('returns null when no bypass team is configured (the block is optional)', () => {
    assert.equal(resolveBypassTeamFromManifest({ repos: [] }), null);
    assert.equal(resolveBypassTeamFromManifest({ branchProtection: {}, repos: [] }), null);
    assert.equal(resolveBypassTeamFromManifest({ branchProtection: { bypassTeam: {} }, repos: [] }), null);
  });
});

// === normalizeTeamPermission ===

describe('normalizeTeamPermission', () => {
  it('reads the highest-privilege true from the permissions object', () => {
    const p = (o) => normalizeTeamPermission({ permissions: o });
    assert.equal(p({ pull: true, triage: true, push: true, maintain: true, admin: true }), 'admin');
    assert.equal(p({ pull: true, triage: true, push: true, maintain: true, admin: false }), 'maintain');
    assert.equal(p({ pull: true, triage: true, push: true, maintain: false, admin: false }), 'write');
    assert.equal(p({ pull: true, triage: true, push: false, maintain: false, admin: false }), 'triage');
    assert.equal(p({ pull: true, triage: false, push: false, maintain: false, admin: false }), 'read');
  });

  it('falls back to the legacy permission string when no permissions object', () => {
    assert.equal(normalizeTeamPermission({ permission: 'push' }), 'write');
    assert.equal(normalizeTeamPermission({ permission: 'pull' }), 'read');
    assert.equal(normalizeTeamPermission({ permission: 'admin' }), 'admin');
    assert.equal(normalizeTeamPermission({ permission: 'maintain' }), 'maintain');
    assert.equal(normalizeTeamPermission({ permission: 'triage' }), 'triage');
  });

  it('defaults to read for an unrecognisable/empty entry', () => {
    assert.equal(normalizeTeamPermission({}), 'read');
    assert.equal(normalizeTeamPermission({ permission: 'weird' }), 'read');
  });
});

describe('PERMISSION_API', () => {
  it('maps our vocabulary to GitHub API permission values', () => {
    assert.deepEqual(PERMISSION_API, {
      read: 'pull', triage: 'triage', write: 'push', maintain: 'maintain', admin: 'admin',
    });
  });
});

// === diffTeamAccess ===

describe('diffTeamAccess', () => {
  it('reports a grant for a declared team absent on GitHub', () => {
    assert.deepEqual(diffTeamAccess({ devs: 'write' }, {}), {
      grants: [{ team: 'devs', level: 'write' }], changes: [], revokes: [],
    });
  });
  it('reports a change when the level differs', () => {
    assert.deepEqual(diffTeamAccess({ sec: 'maintain' }, { sec: 'read' }), {
      grants: [], changes: [{ team: 'sec', from: 'read', to: 'maintain' }], revokes: [],
    });
  });
  it('reports a revoke (with its actual level) for an undeclared team', () => {
    assert.deepEqual(diffTeamAccess({}, { qa: 'read' }), {
      grants: [], changes: [], revokes: [{ team: 'qa', level: 'read' }],
    });
  });
  it('is empty when declared and actual match exactly', () => {
    assert.deepEqual(diffTeamAccess({ a: 'write', b: 'read' }, { a: 'write', b: 'read' }), {
      grants: [], changes: [], revokes: [],
    });
  });
  it('handles a mix of grant, change, and revoke', () => {
    const d = diffTeamAccess({ a: 'write', b: 'admin' }, { b: 'read', c: 'triage' });
    assert.deepEqual(d.grants, [{ team: 'a', level: 'write' }]);
    assert.deepEqual(d.changes, [{ team: 'b', from: 'read', to: 'admin' }]);
    assert.deepEqual(d.revokes, [{ team: 'c', level: 'triage' }]);
  });
  it('empty declared + empty actual = no changes', () => {
    assert.deepEqual(diffTeamAccess({}, {}), { grants: [], changes: [], revokes: [] });
  });
});

// === validateTeamAccessShape ===

describe('validateTeamAccessShape', () => {
  it('accepts an empty object and a valid map', () => {
    assert.deepEqual(validateTeamAccessShape({}), []);
    assert.deepEqual(validateTeamAccessShape({ devs: 'write', sec: 'read' }), []);
  });
  it('rejects null, arrays, and non-object scalars', () => {
    assert.equal(validateTeamAccessShape(null).length, 1);
    assert.equal(validateTeamAccessShape([]).length, 1);
    assert.equal(validateTeamAccessShape('write').length, 1);
    assert.equal(validateTeamAccessShape(5).length, 1);
  });
  it('rejects unknown permission levels and non-string values', () => {
    assert.equal(validateTeamAccessShape({ a: 'owner' }).length, 1);
    assert.equal(validateTeamAccessShape({ a: 5 }).length, 1);
    assert.match(validateTeamAccessShape({ a: 'owner' })[0], /invalid permission/);
  });
  it('collects one error per bad entry', () => {
    const errs = validateTeamAccessShape({ ok: 'write', bad1: 'x', bad2: 'y' });
    assert.equal(errs.length, 2);
  });
});
