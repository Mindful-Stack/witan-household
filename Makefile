.PHONY: help setup pull status split-lore rename repo-rename repos-sync-names repos-sync-names-apply build-index validate doctor test

help:    ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

setup:   ## Clone every sibling declared in household.json
	@./scripts/setup.sh

pull:    ## Fetch all siblings; ff-pull if on clean main
	@./scripts/pull-all.sh

status:  ## One-line git status per sibling
	@./scripts/status-all.sh

split-lore: ## Promote the inline `lore/` to its own sibling repo (interactive; pass REMOTE=<url> to skip prompt)
	@./scripts/split-lore.sh "$(REMOTE)"

rename:  ## Substitute placeholder workspace name (usage: make rename NAME=foo)
	@./scripts/rename.sh "$(NAME)"

repo-rename: ## Rename a sibling repo end-to-end: GitHub + household.json + PR (usage: make repo-rename OLD=foo NEW=bar)
	@node ./scripts/repo-rename.mjs "$(OLD)" "$(NEW)"

repos-sync-names: ## Dry-run: reconcile local sibling dirs + remote URLs with household.json
	@node ./scripts/repos-sync-names.mjs

repos-sync-names-apply: ## Apply the sibling dir/URL reconciliation (interactive)
	@node ./scripts/repos-sync-names.mjs --apply

build-index: ## Rebuild lore/knowledge/_index.json
	@node lore/_tools/cli.js build-index --dir lore/knowledge

validate: ## Run KB validators (frontmatter, links, orphans)
	@node lore/_tools/cli.js validate --dir lore/knowledge

doctor:  ## Run full workspace + KB diagnostic
	@node lore/_tools/cli.js doctor --dir lore/knowledge

test:    ## Run lore tooling + workspace script unit tests
	@node --test lore/_tools/__tests__/*.test.js
	@node --test scripts/__tests__/*.test.mjs
