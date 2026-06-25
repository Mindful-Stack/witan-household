#!/bin/bash
set -euo pipefail

# Bootstrap the witan-household: clone selected sibling repos, enable the
# Lorekeeper plugin in each, refresh the workspace .claude/settings.json.
# Reads the manifest at ./household.json (Node parser; no jq dependency).
#
# Selection modes:
#   (no args)         Interactive picker when run in a terminal; clone-all when
#                     run non-interactively (CI, devcontainer postCreate, etc.).
#   --core            Clone only repos tagged "core".
#   --all             Clone every sibling that has a 'url'.
#   --tag=foo         Clone only repos tagged 'foo'.
#   --repos=a,b,c     Clone only the named repos.
#
# In every mode the workspace meta-repo entry and any entry without a 'url'
# (inline repos such as lore/) are excluded — you're already inside the meta-repo.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Flag parsing ---
MODE=""           # "" (default) | core | all | tag | repos
TAG_FILTER=""
REPOS_FILTER=""
ADOPT=""          # "" | "yes" | "no"  (empty = auto-detect)

for arg in "$@"; do
    case "$arg" in
        --core)     MODE="core" ;;
        --all)      MODE="all" ;;
        --tag=*)    MODE="tag";   TAG_FILTER="${arg#*=}" ;;
        --repos=*)  MODE="repos"; REPOS_FILTER="${arg#*=}" ;;
        --adopt)    ADOPT="yes" ;;
        --no-adopt) ADOPT="no" ;;
        -h|--help)
            cat <<EOF
Usage: $0 [--core | --all | --tag=foo | --repos=name1,name2] [--adopt | --no-adopt]

No args:  interactive picker in a terminal (press Enter for core repos, or
          'all', or comma-separated numbers); clones everything with a 'url'
          when run non-interactively.

Flags:
  --core          Only clone repos tagged 'core'.
  --all           Clone every sibling that has a 'url'.
  --tag=foo       Only clone repos tagged 'foo'.
  --repos=a,b,c   Only clone the named repos.
  --adopt         Force adopt mode (merge this household into the parent folder).
  --no-adopt      Skip adopt-mode auto-detection.

The workspace meta-repo and any entry without a 'url' are always excluded.

Adopt mode (for an existing folder already containing sibling repos):
  cd ~/Source/my-project          # your existing folder of sibling repos
  git clone <household-repo-url> .witan-tmp
  .witan-tmp/scripts/setup.sh

  The script auto-detects when invoked from a .witan-tmp/ clone: it moves the
  household files into the parent folder (never clobbering local files), then
  proceeds with normal setup. --adopt / --no-adopt overrides detection.
EOF
            exit 0
            ;;
        *)
            echo "Unknown flag: $arg" >&2
            exit 2
            ;;
    esac
done

# --- Adoption: bring an existing folder of sibling repos under the household ---
# Auto-detect: script is running from a directory whose basename starts with
# ".witan-tmp" (the conventional temp-clone name). Override with --adopt/--no-adopt.
if [ -z "$ADOPT" ]; then
    case "$(basename "$WORKSPACE")" in
        .witan-tmp|.witan-tmp-*) ADOPT="yes" ;;
        *)                       ADOPT="no" ;;
    esac
fi

if [ "$ADOPT" = "yes" ]; then
    TMP_DIR="$WORKSPACE"
    TARGET="$(cd "$TMP_DIR/.." && pwd)"

    echo "[adopt] Merging the household into $TARGET"

    if [ ! -d "$TMP_DIR/.git" ]; then
        echo "ERROR: $TMP_DIR is not a git clone of a household meta-repo." >&2
        exit 1
    fi
    if [ -e "$TARGET/.git" ]; then
        echo "ERROR: $TARGET already has a .git — adoption would clobber it." >&2
        echo "       If you've already adopted, just run: $TARGET/scripts/setup.sh" >&2
        exit 1
    fi

    # Move .git into place, then merge remaining files without clobbering.
    mv "$TMP_DIR/.git" "$TARGET/.git"
    cp -rn "$TMP_DIR/." "$TARGET/"

    # Cleanup is best-effort: usually succeeds, but if anything blocks it
    # (permissions, locked file, weird FS) surface a clear manual step instead
    # of failing the whole adoption.
    if RM_ERR=$(rm -rf "$TMP_DIR" 2>&1); then
        :
    else
        echo ""
        echo "[adopt] Warning: could not remove $TMP_DIR"
        echo "        $RM_ERR"
        echo "        Adoption succeeded — please remove it manually:"
        echo "          rm -rf $TMP_DIR"
    fi
    echo "[adopt] Done. $TARGET is now a witan-household."

    # Hand off any divergent files to the user for reconciliation.
    cd "$TARGET"
    DIVERGENT=$(git status --porcelain | awk '$1 ~ /M/ {print $2}')
    if [ -n "$DIVERGENT" ]; then
        echo ""
        echo "[adopt] These files in your folder differ from the household:"
        echo "$DIVERGENT" | sed 's/^/          /'
        echo "        Run \`git diff <file>\` to inspect, \`git checkout <file>\` to take the"
        echo "        household version. Continuing setup with your local versions in place."
    fi

    WORKSPACE="$TARGET"
    echo ""
fi

MANIFEST="$WORKSPACE/household.json"

# --- Prereq check ---
echo "[1/3] Checking prerequisites..."
MISSING=""
for tool in git node; do
    if ! command -v "$tool" &>/dev/null; then
        MISSING="$MISSING $tool"
    fi
done
if [ -n "$MISSING" ]; then
    echo "ERROR: Missing required tools:$MISSING" >&2
    exit 1
fi
if [ ! -f "$MANIFEST" ]; then
    echo "ERROR: No household.json at $MANIFEST. Run this from inside a witan-household workspace." >&2
    exit 1
fi
echo "  All prerequisites found."

# --- Manifest helpers (Node, no jq dep) ---

# Tab-separated cloneable candidates in manifest order:
#   <name> \t <url> \t <core 0|1> \t <description>
# "Cloneable" = not the meta-repo entry and has a 'url'.
candidates() {
    node -e "
        const m = require('$MANIFEST');
        m.repos
            .filter(r => r.name !== m.meta_repo && r.url)
            .forEach(r => {
                const core = (r.tags || []).includes('core') ? 1 : 0;
                console.log([r.name, r.url, core, r.description || ''].join('\t'));
            });
    "
}

# Filter the candidate set by mode. Emits "<name>\t<url>" lines.
select_repos() { # $1=mode $2=tag $3=repos-csv
    MODE_ARG="$1" TAG="$2" REPOS_CSV="$3" node -e "
        const m = require('$MANIFEST');
        const mode = process.env.MODE_ARG;
        const tag = process.env.TAG;
        const wanted = process.env.REPOS_CSV.split(',').filter(Boolean);
        let r = m.repos.filter(x => x.name !== m.meta_repo && x.url);
        if (mode === 'core')  r = r.filter(x => (x.tags || []).includes('core'));
        if (mode === 'tag')   r = r.filter(x => (x.tags || []).includes(tag));
        if (mode === 'repos') r = r.filter(x => wanted.includes(x.name));
        r.forEach(x => console.log(x.name + '\t' + x.url));
    "
}

# Enable the Lorekeeper plugin in a sibling's Claude Code project context.
# Writes to .claude/settings.local.json (per-dev, gitignored by Claude Code
# convention). Merges with any existing keys. Respects an explicit user
# override of the flag (true OR false) — only writes if the key is unset.
# Idempotent: silent no-op on re-runs once enabled.
enable_lorekeeper_plugin_for() {
    local sibling_dir="$1"
    [ -d "$sibling_dir" ] || return 0

    mkdir -p "$sibling_dir/.claude"
    local settings_path="$sibling_dir/.claude/settings.local.json"

    node -e "
const fs = require('fs');
const p = process.argv[1];
let cur = {};
if (fs.existsSync(p)) {
  try { cur = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.error('  [plugin] warn: ' + p + ' is not valid JSON; leaving untouched'); process.exit(0); }
}
cur.enabledPlugins = cur.enabledPlugins || {};
// Only set if unset — preserves an explicit user opt-out.
if (!('lore@witan' in cur.enabledPlugins)) {
  cur.enabledPlugins['lore@witan'] = true;
  fs.writeFileSync(p, JSON.stringify(cur, null, 2) + '\n');
  console.log('  [plugin] enabled lore@witan in ' + p);
}
" "$settings_path"
}

# Copy the canonical .claude/settings.json from scripts/ into the workspace
# root. Runs every `setup.sh` invocation so workspaces stay in sync with the
# baseline. The workspace-root file is gitignored (generated, not tracked).
copy_claude_settings() {
    local src="$SCRIPT_DIR/claude-settings.json"
    local dest_dir="$WORKSPACE/.claude"
    local dest="$dest_dir/settings.json"

    if [ ! -f "$src" ]; then
        # No baseline shipped (e.g. an older checkout). Skip silently.
        return 0
    fi

    mkdir -p "$dest_dir"
    cp "$src" "$dest"
    echo "  Updated $dest from scripts/claude-settings.json"
}

# Ensure `gh` uses SSH for git operations on github.com. The household and its
# sibling repos use SSH remotes (`git@github.com:...`) by convention, so
# `gh repo clone` and `gh repo create --clone` clone with SSH. Without this,
# `gh` defaults to HTTPS and the clone push fails in environments without an
# HTTPS credential helper. Idempotent: only writes the config if not `ssh`.
ensure_gh_ssh_protocol() {
    if ! command -v gh >/dev/null 2>&1; then
        echo "  gh CLI not installed; skipping git_protocol check"
        return 0
    fi
    local current
    current="$(gh config get git_protocol --host github.com 2>/dev/null || true)"
    if [ "$current" = "ssh" ]; then
        return 0
    fi
    echo "  Setting gh git_protocol=ssh for github.com (was: ${current:-unset})"
    gh config set git_protocol ssh --host github.com
}

# --- Selection ---
echo ""
echo "[2/3] Selecting repos..."

CAND="$(candidates)"
HAS_CORE=0
if [ -n "$CAND" ] && printf '%s\n' "$CAND" | awk -F'\t' '$3==1{found=1} END{exit !found}'; then
    HAS_CORE=1
fi

# Resolve the default for the empty-mode case: interactive prompt on a TTY,
# otherwise clone-all so automated callers (CI, devcontainer) stay unattended.
if [ -z "$MODE" ] && [ ! -t 0 ]; then
    MODE="all"
fi

SELECTED=""
case "$MODE" in
    core)  SELECTED="$(select_repos core '' '')" ;;
    all)   SELECTED="$(select_repos all '' '')" ;;
    tag)   SELECTED="$(select_repos tag "$TAG_FILTER" '')" ;;
    repos) SELECTED="$(select_repos repos '' "$REPOS_FILTER")" ;;
    "")
        # Interactive picker. Numbers map 1:1 to the candidate list below.
        if [ -z "$CAND" ]; then
            echo "  No cloneable siblings declared (none with a 'url')."
            exit 0
        fi
        i=0
        while IFS=$'\t' read -r name url core desc; do
            i=$((i + 1))
            inst="   "; [ -d "$WORKSPACE/$name" ] && inst="[✓]"
            star=" "; [ "$core" = "1" ] && star="*"
            printf "  %2d) %s %s %s%s\n" "$i" "$inst" "$star" "$name" \
                "$([ -n "$desc" ] && echo " — $desc")"
        done <<< "$CAND"
        echo ""
        echo "  [✓] = already cloned, * = 'core'."
        if [ "$HAS_CORE" -eq 1 ]; then
            echo "  Press Enter to clone core repos, or enter numbers (e.g. 1,3,5), or 'all'."
        else
            echo "  Press Enter to clone all, or enter numbers (e.g. 1,3,5)."
        fi
        printf "  > "
        read -r CHOICE || CHOICE=""
        case "$CHOICE" in
            "")
                if [ "$HAS_CORE" -eq 1 ]; then
                    SELECTED="$(select_repos core '' '')"
                else
                    SELECTED="$(select_repos all '' '')"
                fi
                ;;
            all|ALL)
                SELECTED="$(select_repos all '' '')"
                ;;
            *)
                # Map 1-based indices to candidate lines. Validate every token as
                # an in-range positive integer first — raw input must never reach
                # `sed`, and a bad token must not silently clone an empty URL.
                CAND_COUNT=$(printf '%s\n' "$CAND" | grep -c .)
                PICKS=""
                INVALID=""
                OLDIFS=$IFS; IFS=', '
                for tok in $CHOICE; do
                    [ -n "$tok" ] || continue
                    if printf '%s' "$tok" | grep -qE '^[0-9]+$' \
                        && [ "$tok" -ge 1 ] && [ "$tok" -le "$CAND_COUNT" ]; then
                        PICKS="$PICKS $tok"
                    else
                        INVALID="$INVALID $tok"
                    fi
                done
                IFS=$OLDIFS
                if [ -n "$INVALID" ]; then
                    echo "  ERROR: invalid selection(s):$INVALID" >&2
                    echo "  Expected numbers 1-$CAND_COUNT (comma-separated), 'all', or Enter." >&2
                    exit 1
                fi
                SELECTED="$(for n in $PICKS; do
                    printf '%s\n' "$CAND" | sed -n "${n}p" | cut -f1,2
                done)"
                ;;
        esac
        ;;
esac

if [ -z "${SELECTED:-}" ]; then
    echo "  No siblings selected (manifest may declare none with 'url', or filters excluded all)."
    exit 0
fi

COUNT=$(printf '%s\n' "$SELECTED" | wc -l | xargs)
echo "  $COUNT repo(s) selected."

# --- Clone ---
# Candidates are pre-filtered to cloneable siblings (never the meta-repo or an
# inline url-less entry), so the loop just clones, then enables the plugin in
# every sibling that ended up on disk (freshly cloned or already present).
echo ""
echo "[3/3] Cloning..."
SUCCESS=0
SKIPPED=0
FAILED=0
while IFS=$'\t' read -r name url; do
    [ -n "$name" ] || continue
    if [ -d "$WORKSPACE/$name" ]; then
        echo "  SKIP $name (already exists at $WORKSPACE/$name)"
        SKIPPED=$((SKIPPED + 1))
    elif git -C "$WORKSPACE" clone --quiet "$url" "$name"; then
        echo "  CLONE $name from $url"
        SUCCESS=$((SUCCESS + 1))
    else
        echo "    FAILED: git clone of $name exited non-zero" >&2
        FAILED=$((FAILED + 1))
    fi
    enable_lorekeeper_plugin_for "$WORKSPACE/$name"
done <<< "$SELECTED"

copy_claude_settings
ensure_gh_ssh_protocol

echo ""
echo "Done. $SUCCESS cloned, $SKIPPED skipped, $FAILED failed."

# --- Detect user-level plugin marketplace (best-effort heuristic) ---
# Marketplace can also be configured at project scope; we can't detect that
# from here, so we only check the user-level file. False negatives are OK —
# the worst case is the dev sees a hint they don't strictly need.
if grep -q "Mindful-Stack/witan" "$HOME/.claude/settings.json" 2>/dev/null; then
    MARKETPLACE_STATUS="✓ Plugin marketplace already configured at user level."
else
    MARKETPLACE_STATUS="⚠ Plugin marketplace NOT detected at user level (~/.claude/settings.json) —
    do step 1 below first, otherwise the per-sibling enablement just written
    will be a dangling reference until you install the plugin."
fi

echo ""
echo "=== Setup complete! ==="
echo ""
echo "  Household: $WORKSPACE"
echo ""
echo "  $MARKETPLACE_STATUS"
echo ""
echo "Next steps:"
echo "  1. ONE-TIME per developer — inside Claude Code (any project will do):"
echo "       /plugin marketplace add Mindful-Stack/witan"
echo "       /plugin install lore@witan"
echo "     When prompted for install scope, choose USER LEVEL"
echo "     (writes to ~/.claude/settings.json). Project scope works too, but"
echo "     adds a committed entry to every repo you install from — which"
echo "     defeats the per-dev .claude/settings.local.json this script wrote."
echo "  2. Run /lore:help from the workspace OR any sibling repo to verify."
echo "     (Each sibling's .claude/settings.local.json was updated to enable the plugin.)"

[ "$FAILED" -eq 0 ] || exit 1
