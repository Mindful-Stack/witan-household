# witan-household template

A starter template for a **household**: a versioned, shareable bundle of code repos, a knowledge base, and a devcontainer config that together describe a project's working environment.

A witan-household is the input to:
- [**Reeve**](https://github.com/Daniel-Thyselius/reeve) — `reeve household add <git-url>` or `reeve household new <name>` to use this workspace as a parallel-card kanban.
- [**Lorekeeper**](https://github.com/Mindful-Stack/witan) — install the Lorekeeper Claude Code plugin and run it from this directory; it finds `lore/` via sibling-fallback resolution.

Either tool works in isolation. Both tools work together. Neither tool is required — the workspace shape itself is just a convention.

## Getting started

### Option A — `reeve household new`

```sh
reeve household new my-workspace --template https://github.com/Mindful-Stack/witan-household
```

Reeve clones this template to `~/Source/my-workspace/`, sets the manifest's top-level `name` to `my-workspace`, registers the household, and gives you next-step instructions.

### Option B — "Use this template" button

Click **Use this template** at the top of the GitHub page. Clone the new repo locally. Edit `repos.json` to declare your sibling repos. Run your bootstrap to populate them (see below).

### Option C — `git clone`

```sh
git clone https://github.com/Mindful-Stack/witan-household my-workspace
cd my-workspace
rm -rf .git && git init && git add -A && git commit -m "initial workspace"
```

## Declaring sibling repos

Edit `repos.json`:

```json
{
  "name": "my-workspace",
  "knowledge_base": "lore",
  "repos": [
    { "name": "backend",  "url": "git@github.com:you/backend.git",  "tags": ["backend"] },
    { "name": "frontend", "url": "git@github.com:you/frontend.git", "tags": ["frontend"] },
    { "name": "lore",     "tags": ["docs"], "description": "The household's knowledge base." }
  ]
}
```

- `name` is the directory the sibling clones into. Must match what's on disk.
- `url` is **informational** — used by your bootstrap and by `reeve household show`. Reeve does NOT clone siblings from `url` at card-spawn time; it uses the local clone at `<workspace>/<name>/.git` as the `--reference` source.
- `tags` is free-form categorisation.
- `knowledge_base` (top-level) is a singular pointer to the entry that holds the KB. If unset, no KB is wired.

## Bootstrapping siblings

You own this step — write a `Makefile` target, a `bootstrap.sh`, or run `git clone` by hand. A minimal `make setup` target might look like:

```makefile
setup:
	@jq -r '.repos[] | select(.url) | "\(.name) \(.url)"' repos.json | while read name url; do \
	  [ -d "$$name" ] || git clone "$$url" "$$name"; \
	done
```

After bootstrap, each declared sibling is a populated git repo at `<workspace>/<name>/`. Both Reeve and Lorekeeper now have everything they need.

## The `lore/` knowledge base

`lore/` ships as part of this template — initially tracked in the meta-repo for simplicity. Replace `_starter.md` files with real knowledge as the workspace matures.

If the KB outgrows the single-repo model (becomes too large, needs an independent contribution / review flow, needs to be shared across multiple households), split it:

```sh
# In the meta-repo
git rm -r lore && git commit -m "split lore into its own repo"
# Add `lore/` to .gitignore (or rely on the existing /* allowlist if you remove the !/lore/ line)
git clone <your-new-lore-repo> lore
# Add a `url` field to the `lore` entry in repos.json so future contributors can bootstrap
```

After the split, `lore/` is a sibling repo like any other — the manifest and Lorekeeper integration are unchanged.

## Devcontainer

`.devcontainer/devcontainer.json` is a minimal starter — Ubuntu base, Node feature, Claude Code installed via `postCreateCommand`. Reeve uses this when spawning per-card containers; Lorekeeper-only users can `devcontainer up` directly for a clean dev shell.

To install the Lorekeeper plugin inside the container, append to `postCreateCommand`:

```jsonc
"postCreateCommand": [
  "curl -fsSL https://claude.ai/install.sh | bash",
  "claude plugin marketplace add Mindful-Stack/witan && claude plugin install lorekeeper@witan"
]
```
