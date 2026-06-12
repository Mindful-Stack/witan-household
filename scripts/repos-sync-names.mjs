#!/usr/bin/env node
// Reconcile local sibling directories with the canonical names + URLs in
// household.json. Renames dirs and updates stale `origin` URLs after GitHub-side
// repo renames.
//
// Matching strategy: URL exact match first. If the local URL points at a name
// that's no longer in the manifest, `gh api repos/<old>` follows GitHub's
// automatic redirect — if the redirected name matches a manifest entry, the
// sibling is identified and both the local URL and dir name are updated.
//
// Usage:
//   ./scripts/repos-sync-names.mjs              # dry-run
//   ./scripts/repos-sync-names.mjs --apply      # execute (interactive confirm)
//   ./scripts/repos-sync-names.mjs --apply --yes  # non-interactive

import { readFile, readdir, stat, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline/promises';
import path from 'node:path';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_JSON = path.join(__dirname, '..', 'household.json');
const WORKSPACE = path.join(__dirname, '..');

// === Pure functions ============================================================

/**
 * Extract "<org>/<repo>" from a GitHub remote URL. Accepts SSH and HTTPS forms.
 * @returns {string|null}
 */
export function parseRemoteUrl(url) {
  if (!url) return null;
  let m = url.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (m) return m[1];
  m = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (m) return m[1];
  return null;
}

/**
 * Derive the household's GitHub org from the manifest: the `meta_repo` field
 * names the repos[] entry that is the meta-repo itself, and that entry's `url`
 * points at github.com/<org>/<repo>.
 */
export function resolveOrg(manifest) {
  const self = manifest.repos?.find(r => r.name === manifest.meta_repo);
  const m = /github\.com[:/]([^/]+)\//.exec(self?.url || '');
  if (!m) throw new Error('Cannot resolve GitHub org: household.json needs a meta_repo entry whose "url" points at github.com/<org>/<repo>.');
  return m[1];
}

/**
 * Plan what to do for each sibling. Pure: gh resolution happens upstream and
 * each sibling carries its own `resolvedGithubPath` (or omits it).
 *
 * @param {object} manifest - parsed household.json
 * @param {Array<{
 *   dirName: string,
 *   remoteUrl: string|null,
 *   resolvedGithubPath?: string|null,
 * }>} siblings
 * @returns {{
 *   actions: Array<{
 *     dirName: string,
 *     targetName: string,
 *     targetUrl: string,
 *     needsRename: boolean,
 *     needsUrlUpdate: boolean,
 *   }>,
 *   alreadyCanonical: string[],
 *   notInManifest: Array<{dirName, remoteUrl, githubPath}>,
 *   noGit: string[],
 * }}
 */
export function planActions(manifest, siblings) {
  const pathToEntry = new Map();
  for (const repo of manifest.repos) {
    // The meta-repo entry is the household root itself, never a rename
    // candidate. Url-less entries are inline dirs tracked in the meta-repo
    // (no own .git); parseRemoteUrl returns null for them anyway.
    if (repo.name === manifest.meta_repo) continue;
    const p = parseRemoteUrl(repo.url);
    if (p) pathToEntry.set(p, repo);
  }

  const actions = [];
  const alreadyCanonical = [];
  const notInManifest = [];
  const noGit = [];

  for (const sib of siblings) {
    if (!sib.remoteUrl) {
      noGit.push(sib.dirName);
      continue;
    }
    const githubPath = parseRemoteUrl(sib.remoteUrl);

    // Try direct URL match; fall back to redirect-resolved path
    let entry = githubPath ? pathToEntry.get(githubPath) : null;
    if (!entry && sib.resolvedGithubPath) {
      entry = pathToEntry.get(sib.resolvedGithubPath);
    }
    if (!entry) {
      notInManifest.push({ dirName: sib.dirName, remoteUrl: sib.remoteUrl, githubPath });
      continue;
    }

    const targetPath = parseRemoteUrl(entry.url);
    const needsRename = sib.dirName !== entry.name;
    const needsUrlUpdate = githubPath !== targetPath;

    if (!needsRename && !needsUrlUpdate) {
      alreadyCanonical.push(entry.name);
    } else {
      actions.push({
        dirName: sib.dirName,
        targetName: entry.name,
        targetUrl: entry.url,
        needsRename,
        needsUrlUpdate,
      });
    }
  }

  return { actions, alreadyCanonical, notInManifest, noGit };
}

/**
 * If cwd lives inside an action's dir AND that action renames the dir, return
 * the action (so the caller can refuse to apply). URL-only updates don't
 * invalidate cwd and are safe.
 */
export function cwdInsideRename(cwd, workspace, actions) {
  for (const a of actions) {
    if (!a.needsRename) continue;
    const renamedAbs = path.resolve(workspace, a.dirName);
    const rel = path.relative(renamedAbs, cwd);
    const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    if (inside) return a;
  }
  return null;
}

// === I/O =======================================================================

async function getRemoteUrl(dirPath) {
  try {
    const { stdout } = await execFileP('git', ['-C', dirPath, 'remote', 'get-url', 'origin']);
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Resolve a GitHub repo path through redirects via `gh api`. GitHub auto-
 * redirects renamed repos; the response's `full_name` reflects the current
 * name. Returns null on any failure (gh missing, 404, network, auth).
 */
async function resolveRedirect(githubPath) {
  if (!githubPath) return null;
  try {
    const { stdout } = await execFileP('gh', ['api', `repos/${githubPath}`]);
    const data = JSON.parse(stdout);
    return data.full_name || null;
  } catch {
    return null;
  }
}

async function listSiblings(workspaceDir, manifest, org) {
  const entries = await readdir(workspaceDir, { withFileTypes: true });
  const siblings = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dirPath = path.join(workspaceDir, e.name);
    let hasGit = false;
    try {
      const s = await stat(path.join(dirPath, '.git'));
      hasGit = s.isDirectory() || s.isFile();
    } catch { /* no .git — e.g. an inline dir like lore/ tracked in the meta-repo */ }
    const remoteUrl = hasGit ? await getRemoteUrl(dirPath) : null;
    siblings.push({ dirName: e.name, remoteUrl });
  }

  // For household-org URLs that aren't in the manifest, ask GitHub whether
  // the repo was renamed. Runs in parallel; failures are silently ignored.
  const manifestPaths = new Set(
    manifest.repos.map(r => parseRemoteUrl(r.url)).filter(Boolean),
  );
  await Promise.all(siblings.map(async sib => {
    if (!sib.remoteUrl) return;
    const p = parseRemoteUrl(sib.remoteUrl);
    if (!p || manifestPaths.has(p)) return;
    if (!p.startsWith(`${org}/`)) return;
    sib.resolvedGithubPath = await resolveRedirect(p);
  }));

  return siblings;
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

// === Output ====================================================================

export function describeAction(a) {
  if (a.needsRename && a.needsUrlUpdate) {
    return `${a.dirName}  →  ${a.targetName}  (+ update remote URL)`;
  }
  if (a.needsRename) {
    return `${a.dirName}  →  ${a.targetName}`;
  }
  return `${a.dirName}  (update remote URL)`;
}

function printPlan(plan, org) {
  const canon = [...plan.alreadyCanonical].sort();
  const acts = [...plan.actions].sort((a, b) => a.dirName.localeCompare(b.dirName));

  console.log('Household siblings:');
  if (canon.length === 0 && acts.length === 0) {
    console.log(`  (no ${org} repos detected)`);
  } else {
    for (const c of canon) console.log(`  ✓ ${c}`);
    for (const a of acts) {
      const mark = a.needsRename ? '↻' : '↺';
      console.log(`  ${mark} ${describeAction(a)}`);
    }
  }

  if (plan.notInManifest.length > 0) {
    console.log('');
    console.log('Unmatched (not in household.json):');
    for (const u of plan.notInManifest) {
      console.log(`  ? ${u.dirName}  remote: ${u.remoteUrl}`);
    }
  }

  if (plan.noGit.length > 0) {
    console.log('');
    console.log('Skipped (no git remote):');
    for (const d of [...plan.noGit].sort()) console.log(`  - ${d}`);
  }

  const renameCount = plan.actions.filter(a => a.needsRename).length;
  const urlCount = plan.actions.filter(a => a.needsUrlUpdate).length;
  console.log('');
  console.log(
    `Summary: ${renameCount} rename(s), ${urlCount} URL update(s), ` +
    `${plan.alreadyCanonical.length} already canonical, ` +
    `${plan.notInManifest.length} unmatched, ${plan.noGit.length} non-git.`,
  );
}

// === Main ======================================================================

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const yes = args.includes('--yes') || args.includes('--no-confirm');
  const help = args.includes('--help') || args.includes('-h');

  if (help) {
    console.log(`Usage:
  ./scripts/repos-sync-names.mjs              Dry-run: print pending actions.
  ./scripts/repos-sync-names.mjs --apply      Execute (interactive confirm).
  ./scripts/repos-sync-names.mjs --apply --yes  Skip the confirmation prompt.

For each sibling directory, the script:
  1. Reads its 'origin' remote URL.
  2. Matches the URL against household.json. If it matches, the dir is renamed
     to the manifest's canonical name (when different).
  3. If the URL doesn't match, resolves it through \`gh api repos/<path>\`
     (which follows GitHub's automatic redirects after a repo rename). If
     the resolved name is in household.json, the local remote URL is updated
     AND the directory is renamed to match the manifest.
  4. Otherwise the directory is reported as 'unmatched'.

The GitHub org is derived from household.json's meta_repo entry (its "url"
must point at github.com/<org>/<repo>). Dirs whose URL isn't for that org —
and inline dirs without their own .git (e.g. lore/) — are left alone.
Falls back to URL-exact matching when \`gh\` is unavailable.
`);
    return;
  }

  const manifest = JSON.parse(await readFile(WORKSPACE_JSON, 'utf8'));
  const org = resolveOrg(manifest);
  const siblings = await listSiblings(WORKSPACE, manifest, org);
  const plan = planActions(manifest, siblings);

  printPlan(plan, org);

  if (plan.actions.length === 0) return;

  if (!apply) {
    console.log('');
    console.log('Re-run with --apply to execute.');
    return;
  }

  const blocker = cwdInsideRename(process.cwd(), WORKSPACE, plan.actions);
  if (blocker) {
    console.error('');
    console.error(`Cannot apply: current working directory is inside "${blocker.dirName}".`);
    console.error('Renaming the directory would invalidate this shell\'s cwd.');
    console.error('Re-run from the household root (or any directory outside the pending rename).');
    process.exit(1);
  }

  if (!yes) {
    console.log('');
    const ok = await confirm(`Apply ${plan.actions.length} action(s)? [y/N] `);
    if (!ok) {
      console.log('Aborted.');
      return;
    }
  }

  console.log('');
  for (const a of plan.actions) {
    // URL update first (path is stable); then rename. Either is independently
    // safe to retry.
    const dirPath = path.join(WORKSPACE, a.dirName);
    if (a.needsUrlUpdate) {
      await execFileP('git', ['-C', dirPath, 'remote', 'set-url', 'origin', a.targetUrl]);
      console.log(`  ${a.dirName}: remote → ${a.targetUrl}`);
    }
    if (a.needsRename) {
      await rename(dirPath, path.join(WORKSPACE, a.targetName));
      console.log(`  ${a.dirName} → ${a.targetName}`);
    }
  }
  console.log('Done.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err.stack || err.message || err);
    process.exit(1);
  });
}
