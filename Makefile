.PHONY: help split-lore rename build-index validate doctor test

# The KB directory name comes from household.json's `knowledge_base` field
# (default: lore). This lets a household rename its knowledge base without
# editing this Makefile — the build-index/validate/doctor/test targets follow.
KB_DIR := $(shell node -e "try{process.stdout.write(String(require('./household.json').knowledge_base||'lore'))}catch(e){process.stdout.write('lore')}" 2>/dev/null)
# Guard the empty case (e.g. node absent → stdout empty) so paths never become /_tools/...
ifeq ($(strip $(KB_DIR)),)
KB_DIR := lore
endif

##@ General
help:    ## List targets, grouped by section
	@awk 'BEGIN {FS = ":.*##"} \
		/^##@/ {printf "\n\033[1m%s\033[0m\n", substr($$0, 5)} \
		/^[a-zA-Z_-]+:.*?##/ {printf "  \033[36m%-24s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# Shared household targets (setup/pull/status, repo lifecycle, branch-protection
# policy) live in scripts/Makefile.shared. Household-specific targets below.
include scripts/Makefile.shared

##@ Knowledge base
build-index: ## Rebuild <kb>/knowledge/_index.json
	@node $(KB_DIR)/_tools/cli.js build-index --dir $(KB_DIR)/knowledge

validate: ## Run KB validators (frontmatter, links, orphans)
	@node $(KB_DIR)/_tools/cli.js validate --dir $(KB_DIR)/knowledge

doctor:  ## Run full workspace + KB diagnostic
	@node $(KB_DIR)/_tools/cli.js doctor --dir $(KB_DIR)/knowledge

##@ Workspace
split-lore: ## Promote the inline KB to its own sibling repo (interactive; pass REMOTE=<url> to skip prompt)
	@./scripts/split-lore.sh "$(REMOTE)"

rename:  ## Substitute placeholder workspace name (usage: make rename NAME=foo)
	@./scripts/rename.sh "$(NAME)"

test:    ## Run all unit tests: workspace scripts, manifest checks, KB tooling
	# The KB ($(KB_DIR)/) may be a sibling repo absent from a fresh checkout/CI;
	# $(wildcard ...) drops the glob to nothing when absent instead of erroring.
	@node --test scripts/*.test.mjs household-tests/*.test.mjs $(wildcard $(KB_DIR)/_tools/__tests__/*.test.js)
