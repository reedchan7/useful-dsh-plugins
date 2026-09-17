# useful-dsh-plugins — one entry point for building, checking, installing and
# publishing the plugins in this workspace.
#
# The repository is developed with Bun. The DSH profile it installs into is
# managed by `dsh plugin`, which forwards to pnpm inside $DSH_HOME/profiles/<n>;
# the two toolchains do not conflict because every plugin ships zero runtime
# dependencies (see AGENTS.md).

SHELL := /bin/bash
.DEFAULT_GOAL := help

# --- configuration ----------------------------------------------------------

# Plugins to act on. Add a name here after `make new NAME=...`.
PLUGINS ?= dsh-cost
# DSH profile the plugins install into.
PROFILE ?= web
# dsh executable.
DSH ?= dsh
# npm scope of the plugin packages.
SCOPE ?= @reedchan7
# Port of the running `dsh web` host; `make verify` queries it.
PORT ?= 3080
# Install spec override: empty means "link this checkout", otherwise a full pnpm
# spec such as `github:reedchan7/useful-dsh-plugins#v0.1.0` or `@reedchan7/dsh-cost`.
PLUGIN ?=
# Tag used by `make install-github`.
TAG ?= v0.1.0

# Comma-separated plugin list turned into space-separated for recipes.
PLUGIN_LIST := $(subst $(comma), ,$(PLUGINS))
comma := ,

##
## Help
##

.PHONY: help
help: ## Show this help
	@printf 'useful-dsh-plugins\n\n'
	@printf 'Usage: make <target> [PLUGINS="dsh-cost ..."] [PROFILE=web]\n'
	@awk ' \
		/^## [A-Za-z]/ { sub(/^## /, ""); printf "\n\033[1m%s\033[0m\n", $$0; next } \
		/^[a-zA-Z0-9_-]+:.*## / { \
			split($$0, parts, "## "); \
			target = $$0; sub(/:.*/, "", target); \
			printf "  \033[36m%-16s\033[0m %s\n", target, parts[2]; \
		}' $(MAKEFILE_LIST)
	@printf '\nPlugins: %s\nProfile: %s\n' '$(PLUGIN_LIST)' '$(PROFILE)'

##
## Environment
##

.PHONY: env
env: ## Print the resolved toolchain and profile paths
	@printf 'bun            %s (%s)\n' "$$(bun --version 2>/dev/null || echo MISSING)" "$$(command -v bun || echo -)"
	@printf 'dsh            %s\n' "$$($(DSH) --version 2>/dev/null || echo MISSING)"
	@printf 'DSH_HOME       %s\n' "$${DSH_HOME:-$$HOME/.dsh}"
	@printf 'profile dir    %s\n' "$${DSH_HOME:-$$HOME/.dsh}/profiles/$(PROFILE)"
	@printf 'node           %s\n' "$$(node --version 2>/dev/null || echo MISSING)"
	@printf 'npm account    %s\n' "$$(npm whoami 2>/dev/null || echo 'not logged in')"
	@printf 'plugins        %s\n' '$(PLUGIN_LIST)'
	@printf 'scope          %s\n' '$(SCOPE)'

.PHONY: doctor
doctor: ## Check the toolchain and the DSH profile before installing
	@command -v bun >/dev/null || { printf 'bun is required (>=1.4.0)\n' >&2; exit 1; }
	@command -v $(DSH) >/dev/null || { printf '%s not found on PATH; set DSH=/path/to/dsh\n' '$(DSH)' >&2; exit 1; }
	@[ -f "$${DSH_HOME:-$$HOME/.dsh}/profiles/$(PROFILE)/package.json" ] \
		|| { printf 'profile "%s" does not exist yet; run `%s web` once to create it\n' '$(PROFILE)' '$(DSH)' >&2; exit 1; }
	@$(MAKE) --no-print-directory env
	@printf '\ninstalled bundles:\n'
	@$(DSH) --profile $(PROFILE) --dump-config 2>/dev/null \
		| grep -E '^# == ' \
		| sed 's/^/  /' || printf '  (could not read the composed config)\n'

##
## Setup
##

.PHONY: setup
setup: ## Install toolchain dependencies and git hooks
	bun install
	$(MAKE) hooks

.PHONY: hooks
hooks: ## Install the lefthook git hooks
	bunx lefthook install

##
## Quality gates
##

.PHONY: check
check: fmt-check lint typecheck docs-check test build ## Run every gate (same as CI)
	@printf '\nall gates passed\n'

.PHONY: fmt
fmt: ## Format the repository in place
	bun run fmt

.PHONY: fmt-check
fmt-check: ## Verify formatting without writing
	bun run fmt:check

.PHONY: lint
lint: ## Lint the repository
	bun run lint

.PHONY: typecheck
typecheck: ## Type-check with the TypeScript compiler
	bun run typecheck

.PHONY: docs-check
docs-check: ## Verify every README has its README_CN counterpart
	bun run docs:check

.PHONY: test
test: ## Run the test suite
	bun run test

.PHONY: test-watch
test-watch: ## Re-run tests on change
	bun test --watch

##
## Build & publish
##

.PHONY: build
build: ## Build every plugin into plugins/<name>/lib
	bun run build:plugins

.PHONY: pack
pack: build ## Produce an installable tarball per plugin
	@for plugin in $(PLUGIN_LIST); do \
		printf 'packing %s\n' "$$plugin"; \
		(cd plugins/$$plugin && bun pm pack); \
	done

.PHONY: publish
publish: build ## Publish the plugins to npmjs.com (requires `npm login`)
	@npm whoami >/dev/null 2>&1 \
		|| { printf 'not logged in to npm; run `npm login` first\n' >&2; exit 1; }
	@for plugin in $(PLUGIN_LIST); do \
		printf '\n== publishing %s/%s\n' '$(SCOPE)' "$$plugin"; \
		(cd plugins/$$plugin && npm publish --access public); \
	done
	@printf '\ninstall a published release with `make install PLUGIN=%s/<name>`\n' '$(SCOPE)'

##
## DSH profile
##

.PHONY: install
install: build ## Install the plugins into the DSH profile (link: by default)
	@[ -n "$$($(DSH) --version 2>/dev/null)" ] || { printf '%s not runnable\n' '$(DSH)' >&2; exit 1; }
	@for plugin in $(PLUGIN_LIST); do \
		spec='$(PLUGIN)'; \
		[ -n "$$spec" ] || spec="link:$$(pwd)/plugins/$$plugin"; \
		printf '\n== %s\n' "$$spec"; \
		if $(DSH) plugin --profile $(PROFILE) list 2>/dev/null | grep -q "$$plugin"; then \
			printf 'already installed; use `make reinstall` to refresh\n'; \
		else \
			$(DSH) plugin --profile $(PROFILE) add "$$spec"; \
		fi; \
	done
	@printf '\nrestart `%s web` (or `%s --profile %s`) and hard-refresh the browser\n' '$(DSH)' '$(DSH)' '$(PROFILE)'

.PHONY: install-github
install-github: ## Install from the git tag instead of this checkout (TAG=v0.1.0)
	@$(MAKE) install PLUGIN='github:reedchan7/useful-dsh-plugins#$(TAG)'

.PHONY: reinstall
reinstall: build ## Re-link the plugins after a rebuild
	@for plugin in $(PLUGIN_LIST); do \
		$(DSH) plugin --profile $(PROFILE) remove '$(SCOPE)'/$$plugin >/dev/null 2>&1 || true; \
	done
	@$(MAKE) install

.PHONY: uninstall
uninstall: ## Remove the plugins from the DSH profile
	@for plugin in $(PLUGIN_LIST); do \
		printf 'removing %s\n' '$(SCOPE)'/$$plugin; \
		$(DSH) plugin --profile $(PROFILE) remove '$(SCOPE)'/$$plugin || true; \
	done

.PHONY: update
update: ## Update installed plugins from the registry (or rebuild local links)
	@for plugin in $(PLUGIN_LIST); do \
		if $(DSH) plugin --profile $(PROFILE) list 2>/dev/null | grep -q "$$plugin"; then \
			$(DSH) plugin --profile $(PROFILE) update --latest '$(SCOPE)'/$$plugin || true; \
		fi; \
	done
	@$(MAKE) build

.PHONY: status
status: ## Show what the DSH profile currently has installed
	@$(DSH) plugin --profile $(PROFILE) list || true
	@printf '\nbundle layers:\n'
	@$(DSH) --profile $(PROFILE) --dump-config 2>/dev/null | grep -E '^# == ' | sed 's/^/  /' || true

##
## Runtime checks
##

# SESSION is a DSH session id; `make verify` prints the summary the pill renders.
SESSION ?=
.PHONY: verify
verify: ## Query the running host for one session summary (SESSION=<id>)
	@[ -n '$(SESSION)' ] || { \
		printf 'usage: make verify SESSION=<session-id>\n\nrecent sessions:\n' >&2; \
		ls -1t "$${DSH_HOME:-$$HOME/.dsh}/sessions"/*/ 2>/dev/null | head -5 >&2 || true; \
		exit 1; \
	}
	@curl -sS "http://127.0.0.1:$(PORT)/api/dsh-cost/summary?session=$(SESSION)" | python3 -m json.tool

##
## Scaffolding
##

.PHONY: new
new: ## Scaffold a new plugin from templates/plugin (NAME=<dir-name>)
	@[ -n '$(NAME)' ] || { printf 'usage: make new NAME=dsh-example\n' >&2; exit 1; }
	bun tools/new-plugin/src/index.ts --name '$(NAME)' --scope '$(SCOPE)'

##
## Housekeeping
##

.PHONY: clean
clean: ## Remove build output and dependencies
	rm -rf node_modules plugins/*/lib coverage
	@printf 'cleaned\n'

.PHONY: clean-build
clean-build: ## Remove plugin build output only
	rm -rf plugins/*/lib
	@printf 'cleaned build output\n'
