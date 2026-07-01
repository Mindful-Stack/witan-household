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

1. **On your host** — for direct Claude Code use outside any devcontainer. Install via `/plugin marketplace add Mindful-Stack/witan` + `/plugin install lore@witan`.
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
- `tags` is free-form categorisation. The `core` tag is special-cased by `make setup`: pressing Enter at the interactive prompt (or running `make setup-core`) clones just the core-tagged repos.
- `meta_repo` (top-level, required) is a singular pointer to the `repos[]` entry that IS the meta-repo itself. Its `url` is also where the repo-lifecycle tooling derives your GitHub org from (`github.com/<org>/<repo>`) — no org is hardcoded anywhere.
- `knowledge_base` (top-level, optional) is a singular pointer to the entry that holds the KB. Can equal `meta_repo` if the KB is part of the meta-repo with no separate KB entry. If unset, no KB is wired.
- `shared_knowledge_bases` (top-level, optional) is an array of additional, lower-priority KB names — each a pointer to a `repos[]` entry, like `knowledge_base` — e.g. an org-wide standards repo layered underneath the team's own KB. Lorekeeper (1.1.0+) reads them in array order (lowest priority first), with `knowledge_base` highest and the only default write target. When the same relative file exists in more than one KB, the higher-priority file wins outright (whole-file replacement). Each name should also appear as a `repos[]` entry with a `url` so your bootstrap clones it; each directory must contain a `knowledge/` folder. Reeve ignores this field.
- `branchProtection` (top-level, optional) may declare a `bypassTeam: { slug, id }` that the policy tooling grants a PR-mode bypass; per-repo `branchProtection: { requiredStatusCheck }` blocks declare the required CI status check (or `null`). Both are only needed if you use `make policy-*`.

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

This template ships the bootstrap — run `make setup`:

- **Interactive (default):** lists every manifest entry with a number, marks what's already on disk (`[✓]`) and what's `core`-tagged (`*`). Enter clones just core; `all` clones everything; `1,3,5` picks repos.
- **Non-interactive:** `make setup-core`, `make setup-all`, or `./scripts/setup.sh --tag=backend | --repos=a,b`.
- Along the way it enables the Lorekeeper plugin in each cloned sibling's `.claude/settings.local.json` (per-dev, never committed; an explicit opt-out is respected), refreshes the workspace `.claude/settings.json` from the `scripts/claude-settings.json` baseline, and sets `gh`'s git protocol to SSH so `gh`-driven clones match the manifest's `git@github.com:` remotes.
- Re-run it anytime: already-present siblings are skipped, newly-declared ones get cloned.

After bootstrap, each declared sibling is a populated git repo at `<workspace>/<name>/`. Both Reeve and Lorekeeper now have everything they need.

### Selecting which siblings to clone

The shipped `scripts/setup.sh` (run via `make setup`) does the above and adds selection modes so a large workspace doesn't have to clone everything:

```sh
make setup                      # interactive picker in a terminal; clone-all when non-interactive
./scripts/setup.sh --core       # only repos tagged "core"
./scripts/setup.sh --all        # every sibling that has a url
./scripts/setup.sh --tag=web    # only repos tagged "web"
./scripts/setup.sh --repos=a,b  # only the named repos
```

Run with no flags in a terminal, it lists every cloneable sibling — marking those already cloned (`[✓]`) and those tagged `core` (`*`) — and lets you press Enter (core, or all when nothing is tagged `core`), type `all`, or pick by number (`1,3,5`). Run non-interactively (CI, the devcontainer `postCreateCommand`) it clones everything with a `url`, so automated setup stays unattended. Tag the repos most contributors need with `"core"` in `household.json` to make the Enter default useful.

### Adopting an existing folder of sibling repos

If you already have a folder with your sibling repos in it and want to make it a household:

```sh
cd /your/existing/folder
git clone <your-household-repo-url> .witan-tmp
.witan-tmp/scripts/setup.sh
```

`setup.sh` auto-detects the `.witan-tmp/` clone and switches to **adopt mode**: it moves the household's `.git` and files into your folder via `cp -rn` (never clobbering local files), removes `.witan-tmp/`, then continues with the normal flow. Divergent files are listed at the end for manual reconciliation (`git diff` / `git checkout`).

## Workspace tooling

`make help` lists every target. The shared targets live in `scripts/Makefile.shared`; the root `Makefile` includes it and adds the household-specific ones.

### Day-to-day

| Command | What it does |
|---------|--------------|
| `make status` | One-line `git status` per sibling (branch, dirty count, ahead/behind) |
| `make pull` | `git fetch --prune` everywhere; ff-pulls clean `main`/`master` branches |
| `make setup` | Re-run anytime: clones newly-added siblings, re-enables the plugin in each |

### Managing repos

| Command | What it does |
|---------|--------------|
| `make repos-create NAME=foo DESCRIPTION="..." [TAGS=t1,t2]` | Publish the current local repo to your GitHub org and register it in `household.json` (run with no vars for interactive mode) |
| `make repos-rename OLD=foo NEW=bar` | Rename a repo end-to-end: GitHub rename + `household.json` update + opens a PR |
| `make repos-sync-names` | Dry-run: sync local sibling dir names + remote URLs **to match** `household.json` — run after a rename PR merges to catch up |
| `make repos-sync-names-apply` | Execute the renames + URL updates (interactive confirm) |
| `make policy-audit` | Read-only drift check of branch protection across every repo (markdown table) |
| `make policy-apply REPO=foo` | Apply the standard branch-protection policy to one repo (idempotent) |
| `make policy-audit-write` | Audit + persist current state to `household.json` (bootstrap only — typically run once) |
| `make access-apply REPO=foo [DRY_RUN=1]` | Authoritatively reconcile repo `foo`'s team access to its `teamAccess` block (grant/change/revoke); `DRY_RUN=1` previews |
| `make test` | All unit tests: workspace scripts, manifest shape checks (`household-tests/`), KB tooling |

The GitHub org for all of these is derived from the `meta_repo` entry's `url` in `household.json`. Entries without a `url` (inline directories like `lore/`) are skipped wherever a real GitHub repo is required. Auth uses whatever `gh auth status` reports.

### About repo policy

`scripts/repo-policy.mjs` keeps branch protection consistent across every repo in `household.json`. The standard (applied to each repo's default branch): blocks deletion + force-push, requires a PR with 1 review + thread resolution, allows squash-only merges, and — if `branchProtection.bypassTeam` is declared in the manifest — gives that team a PR-mode bypass. The bypass team is optional; without it the policy is simply strict for everyone.

Team access is managed separately from branch protection: declare a `teamAccess` object (`{ "team-slug": "read|triage|write|maintain|admin" }`) on a repo entry, see drift in `make policy-audit`, and enforce it with `make access-apply REPO=<name>`. `access-apply` is authoritative — it revokes teams not in the block — so preview with `DRY_RUN=1` first. A repo with no `teamAccess` key is left unmanaged. Requires `gh` authed with `read:org`.

### Tips

**VS Code / Cursor multi-root:** create a personal `workspace.code-workspace` file (gitignored) at the workspace root, then open via **File → Open Workspace from File…** to see each sibling as its own root in the sidebar:

```json
{
  "folders": [
    { "path": "." },
    { "path": "backend" },
    { "path": "frontend" }
  ]
}
```

## Renaming a sibling repo

When a sibling repo needs a new name, do it once at the source and let teammates reconcile automatically — `household.json` is the single source of truth for repo names.

```sh
make repos-rename OLD=old-name NEW=new-name
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
  "claude plugin marketplace add Mindful-Stack/witan && claude plugin install lore@witan"
]
```
