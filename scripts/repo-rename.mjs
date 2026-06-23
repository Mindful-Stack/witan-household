#!/usr/bin/env node
// Rename a single sibling repo end-to-end: GitHub rename + household.json update + PR.
//
// Updates an existing entry's name + URL. Teammates then catch their local state
// up via `make repos-sync-names-apply`.
//
// What it does:
//   1. Validate: OLD exists in household.json, NEW doesn't conflict, working tree clean.
//   2. (unless --no-github) Rename on GitHub: `gh repo edit <org>/OLD --rename NEW`,
//      where <org> is read from the entry's own URL.
//   3. Update household.json in place (entry's name + url).
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
import { formatRepos, parseRemoteUrl, renameRepoInUrl } from './manifest.mjs';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = path.join(__dirname, '..', 'household.json');
const WORKSPACE = path.join(__dirname, '..');

// === Pure functions ============================================================

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
 * Pure — does not mutate input. Entries without a `url` (inline repos) get only
 * their `name` changed.
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
    return {
      ...r,
      name: newName,
      url: renameRepoInUrl(r.url, oldName, newName),
    };
  });
  return { ...manifest, repos };
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
  2. (unless --no-github) Rename on GitHub: gh repo edit <org>/OLD --rename NEW
     (<org> is read from the entry's own URL).
  3. Update household.json (entry's name + url).
  4. Create a branch (rename-OLD-to-NEW), commit, push, open PR via gh.
  5. After PR merges, teammates run \`make repos-sync-names-apply\` to update
     their local sibling dir + remote URL.

Requires \`gh\` for the GitHub rename and PR creation.
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

  const raw = await readFile(MANIFEST, 'utf8');
  const manifest = JSON.parse(raw);

  let oldEntry;
  try {
    oldEntry = validateRename(manifest, oldName, newName);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }

  // The GitHub rename needs an org. Derive it from the entry's own URL rather
  // than assuming a single hard-coded org.
  const githubPath = parseRemoteUrl(oldEntry.url);
  const org = githubPath ? githubPath.split('/')[0] : null;
  if (!noGithub && !org) {
    console.error(
      `Error: entry "${oldName}" has no GitHub URL to rename. ` +
      `Rename it on GitHub yourself and re-run with --no-github, ` +
      `or add a \`url\` to the entry first.`,
    );
    process.exit(1);
  }

  if (!(await isWorkingTreeClean(WORKSPACE))) {
    console.error('Error: workspace has uncommitted changes. Commit or stash first.');
    process.exit(1);
  }

  const branch = `rename-${oldName}-to-${newName}`;
  const newUrl = oldEntry.url
    ? renameRepoInUrl(oldEntry.url, oldName, newName)
    : '(none)';

  console.log(`About to rename: ${oldName} → ${newName}`);
  console.log(`  Manifest entry: name="${newName}", url="${newUrl}"`);
  console.log(`  GitHub: ${noGithub ? 'SKIPPED (--no-github)' : `gh repo edit ${org}/${oldName} --rename ${newName}`}`);
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
  if (!noGithub) {
    console.log(`[1/4] gh repo edit ${org}/${oldName} --rename ${newName}`);
    await execFileP('gh', ['repo', 'edit', `${org}/${oldName}`, '--rename', newName]);
  } else {
    console.log('[1/4] GitHub rename skipped (--no-github)');
  }

  // 2. Update household.json
  console.log('[2/4] Updating household.json');
  const updated = applyRenameToManifest(manifest, oldName, newName);
  await writeFile(MANIFEST, formatRepos(updated));

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
      : `GitHub repo already renamed via \`gh repo edit ${org}/${oldName} --rename ${newName}\` (handled by \`repo-rename.mjs\`).\n\n`) +
    `**Teammates after merge:**\n` +
    `1. \`git pull\` in the workspace.\n` +
    `2. \`make repos-sync-names-apply\` to update local sibling dir + remote URL.\n`;
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
