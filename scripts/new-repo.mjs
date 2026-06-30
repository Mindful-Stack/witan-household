#!/usr/bin/env node
// Publish a local repo as a new GitHub repo in the household org.
//
// Usage: scripts/new-repo.mjs [--name=<repo-name>] [--description="..."] [--tags=t1,t2]
//
// Run with no flags to be walked through prompts (name prefix → suffix →
// description → tags), or pass flags for scripted usage. Run from inside the
// local checkout you want to publish (must be a git repo with at least one
// commit on main and no existing `origin` remote).
//
// The GitHub org is not hardcoded: it is resolved from household.json — the
// repos[] entry named by `meta_repo` must have a "url" pointing at
// github.com/<org>/<repo>.
//
// Flow:
//   1. Pre-flight: in a git repo, has commits, on main, no origin remote.
//   2. Create the GitHub repo (gh repo create ... --private).
//   3. Add origin remote and `git push -u origin main`.
//   4. Append entry to household.json (uses formatRepos to preserve style).
//
// The new entry's household.json change is left uncommitted on the meta-repo so
// the dev can review and commit it themselves.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import path from 'node:path';

import { formatRepos } from './repo-policy.mjs';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOUSEHOLD_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(HOUSEHOLD_ROOT, 'household.json');

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
 * Build the household.json entry for a new repo.
 */
export function buildRepoEntry({ name, description, tags = [] }, org) {
  return {
    name,
    url: `git@github.com:${org}/${name}.git`,
    description,
    tags,
  };
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

async function promptYesNo(rl, question, defaultYes) {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  for (;;) {
    const raw = (await rl.question(`${question} ${hint} `)).trim().toLowerCase();
    if (!raw) return defaultYes;
    if (['y', 'yes'].includes(raw)) return true;
    if (['n', 'no'].includes(raw)) return false;
    console.error(`  ✗ please answer y or n`);
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

Publishes a local repo as a new GitHub repo under your org. The org is
resolved from household.json: the meta_repo entry's "url" must point at
github.com/<org>/<repo>. Two modes:

  --here   Use the current directory (must already be a git repo with at
           least one commit on main and no origin).
  --new    Scaffold a new ./<name>/ subdirectory: mkdir, git init -b main,
           write a starter README, commit, then publish.

Run with no flags to be prompted for: name prefix, repo suffix,
description, tags, and which mode to use. The default is --new when run
from the household root, --here otherwise.

Pre-flight requirements (--here mode):
  - Inside a git repo with at least one commit
  - Current branch is "main"
  - No existing "origin" remote

What it does (--new mode also runs step 0):
  0. mkdir <name>; git init; write README; initial commit
  1. gh repo create <org>/<name> --private
  2. git remote add origin git@github.com:<org>/<name>.git
  3. git push -u origin main
  4. Append entry to ${path.relative(process.cwd(), MANIFEST_PATH)}
  5. Apply branch-protection policy (scripts/repo-policy.mjs apply; best-effort)

Repos are created --private (the most portable default; --internal is
specific to certain GitHub org plans — edit this script if you want it).

After it finishes, commit the updated household.json in the meta-repo.

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
  let flagMode;
  try {
    flagMode = resolveModeFromFlags(opts);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(2);
  }
  const suggestedMode = flagMode ?? defaultMode(process.cwd(), HOUSEHOLD_ROOT);

  // Flag path: --name given. Validate strictly; only prompt for missing description/tags/mode.
  if (opts.name) {
    const err = validateName(opts.name);
    if (err) {
      console.error(`Error: ${err}`);
      process.exit(2);
    }
    let description = opts.description;
    let tagsRaw = opts.tags;
    let mode = flagMode;
    if (!description || tagsRaw === undefined || mode === null) {
      requireTTY();
      await withReadline(async (rl) => {
        if (!description) {
          description = await promptUntilValid(rl, 'Description? ', v => v ? null : 'description is required');
        }
        if (tagsRaw === undefined) {
          tagsRaw = await promptUntilValid(rl, 'Tags (comma-separated, optional)? ', () => null, { allowEmpty: true });
        }
        if (mode === null) {
          mode = await promptMode(rl, opts.name, suggestedMode);
        }
      });
    }
    return { name: opts.name, description, tagsRaw, mode };
  }

  // Interactive path: prompt for prefix → suffix → description → tags → mode.
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
    const mode = flagMode ?? await promptMode(rl, name, suggestedMode);
    return { name, description, tagsRaw, mode };
  });
}

async function promptMode(rl, name, suggested) {
  const cwd = process.cwd();
  console.log(`\nWhere should the new repo live?`);
  console.log(`  - current directory: ${cwd}`);
  console.log(`  - new subdirectory:  ${path.join(cwd, name)}/`);
  const useNew = await promptYesNo(rl, `Create a new subdirectory ./${name}/ ?`, suggested === 'new');
  return useNew ? 'new' : 'here';
}

async function seedNewDir(name, description) {
  const target = path.resolve(process.cwd(), name);
  if (existsSync(target)) {
    const entries = await readdir(target);
    if (entries.length > 0) {
      throw new Error(`directory ${target} already exists and is not empty`);
    }
  } else {
    await mkdir(target, { recursive: false });
  }
  process.chdir(target);
  await runStreamed('git', ['init', '-b', 'main']);
  const readme = `# ${name}\n\n${description}\n`;
  await writeFile('README.md', readme, 'utf8');
  await runStreamed('git', ['add', 'README.md']);
  await runStreamed('git', ['commit', '-m', 'initial commit']);
}

async function main() {
  const opts = parseFlags(process.argv.slice(2));

  if (opts.help || opts.h) {
    help();
    return;
  }

  // Treat empty strings (from `make repos-create` with unset vars) as missing.
  for (const k of ['name', 'description', 'tags']) {
    if (opts[k] === '') delete opts[k];
  }

  const { name, description, tagsRaw, mode } = await gatherInputs(opts);
  const tags = (typeof tagsRaw === 'string' && tagsRaw)
    ? tagsRaw.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  // Resolve the org up front so a misconfigured manifest fails before any
  // side effects (scaffolding, gh repo create, ...).
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const org = resolveOrg(manifest);

  const steps = mode === 'new' ? 6 : 5;
  let step = 1;
  const stepLabel = () => `[${step++}/${steps}]`;

  if (mode === 'new') {
    console.log(`\n${stepLabel()} Scaffolding ./${name}/ ...`);
    await seedNewDir(name, description);
    console.log(`  ok`);
  }

  console.log(`\n${stepLabel()} Pre-flight checks...`);
  await preflight();
  console.log(`  ok`);

  console.log(`\n${stepLabel()} Creating ${org}/${name} on GitHub...`);
  await runStreamed('gh', ['repo', 'create', `${org}/${name}`, '--private', '--description', description]);

  console.log(`\n${stepLabel()} Adding remote and pushing main...`);
  await runStreamed('git', ['remote', 'add', 'origin', `git@github.com:${org}/${name}.git`]);
  await runStreamed('git', ['push', '-u', 'origin', 'main']);

  console.log(`\n${stepLabel()} Adding entry to household.json...`);
  manifest.repos.push(buildRepoEntry({ name, description, tags }, org));
  await writeFile(MANIFEST_PATH, formatRepos(manifest), 'utf8');
  console.log(`  added ${name} to ${path.relative(process.cwd(), MANIFEST_PATH)}`);

  // Best-effort: a policy failure shouldn't undo a successful create+push.
  console.log(`\n${stepLabel()} Applying branch-protection policy...`);
  try {
    await runStreamed('node', [path.join(__dirname, 'repo-policy.mjs'), 'apply', name, '--yes']);
  } catch {
    console.log(`  warning: policy apply failed — run \`make policy-apply REPO=${name}\` later.`);
  }

  console.log(`\n✓ ${name} created, pushed, and registered.`);
  if (mode === 'new') {
    console.log(`\nNext:`);
    console.log(`  - cd ${name}/   (your shell is still in the parent dir)`);
    console.log(`  - review and commit the household.json change in the meta-repo`);
  } else {
    console.log(`\nNext: review and commit the household.json change.`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err.stack || err.message || err);
    process.exit(1);
  });
}
