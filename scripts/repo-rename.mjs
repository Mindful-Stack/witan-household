#!/usr/bin/env node
// Rename a single repo end-to-end: GitHub rename + household.json update + PR.
//
// Mirror of new-repo: where new-repo adds an entry to the manifest, repo-rename
// updates an existing entry's name + URL. Teammates then catch their local
// state up by renaming their sibling dir + updating its remote URL.
//
// What it does:
//   1. Validate: OLD exists in household.json, NEW is a legal name, working tree clean.
//   2. (unless --no-github) Rename on GitHub: `gh repo rename NEW --repo <org>/<current-github-repo>`.
//      The org and current GitHub repo name are derived from the entry's `url` in household.json
//      (NOT from the manifest name — they may differ). Entries without a `url` skip this step.
//   3. Update household.json in place (entry's name + url; top-level meta_repo /
//      knowledge_base if the renamed entry is the meta-repo / knowledge base).
//   4. Branch + commit + push + open PR via `gh pr create`.
//   5. Print next steps.
//
// Converge case: when OLD === NEW (and the GitHub repo name differs from the
// manifest name), this is not a no-op — it renames the GitHub repo and rewrites
// the entry's url to match the existing manifest name, without changing the name.
// In interactive mode, pressing Enter at the new-name prompt triggers this when
// the GitHub repo and manifest name diverge.
//
// Usage:
//   ./scripts/repo-rename.mjs                    Interactive: pick repo + enter new name
//   ./scripts/repo-rename.mjs OLD NEW            Full flow
//   ./scripts/repo-rename.mjs OLD OLD            Converge: rename GitHub/url to match the manifest name
//   ./scripts/repo-rename.mjs OLD NEW --no-github    Skip GH rename (already done)
//   ./scripts/repo-rename.mjs OLD NEW --yes          Skip the confirmation prompt
//   ./scripts/repo-rename.mjs OLD NEW --rename-local  Also rename the local sibling folder

import { readFile, writeFile, rename as fsRename, stat, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline/promises';
import path from 'node:path';

import { formatRepos } from './repo-policy.mjs';
import { parseRemoteUrl } from './repos-sync-names.mjs';

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
// Retained for test coverage; superseded in production by deriveGithubTarget/parseRemoteUrl.
export function resolveOrg(manifest) {
  const self = manifest.repos?.find(r => r.name === manifest.meta_repo);
  const m = /github\.com[:/]([^/]+)\//.exec(self?.url || '');
  if (!m) throw new Error('Cannot resolve GitHub org: household.json needs a meta_repo entry whose "url" points at github.com/<org>/<repo>.');
  return m[1];
}

/**
 * Derive the current GitHub org and repo name from an entry's `url`.
 * Returns `{ org, repo }` where `repo` is the real GitHub repo name (which
 * may differ from the manifest name). Returns null when the entry has no url
 * or the url is not a recognisable GitHub url.
 *
 * @param {object} entry - a repos[] entry from household.json
 * @returns {{ org: string, repo: string } | null}
 */
export function deriveGithubTarget(entry) {
  if (!entry.url) return null;
  const parsed = parseRemoteUrl(entry.url);
  if (!parsed) return null;
  const [org, repo] = parsed.split('/');
  return { org, repo };
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
 * Validate that NEW is a legal repo name that doesn't collide with existing
 * entries or equal OLD. Throws a descriptive Error on failure.
 *
 * @param {string} newName
 * @param {string} oldName
 * @param {object} manifest - parsed household.json
 * @param {{ allowSameName?: boolean }} [opts] - when allowSameName is set,
 *   NEW === OLD is accepted (the "converge" case: the manifest name is already
 *   the target and only GitHub/url needs to catch up), and the self-collision
 *   check is skipped. Char validation still applies.
 */
export function validateNewName(newName, oldName, manifest, opts = {}) {
  const { allowSameName = false } = opts;
  if (!newName) throw new Error('NEW name is required.');
  if (!/^[A-Za-z0-9._-]+$/.test(newName)) {
    throw new Error(`"${newName}" is not a valid repo name (allowed: A-Z a-z 0-9 . _ -).`);
  }
  if (newName === oldName) {
    if (allowSameName) return; // converge: same name is intentional, not a self-collision
    throw new Error('OLD and NEW are identical.');
  }
  const collision = manifest.repos.find(r => r.name === newName);
  if (collision) throw new Error(`household.json already has an entry named "${newName}".`);
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
 *
 * The url rewrite uses the CURRENT GitHub repo name (derived from the url via
 * parseRemoteUrl), not the manifest name — so it works correctly even when the
 * manifest name and the GitHub repo name differ.
 *
 * Accepts oldName === newName (the "converge" case): the entry keeps its name
 * and only the url's repo segment is rewritten to match the manifest name. The
 * self-collision check is skipped in that case.
 *
 * Pure — does not mutate input.
 *
 * @param {object} manifest
 * @param {string} oldName
 * @param {string} newName
 * @returns {object} new manifest
 */
export function applyRenameToManifest(manifest, oldName, newName) {
  if (!oldName || !newName) throw new Error('OLD and NEW are required.');
  if (!manifest.repos?.find(r => r.name === oldName)) {
    throw new Error(`No entry named "${oldName}" in household.json.`);
  }
  if (newName !== oldName && manifest.repos.find(r => r.name === newName)) {
    throw new Error(`household.json already has an entry named "${newName}".`);
  }
  const repos = manifest.repos.map(r => {
    if (r.name !== oldName) return r;
    const renamed = { ...r, name: newName };
    if (r.url) {
      // Use the GitHub repo name from the url (not the manifest name) as the
      // segment to replace — they may differ (e.g. manifest "file-extractor"
      // pointing at github.com/org/File-Extract-API.git).
      const parsed = parseRemoteUrl(r.url);
      const currentGhRepo = parsed ? parsed.split('/')[1] : oldName;
      renamed.url = renameRepoInUrl(r.url, currentGhRepo, newName);
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

async function promptLine(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function confirm(question) {
  return /^y(es)?$/i.test((await promptLine(question)).trim());
}

// === Main ======================================================================

function help() {
  console.log(`Usage:
  ./scripts/repo-rename.mjs                    Interactive: pick a repo from a numbered list
  ./scripts/repo-rename.mjs OLD NEW            Full flow: GitHub rename + household.json + PR
  ./scripts/repo-rename.mjs OLD NEW --no-github    Skip GH rename (already done manually)
  ./scripts/repo-rename.mjs OLD NEW --yes          Skip the confirmation prompt
  ./scripts/repo-rename.mjs OLD NEW --rename-local  Also rename the local sibling folder

What it does:
  1. Validate OLD exists in household.json, NEW is a legal name, working tree clean.
  2. (unless --no-github) Rename on GitHub:
       gh repo rename NEW --repo <org>/<current-github-repo>
     The org and current GitHub repo name come from the entry's "url" in household.json,
     so it works even when the manifest name differs from the GitHub repo name.
     Entries without a url (inline directories) skip this step.

Converge (OLD === NEW): when the GitHub repo name differs from the manifest name,
  passing the same name (or pressing Enter in interactive mode) renames the GitHub
  repo + url to match the existing manifest name, leaving the name unchanged.
  3. Update household.json (entry's name + url; top-level meta_repo /
     knowledge_base if the renamed entry is the meta-repo / knowledge base).
  4. Create a branch (rename-OLD-to-NEW), commit, push, open PR via gh.
  5. After PR merges, teammates run \`git pull\` in the household meta-repo and
     either:
     - run \`make repos-sync-names-apply\` to reconcile their local sibling dirs, OR
     - the folder was already renamed locally (--rename-local) and only the
       PR merge + pull is needed.

--rename-local: when set, also renames the local sibling folder and updates its
  origin remote URL. Off by default — without it, teammates reconcile via
  \`make repos-sync-names-apply\`.

Interactive mode: when invoked with no OLD/NEW arguments and stdin is a TTY,
  prints a numbered list of entries with a url, lets you pick one and type a new
  name, then optionally renames the local folder.

Requires \`gh\` for the GitHub rename and PR creation.

Example: ./scripts/repo-rename.mjs acme-foo acme-bar
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    help();
    return;
  }

  const positional = args.filter(a => !a.startsWith('--'));
  const noGithub = args.includes('--no-github');
  const yes = args.includes('--yes');
  let renameLocal = args.includes('--rename-local');

  const raw = await readFile(WORKSPACE_JSON, 'utf8');
  const manifest = JSON.parse(raw);

  let oldName, newName;

  if (positional.length === 0) {
    // Interactive mode — requires a TTY
    if (!process.stdin.isTTY) {
      console.error('Error: OLD and NEW required (stdin is not a TTY).');
      console.error('Usage: ./scripts/repo-rename.mjs OLD NEW [--no-github] [--yes] [--rename-local]');
      process.exit(2);
    }

    const renameable = manifest.repos.filter(r => r.url);
    if (renameable.length === 0) {
      console.error('No entries with a url in household.json (nothing to rename on GitHub).');
      process.exit(1);
    }

    console.log('Repos available to rename:');
    renameable.forEach((r, i) => {
      const ghTarget = deriveGithubTarget(r);
      const ghLabel = ghTarget ? ` → github: ${ghTarget.org}/${ghTarget.repo}` : '';
      console.log(`  ${i + 1}. ${r.name}${ghLabel}`);
    });

    const pick = await promptLine('Pick a number: ');
    const idx = parseInt(pick, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= renameable.length) {
      console.error(`Invalid choice: "${pick}"`);
      process.exit(1);
    }
    const picked = renameable[idx];
    oldName = picked.name;
    const pickedGh = deriveGithubTarget(picked);
    // Converge hint: when the GitHub repo name already differs from the manifest
    // name, the common intent is to rename GitHub (and the url) to match the
    // manifest name — not to pick a brand-new name. Pressing Enter does exactly
    // that.
    const diverges = pickedGh && pickedGh.repo !== oldName;
    const prompt = diverges
      ? `New name for "${oldName}" — GitHub repo is currently "${pickedGh.repo}".\n` +
        `  Press Enter to keep "${oldName}" and rename GitHub to match, or type a new name: `
      : `New name for "${oldName}" (Enter to cancel): `;
    newName = (await promptLine(prompt)).trim();
    if (newName === '') {
      if (diverges) {
        newName = oldName; // converge on the existing manifest name
      } else {
        console.log('Aborted (no new name given).');
        return;
      }
    }

    try {
      validateNewName(newName, oldName, manifest, { allowSameName: true });
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }

    if (!renameLocal) {
      const nameChanges = newName !== oldName;
      const localOldPath = path.join(WORKSPACE, oldName);
      let localFolderExists = false;
      try { await stat(localOldPath); localFolderExists = true; } catch { /* absent */ }
      if (localFolderExists) {
        const ans = nameChanges
          ? await promptLine(`Also rename the local folder '${oldName}' → '${newName}' and update its remote URL? [y/N] `)
          : await promptLine(`Also update the local clone's git remote URL to the renamed GitHub repo? [y/N] `);
        renameLocal = /^y(es)?$/i.test(ans.trim());
      } else {
        console.log(`  Note: no local folder "${oldName}" found — skipping local-update prompt.`);
      }
    }
  } else if (positional.length === 2) {
    [oldName, newName] = positional;
  } else {
    console.error('Error: expected exactly 2 positional args (OLD NEW), or no positional args for interactive mode.');
    help();
    process.exit(2);
  }

  const oldEntry = manifest.repos.find(r => r.name === oldName);
  if (!oldEntry) {
    console.error(`Error: No entry named "${oldName}" in household.json.`);
    process.exit(1);
  }

  // allowSameName: OLD === NEW is the "converge" case (manifest name already
  // correct; only GitHub/url needs to catch up), valid here. The no-op guard
  // below rejects the case where nothing at all would change.
  try {
    validateNewName(newName, oldName, manifest, { allowSameName: true });
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }

  const hasUrl = Boolean(oldEntry.url);
  const ghTarget = hasUrl ? deriveGithubTarget(oldEntry) : null;

  // Fix 1: fail fast when a url is present but unparseable (non-GitHub host, malformed)
  // and the user has not asserted they handled GitHub themselves.
  if (hasUrl && !ghTarget && !noGithub) {
    console.error(`Error: could not parse a GitHub org/repo from url "${oldEntry.url}" for "${oldName}". If the repo was already renamed on GitHub, re-run with --no-github.`);
    process.exit(1);
  }

  // What actually changes. `nameChanges` is a true rename; otherwise we're
  // converging GitHub/url onto the existing manifest name.
  const currentGhRepo = ghTarget ? ghTarget.repo : null;
  const nameChanges = newName !== oldName;
  const githubNeedsRename = Boolean(ghTarget) && !noGithub && currentGhRepo !== newName;
  const newUrl = hasUrl ? renameRepoInUrl(oldEntry.url, currentGhRepo ?? oldName, newName) : null;
  const urlNeedsRewrite = hasUrl && newUrl !== oldEntry.url;
  const isConverge = !nameChanges;

  // No-op guard: reject only when the manifest name, GitHub repo, and url all
  // already agree on NEW — nothing left to do.
  if (!nameChanges && !githubNeedsRename && !urlNeedsRewrite) {
    console.error(`Error: nothing to do — manifest name, GitHub repo, and url already agree on "${newName}".`);
    console.error('To rename the repo, pass a different NEW name.');
    process.exit(1);
  }

  if (!(await isWorkingTreeClean(WORKSPACE))) {
    console.error('Error: household meta-repo has uncommitted changes. Commit or stash first.');
    process.exit(1);
  }

  // Fix 2: preflight local folder rename before any remote/manifest mutation.
  // Only relevant for a true rename — converge keeps the folder name.
  if (renameLocal && hasUrl && nameChanges) {
    const localNewPath = path.join(WORKSPACE, newName);
    let newAlreadyExists = false;
    try { await stat(localNewPath); newAlreadyExists = true; } catch { /* absent — good */ }
    if (newAlreadyExists) {
      console.error(`Error: cannot rename local folder — "${newName}" already exists in the workspace. Resolve the conflict first.`);
      process.exit(1);
    }
  }

  const branch = isConverge ? `sync-github-name-${newName}` : `rename-${oldName}-to-${newName}`;
  const commitMsg = isConverge
    ? `chore: converge ${newName} url on renamed GitHub repo`
    : `rename: ${oldName} → ${newName}`;
  const prTitle = isConverge ? `sync: ${newName} GitHub repo name` : `rename: ${oldName} → ${newName}`;

  if (isConverge) {
    console.log(`About to converge "${newName}" on its GitHub repo (manifest name unchanged):`);
  } else {
    console.log(`About to rename: ${oldName} → ${newName}`);
  }
  console.log(hasUrl
    ? `  Manifest entry: name="${newName}", url="${newUrl}"`
    : `  Manifest entry: name="${newName}" (no url — inline directory, name only)`);
  if (noGithub) {
    console.log('  GitHub: SKIPPED (--no-github)');
  } else if (!hasUrl) {
    console.log('  GitHub: SKIPPED (entry has no url — nothing to rename on GitHub)');
  } else if (githubNeedsRename) {
    console.log(`  GitHub: gh repo rename ${newName} --repo ${ghTarget.org}/${ghTarget.repo}`);
  } else {
    console.log(`  GitHub: already named "${newName}" — nothing to rename`);
  }
  console.log(`  Branch: ${branch}`);
  console.log(`  PR title: "${prTitle}"`);
  if (renameLocal && nameChanges) {
    console.log(`  Local folder: will rename ${oldName} → ${newName} and update remote URL`);
  } else if (renameLocal) {
    console.log(`  Local folder: will update remote URL (name unchanged)`);
  } else {
    console.log(`  Local folder: unchanged (teammates reconcile via make repos-sync-names-apply)`);
  }
  console.log('');

  if (!yes) {
    const ok = await confirm('Proceed? [y/N] ');
    if (!ok) {
      console.log('Aborted.');
      return;
    }
  }

  // 1. GitHub rename. `gh repo rename <new> --repo <org>/<current>` is the
  // correct command — `gh repo edit` has no --rename flag.
  if (noGithub) {
    console.log('[1/4] GitHub rename skipped (--no-github)');
  } else if (!hasUrl) {
    console.log(`[1/4] GitHub rename skipped ("${oldName}" has no url in household.json — inline directory)`);
  } else if (githubNeedsRename) {
    console.log(`[1/4] gh repo rename ${newName} --repo ${ghTarget.org}/${ghTarget.repo}`);
    await execFileP('gh', ['repo', 'rename', newName, '--repo', `${ghTarget.org}/${ghTarget.repo}`, '--yes']);
  } else {
    console.log(`[1/4] GitHub rename skipped (repo is already named "${newName}")`);
  }

  // 2. Update household.json (atomic write)
  console.log('[2/4] Updating household.json');
  const updated = applyRenameToManifest(manifest, oldName, newName);
  await writeFileAtomic(WORKSPACE_JSON, formatRepos(updated));

  // 2b. Optional local folder rename
  // Fix 3: track actual outcome (not just the request) for accurate PR body
  let localRenamed = false;
  let localUrlUpdated = false;
  if (renameLocal && !hasUrl) {
    console.log(`  Note: --rename-local ignored — "${oldName}" is an inline directory (no url; not a separate git repo).`);
  } else if (renameLocal && hasUrl) {
    // The local folder is conventionally named after the manifest name, so it's
    // `oldName` here (which equals `newName` in the converge case).
    const localOldPath = path.join(WORKSPACE, oldName);
    let localExists = false;
    try {
      await stat(localOldPath);
      localExists = true;
    } catch { /* folder doesn't exist */ }

    if (localExists) {
      let finalPath = localOldPath;
      if (nameChanges) {
        finalPath = path.join(WORKSPACE, newName);
        await fsRename(localOldPath, finalPath);
        localRenamed = true;
        console.log(`  Renamed local folder: ${oldName} → ${newName}`);
      }
      if (newUrl && urlNeedsRewrite) {
        await execFileP('git', ['-C', finalPath, 'remote', 'set-url', 'origin', newUrl]);
        localUrlUpdated = true;
        console.log(`  Updated remote URL: ${newUrl}`);
      }
    } else {
      console.log(`  Note: local folder "${oldName}" not found — skipping local update.`);
    }
  }

  // 3. Branch + commit + push
  const cur = await currentBranch(WORKSPACE);
  if (cur !== 'main') {
    console.error(`Warning: current branch is "${cur}", not main. The new branch will fork from here.`);
  }
  console.log(`[3/4] Creating branch ${branch}, committing, pushing`);
  await execFileP('git', ['-C', WORKSPACE, 'checkout', '-b', branch]);
  await execFileP('git', ['-C', WORKSPACE, 'add', 'household.json']);
  await execFileP('git', ['-C', WORKSPACE, 'commit', '-m', commitMsg]);
  await execFileP('git', ['-C', WORKSPACE, 'push', '-u', 'origin', branch]);

  // 4. Open PR
  console.log('[4/4] Opening PR');
  const ghRenameNote = githubNeedsRename
    ? `GitHub repo \`${ghTarget.org}/${currentGhRepo}\` renamed to \`${ghTarget.org}/${newName}\` via \`gh repo rename\` (handled by \`repo-rename.mjs\`).`
    : '';
  const localNote = localRenamed
    ? `Local folder \`${oldName}\` was renamed to \`${newName}\` and its remote URL updated on this machine.`
    : localUrlUpdated
      ? `Local clone's remote URL was updated to the renamed GitHub repo on this machine.`
      : `Local folder was NOT renamed — teammates (and this machine) should run \`make repos-sync-names-apply\` to reconcile.`;

  const summary = isConverge
    ? `Converges \`${newName}\` in household.json onto its renamed GitHub repo (manifest name unchanged; url updated to \`${newUrl}\`).\n\n`
    : `Renames \`${oldName}\` → \`${newName}\` in household.json.\n\n`;

  const body = summary +
    (noGithub
      ? `GitHub rename was done separately (\`--no-github\` flag).\n\n`
      : githubNeedsRename
        ? `${ghRenameNote}\n\n`
        : hasUrl
          ? `No GitHub rename needed — repo is already named \`${newName}\`.\n\n`
          : `No GitHub rename needed — \`${oldName}\` is an inline directory (no \`url\` in household.json).\n\n`) +
    `${localNote}\n\n` +
    `**Teammates after merge:**\n` +
    `1. \`git pull\` in the household meta-repo.\n` +
    (hasUrl
      ? `2. Run \`make repos-sync-names-apply\` to reconcile your local sibling dir and its remote URL.\n`
      : `2. Nothing else — the directory is tracked inline in the meta-repo.\n`);
  const { stdout } = await execFileP('gh', [
    'pr', 'create',
    '--title', prTitle,
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
