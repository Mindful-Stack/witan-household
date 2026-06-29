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
# so it's resolved separately and reported first. Siblings are every other entry.
META=$(node -e "const m = require('$MANIFEST'); process.stdout.write(m.meta_repo || '')")
SIBLINGS=$(node -e "
    const m = require('$MANIFEST');
    m.repos.filter(r => r.name !== m.meta_repo).forEach(r => console.log(r.name));
")

status_one() { # $1=label $2=dir
    local name="$1" DIR="$2" BRANCH DIRTY AHEAD BEHIND
    if [ ! -d "$DIR/.git" ]; then
        printf "%-30s (no .git/)\n" "$name"
        return
    fi
    BRANCH=$(git -C "$DIR" symbolic-ref --short HEAD 2>/dev/null || echo "?")
    DIRTY=$(git -C "$DIR" status --porcelain | wc -l | xargs)
    AHEAD=$(git -C "$DIR" rev-list --count "@{u}..HEAD" 2>/dev/null || echo "0")
    BEHIND=$(git -C "$DIR" rev-list --count "HEAD..@{u}" 2>/dev/null || echo "0")
    printf "%-30s %s  %d dirty  %d ahead  %d behind\n" "$name" "$BRANCH" "$DIRTY" "$AHEAD" "$BEHIND"
}

# Meta-repo (the workspace root) first, then siblings.
[ -n "$META" ] && status_one "$META (meta)" "$WORKSPACE"
for name in $SIBLINGS; do
    status_one "$name" "$WORKSPACE/$name"
done
