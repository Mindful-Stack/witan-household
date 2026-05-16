# CLAUDE.md

Workspace-level guidance for Claude Code across this household.

This directory is a **witan-household meta-repo**. The manifest at `household.json` declares which sibling repos make up the household; each is cloned alongside this one as a gitignored subdirectory. The Lorekeeper plugin (if installed) reads the knowledge base from `lore/` via its sibling-fallback resolution.

## Layout

```
my-workspace/                       ← this directory (the meta-repo)
├── household.json                      ← workspace manifest
├── .devcontainer/devcontainer.json
├── CLAUDE.md                       ← you are here
├── lore/                           ← knowledge base (tracked in this repo by default)
│   └── knowledge/
│       ├── general/, domain/, frameworks/, languages/, learnings/
└── <sibling>/                      ← cloned in by your bootstrap; gitignored
```

## Shell hygiene

- Use `git -C <subdir>` instead of `cd <subdir> && git ...`. Sibling repos sit right alongside; `git -C backend status` is shorter and doesn't leak cwd.
- Prefer relative paths over absolute paths when the target is inside the workspace.

## Where to read more

- `README.md` — human onboarding for this workspace, including how to add sibling repos and (optionally) split the `lore/` into its own repo later.
- `lore/knowledge/` — domain context, standards, learnings. Each `_starter.md` is a placeholder; replace with real content as the workspace matures.
- Each sibling's own `CLAUDE.md` if it has one — project-specific guidance.
