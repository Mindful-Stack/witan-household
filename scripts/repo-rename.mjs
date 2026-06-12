#!/usr/bin/env node
// Rename a single repo end-to-end: GitHub rename + household.json update + PR.
//
// Mirror of new-repo: where new-repo adds an entry to the manifest, repo-rename
// updates an existing entry's name + URL. Teammates then catch their local
// state up by renaming their sibling dir + updating its remote URL.
//
// What it does:
//   1. Validate: OLD exists in household.json, NEW doesn't conflict, working tree clean.
//   2. (unless --no-github) Rename on GitHub: `gh repo edit <org>/OLD --rename NEW`.
//      The org is derived from the meta_repo entry's url in household.json.
//      Entries without a `url` (inline directories) skip this step.
//   3. Update household.json in place (entry's name + url; top-level meta_repo /
//      knowledge_base if the renamed entry is the meta-repo / knowledge base).
//   4. Branch + commit + push + open PR via `gh pr create`.
//   5. Print next steps.
//
// Usage:
//   ./scripts/repo-rename.mjs OLD NEW                Full flow
//   ./scripts/repo-rename.mjs OLD NEW --no-github    Skip GH rename (already done)
//   ./scripts/repo-rename.mjs OLD NEW --yes          Skip the confirmation prompt

import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline/promises';
import path from 'node:path';

import { formatRepos } from './repo-policy.mjs';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_JSON = path.join(__dirname, '..', 'household.json');
const WORKSPACE = path.join(__dirname, '..');

// === Pure functions ============================================================

/**
 * Derive the GitHub org from the manifest's own meta-repo entry.
 *
 * The household has no hardcoded org: the meta_repo entry's `url` is the
 * source of truth. Works for both ssh (git@github.com:org/repo.git) and
 * https (https://github.com/org/repo.git) forms.
 *
 * @param {object} manifest - parsed household.json
 * @returns {string} the GitHub org
 */
export function resolveOrg(manifest) {
  const self = manifest.repos?.find(r => r.name === manifest.meta_repo);
  const m = /github\.com[:/]([^/]+)\//.exec(self?.url || '');
  if (!m) throw new Error('Cannot resolve GitHub org: household.json needs a meta_repo entry whose "url" points at github.com/<org>/<repo>.');
  return m[1];
}

/**
 * Rewrite the trailing repo name in a remote URL, preserving its form. Matches
 * the final `/<oldName>` segment with an optional `.git` suffix, anchored at the
 * end of the string, so it works for SSH and HTTPS URLs with or without `.git`
 * (`parseRemoteUrl` elsewhere accepts both forms) and never touches an org
 * segment that merely shares the name. Returns the URL unchanged when it's
 * falsy or doesn't end in `<oldName>`.
 *
 * @param {string|null|undefined} url
 * @param {string} oldName
 * @param {string} newName
 * @returns {string|null|undefined}
 */
export function renameRepoInUrl(url, oldName, newName) {
  if (!url) return url;
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return url.replace(new RegExp(`/${escaped}(\\.git)?$`), `/${newName}$1`);
}

/**
 * Validate OLD/NEW against the manifest. Returns the matched entry or throws.
 *
 * @param {object} manifest - parsed household.json
 * @param {string} oldName
 * @param {string} newName
 * @returns {object} the matched entry
 */
export function validateRename(manifest, oldName, newName) {
  if (!oldName || !newName) {
    throw new Error('OLD and NEW are required.');
  }
  if (oldName === newName) {
    throw new Error('OLD and NEW are identical.');
  }
  const oldEntry = manifest.repos.find(r => r.name === oldName);
  if (!oldEntry) {
    throw new Error(`No entry named "${oldName}" in household.json.`);
  }
  const collision = manifest.repos.find(r => r.name === newName);
  if (collision) {
    throw new Error(`household.json already has an entry named "${newName}".`);
  }
  return oldEntry;
}

/**
 * Return a new manifest with the matching entry's `name` and `url` updated.
 * Entries without a `url` (inline directories, e.g. the knowledge base) get
 * only their `name` updated. If the renamed entry is the meta-repo or the
 * knowledge base, the top-level `meta_repo` / `knowledge_base` field follows.
 * Pure — does not mutate input.
 *
 * @param {object} manifest
 * @param {string} oldName
 * @param {string} newName
 * @returns {object} new manifest
 */
export function applyRenameToManifest(manifest, oldName, newName) {
  validateRename(manifest, oldName, newName);
  const repos = manifest.repos.map(r => {
    if (r.name !== oldName) return r;
    const renamed = { ...r, name: newName };
    if (r.url) {
      renamed.url = renameRepoInUrl(r.url, oldName, newName);
    }
    return renamed;
  });
  const updated = { ...manifest, repos };
  if (manifest.meta_repo === oldName) updated.meta_repo = newName;
  if (manifest.knowledge_base === oldName) updated.knowledge_base = newName;
  return updated;
}

// === I/O =======================================================================

async function isWorkingTreeClean(dir) {
  const { stdout } = await execFileP('git', ['-C', dir, 'status', '--porcelain']);
  return stdout.trim() === '';
}

async function currentBranch(dir) {
  const { stdout } = await execFileP('git', ['-C', dir, 'branch', '--show-current']);
  return stdout.trim();
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// === Main ======================================================================

function help() {
  console.log(`Usage:
  ./scripts/repo-rename.mjs OLD NEW                Full flow: GitHub rename + household.json + PR
  ./scripts/repo-rename.mjs OLD NEW --no-github    Skip GH rename (already done manually)
  ./scripts/repo-rename.mjs OLD NEW --yes          Skip the confirmation prompt

What it does:
  1. Validate OLD exists in household.json, NEW doesn't conflict, working tree clean.
  2. (unless --no-github) Rename on GitHub: gh repo edit <your GitHub org>/OLD --rename NEW
     (org derived from the meta_repo entry's url in household.json; entries
     without a url — inline directories — skip this step)
  3. Update household.json (entry's name + url; top-level meta_repo /
     knowledge_base if the renamed entry is the meta-repo / knowledge base).
  4. Create a branch (rename-OLD-to-NEW), commit, push, open PR via gh.
  5. After PR merges, teammates run \`git pull\` in the household meta-repo and
     rename their local sibling dir + update its remote URL.

Requires \`gh\` for the GitHub rename and PR creation.

Example: ./scripts/repo-rename.mjs acme-foo acme-bar
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    help();
    return;
  }

  const positional = args.filter(a => !a.startsWith('--'));
  const noGithub = args.includes('--no-github');
  const yes = args.includes('--yes');

  if (positional.length !== 2) {
    console.error('Error: expected exactly 2 positional args (OLD NEW).');
    help();
    process.exit(2);
  }
  const [oldName, newName] = positional;

  const raw = await readFile(WORKSPACE_JSON, 'utf8');
  const manifest = JSON.parse(raw);

  let oldEntry;
  try {
    oldEntry = validateRename(manifest, oldName, newName);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }

  const hasUrl = Boolean(oldEntry.url);

  // Resolve the org at runtime, only when we actually need it for the GitHub
  // rename (never at module top-level — tests import the pure functions).
  let org = null;
  if (!noGithub && hasUrl) {
    try {
      org = resolveOrg(manifest);
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  }

  if (!(await isWorkingTreeClean(WORKSPACE))) {
    console.error('Error: household meta-repo has uncommitted changes. Commit or stash first.');
    process.exit(1);
  }

  const branch = `rename-${oldName}-to-${newName}`;
  const newUrl = hasUrl ? renameRepoInUrl(oldEntry.url, oldName, newName) : null;

  console.log(`About to rename: ${oldName} → ${newName}`);
  console.log(hasUrl
    ? `  Manifest entry: name="${newName}", url="${newUrl}"`
    : `  Manifest entry: name="${newName}" (no url — inline directory, name only)`);
  console.log(`  GitHub: ${noGithub
    ? 'SKIPPED (--no-github)'
    : hasUrl
      ? `gh repo edit ${org}/${oldName} --rename ${newName}`
      : 'SKIPPED (entry has no url — nothing to rename on GitHub)'}`);
  console.log(`  Branch: ${branch}`);
  console.log(`  PR title: "rename: ${oldName} → ${newName}"`);
  console.log('');

  if (!yes) {
    const ok = await confirm('Proceed? [y/N] ');
    if (!ok) {
      console.log('Aborted.');
      return;
    }
  }

  // 1. GitHub rename
  if (noGithub) {
    console.log('[1/4] GitHub rename skipped (--no-github)');
  } else if (!hasUrl) {
    console.log(`[1/4] GitHub rename skipped ("${oldName}" has no url in household.json — inline directory)`);
  } else {
    console.log(`[1/4] gh repo edit ${org}/${oldName} --rename ${newName}`);
    await execFileP('gh', ['repo', 'edit', `${org}/${oldName}`, '--rename', newName]);
  }

  // 2. Update household.json
  console.log('[2/4] Updating household.json');
  const updated = applyRenameToManifest(manifest, oldName, newName);
  await writeFile(WORKSPACE_JSON, formatRepos(updated));

  // 3. Branch + commit + push
  const cur = await currentBranch(WORKSPACE);
  if (cur !== 'main') {
    console.error(`Warning: current branch is "${cur}", not main. The new branch will fork from here.`);
  }
  console.log(`[3/4] Creating branch ${branch}, committing, pushing`);
  await execFileP('git', ['-C', WORKSPACE, 'checkout', '-b', branch]);
  await execFileP('git', ['-C', WORKSPACE, 'add', 'household.json']);
  await execFileP('git', ['-C', WORKSPACE, 'commit', '-m', `rename: ${oldName} → ${newName}`]);
  await execFileP('git', ['-C', WORKSPACE, 'push', '-u', 'origin', branch]);

  // 4. Open PR
  console.log('[4/4] Opening PR');
  const body = `Renames \`${oldName}\` → \`${newName}\`.\n\n` +
    (noGithub
      ? `GitHub rename was done separately (\`--no-github\` flag).\n\n`
      : hasUrl
        ? `GitHub repo already renamed via \`gh repo edit ${org}/${oldName} --rename ${newName}\` (handled by \`repo-rename.mjs\`).\n\n`
        : `No GitHub rename needed — \`${oldName}\` is an inline directory (no \`url\` in household.json).\n\n`) +
    `**Teammates after merge:**\n` +
    `1. \`git pull\` in the household meta-repo.\n` +
    (hasUrl
      ? `2. Run \`make repos-sync-names-apply\` to rename your local sibling dir and update its remote URL\n` +
        `   (or manually: \`mv ${oldName} ${newName} && git -C ${newName} remote set-url origin ${newUrl}\`).\n`
      : `2. Nothing else — the directory is tracked inline in the meta-repo.\n`);
  const { stdout } = await execFileP('gh', [
    'pr', 'create',
    '--title', `rename: ${oldName} → ${newName}`,
    '--body', body,
  ]);
  console.log(stdout.trim());
  console.log('');
  console.log('Done.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err.stack || err.message || err);
    process.exit(1);
  });
}
