#!/usr/bin/env node
// Publish a local repo as a new GitHub repo in the household org.
//
// Usage: scripts/new-repo.mjs [--name=<repo-name>] [--description="..."] [--tags=t1,t2] [--here|--new]
//
// Run with no flags to be walked through prompts (name prefix → suffix →
// description → tags), or pass flags for scripted usage. Where the repo comes
// from is decided, not asked: run from the household root it scaffolds a new
// ./<name>/ subdirectory (--new); run from inside an existing checkout it
// publishes that checkout (--here). Either flag overrides the default.
//
// An explicit empty `--tags=` means "no tags" and is not prompted for, so the
// `make repos-create NAME=… DESCRIPTION=…` call is fully non-interactive.
//
// The GitHub org is not hardcoded: it is resolved from household.json — the
// repos[] entry named by `meta_repo` must have a "url" pointing at
// github.com/<org>/<repo>.
//
// Flow:
//   1. Create a throwaway worktree of the meta-repo on origin/main, validate
//      the new entry against the manifest there, and check gh is signed in and
//      the name is free on GitHub (all before any side effects).
//   2. (--new) Scaffold ./<name>/: git init, README, initial commit.
//   3. Pre-flight: in a git repo, has commits, on main, no origin remote.
//   4. Create the GitHub repo (gh repo create ... --private), add origin, push main.
//   5. Write the entry to household.json in the worktree; commit and push a
//      chore/repos-create-<name> branch.
//   6. Apply branch protection and team access from that manifest (best-effort).
//   7. Open the PR. The meta-repo checkout's branch, index and uncommitted
//      changes are never touched.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, readdir, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import path from 'node:path';

import { formatRepos } from './repo-policy.mjs';
import { parseRemoteUrl } from './repos-sync-names.mjs';
import {
  worktreeCommands, resolveBaseRef, assertPrimaryCheckout, isWorkingTreeClean,
  currentBranch, writeFileAtomic, cleanupWorktree, shouldDeleteBranch,
} from './manifest-worktree.mjs';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOUSEHOLD_ROOT = path.resolve(__dirname, '..');

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEGMENT_RE = /^[a-z0-9][a-z0-9-]*$/;

// === Pure functions (testable) ================================================

/**
 * Validate a repo name. Any lowercase [a-z0-9] words separated by single
 * hyphens are allowed — single-word names (e.g. "lore", "backend") are fine.
 * Returns null if valid, an error message otherwise.
 */
export function validateName(name) {
  if (!name) return 'name is required';
  if (!NAME_RE.test(name)) {
    return `name "${name}" must be lowercase [a-z0-9] words separated by single hyphens (e.g. "lore" or "acme-foo")`;
  }
  return null;
}

/**
 * Validate a single segment (name prefix or repo suffix).
 * Multi-word segments like "my-team" are allowed.
 */
export function validateSegment(seg, label) {
  if (!seg) return `${label} is required`;
  if (!SEGMENT_RE.test(seg)) {
    return `${label} "${seg}" must be lowercase [a-z0-9-] and start with a letter or digit`;
  }
  return null;
}

/**
 * Resolve the GitHub org from the household manifest: the repos[] entry
 * named by `meta_repo` must have a url pointing at github.com/<org>/<repo>.
 */
export function resolveOrg(manifest) {
  const self = manifest.repos?.find(r => r.name === manifest.meta_repo);
  const m = /github\.com[:/]([^/]+)\//.exec(self?.url || '');
  if (!m) throw new Error('Cannot resolve GitHub org: household.json needs a meta_repo entry whose "url" points at github.com/<org>/<repo>.');
  return m[1];
}

/**
 * The teamAccess block a new repo should start with: every grant that all
 * managed repos (those with a `teamAccess` key) share at the same level.
 *
 * Returns null — leave the entry unmanaged — when no repo declares teamAccess or
 * the managed repos share nothing. Never `{}`: that means "no teams", and
 * access-apply would revoke every grant on the repo.
 *
 * @param {object} manifest - parsed household.json
 * @returns {Record<string, string> | null}
 */
export function defaultTeamAccess(manifest) {
  const managed = (manifest.repos ?? [])
    .map(r => r.teamAccess)
    .filter(t => t && typeof t === 'object' && !Array.isArray(t));
  if (managed.length === 0) return null;
  const [first, ...rest] = managed;
  const shared = Object.fromEntries(
    Object.entries(first).filter(([team, level]) => rest.every(t => t[team] === level)),
  );
  return Object.keys(shared).length ? shared : null;
}

/**
 * Build the household.json entry for a new repo.
 *
 * Every entry declares branch protection so `make policy-audit` treats the repo
 * like the rest; a new repo has no CI, so no status check is required yet.
 * teamAccess is included only when a default exists (see defaultTeamAccess).
 */
export function buildRepoEntry({ name, description, tags = [] }, org, { teamAccess = null } = {}) {
  const entry = {
    name,
    url: `git@github.com:${org}/${name}.git`,
    description,
    tags,
  };
  if (teamAccess) entry.teamAccess = { ...teamAccess };
  entry.branchProtection = { requiredStatusCheck: null };
  return entry;
}

/**
 * Return a new manifest with `entry` appended. Throws when the name, or the
 * GitHub repo the url points at, is already registered. Pure.
 */
export function addRepoToManifest(manifest, entry) {
  const repos = manifest.repos ?? [];
  if (repos.some(r => r.name === entry.name)) {
    throw new Error(`household.json already has an entry named "${entry.name}".`);
  }
  const target = parseRemoteUrl(entry.url)?.toLowerCase();
  const clash = target && repos.find(r => parseRemoteUrl(r.url)?.toLowerCase() === target);
  if (clash) {
    throw new Error(`household.json entry "${clash.name}" already points at ${target}.`);
  }
  return { ...manifest, repos: [...repos, entry] };
}

/** Branch, commit message and PR title for registering `name`. */
export function manifestPrPlan(name) {
  const title = `chore(manifest): register ${name}`;
  return { branch: `chore/repos-create-${name}`, commitMsg: title, prTitle: title };
}

/**
 * The PR body: what the repo is, the defaults written for it, and which policy
 * steps reached GitHub.
 *
 * @param {{ entry: object, org: string,
 *   policy: { protection: 'applied'|'failed', access: 'applied'|'failed'|'skipped' } }} args
 */
export function buildPrBody({ entry, org, policy }) {
  const { name } = entry;
  const tags = entry.tags?.length ? entry.tags.map(t => `\`${t}\``).join(', ') : 'none';
  const access = entry.teamAccess
    ? `- \`teamAccess\`: ${Object.entries(entry.teamAccess).map(([t, l]) => `\`${t}: ${l}\``).join(', ')} — ` +
      `the grants every managed repo in the manifest already shares.`
    : `- no \`teamAccess\` block: no grant is shared by every managed repo, so the entry is ` +
      `unmanaged for team access. Add one, then \`make access-apply REPO=${name}\`.`;
  const step = (state, target) => state === 'applied'
    ? 'applied'
    : state === 'skipped'
      ? 'skipped (no `teamAccess` declared)'
      : `**failed** — after merging, run \`make ${target} REPO=${name}\``;
  return [
    `Registers \`${name}\` in household.json. \`make repos-create\` created the private GitHub repo ` +
      `[${org}/${name}](https://github.com/${org}/${name}) and pushed \`main\`.`,
    '',
    `- **Description:** ${entry.description}`,
    `- **Tags:** ${tags}`,
    '',
    '**Defaults written to the entry**',
    '',
    access,
    `- \`branchProtection\`: the standard ruleset with no required status check, since the repo has ` +
      `no CI yet. Set \`requiredStatusCheck\` once it does, then \`make policy-apply REPO=${name}\`.`,
    '',
    '**Applied to GitHub before this PR was opened**',
    '',
    `- Branch protection: ${step(policy.protection, 'policy-apply')}`,
    `- Team access: ${step(policy.access, 'access-apply')}`,
    '',
    `**After merge:** \`git pull\` in the meta-repo. Teammates get a local clone with \`make setup\`.`,
  ].join('\n') + '\n';
}
/**
 * Why `org/name` cannot be created on GitHub, or null when it can. Checked
 * before anything is scaffolded: the manifest check on the base ref cannot see
 * a repo created outside it, or one whose registration PR has not merged. Pure.
 */
export function githubNameProblem({ authOk, exists, org, name }) {
  if (!authOk) return 'gh is not authenticated. Run: gh auth login';
  if (exists) {
    return `${org}/${name} already exists on GitHub. If an earlier run created it, merge its ` +
      `registration PR; otherwise pick another name.`;
  }
  return null;
}

/**
 * What a failed run left behind, and how to get past it on the retry. Pure.
 *
 * @param {{ name: string, branch: string, scaffolded: boolean, ghCreated: boolean, pushed: boolean }} state
 * @returns {string[]} lines for stderr; empty when nothing was left behind
 */
export function failureNotes({ name, branch, scaffolded, ghCreated, pushed }) {
  if (ghCreated) {
    return [
      `Note: ${name} already exists on GitHub, so re-running will fail at "gh repo create".`,
      pushed
        ? `  Branch ${branch} was pushed; open its PR with: gh pr create --head ${branch}`
        : `  Register it by hand: add its entry to household.json and open a PR.`,
    ];
  }
  if (scaffolded) {
    return [
      `Note: ./${name}/ was scaffolded but nothing reached GitHub. It is safe to delete, and the`,
      `  retry needs it gone: rm -rf ${name}`,
    ];
  }
  return [];
}

/**
 * Pick a sensible default mode for where to publish from.
 * Returns 'new' when cwd is the household root (no point publishing the
 * meta-repo) and 'here' otherwise.
 */
export function defaultMode(cwd, householdRoot) {
  return path.resolve(cwd) === path.resolve(householdRoot) ? 'new' : 'here';
}

/**
 * Parse CLI flags of the form --key=value or --flag.
 * Values are kept as raw strings; callers handle their own conversion.
 */
export function parseFlags(argv) {
  const opts = {};
  for (const arg of argv) {
    const m = arg.match(/^--([\w-]+)(?:=(.*))?$/);
    if (m) opts[m[1]] = m[2] ?? true;
  }
  return opts;
}

/**
 * Where the repo comes from. Never prompted: from the household root the answer
 * is always "scaffold a new subdirectory", and from inside a checkout it is
 * "publish this one". --here / --new override.
 */
export function resolveMode(opts, cwd, householdRoot) {
  return resolveModeFromFlags(opts) ?? defaultMode(cwd, householdRoot);
}

/**
 * Treat an empty --name= or --description= as missing (the make target passes
 * them through even when unset), but keep an explicit empty --tags= as "no
 * tags": `make repos-create NAME=…` forwards --tags=, and prompting for it would
 * make the scripted call need a TTY. Omit --tags entirely to be asked. Pure.
 */
export function normalizeOpts(opts) {
  const out = { ...opts };
  for (const k of ['name', 'description']) {
    if (out[k] === '' || out[k] === true) delete out[k];
  }
  return out;
}

/** Which inputs still need a prompt once --name is known. */
export function missingInputs(opts) {
  const missing = [];
  if (!opts.description) missing.push('description');
  if (opts.tags === undefined) missing.push('tags');
  return missing;
}

/** Comma-separated tags → array; anything else (absent, bare flag) → []. */
export function parseTags(raw) {
  return typeof raw === 'string' ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
}

// === Shell helpers ============================================================

async function sh(cmd, args) {
  const { stdout } = await execFileP(cmd, args);
  return stdout.trim();
}

async function shOk(cmd, args) {
  try { await execFileP(cmd, args); return true; }
  catch { return false; }
}

function runStreamed(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`)));
  });
}

// === Interactive prompts ======================================================

async function withReadline(fn) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try { return await fn(rl); }
  finally { rl.close(); }
}

async function promptUntilValid(rl, question, validate, { allowEmpty = false } = {}) {
  for (;;) {
    const raw = (await rl.question(question)).trim();
    if (!raw && allowEmpty) return '';
    const err = validate(raw);
    if (!err) return raw;
    console.error(`  ✗ ${err}`);
  }
}

function requireTTY() {
  if (!stdin.isTTY) {
    throw new Error('interactive prompts require a TTY — pass --name and --description as flags for non-interactive use');
  }
}

// === Pre-flight ===============================================================

async function preflight() {
  if (!(await shOk('git', ['rev-parse', '--git-dir']))) {
    throw new Error('not inside a git repo');
  }
  if (!(await shOk('git', ['rev-parse', 'HEAD']))) {
    throw new Error('no commits yet — make at least one commit before publishing');
  }
  const existing = await sh('git', ['remote', 'get-url', 'origin']).catch(() => '');
  if (existing) {
    throw new Error(`origin remote already exists (${existing}). Rename or remove it first.`);
  }
  const branch = await sh('git', ['symbolic-ref', '--short', 'HEAD']);
  if (branch !== 'main') {
    throw new Error(`current branch is "${branch}", expected "main". Rename with: git branch -m main`);
  }
}

// === Main =====================================================================

function help() {
  console.log(`Usage: scripts/new-repo.mjs [--name=<repo-name>] [--description="..."] [--tags=t1,t2] [--here|--new]

Publishes a repo as a new GitHub repo under your org and registers it in
household.json through a PR. The org is resolved from household.json: the
meta_repo entry's "url" must point at github.com/<org>/<repo>.

Where the repo comes from is decided by where you run it, not asked:

  household root     --new: scaffold ./<name>/ (mkdir, git init -b main,
                     starter README, initial commit), then publish it.
  inside a checkout  --here: publish the current directory (a git repo with
                     at least one commit on main and no origin).

Pass --here or --new to override. Run with no flags to be prompted for name
prefix, repo suffix, description and tags. Omit --tags to be asked for them;
--tags= (empty) means no tags and is not prompted for, which is what
\`make repos-create NAME=… DESCRIPTION=…\` sends — so that call never prompts.

What it does:
  1. Create a throwaway worktree of the meta-repo on origin/main and check
     the name is free in household.json there.
  2. (--new) Scaffold ./<name>/.
  3. Pre-flight: git repo, has commits, on "main", no "origin" remote.
  4. gh repo create <org>/<name> --private; add origin; git push -u origin main
  5. Add the entry to household.json in the worktree, commit it on
     chore/repos-create-<name>, push.
  6. Apply branch protection and team access from that manifest
     (repo-policy.mjs apply / access-apply; best-effort).
  7. Open the PR. This checkout's branch, index and uncommitted changes are
     never touched.

The new entry gets the teamAccess grants every managed repo already shares
(omitted when there are none) and branchProtection with no required status
check.

Repos are created --private (the most portable default; --internal is
specific to certain GitHub org plans — edit this script if you want it).

Naming: lowercase [a-z0-9] words separated by single hyphens. Single-word
names are allowed (lore, backend, ...), as are prefixed ones (acme-foo).
`);
}

export function resolveModeFromFlags(opts) {
  if (opts.here && opts.new) {
    throw new Error('--here and --new are mutually exclusive');
  }
  if (opts.here) return 'here';
  if (opts.new) return 'new';
  return null;
}

async function gatherInputs(opts) {
  // Flag path: --name given. Validate strictly; only prompt for what is missing.
  if (opts.name) {
    const err = validateName(opts.name);
    if (err) {
      console.error(`Error: ${err}`);
      process.exit(2);
    }
    let description = opts.description;
    let tagsRaw = opts.tags;
    const missing = missingInputs(opts);
    if (missing.length) {
      requireTTY();
      await withReadline(async (rl) => {
        if (missing.includes('description')) {
          description = await promptUntilValid(rl, 'Description? ', v => v ? null : 'description is required');
        }
        if (missing.includes('tags')) {
          tagsRaw = await promptUntilValid(rl, 'Tags (comma-separated, optional)? ', () => null, { allowEmpty: true });
        }
      });
    }
    return { name: opts.name, description, tagsRaw };
  }

  // Interactive path: prompt for prefix → suffix → description → tags.
  requireTTY();
  return withReadline(async (rl) => {
    const prefix = await promptUntilValid(
      rl,
      'Name prefix? (acme, data, platform, ...) > ',
      v => validateSegment(v, 'name prefix'),
    );
    const suffix = await promptUntilValid(
      rl,
      'Repo suffix? (optional — Enter for a single-word name) > ',
      v => validateSegment(v, 'repo suffix'),
      { allowEmpty: true },
    );
    const name = suffix ? `${prefix}-${suffix}` : prefix;
    console.log(`  → repo name: ${name}`);
    const description = opts.description ?? await promptUntilValid(
      rl,
      'Description? ',
      v => v ? null : 'description is required',
    );
    const tagsRaw = opts.tags ?? await promptUntilValid(
      rl,
      'Tags (comma-separated, optional)? ',
      () => null,
      { allowEmpty: true },
    );
    return { name, description, tagsRaw };
  });
}

/** Throw before any side effect if `org/name` cannot be created on GitHub. */
async function assertNameFreeOnGitHub(org, name) {
  const authOk = await shOk('gh', ['auth', 'status']);
  const exists = authOk && await shOk('gh', ['repo', 'view', `${org}/${name}`, '--json', 'name']);
  const problem = githubNameProblem({ authOk, exists, org, name });
  if (problem) throw new Error(problem);
}

/** Refuse a non-empty ./<name>/: it is the user's, never ours to scaffold into. */
async function assertScaffoldTarget(name) {
  const target = path.resolve(process.cwd(), name);
  if (existsSync(target) && (await readdir(target)).length > 0) {
    throw new Error(`directory ${target} already exists and is not empty`);
  }
}

async function seedNewDir(name, description) {
  const target = path.resolve(process.cwd(), name);
  if (!existsSync(target)) await mkdir(target, { recursive: false });
  process.chdir(target);
  await runStreamed('git', ['init', '-b', 'main']);
  const readme = `# ${name}\n\n${description}\n`;
  await writeFile('README.md', readme, 'utf8');
  await runStreamed('git', ['add', 'README.md']);
  await runStreamed('git', ['commit', '-m', 'initial commit']);
}

/** Run a repo-policy.mjs subcommand; resolve to 'applied' or 'failed', never throw. */
async function runPolicy(policyScript, subcommand, name) {
  try {
    await runStreamed('node', [policyScript, subcommand, name, '--yes']);
    return 'applied';
  } catch {
    return 'failed';
  }
}

async function main() {
  const opts = normalizeOpts(parseFlags(process.argv.slice(2)));

  if (opts.help || opts.h) {
    help();
    return;
  }

  let mode;
  try {
    mode = resolveMode(opts, process.cwd(), HOUSEHOLD_ROOT);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(2);
  }

  // Sibling repos and household.json live in the primary checkout only.
  await assertPrimaryCheckout(HOUSEHOLD_ROOT);

  const { name, description, tagsRaw } = await gatherInputs(opts);
  const tags = parseTags(tagsRaw);
  const plan = manifestPrPlan(name);

  console.log(mode === 'new'
    ? `\nScaffolding a new repo in ./${name}/ (run from the household root; pass --here to publish this directory instead).`
    : `\nPublishing the current directory ${process.cwd()} (pass --new to scaffold ./${name}/ instead).`);
  if (!(await isWorkingTreeClean(HOUSEHOLD_ROOT))) {
    console.log('Note: meta-repo has uncommitted changes; they are untouched (the manifest commit is made in a worktree).');
  }

  const steps = mode === 'new' ? 7 : 6;
  let step = 1;
  const stepLabel = () => `[${step++}/${steps}]`;

  // The worktree and the GitHub name check come first, so a taken name or a
  // leftover branch fails before anything is scaffolded or created on GitHub.
  console.log(`\n${stepLabel()} Preparing ${plan.branch} from the base ref...`);
  const base = await resolveBaseRef(HOUSEHOLD_ROOT);
  const worktreePath = await mkdtemp(path.join(tmpdir(), 'household-create-'));
  const [add, ...commitAndPush] = worktreeCommands({
    workspace: HOUSEHOLD_ROOT, worktreePath, branch: plan.branch, base, commitMsg: plan.commitMsg,
  });

  let worktreeAdded = false;
  let scaffolded = false;
  let ghCreated = false;
  let pushed = false;
  let prUrl;
  try {
    try {
      await execFileP(add.cmd, add.args);
      worktreeAdded = true;
    } catch (e) {
      console.error(`Error: could not create worktree for branch "${plan.branch}".`);
      console.error(`  If the branch already exists, an earlier run may have an open PR for it.`);
      console.error(`  If not, delete it and retry: git branch -D ${plan.branch}`);
      throw e;
    }

    // Build from the manifest on the base ref, never this checkout: a local
    // copy may be stale (and would revert upstream entries) or carry an
    // unrelated uncommitted edit.
    const worktreeManifest = path.join(worktreePath, 'household.json');
    const baseManifest = JSON.parse(await readFile(worktreeManifest, 'utf8'));
    const org = resolveOrg(baseManifest);
    const entry = buildRepoEntry({ name, description, tags }, org, { teamAccess: defaultTeamAccess(baseManifest) });
    const updated = addRepoToManifest(baseManifest, entry);
    await assertNameFreeOnGitHub(org, name);
    console.log(`  ok (forked from ${base})`);

    if (mode === 'new') {
      console.log(`\n${stepLabel()} Scaffolding ./${name}/ ...`);
      await assertScaffoldTarget(name);
      scaffolded = true;   // set before seeding: a failure partway still leaves the directory
      await seedNewDir(name, description);
      console.log(`  ok`);
    }

    console.log(`\n${stepLabel()} Pre-flight checks...`);
    await preflight();
    console.log(`  ok`);

    console.log(`\n${stepLabel()} Creating ${org}/${name} on GitHub and pushing main...`);
    await runStreamed('gh', ['repo', 'create', `${org}/${name}`, '--private', '--description', description]);
    ghCreated = true;
    await runStreamed('git', ['remote', 'add', 'origin', `git@github.com:${org}/${name}.git`]);
    await runStreamed('git', ['push', '-u', 'origin', 'main']);

    console.log(`\n${stepLabel()} Committing the household.json entry to ${plan.branch}...`);
    await writeFileAtomic(worktreeManifest, formatRepos(updated));
    for (const { cmd, args } of commitAndPush) await execFileP(cmd, args);
    pushed = true;

    // Run the worktree's own repo-policy.mjs: it reads the household.json next
    // to it, which already has the entry. This checkout's copy does not until
    // the PR merges. Best-effort: a policy failure must not undo the create.
    console.log(`\n${stepLabel()} Applying branch protection and team access...`);
    const policyScript = path.join(worktreePath, 'scripts', 'repo-policy.mjs');
    const policy = {
      protection: await runPolicy(policyScript, 'apply', name),
      access: entry.teamAccess ? await runPolicy(policyScript, 'access-apply', name) : 'skipped',
    };

    console.log(`\n${stepLabel()} Opening PR...`);
    const { stdout: prOut } = await execFileP('gh', [
      'pr', 'create',
      '--head', plan.branch,
      '--title', plan.prTitle,
      '--body', buildPrBody({ entry, org, policy }),
    ], { cwd: worktreePath });
    prUrl = prOut.trim();

    for (const [what, state, target] of [
      ['branch protection', policy.protection, 'policy-apply'],
      ['team access', policy.access, 'access-apply'],
    ]) {
      if (state === 'failed') console.log(`  warning: ${what} failed — run \`make ${target} REPO=${name}\` after the PR merges.`);
    }
  } catch (e) {
    const notes = failureNotes({ name, branch: plan.branch, scaffolded, ghCreated, pushed });
    if (notes.length) console.error(['', ...notes].join('\n'));
    throw e;
  } finally {
    await cleanupWorktree({
      workspace: HOUSEHOLD_ROOT, worktreePath, branch: plan.branch,
      deleteBranch: shouldDeleteBranch({ worktreeAdded, prOpened: Boolean(prUrl) }),
    });
  }

  console.log(`\n✓ ${name} created and pushed; registration PR opened:`);
  console.log(prUrl);
  console.log(`\nThis checkout's branch is unchanged (still on ${await currentBranch(HOUSEHOLD_ROOT)}).`);
  console.log(`household.json here gains the entry once the PR merges and you pull.`);
  if (mode === 'new') console.log(`Next: cd ${name}/   (your shell is still in the parent dir)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err.stack || err.message || err);
    process.exit(1);
  });
}
