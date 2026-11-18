# CodeMie Connect — developer shortcuts.
# Run `make` or `make help` to list targets. Rust commands run from src-tauri/.

SHELL      := /bin/bash
.DEFAULT_GOAL := help

TAURI_DIR  := src-tauri
CARGO      := cargo
NODE_BIN   := assets/macos/node/bin/node
PRODUCT    := $(shell node -p "require('./$(TAURI_DIR)/tauri.conf.json').productName" 2>/dev/null)
VERSION    := $(shell node -p "require('./$(TAURI_DIR)/tauri.conf.json').version" 2>/dev/null)
TARGET_DIR ?= $(TAURI_DIR)/target
APP        := $(TARGET_DIR)/release/bundle/macos/$(PRODUCT).app

.PHONY: help setup stage restage dev run open \
        build build-fast build-app sign notarize \
        fmt fmt-check lint lint-fix test test-js test-rust test-ui check \
        version clean

help: ## List available targets
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

## ---- Setup -------------------------------------------------------------

setup: ## Install JS dev deps and check the Tauri CLI is present
	npm install
	@$(CARGO) tauri --version >/dev/null 2>&1 || { \
	  echo "Tauri CLI missing. Install: cargo install tauri-cli --version '^2' --locked"; exit 1; }
	@echo "Toolchain OK: $$($(CARGO) tauri --version)"

# The bundled runtime must be staged once per checkout, or every cargo command
# in src-tauri/ fails with "resource path ... doesn't exist".
$(NODE_BIN):
	scripts/stage-runtime.sh

stage: $(NODE_BIN) ## Stage the bundled Node runtime + CLI (once per checkout)

restage: ## Re-download Node and reinstall the CLI tree from scratch
	scripts/stage-runtime.sh --force

## ---- Run ---------------------------------------------------------------

dev: | $(NODE_BIN) ## Run the app locally with hot reload (cargo tauri dev)
	cd $(TAURI_DIR) && $(CARGO) tauri dev

run: dev ## Alias for dev

open: ## Open the last release .app build
	@test -d "$(APP)" || { echo "No build at $(APP). Run 'make build' first."; exit 1; }
	open "$(APP)"

## ---- Build -------------------------------------------------------------

build: ## Stage, verify and build the .app + DMG (build-installer.sh)
	./build-installer.sh

build-fast: | $(NODE_BIN) ## Same as build, reusing the staged runtime
	./build-installer.sh --skip-stage

build-app: | $(NODE_BIN) ## Plain Tauri build, no verification (UI-only changes)
	cd $(TAURI_DIR) && CI=true $(CARGO) tauri build

sign: ## Sign the .app + DMG (needs .env.signing)
	./sign-dmg.sh

notarize: ## Sign, notarize and staple (needs Apple ID env vars)
	NOTARIZE=1 ./sign-dmg.sh

## ---- Quality gates -----------------------------------------------------

fmt: ## Format Rust code
	cd $(TAURI_DIR) && $(CARGO) fmt

fmt-check: ## Check Rust formatting
	cd $(TAURI_DIR) && $(CARGO) fmt --check

lint: | $(NODE_BIN) ## Run clippy with warnings as errors
	cd $(TAURI_DIR) && $(CARGO) clippy -- -D warnings

lint-fix: | $(NODE_BIN) ## Apply clippy's automatic fixes
	cd $(TAURI_DIR) && $(CARGO) clippy --fix --allow-dirty -- -D warnings

test-js: ## Run frontend unit tests (node:test)
	npm test

test-rust: | $(NODE_BIN) ## Run Rust unit tests
	cd $(TAURI_DIR) && $(CARGO) test

test: test-js test-rust ## Run JS and Rust unit tests

test-ui: ## Run Playwright UI tests
	npm run test:ui

check: fmt-check lint test ## Run all quality gates (fmt, clippy, tests)

## ---- Misc --------------------------------------------------------------

version: ## Print product name and version
	@echo "$(PRODUCT) $(VERSION)"

clean: ## Remove Rust build output
	cd $(TAURI_DIR) && $(CARGO) clean
