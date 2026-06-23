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

Click **Use this template** at the top of the GitHub page. Clone the new repo locally. Edit `household.json` to declare your sibling repos. Run your bootstrap to populate them (see below).

### Option C — `git clone`

```sh
git clone https://github.com/Mindful-Stack/witan-household my-workspace
cd my-workspace
rm -rf .git && git init && git add -A && git commit -m "initial workspace"
```

## Adopting witan in an existing project

If you already have a project, you don't need to start fresh. Run `/lore:init` from inside any directory and Lorekeeper detects your state:

### Scenario 1 — greenfield (no project yet)

```sh
mkdir my-workspace && cd my-workspace
# In Claude Code:
/lore:init
```

Lorekeeper scaffolds the witan-household structure (household.json, .devcontainer/, CLAUDE.md, lore/, .gitignore), substitutes the workspace name, and initialises a git repo.

### Scenario 2 — existing single-repo project, no KB yet

```sh
cd ~/Source/my-existing-project
/lore:init
```

Lorekeeper detects the existing `.git/`, asks before touching anything, then adds the workspace files alongside your existing code. Your `.git/` history, your code, and your remote stay exactly as they were — you just gain `household.json`, `lore/`, and the `.devcontainer/` directory.

### Scenario 3 — existing single-repo with `docs/` or `knowledge/` already

Same as Scenario 2, but `/lore:init` notices the existing docs directory. It offers to rename it to `lore/knowledge/` (recommended) or set up `KNOWLEDGE_BASE_PATH` to point at the existing location.

### Scenario 4 — poly-repo (multiple sibling repos)

```sh
mkdir ~/Source/my-workspace && mv ~/Source/backend ~/Source/frontend ~/Source/my-workspace/
cd ~/Source/my-workspace
/lore:init
```

Lorekeeper detects the sibling repos, asks which to include, and populates `household.json` accordingly. The workspace meta-repo wraps them; their individual `.git/` histories are unchanged.

### Scenario 5 — poly-repo + existing separate KB

Same as Scenario 4, plus move your existing KB repo into the workspace as `lore/` (or any other name; declare it in `household.json` and set `knowledge_base` to point at it).

## Two-install reality

Lorekeeper is installed in **two distinct contexts**:

1. **On your host** — for direct Claude Code use outside any devcontainer. Install via `/plugin marketplace add Mindful-Stack/witan` + `/plugin install lorekeeper@witan`.
2. **Inside every Reeve card's container** — automatically, via this template's `.devcontainer/devcontainer.json` `postCreateCommand`.

Same plugin, two install paths, both deliberate. The host install serves general CC work; the container install serves Reeve cards (which run with `--dangerously-skip-permissions`). They don't share state.

If you're not using Reeve, the container install is still useful: any `devcontainer up`-spawned dev shell from this workspace ships with Lorekeeper. If you want to disable it, edit `.devcontainer/devcontainer.json` and remove the last two entries in `postCreateCommand`.

## Declaring sibling repos

Edit `household.json`:

```json
{
  "meta_repo": "my-workspace",
  "knowledge_base": "lore",
  "repos": [
    { "name": "my-workspace", "url": "git@github.com:you/my-workspace.git", "description": "The workspace meta-repo" },
    { "name": "backend",      "url": "git@github.com:you/backend.git",       "tags": ["backend"] },
    { "name": "frontend",     "url": "git@github.com:you/frontend.git",      "tags": ["frontend"] },
    { "name": "lore",         "tags": ["docs"], "description": "The household's knowledge base." }
  ]
}
```

- `repos[]` lists every repo in the workspace, **including the workspace meta-repo itself**.
- `name` is the manifest identifier; for non-workspace entries it's also the directory the sibling clones into.
- `url` is **informational** — used by your bootstrap and by `reeve household show`. Reeve does NOT clone siblings from `url` at card-spawn time; it uses the local directory at `<workspace>/<name>/` as the `--reference` source.
- `tags` is free-form categorisation.
- `meta_repo` (top-level, required) is a singular pointer to the `repos[]` entry that IS the meta-repo itself.
- `knowledge_base` (top-level, optional) is a singular pointer to the entry that holds the KB. Can equal `meta_repo` if the KB is part of the meta-repo with no separate KB entry. If unset, no KB is wired.
- `shared_knowledge_bases` (top-level, optional) is an array of additional, lower-priority KB names — each a pointer to a `repos[]` entry, like `knowledge_base` — e.g. an org-wide standards repo layered underneath the team's own KB. Lorekeeper (1.1.0+) reads them in array order (lowest priority first), with `knowledge_base` highest and the only default write target. When the same relative file exists in more than one KB, the higher-priority file wins outright (whole-file replacement). Each name should also appear as a `repos[]` entry with a `url` so your bootstrap clones it; each directory must contain a `knowledge/` folder. Reeve ignores this field.

```json
{
  "meta_repo": "my-workspace",
  "knowledge_base": "lore",
  "shared_knowledge_bases": ["org-lore"],
  "repos": [
    { "name": "org-lore", "url": "git@github.com:your-org/org-lore.git", "tags": ["docs"], "description": "Org-wide shared knowledge base." }
  ]
}
```

**Sibling vs inline (no manifest distinction — just disk state):** Reeve at clone time looks at each non-workspace `repos[]` entry's directory on the host:
- Has its own `.git/` → it's a separate sibling repo; Reeve clones it for the card via `--reference --dissociate`.
- Exists without `.git/` → it's an inline directory tracked as part of the meta-repo; arrives with the workspace clone.
- Doesn't exist → user forgot to bootstrap; hard error.

The starter `household.json` in this template uses the inline shape for `lore/` — the KB lives inside the meta-repo's git history. To split it into its own repo later, see the "Splitting the lore" section below.

## Bootstrapping siblings

You own this step — write a `Makefile` target, a `bootstrap.sh`, or run `git clone` by hand. A minimal `make setup` target might look like:

```makefile
setup:
	@WORKSPACE=$$(jq -r '.meta_repo' household.json); \
	jq -r --arg ws "$$WORKSPACE" '.repos[] | select(.name != $$ws and .url) | "\(.name) \(.url)"' household.json | \
	while read name url; do \
	  [ -d "$$name" ] || git clone "$$url" "$$name"; \
	done
```

(The filter skips the workspace entry — you're already inside it.)

After bootstrap, each declared sibling is a populated git repo at `<workspace>/<name>/`. Both Reeve and Lorekeeper now have everything they need.

## Renaming a sibling repo

When a sibling repo needs a new name, do it once at the source and let teammates reconcile automatically — `household.json` is the single source of truth for repo names.

```sh
make repo-rename OLD=old-name NEW=new-name
```

This renames the repo on GitHub (org read from the entry's own `url`), updates the matching `household.json` entry's `name` and `url`, then branches, commits, and opens a PR. Pass `--no-github` (e.g. `node ./scripts/repo-rename.mjs old new --no-github`) if you already renamed it on GitHub by hand.

After the PR merges, each teammate catches their local checkout up:

```sh
make repos-sync-names         # dry-run: show what would change
make repos-sync-names-apply   # rename local dirs + fix stale origin URLs
```

`repos-sync-names` matches each sibling directory to `household.json` by its `origin` URL. When a URL is stale (the repo was renamed on GitHub), it follows GitHub's redirect via `gh api` to find the canonical entry, then renames the local directory and updates the remote URL to match the manifest. Directories whose org isn't represented in `household.json` are left untouched.

## The `lore/` knowledge base

`lore/` ships as part of this template — initially tracked in the meta-repo for simplicity. The `lore` entry in `household.json` has no `url`, signalling that it's inline. Replace `_starter.md` files with real knowledge as the workspace matures.

### Splitting the lore

If the KB outgrows the single-repo model (becomes too large, needs an independent contribution / review flow, needs to be shared across multiple households), split it:

```sh
# 1. Remove the inline directory from the meta-repo's history.
git rm -r lore && git commit -m "split lore into its own repo"

# 2. Stop tracking lore/ in the meta-repo. Edit .gitignore — the
#    catch-all `/*` already excludes lore/; just remove the `!/lore/`
#    allowlist line. Commit.

# 3. Clone your separate lore repo as a sibling.
git clone <your-new-lore-repo> lore

# 4. Edit household.json: add a `url` to the `lore` entry so future
#    contributors' bootstrap can clone it.
```

After the split, `lore/` is a sibling repo like any other. The manifest's shape is unchanged — the `lore` entry just acquires a `url`, and Reeve auto-detects the sibling-with-`.git/` shape at clone time.

## Devcontainer

`.devcontainer/devcontainer.json` is a minimal starter — Ubuntu base, Node feature, Claude Code installed via `postCreateCommand`. Reeve uses this when spawning per-card containers; Lorekeeper-only users can `devcontainer up` directly for a clean dev shell.

To install the Lorekeeper plugin inside the container, append to `postCreateCommand`:

```jsonc
"postCreateCommand": [
  "curl -fsSL https://claude.ai/install.sh | bash",
  "claude plugin marketplace add Mindful-Stack/witan && claude plugin install lorekeeper@witan"
]
```
