.PHONY: help split-lore rename build-index validate doctor test

help:    ## List targets
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-24s\033[0m %s\n", $$1, $$2}'

# Shared household targets (setup/pull/status, repo lifecycle, branch-protection
# policy) live in scripts/Makefile.shared. Household-specific targets below.
include scripts/Makefile.shared

split-lore: ## Promote the inline `lore/` to its own sibling repo (interactive; pass REMOTE=<url> to skip prompt)
	@./scripts/split-lore.sh "$(REMOTE)"

rename:  ## Substitute placeholder workspace name (usage: make rename NAME=foo)
	@./scripts/rename.sh "$(NAME)"

build-index: ## Rebuild lore/knowledge/_index.json
	@node lore/_tools/cli.js build-index --dir lore/knowledge

validate: ## Run KB validators (frontmatter, links, orphans)
	@node lore/_tools/cli.js validate --dir lore/knowledge

doctor:  ## Run full workspace + KB diagnostic
	@node lore/_tools/cli.js doctor --dir lore/knowledge

test:    ## Run all unit tests: workspace scripts, manifest checks, lore tooling
	@node --test scripts/*.test.mjs household-tests/*.test.mjs lore/_tools/__tests__/*.test.js
