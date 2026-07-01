#!/usr/bin/env node
// Apply and audit standardized repo policy across the household's repos.
// Covers branch-protection rulesets today; designed to grow to other
// per-repo settings (auto-delete-on-merge, allowed merge methods, etc.).
//
// Usage:
//   ./scripts/repo-policy.mjs audit [--write]
//   ./scripts/repo-policy.mjs apply <repo> [--dry-run] [--yes]
//   ./scripts/repo-policy.mjs help
//
// Wraps `gh api` for all GitHub calls (no token management here).
//
// === Workflow ================================================================
//
// household.json is the source of truth for desired branch-protection state.
// Each repo entry's `branchProtection` block is what `apply` enforces; the
// optional top-level `branchProtection.bypassTeam` block caches the team config
// so `apply` doesn't hit GitHub for the team id every run.
//
// The GitHub org is derived from the meta_repo entry's url — no org is
// hardcoded here. Manifest entries without a `url` are inline directories
// (no GitHub repo) and are skipped.
//
// Typical flows:
//
//   1. Bootstrap (one-time): `audit --write` walks every repo on GitHub, fills
//      in each entry's `branchProtection` from the current ruleset, and (when a
//      bypass team slug is configured) caches the bypass team id. Commit the
//      resulting household.json. From here on, household.json is the canonical
//      desired state.
//
//   2. Routine drift check: `audit` (no --write) prints a markdown table of
//      every repo's current state. Read-only, safe to run anytime.
//
//   3. Make a change: hand-edit a repo's `branchProtection` block in
//      household.json, then `apply <repo> --dry-run` to preview, `apply <repo>`
//      (or `--yes` for non-interactive) to commit.
//
//   4. Re-baseline: if GitHub has drifted from household.json and you want to
//      adopt the GitHub state, `audit --write` re-syncs. Note this overwrites
//      any unapplied manual edits to household.json — don't run it between editing
//      and applying.

import { readFile, writeFile, rename as fsRename, unlink } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline/promises';
import path from 'node:path';
import { parseRemoteUrl } from './repos-sync-names.mjs';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOUSEHOLD_JSON = path.join(__dirname, '..', 'household.json');

async function writeFileAtomic(filePath, content) {
  const tmp = filePath + '.tmp';
  try {
    await writeFile(tmp, content);
    await fsRename(tmp, filePath);
  } catch (e) {
    await unlink(tmp).catch(() => {});   // best-effort cleanup; ignore if absent
    throw e;
  }
}

const RULESET_NAME = 'main protection';

// === Standard policy ===========================================================
// The shape every repo's ruleset should converge on. Per-repo variations are
// limited to optional required-status-check name (see household.json branchProtection).

const STANDARD_RULES = [
  { type: 'deletion' },
  { type: 'non_fast_forward' },
  {
    type: 'pull_request',
    parameters: {
      required_approving_review_count: 1,
      dismiss_stale_reviews_on_push: false,
      required_reviewers: [],
      require_code_owner_review: false,
      require_last_push_approval: false,
      required_review_thread_resolution: true,
      allowed_merge_methods: ['squash'],
    },
  },
];

// Repo-level settings (PATCH /repos/{owner}/{repo}) we standardize uniformly
// across the org. Currently just auto-delete-on-merge — keeps merged feature
// branches from cluttering the repo. No per-repo override needed.
const STANDARD_REPO_META = {
  delete_branch_on_merge: true,
};

// === Pure functions ============================================================

/**
 * Derive the GitHub org from the manifest's own meta_repo entry.
 *
 * The household template doesn't hardcode an org; instead the repos[] entry
 * named by the top-level `meta_repo` field must carry a github.com url
 * (SSH or HTTPS), e.g. git@github.com:acme/acme-household.git.
 *
 * @param {object} manifest
 * @returns {string} the org segment of the meta_repo entry's url
 */
export function resolveOrg(manifest) {
  const self = manifest.repos?.find(r => r.name === manifest.meta_repo);
  const m = /github\.com[:/]([^/]+)\//.exec(self?.url || '');
  if (!m) throw new Error('Cannot resolve GitHub org: household.json needs a meta_repo entry whose "url" points at github.com/<org>/<repo>.');
  return m[1];
}

/**
 * Derive the GitHub { org, repo } for a manifest entry from its `url`.
 *
 * Returns null when:
 *   - the entry has no `url` (inline directory), or
 *   - the url is not a recognisable github.com SSH/HTTPS remote.
 *
 * Mirrors `deriveGithubTarget` in repo-rename.mjs without cross-importing it;
 * both delegate to the shared `parseRemoteUrl` from repos-sync-names.mjs.
 *
 * @param {{ url?: string }} repo - a manifest repos[] entry
 * @returns {{ org: string, repo: string } | null}
 */
export function githubTargetFor(repoEntry) {
  const parsed = parseRemoteUrl(repoEntry?.url);
  if (!parsed) return null;
  const slash = parsed.indexOf('/');
  return { org: parsed.slice(0, slash), repo: parsed.slice(slash + 1) };
}

// GitHub reports a team's repo permission redundantly: a legacy `permission`
// string and a `permissions` boolean object. Normalize both to our five role
// names so comparisons are apples-to-apples.
const LEGACY_TO_LEVEL = { pull: 'read', triage: 'triage', push: 'write', maintain: 'maintain', admin: 'admin' };
const PERMS_HIGH_TO_LOW = ['admin', 'maintain', 'push', 'triage', 'pull'];

/** @param {{permissions?: object, permission?: string}} entry */
export function normalizeTeamPermission(entry) {
  const perms = entry?.permissions;
  if (perms && typeof perms === 'object') {
    for (const key of PERMS_HIGH_TO_LOW) {
      if (perms[key]) return LEGACY_TO_LEVEL[key];
    }
  }
  return LEGACY_TO_LEVEL[entry?.permission] ?? 'read';
}

// Our manifest vocabulary → the GitHub API `permission` value (PUT team-repo).
export const PERMISSION_API = {
  read: 'pull', triage: 'triage', write: 'push', maintain: 'maintain', admin: 'admin',
};

/**
 * Build the desired ruleset JSON for a repo.
 *
 * @param {object} opts
 * @param {number|null} [opts.bypassTeamId] - numeric GitHub team id for the
 *   configured bypass team, or null/undefined when no bypass team is
 *   configured (the ruleset then carries no bypass actors).
 * @param {string|null} [opts.requiredStatusCheck] - optional status-check context name.
 * @returns {object} Ruleset JSON ready to POST/PUT.
 */
export function buildRuleset({ bypassTeamId, requiredStatusCheck = null }) {
  const rules = STANDARD_RULES.map(r => structuredClone(r));
  if (requiredStatusCheck) {
    rules.push({
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: true,
        required_status_checks: [{ context: requiredStatusCheck }],
      },
    });
  }
  return {
    name: RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules,
    // The rulesets API accepts an empty bypass_actors array (no bypass =
    // strictest); used when no bypass team is configured in household.json.
    bypass_actors: bypassTeamId == null
      ? []
      : [
          { actor_id: bypassTeamId, actor_type: 'Team', bypass_mode: 'pull_request' },
        ],
  };
}

/**
 * Compute differences between an existing ruleset and a desired one.
 * Returns an array of human-readable diff strings. Empty array = identical.
 *
 * Compares: rule types present, pull_request parameters, status-check contexts,
 * bypass actors. Other ruleset metadata (id, timestamps, etc.) is ignored.
 *
 * @param {object|null} existing
 * @param {object} desired
 * @returns {string[]}
 */
export function diffRulesets(existing, desired) {
  if (!existing) return ['no existing ruleset (will create)'];
  const diffs = [];

  const existingRuleTypes = new Set((existing.rules || []).map(r => r.type));
  const desiredRuleTypes = new Set(desired.rules.map(r => r.type));
  for (const t of desiredRuleTypes) {
    if (!existingRuleTypes.has(t)) diffs.push(`missing rule: ${t}`);
  }
  for (const t of existingRuleTypes) {
    if (!desiredRuleTypes.has(t)) diffs.push(`extra rule: ${t}`);
  }

  // pull_request parameters
  const ePR = (existing.rules || []).find(r => r.type === 'pull_request')?.parameters;
  const dPR = desired.rules.find(r => r.type === 'pull_request')?.parameters;
  if (ePR && dPR) {
    for (const k of Object.keys(dPR)) {
      const a = JSON.stringify(ePR[k]);
      const b = JSON.stringify(dPR[k]);
      if (a !== b) diffs.push(`pull_request.${k}: ${a} → ${b}`);
    }
  }

  // status checks
  const eSC = (existing.rules || []).find(r => r.type === 'required_status_checks')?.parameters;
  const dSC = desired.rules.find(r => r.type === 'required_status_checks')?.parameters;
  if (eSC || dSC) {
    const eCtx = (eSC?.required_status_checks || []).map(c => c.context).sort();
    const dCtx = (dSC?.required_status_checks || []).map(c => c.context).sort();
    if (JSON.stringify(eCtx) !== JSON.stringify(dCtx)) {
      diffs.push(`status_checks: [${eCtx.join(', ')}] → [${dCtx.join(', ')}]`);
    }
  }

  // bypass actors (compare by sorted JSON-stringified tuples — robust to colons in values)
  const bypassKey = b => JSON.stringify([b.actor_type, b.actor_id, b.bypass_mode]);
  const eByp = (existing.bypass_actors || []).map(bypassKey).sort();
  const dByp = (desired.bypass_actors || []).map(bypassKey).sort();
  if (JSON.stringify(eByp) !== JSON.stringify(dByp)) {
    diffs.push(`bypass_actors: [${eByp.join(', ')}] → [${dByp.join(', ')}]`);
  }

  return diffs;
}

/**
 * Summarize a repo's current protection state for the audit table.
 *
 * Picks a "primary" ruleset to extract detail from: the one named RULESET_NAME
 * if present, otherwise the first active ruleset. Falls back to classic-
 * protection equivalents where the ruleset doesn't have a value. Returns null
 * for individual fields when neither source provides one.
 *
 * @param {object[]} rulesets - from GET /repos/.../rulesets
 * @param {object|null} classic - from GET /repos/.../branches/main/protection (null if 404)
 * @param {object|null} [repoMeta] - from GET /repos/.../{owner}/{repo} (top-level repo settings)
 * @returns {{
 *   state: string,
 *   statusCheck: string|null,
 *   requiredReviews: number|null,
 *   squashOnly: boolean|null,
 *   threadResolution: boolean|null,
 *   codeOwnerReview: boolean|null,
 *   bypassActors: object[],
 *   deleteBranchOnMerge: boolean|null,
 * }}
 *   state: "none" | "classic" | "ruleset" | "ruleset+classic" |
 *          "multiple-rulesets" | "multiple-rulesets+classic"
 *   bypassActors: raw {actor_id, actor_type, bypass_mode} entries — slug
 *     resolution happens in the caller (one GitHub call per unique team).
 *   deleteBranchOnMerge: from the repo object's delete_branch_on_merge field,
 *     null if repoMeta wasn't provided.
 */
export function summarizeState(rulesets, classic, repoMeta = null) {
  const rs = rulesets || [];
  let state;
  if (rs.length === 0 && !classic) state = 'none';
  else if (rs.length === 0 && classic) state = 'classic';
  else if (rs.length === 1 && !classic) state = 'ruleset';
  else if (rs.length === 1 && classic) state = 'ruleset+classic';
  else if (rs.length >= 2 && !classic) state = 'multiple-rulesets';
  else state = 'multiple-rulesets+classic';

  // Pick the primary ruleset for detail extraction
  const primary = rs.find(r => r.name === RULESET_NAME) ?? rs[0] ?? null;
  const prParams = primary?.rules?.find(r => r.type === 'pull_request')?.parameters ?? null;
  const merges = prParams?.allowed_merge_methods;

  // Status check: prefer ruleset, fall back to classic
  let statusCheck = null;
  for (const ruleset of rs) {
    const sc = (ruleset.rules || []).find(r => r.type === 'required_status_checks');
    const ctx = sc?.parameters?.required_status_checks?.[0]?.context;
    if (ctx) { statusCheck = ctx; break; }
  }
  if (!statusCheck && classic?.required_status_checks?.contexts?.length) {
    statusCheck = classic.required_status_checks.contexts[0];
  }

  return {
    state,
    statusCheck,
    requiredReviews: prParams?.required_approving_review_count
      ?? classic?.required_pull_request_reviews?.required_approving_review_count
      ?? null,
    squashOnly: merges
      ? merges.length === 1 && merges[0] === 'squash'
      : null,
    threadResolution: prParams?.required_review_thread_resolution
      ?? classic?.required_conversation_resolution?.enabled
      ?? null,
    codeOwnerReview: prParams?.require_code_owner_review
      ?? classic?.required_pull_request_reviews?.require_code_owner_reviews
      ?? null,
    bypassActors: primary?.bypass_actors ?? [],
    deleteBranchOnMerge: repoMeta?.delete_branch_on_merge ?? null,
  };
}

/**
 * Compute the drift between a repo's current settings and STANDARD_REPO_META.
 * Returns a list of human-readable diff strings (empty = no drift).
 *
 * @param {object|null} current - from getRepoMeta (the full repo object), or null
 * @returns {string[]}
 */
export function diffRepoMeta(current) {
  if (!current) return [];
  const diffs = [];
  for (const [key, want] of Object.entries(STANDARD_REPO_META)) {
    if (current[key] !== want) {
      diffs.push(`${key}: ${current[key]} → ${want}`);
    }
  }
  return diffs;
}

/**
 * Render a bypass-actor entry as a short human-readable string.
 * Knows the special Admin role mapping; falls back to actor_type:id for anything
 * else unknown to the team-slug map.
 *
 * @param {object} actor - {actor_id, actor_type, bypass_mode}
 * @param {Map<number,string>} teamSlugById - id → slug map for Team-type actors
 * @returns {string}
 */
export function formatBypassActor(actor, teamSlugById) {
  let name;
  if (actor.actor_type === 'Team') {
    name = teamSlugById.get(actor.actor_id) ?? `team:${actor.actor_id}`;
  } else if (actor.actor_type === 'RepositoryRole' && actor.actor_id === 5) {
    name = 'admin';
  } else if (actor.actor_type === 'OrganizationAdmin') {
    name = 'org-admin';
  } else {
    name = `${actor.actor_type}:${actor.actor_id}`;
  }
  // Append mode if it's not the standard "pull_request" so drift is visible
  return actor.bypass_mode === 'pull_request' ? name : `${name} (${actor.bypass_mode})`;
}

/**
 * Render a list of bypass actors as a single comma-separated cell.
 * Returns "—" for an empty list (no bypass = strictest).
 */
export function formatBypassActors(actors, teamSlugById) {
  if (!actors?.length) return '—';
  return actors.map(a => formatBypassActor(a, teamSlugById)).join(', ');
}

/**
 * Render a tri-state boolean for the audit table.
 * true → "✓", false → "✗", null/undefined → "—".
 */
function tribool(v) {
  if (v === true) return '✓';
  if (v === false) return '✗';
  return '—';
}

/**
 * Pure resolver for the bypass-team config in household.json.
 *
 * The bypass team is optional in this template: returns null when no
 * `branchProtection.bypassTeam.slug` is configured, and rulesets are then
 * built without bypass actors.
 * If `.id` is present, returns it as cached. Otherwise returns id=null, signalling
 * the caller should fetch via getTeamId(slug) and (if --write) persist it.
 *
 * @param {object} manifest
 * @returns {{ id: number|null, slug: string, cached: boolean } | null}
 */
export function resolveBypassTeamFromManifest(manifest) {
  const config = manifest.branchProtection?.bypassTeam;
  if (!config?.slug) return null;
  if (config.id) return { id: config.id, slug: config.slug, cached: true };
  return { id: null, slug: config.slug, cached: false };
}

/**
 * Authoritative diff of a declared team-access map against the actual one.
 * @param {Record<string,string>} declared
 * @param {Record<string,string>} actual
 * @returns {{grants:{team:string,level:string}[], changes:{team:string,from:string,to:string}[], revokes:{team:string,level:string}[]}}
 */
export function diffTeamAccess(declared, actual) {
  const grants = [], changes = [], revokes = [];
  for (const [team, level] of Object.entries(declared)) {
    if (!(team in actual)) grants.push({ team, level });
    else if (actual[team] !== level) changes.push({ team, from: actual[team], to: level });
  }
  for (const [team, level] of Object.entries(actual)) {
    if (!(team in declared)) revokes.push({ team, level });
  }
  return { grants, changes, revokes };
}

// === gh CLI wrapper ============================================================

/**
 * Run `gh api <args>` and return parsed JSON (or null if empty output).
 * Throws on non-zero exit unless `swallow404` is set.
 *
 * Uses spawn (not execFile) when stdin is provided: execFile's `input` option
 * hangs against `gh api --input -` on Node 25.x (child never sees stdin EOF).
 * Explicit `stdin.end()` after write fixes it.
 */
async function gh(args, { stdin, swallow404 = false } = {}) {
  if (stdin !== undefined) {
    return ghWithStdin(args, stdin, swallow404);
  }
  try {
    const { stdout } = await execFileP('gh', args);
    if (!stdout.trim()) return null;
    return JSON.parse(stdout);
  } catch (err) {
    if (swallow404 && err.stderr && /\b404\b/.test(err.stderr)) return null;
    const msg = err.stderr || err.message || String(err);
    throw new Error(`gh ${args.join(' ')} failed: ${msg.trim()}`);
  }
}

function ghWithStdin(args, stdin, swallow404) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) {
        resolve(stdout.trim() ? JSON.parse(stdout) : null);
        return;
      }
      if (swallow404 && /\b404\b/.test(stderr)) {
        resolve(null);
        return;
      }
      reject(new Error(`gh ${args.join(' ')} failed (exit ${code}): ${stderr.trim()}`));
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

async function listRulesets(org, repo) {
  return (await gh(['api', `repos/${org}/${repo}/rulesets`])) || [];
}

async function getRulesetDetail(org, repo, id) {
  return gh(['api', `repos/${org}/${repo}/rulesets/${id}`]);
}

async function getClassicProtection(org, repo) {
  return gh(['api', `repos/${org}/${repo}/branches/main/protection`], { swallow404: true });
}

async function getRepoMeta(org, repo) {
  return gh(['api', `repos/${org}/${repo}`]);
}

async function patchRepoMeta(org, repo, body) {
  return gh(
    ['api', `repos/${org}/${repo}`, '-X', 'PATCH', '--input', '-'],
    { stdin: JSON.stringify(body) },
  );
}

async function getTeamId(org, slug) {
  const team = await gh(['api', `orgs/${org}/teams/${slug}`]);
  return team.id;
}

/**
 * Fetch all teams in the org and return a Map of team id → slug.
 * Used by audit to render bypass-actor team IDs as human-readable slugs.
 */
async function listOrgTeams(org) {
  const teams = (await gh(['api', `orgs/${org}/teams`, '--paginate'])) || [];
  return new Map(teams.map(t => [t.id, t.slug]));
}

/**
 * Async wrapper around resolveBypassTeamFromManifest that resolves the team id
 * via GitHub if not cached in the manifest. Returns null when no bypass team
 * is configured (the bypass team is optional in this template).
 */
async function resolveBypassTeam(org, manifest) {
  const resolved = resolveBypassTeamFromManifest(manifest);
  if (!resolved) return null;
  if (resolved.cached) return resolved;
  const id = await getTeamId(org, resolved.slug);
  return { id, slug: resolved.slug, cached: false };
}

async function putRuleset(org, repo, id, ruleset) {
  return gh(
    ['api', `repos/${org}/${repo}/rulesets/${id}`, '-X', 'PUT', '--input', '-'],
    { stdin: JSON.stringify(ruleset) },
  );
}

async function postRuleset(org, repo, ruleset) {
  return gh(
    ['api', `repos/${org}/${repo}/rulesets`, '-X', 'POST', '--input', '-'],
    { stdin: JSON.stringify(ruleset) },
  );
}

/**
 * Interactive y/N prompt. Returns true only on an explicit "y"/"yes".
 */
async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// === Commands ==================================================================

async function cmdAudit({ write }) {
  const manifest = JSON.parse(await readFile(HOUSEHOLD_JSON, 'utf8'));
  const org = resolveOrg(manifest);

  // Resolve bypass team id (single GitHub call if not cached); null when no
  // bypass team is configured. Persisted below if --write.
  const bypass = await resolveBypassTeam(org, manifest);

  // Fetch the org team list once so we can render team IDs in bypass actors
  // as readable slugs. Runs in parallel with the per-repo audits below.
  const teamsPromise = listOrgTeams(org);

  // Entries without a url are inline directories (no GitHub repo) — skip them.
  // Entries whose url can't be parsed as a GitHub remote are also skipped with
  // a clear diagnostic (no silent fallback to manifest name).
  const ghRepos = manifest.repos.filter(repo => {
    if (!repo.url) {
      console.error(`[skip] ${repo.name} (inline, no GitHub repo)`);
      return false;
    }
    if (!githubTargetFor(repo)) {
      console.error(`[skip] ${repo.name}: cannot parse GitHub org/repo from url "${repo.url}"`);
      return false;
    }
    return true;
  });

  // Audit every repo in parallel. Within each repo, run listRulesets and
  // getClassicProtection concurrently, then fan out getRulesetDetail across
  // active rulesets.
  const results = await Promise.all(ghRepos.map(async (repo) => {
    const { org: ghOrg, repo: ghRepo } = githubTargetFor(repo);
    const [list, classic, repoMeta] = await Promise.all([
      listRulesets(ghOrg, ghRepo),
      getClassicProtection(ghOrg, ghRepo),
      getRepoMeta(ghOrg, ghRepo),
    ]);
    const details = await Promise.all(
      list.filter(r => r.enforcement === 'active')
          .map(r => getRulesetDetail(ghOrg, ghRepo, r.id))
    );
    const summary = summarizeState(details, classic, repoMeta);
    return {
      repo,
      ghOrg,
      ghRepo,
      activeCount: details.length,
      inactiveCount: list.length - details.length,
      ...summary,
    };
  }));

  const teamSlugById = await teamsPromise;

  // Print markdown table. Columns capture the dimensions of the standard so
  // drift is visible at a glance: review count, squash-only, conversation
  // resolution, code-owner review, bypass actors, required status check,
  // and the repo-level delete-branch-on-merge setting.
  console.log('| Repo | State | Active | Reviews | Squash | Threads | CO | Bypass | Status check | Del-on-merge |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of results) {
    const sc = r.statusCheck ? `\`${r.statusCheck}\`` : '—';
    const count = r.inactiveCount > 0 ? `${r.activeCount} (+${r.inactiveCount} disabled)` : `${r.activeCount}`;
    const reviews = r.requiredReviews ?? '—';
    const squash = tribool(r.squashOnly);
    const threads = tribool(r.threadResolution);
    const co = tribool(r.codeOwnerReview);
    const bypassStr = formatBypassActors(r.bypassActors, teamSlugById);
    const delOnMerge = tribool(r.deleteBranchOnMerge);
    // Show GitHub repo name in parentheses when it differs from the manifest name
    const displayName = r.ghRepo && r.ghRepo !== r.repo.name
      ? `${r.repo.name} (${r.ghOrg}/${r.ghRepo})`
      : r.repo.name;
    console.log(`| ${displayName} | ${r.state} | ${count} | ${reviews} | ${squash} | ${threads} | ${co} | ${bypassStr} | ${sc} | ${delOnMerge} |`);
  }

  if (write) {
    // Persist bypass team id if a slug is configured but the id wasn't cached.
    if (bypass && !bypass.cached) {
      manifest.branchProtection.bypassTeam.id = bypass.id;
    }
    // Persist per-repo branchProtection.requiredStatusCheck.
    for (const r of results) {
      r.repo.branchProtection = r.repo.branchProtection || {};
      if (r.statusCheck) r.repo.branchProtection.requiredStatusCheck = r.statusCheck;
      else if (!('requiredStatusCheck' in r.repo.branchProtection)) {
        r.repo.branchProtection.requiredStatusCheck = null;
      }
    }
    await writeFileAtomic(HOUSEHOLD_JSON, formatRepos(manifest));
    console.error(`\nWrote inferred branchProtection config to ${path.relative(process.cwd(), HOUSEHOLD_JSON)}`);
  } else {
    console.error('\n(read-only audit; pass --write to bootstrap household.json)');
    if (bypass && !bypass.cached) {
      console.error('(note: bypass team id not cached in household.json — run with --write to persist)');
    }
  }
}

/**
 * Pretty-print the household.json manifest while keeping short string-arrays inline,
 * which matches the hand-authored style and avoids a 100+-line formatting churn
 * the first time we write to the file.
 *
 * @param {object} manifest
 * @returns {string}
 */
export function formatRepos(manifest) {
  let s = JSON.stringify(manifest, null, 2);
  // Match an array body containing only quoted strings spread across lines, and
  // re-inline it if the collapsed form stays under 80 columns.
  s = s.replace(
    /\[\n\s+("(?:[^"\\]|\\.)*"(?:,\n\s+"(?:[^"\\]|\\.)*")*)\n\s*\]/g,
    (match, items) => {
      // Split only on the cross-line separator JSON.stringify emits — never on
      // commas inside string contents.
      const inline = '[' + items.split(/,\n\s+/).map(t => t.trim()).join(', ') + ']';
      return inline.length <= 80 ? inline : match;
    },
  );
  return s + '\n';
}

async function cmdApply(repoName, { dryRun, yes }) {
  if (!repoName) {
    console.error('apply: missing repo name. Usage: apply <repo> [--dry-run]');
    process.exit(2);
  }
  const manifest = JSON.parse(await readFile(HOUSEHOLD_JSON, 'utf8'));
  const repo = manifest.repos.find(r => r.name === repoName);
  if (!repo) {
    console.error(`apply: repo "${repoName}" not found in household.json`);
    process.exit(2);
  }
  if (!repo.url) {
    console.log(`[skip] ${repo.name} (inline, no GitHub repo)`);
    return;
  }
  const ghTarget = githubTargetFor(repo);
  if (!ghTarget) {
    console.error(`apply: ${repo.name}: cannot parse GitHub org/repo from url "${repo.url}"`);
    process.exit(1);
  }
  const { org: ghOrg, repo: ghRepo } = ghTarget;

  // Resolve bypass team using the household org (bypass team is org-scoped)
  const householdOrg = resolveOrg(manifest);
  const bypass = await resolveBypassTeam(householdOrg, manifest);
  if (bypass && !bypass.cached) {
    console.error('(note: bypass team id not cached in household.json — run `audit --write` to persist)');
  }
  const requiredStatusCheck = repo.branchProtection?.requiredStatusCheck || null;
  const desired = buildRuleset({ bypassTeamId: bypass?.id ?? null, requiredStatusCheck });

  // Fetch existing ruleset + repo meta in parallel
  const [list, repoMeta] = await Promise.all([
    listRulesets(ghOrg, ghRepo),
    getRepoMeta(ghOrg, ghRepo),
  ]);
  const match = list.find(r => r.name === RULESET_NAME);
  const existing = match ? await getRulesetDetail(ghOrg, ghRepo, match.id) : null;

  const rulesetDiffs = diffRulesets(existing, desired);
  const metaDiffs = diffRepoMeta(repoMeta);
  const allDiffs = [
    ...rulesetDiffs.map(d => `[ruleset] ${d}`),
    ...metaDiffs.map(d => `[repo] ${d}`),
  ];

  if (allDiffs.length === 0) {
    console.log(`${repo.name}: no changes (already matches standard)`);
    return;
  }

  const verb = match ? 'update' : 'create';
  const what = rulesetDiffs.length > 0 && metaDiffs.length > 0
    ? `${verb} ruleset "${RULESET_NAME}" and patch repo settings`
    : rulesetDiffs.length > 0
      ? `${verb} ruleset "${RULESET_NAME}"`
      : 'patch repo settings';
  console.log(`${repo.name}: would ${what}`);
  for (const d of allDiffs) console.log(`  - ${d}`);

  // Warn about non-standard sibling rulesets that we don't touch
  const others = list.filter(r => r.name !== RULESET_NAME);
  if (others.length > 0) {
    console.log(`  (note: ${others.length} other ruleset(s) on this repo — review/clean manually)`);
    for (const o of others) console.log(`    - "${o.name}" (id ${o.id})`);
  }

  if (dryRun) {
    console.log(`${repo.name}: dry-run, no changes applied`);
    return;
  }

  if (!yes) {
    const proceed = await confirm(`Apply these changes to ${repo.name}? [y/N] `);
    if (!proceed) {
      console.log(`${repo.name}: aborted`);
      return;
    }
  }

  if (rulesetDiffs.length > 0) {
    if (match) await putRuleset(ghOrg, ghRepo, match.id, desired);
    else await postRuleset(ghOrg, ghRepo, desired);
  }
  if (metaDiffs.length > 0) {
    await patchRepoMeta(ghOrg, ghRepo, STANDARD_REPO_META);
  }
  console.log(`${repo.name}: applied`);
}

function help() {
  console.log(`Usage:
  ./scripts/repo-policy.mjs audit [--write]
      Inspect every repo in household.json; print state table.
      Entries without a "url" are inline directories and are skipped.
      With --write, populate each repo's branchProtection.requiredStatusCheck
      from currently-required checks (bootstrap).

  ./scripts/repo-policy.mjs apply <repo> [--dry-run] [--yes]
      Apply the standard ruleset "${RULESET_NAME}" to one repo.
      Idempotent (PUT if a matching-name ruleset exists, POST otherwise).
      --dry-run prints the diff and exits without changes.
      --yes (alias: --no-confirm) skips the interactive confirmation prompt.

  ./scripts/repo-policy.mjs help
      Show this message.

The GitHub org (e.g. acme in github.com/acme/acme-foo) is derived from the
meta_repo entry's url in household.json — set that to your GitHub org's url.

Standard rules applied to every repo:
  - block deletion of default branch
  - block non-fast-forward (force-push)
  - require PR with 1 approving review (squash-only)
  - require conversation/thread resolution
  - bypass (optional): team named in household.json branchProtection.bypassTeam
    (PR mode), e.g. {"bypassTeam": {"slug": "my-team"}}; when no bypass team
    is configured, the ruleset is applied with no bypass actors (strictest)
  - required_status_checks rule added per-repo from
    household.json[repo].branchProtection.requiredStatusCheck (if set)

Standard repo settings (PATCH /repos/{owner}/{repo}):
  - delete_branch_on_merge: true (auto-delete head branches after PR merge)
`);
}

// === Main ======================================================================

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const flags = new Set(rest.filter(a => a.startsWith('--')));
  const positional = rest.filter(a => !a.startsWith('--'));

  switch (cmd) {
    case 'audit':
      await cmdAudit({ write: flags.has('--write') });
      break;
    case 'apply':
      await cmdApply(positional[0], {
        dryRun: flags.has('--dry-run'),
        yes: flags.has('--yes') || flags.has('--no-confirm'),
      });
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      help();
      break;
    default:
      console.error(`unknown command: ${cmd}`);
      help();
      process.exit(2);
  }
}

// Only run if invoked directly (not when imported in tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err.stack || err.message || err);
    process.exit(1);
  });
}
