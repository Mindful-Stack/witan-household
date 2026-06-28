#!/bin/bash
set -euo pipefail

# Fast-forward pull every knowledge-base repo declared in household.json.
# Same safety rules as pull-all.sh (ff-only, only on a clean main), but scoped
# to the KBs — this is what the agent runs when the SessionStart hook reports
# stale knowledge bases.
#
# KB resolution from household.json:
#   shared_knowledge_bases (array, optional, lower priority)
#   + knowledge_base (string, default "lore", higher priority / write target)
# Names are trimmed and deduped before pulling.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFEST="$WORKSPACE/household.json"

KB_NAMES=$(node -e "
const r = require(process.argv[1]);
const shared = Array.isArray(r.shared_knowledge_bases) ? r.shared_knowledge_bases : [];
const team = (typeof r.knowledge_base === 'string' && r.knowledge_base.trim()) ? r.knowledge_base.trim() : 'lore';
const names = [...shared, team];
const seen = new Set();
const out = [];
for (let n of names) {
  if (typeof n !== 'string') continue;
  n = n.trim();
  if (!n || seen.has(n)) continue;
  seen.add(n);
  out.push(n);
}
console.log(out.join('\n'));
" "$MANIFEST")

if [ -z "$KB_NAMES" ]; then
    echo "No knowledge bases declared in household.json — nothing to update."
    exit 0
fi

FAILED=0
cd "$WORKSPACE" || exit 1
while IFS= read -r NAME; do
    [ -z "$NAME" ] && continue
    if [ ! -d "$NAME" ]; then
        echo "$NAME: not cloned locally (skipped — run make setup)"
        continue
    fi
    if ! git -C "$NAME" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        echo "$NAME: not a git repo (skipped)"
        continue
    fi

    # Guard the fetch: under `set -e` a bare failure (network/auth) would abort
    # the whole script, skipping the remaining KBs and the FAILED aggregation.
    # Record it and move on so every KB gets a chance.
    if ! git -C "$NAME" fetch --prune --quiet; then
        echo "$NAME: fetch failed (network/auth?) — skipped"
        FAILED=1
        continue
    fi

    BRANCH=$(git -C "$NAME" symbolic-ref --short HEAD 2>/dev/null || echo "DETACHED")
    if [ -n "$(git -C "$NAME" status --porcelain)" ]; then
        DIRTY="dirty"
    else
        DIRTY="clean"
    fi

    if [ "$BRANCH" = "main" ] && [ "$DIRTY" = "clean" ]; then
        if git -C "$NAME" pull --ff-only --quiet; then
            echo "$NAME: updated ($(git -C "$NAME" log -1 --format='%h %s'))"
        else
            echo "$NAME: pull failed (not a fast-forward?)"
            FAILED=1
        fi
    else
        echo "$NAME: fetched only; on $BRANCH, $DIRTY — pull skipped, may still be stale"
    fi
done <<< "$KB_NAMES"

exit $FAILED
