#!/bin/bash
set -euo pipefail

# Bootstrap the witan-household: clone declared sibling repos.
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
MANIFEST="$WORKSPACE/household.json"

# --- Flag parsing ---
MODE=""           # "" (default) | core | all | tag | repos
TAG_FILTER=""
REPOS_FILTER=""

for arg in "$@"; do
    case "$arg" in
        --core)     MODE="core" ;;
        --all)      MODE="all" ;;
        --tag=*)    MODE="tag";   TAG_FILTER="${arg#*=}" ;;
        --repos=*)  MODE="repos"; REPOS_FILTER="${arg#*=}" ;;
        -h|--help)
            cat <<EOF
Usage: $0 [--core | --all | --tag=foo | --repos=name1,name2]

No args:  interactive picker in a terminal (press Enter for core repos, or
          'all', or comma-separated numbers); clones everything with a 'url'
          when run non-interactively.

Flags:
  --core          Only clone repos tagged 'core'.
  --all           Clone every sibling that has a 'url'.
  --tag=foo       Only clone repos tagged 'foo'.
  --repos=a,b,c   Only clone the named repos.

The workspace meta-repo and any entry without a 'url' are always excluded.
EOF
            exit 0
            ;;
        *)
            echo "Unknown flag: $arg" >&2
            exit 2
            ;;
    esac
done

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
echo "  OK"

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
        continue
    fi
    echo "  CLONE $name from $url"
    if git -C "$WORKSPACE" clone --quiet "$url" "$name"; then
        SUCCESS=$((SUCCESS + 1))
    else
        echo "    FAILED: git clone exited non-zero" >&2
        FAILED=$((FAILED + 1))
    fi
done <<< "$SELECTED"

echo ""
echo "Done. $SUCCESS cloned, $SKIPPED skipped, $FAILED failed."
[ $FAILED -eq 0 ] || exit 1
