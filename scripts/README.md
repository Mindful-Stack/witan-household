# scripts/

Workspace tooling for the witan-household. Vendored directly in the meta-repo
(tracked alongside the manifest); structured so it could later be split into
its own repo and mounted back as a git submodule — the same move the `lore/`
knowledge base supports via `make split-lore`.

## Contents

- Bash + Node `.mjs` scripts: `setup.sh`, `pull-all.sh`, `status-all.sh`,
  `rename.sh`, `split-lore.sh`, `new-repo.mjs`, `repo-rename.mjs`,
  `repos-sync-names.mjs`, `repo-policy.mjs`. All stdlib-only — no
  `npm install` required.
- `Makefile.shared` — the shared make targets (`setup`, `pull`, `status`,
  `new-repo`, `repo-rename`, `repos-sync-names`, `policy-*`, `test-scripts`).
  The root `Makefile` does `include scripts/Makefile.shared` and adds the
  household-specific targets (`split-lore`, `rename`, lore tooling).
- `claude-settings.json` — canonical Claude Code baseline. `setup.sh` copies
  it to the workspace root's `.claude/settings.json` on every run; that copy
  is generated, not tracked.

## Conventions

- The GitHub org is never hardcoded: scripts derive it from the manifest's
  `meta_repo` entry's `url` (`github.com/<org>/<repo>`).
- Manifest entries without a `url` are inline directories (e.g. `lore/`) —
  every script skips them where a real GitHub repo is required.
- Bash: `#!/bin/bash`, `set -euo pipefail`, script-relative paths via
  `SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"`.
- Node: `.mjs` ESM, `node:` import prefix on stdlib, no external deps,
  `execFile` not `exec`, pure-function/IO split.
- Tests: co-located `*.test.mjs`, `node:test` + `node:assert/strict`.
  Run with `make test-scripts` (or `make test` for every suite).
