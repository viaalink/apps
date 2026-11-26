#!/bin/bash
# Wiki.js per-package bootstrap. Thin wrapper around scripts/lib/_lib.sh.
#
# Source from a sibling script:
#   source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
#
# Sets:
#   - SCRIPT_DIR / PACKAGE_DIR / PROJECT_ROOT — resolved from the caller
#   - LOG_PREFIX=WIKIJS so log/warn/error print "[WIKIJS] ..."
#   - Loads .env (best-effort) via pma_load_env
#
# Anything else lives in scripts/lib/_lib.sh (colors, helpers, env loader).

# Resolve caller paths. Use BASH_SOURCE[1] so paths are relative to the
# script that sourced us, not _lib.sh itself.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$(dirname "$PACKAGE_DIR")")"

# Wiki.js-specific log prefix; export so the shared lib picks it up.
export LOG_PREFIX="WIKIJS"

# shellcheck source=/dev/null
source "$PROJECT_ROOT/scripts/lib/_lib.sh"

# Load environment (best-effort)
pma_load_env "$PROJECT_ROOT/.env" || true
