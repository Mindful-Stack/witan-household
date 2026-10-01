# scripts/

Workspace tooling for the witan-household. Vendored directly in the meta-repo
(tracked alongside the manifest); structured so it could later be split into
its own repo and mounted back as a git submodule — the same move the `lore/`
knowledge base supports via `make split-lore`.

## Contents

- Bash + Node `.mjs` scripts: `setup.sh`, `pull-all.sh`, `status-all.sh`,
  `update-kb.sh`, `rename.sh`, `split-lore.sh`, `new-repo.mjs`,
  `repo-rename.mjs`, `repos-sync-names.mjs`, `repo-policy.mjs`.
  All stdlib-only — no `npm install` required.
- `manifest-worktree.mjs` — shared helpers for landing a `household.json`
  change as a PR: base-ref selection, the primary-checkout guard, and the
  throwaway-worktree commit/push/cleanup. Used by `new-repo.mjs`.
- `Makefile.shared` — the shared make targets (`setup`, `pull`, `status`,
  `update-kb`, `repos-create`, `repos-rename`, `repos-sync-names`, `policy-*`,
  `test-scripts`). The root `Makefile` does `include scripts/Makefile.shared`
  and adds household-specific targets (`split-lore`, `rename`, KB tooling).
- `claude-settings.json` — canonical Claude Code baseline. `setup.sh` copies
  it to the workspace root's `.claude/settings.json` on every run; that copy
  is generated, not tracked.

## `new-repo.mjs` — create and register a repo

```
make repos-create NAME=my-service DESCRIPTION="Service description" [TAGS=core,backend]
# or, for the interactive prompts:
make repos-create
```

Creates a private GitHub repo in the household org, pushes `main`, and
registers it in `household.json` through a PR.

**Where the repo comes from is decided, not asked.** Run from the workspace
root (which is where `make` runs it), it scaffolds `./<name>/` — `git init -b
main`, a starter README, an initial commit. Run from inside an existing
checkout (`../scripts/new-repo.mjs`), it publishes that checkout (on `main`, at
least one commit, no `origin`). `--new` / `--here` override either default. It
refuses to run from a git worktree of the meta-repo.

**`make repos-create NAME=… DESCRIPTION=…` never prompts.** The make target
then forwards `--tags=`, and an explicitly empty value means "no tags". Omit
`--tags` entirely when calling the script directly to be asked for them.

**The manifest change is a PR, not an uncommitted edit.** The entry is
written, committed on `chore/repos-create-<name>` and pushed from a throwaway
`git worktree` built on `origin/main`, so this checkout's branch, index and
uncommitted changes are never touched and the command is safe to run alongside
other sessions. The worktree, the name check against the manifest there, and a
check that `gh` is signed in and the name is free on GitHub all come before
anything is scaffolded or created, so a name taken in either place fails with
no side effects. A later failure prints what was left behind: a scaffolded
`./<name>/` that never reached GitHub is named as safe to delete.

**The new entry is managed from day one:**

- `teamAccess` — every grant that all repos with a `teamAccess` block share at
  the same level. Omitted, leaving the repo unmanaged, when nothing is shared;
  never `{}`, which would revoke every grant.
- `branchProtection` — `requiredStatusCheck: null`, since a new repo has no CI.

Branch protection and team access are then applied (best-effort) by the
worktree's own `repo-policy.mjs`, which reads the manifest that already has the
entry. The PR body records which steps succeeded and the `make` target to rerun
for any that failed.

## `repo-rename.mjs` — end-to-end repo rename

Renames a single repo: GitHub rename, `household.json` update (atomic write),
branch + PR.

**Interactive mode** (no OLD/NEW args, stdin is a TTY):

```
make repos-rename
# or
./scripts/repo-rename.mjs
```

Prints a numbered list of renameable repos (those with a `url`), showing the
real GitHub repo name alongside the manifest name:

```
Repos available to rename:
  1. my-household → github: acme-org/my-household
  2. file-extractor → github: acme-org/File-Extract-API
Pick a number: 2
New name for "file-extractor": file-extractor-v2
Also rename the local folder 'file-extractor' → 'file-extractor-v2'? [y/N]
```

**Non-interactive mode** (positional args):

```
make repos-rename OLD=file-extractor NEW=file-extractor-v2
# or
./scripts/repo-rename.mjs file-extractor file-extractor-v2 [--no-github] [--yes] [--rename-local]
```

**Manifest name vs GitHub repo name:** the GitHub rename targets the real
repo name from the entry's `url` (`gh repo rename file-extractor-v2 --repo
acme-org/File-Extract-API`), not the manifest name — so it works correctly
even when they differ.

**Converge (`OLD === NEW`):** when the manifest name is already what you want
the GitHub repo called but the GitHub repo still has its old name, pass the
same name (`make repos-rename OLD=portal NEW=portal`, or just press Enter in the
interactive picker). This renames the GitHub repo + url to match the manifest
name without changing the name. Passing identical names when nothing diverges
is rejected as a no-op.

**`--rename-local`:** also renames the local sibling folder and updates its
`origin` remote URL (in the converge case, only the remote URL is updated —
the folder name already matches). Off by default — without it, teammates
reconcile via `make repos-sync-names-apply` after pulling.

## `update-kb.sh` — pull stale knowledge bases

```
make update-kb
```

Fast-forward pulls every KB declared in `household.json`
(`shared_knowledge_bases` + `knowledge_base`). The Lorekeeper SessionStart
hook tells the agent to prompt users with `make update-kb` when KBs are stale.
Uses ff-only safety: only pulls on a clean `main`; fetches all KBs regardless
of per-KB failures.

## `repo-policy.mjs access-apply` — team access

Declare `teamAccess` on a repo entry in `household.json`:

```json
{ "name": "portal", "url": "…", "teamAccess": { "developers": "write", "security": "read" } }
```

Levels: `read · triage · write · maintain · admin`. `make policy-audit` shows a
team-access drift table for every repo; `make access-apply REPO=portal` makes
GitHub match the block **authoritatively** — undeclared teams are revoked. Use
`DRY_RUN=1` to preview. Team ops use each repo's own org (correct for mixed-org
households). Absent `teamAccess` key = unmanaged (skipped); `{}` = no teams.
Requires `gh` with `read:org`. Manages direct grants only (inherited parent-team
access is advisory).

## Conventions

- The GitHub org is never hardcoded: scripts derive it from the manifest's
  `meta_repo` entry's `url` (`github.com/<org>/<repo>`).
- Manifest entries without a `url` are inline directories (e.g. `lore/`) —
  every script skips them where a real GitHub repo is required.
- Manifest name need not equal the GitHub repo name: `repo-rename.mjs` and
  `repos-sync-names.mjs` derive the real GitHub name from the entry's `url`.
- Bash: `#!/bin/bash`, `set -euo pipefail`, script-relative paths via
  `SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"`.
- Node: `.mjs` ESM, `node:` import prefix on stdlib, no external deps,
  `execFile` not `exec`, pure-function/IO split.
- Tests: co-located `*.test.mjs`, `node:test` + `node:assert/strict`.
  Run with `make test-scripts` (or `make test` for every suite).
