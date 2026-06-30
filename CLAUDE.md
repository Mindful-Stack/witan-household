# CLAUDE.md

Workspace-level guidance for Claude Code across this household.

This directory is a **witan-household meta-repo**. The manifest at `household.json` declares which sibling repos make up the household; each is cloned alongside this one as a gitignored subdirectory by `make setup`. The Lorekeeper plugin (if installed) reads the knowledge base from `lore/` via its sibling-fallback resolution. Per-project `CLAUDE.md` files compose with this one — Claude Code's tree-walk loads both.

## Layout

```
my-workspace/                       ← this directory (the meta-repo)
├── household.json                      ← workspace manifest
├── .devcontainer/devcontainer.json
├── CLAUDE.md                       ← you are here
├── Makefile                        ← `include scripts/Makefile.shared` + household targets
├── scripts/                        ← workspace tooling (setup, repo lifecycle, policy)
├── household-tests/                ← manifest shape checks (run via `make test`)
├── lore/                           ← knowledge base (tracked in this repo by default)
│   └── knowledge/
│       ├── general/, domain/, frameworks/, languages/, learnings/
└── <sibling>/                      ← cloned in by `make setup`; gitignored
```

## Shell hygiene

- Use `git -C <subdir>` instead of `cd <subdir> && git ...`. Sibling repos sit right alongside; `git -C backend status` is shorter and doesn't leak cwd. Same applies to `make -C <subdir> <target>`.
- Prefer relative paths over absolute paths when the target is inside the workspace.
- For non-git tools without a `-C` flag, use a one-shot subshell: `(cd subdir && some-tool)`.

## Workspace tooling

`make help` lists every target. The ones you'll reach for most:

- `make setup` / `setup-core` / `setup-all` — clone siblings declared in `household.json`.
- `make status` / `make pull` — cross-repo git status / fetch+ff-pull.
- `make repos-create`, `make repos-rename OLD= NEW=`, `make repos-sync-names[-apply]` — repo lifecycle; they keep `household.json` in sync and derive the GitHub org from the `meta_repo` entry's `url`.
- `make policy-audit` / `policy-apply REPO=` — branch-protection drift check / apply.
- `make test` — workspace scripts + manifest checks + lore tooling tests.

Manifest entries without a `url` are inline directories (e.g. `lore/`), tracked in this repo rather than cloned — tooling skips them wherever a real GitHub repo is required. See `scripts/README.md` for script conventions.

## Where to read more

- `README.md` — human onboarding for this workspace, including how to add sibling repos and (optionally) split the `lore/` into its own repo later.
- `lore/knowledge/` — domain context, standards, learnings. Each `_starter.md` is a placeholder; replace with real content as the workspace matures.
- Each sibling's own `CLAUDE.md` if it has one — project-specific guidance.
