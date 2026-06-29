#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFEST="$WORKSPACE/household.json"

if [ ! -f "$MANIFEST" ]; then
    echo "ERROR: No household.json. Run from inside a witan-household workspace." >&2
    exit 1
fi

# The meta-repo IS the workspace root ($WORKSPACE), not a sibling subdirectory,
# so it's resolved separately and pulled first. Siblings are every other entry.
META=$(node -e "const m = require('$MANIFEST'); process.stdout.write(m.meta_repo || '')")
SIBLINGS=$(node -e "
    const m = require('$MANIFEST');
    m.repos.filter(r => r.name !== m.meta_repo).forEach(r => console.log(r.name));
")

# Fetch a repo; fast-forward pull only when on a clean main/master. A repo on a
# feature branch (e.g. the workspace meta-repo while you're mid-change) is fetched
# but left exactly where it is — never auto-pulled out from under you.
pull_one() { # $1=label $2=dir
    local name="$1" DIR="$2" BRANCH
    if [ ! -d "$DIR/.git" ]; then
        echo "[SKIP] $name (no .git/)"
        return
    fi
    echo "[FETCH] $name"
    git -C "$DIR" fetch --prune --quiet
    BRANCH=$(git -C "$DIR" symbolic-ref --short HEAD 2>/dev/null || echo "")
    if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
        if [ -z "$(git -C "$DIR" status --porcelain)" ]; then
            git -C "$DIR" pull --ff-only --quiet && echo "  pulled" || echo "  ff-pull failed"
        else
            echo "  dirty; skipping pull"
        fi
    else
        echo "  on '$BRANCH'; not pulling"
    fi
}

# Meta-repo (the workspace root) first, then siblings.
[ -n "$META" ] && pull_one "$META (meta)" "$WORKSPACE"
for name in $SIBLINGS; do
    pull_one "$name" "$WORKSPACE/$name"
done
