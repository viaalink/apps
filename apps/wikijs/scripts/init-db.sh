#!/bin/bash
# Package: wikijs
# Purpose: Initialize Wiki.js database via setup wizard API
# Usage: bash packages/wikijs/scripts/init-db.sh
#
# Called by: just wikijs-init-db
# Requires: Wiki.js container running

set -eo pipefail

# shellcheck source=./_lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

# Defaults
WIKIJS_PORT="${WIKIJS_PORT}"
WIKIJS_ADMIN_EMAIL="${WIKIJS_ADMIN_EMAIL}"
WIKIJS_ADMIN_PASSWORD="${WIKIJS_ADMIN_PASSWORD}"

log "Initializing Wiki.js database..."

# Check if already initialized
INIT_CHECK=$(curl -s "http://localhost:$WIKIJS_PORT/graphql" -X POST \
    -H "Content-Type: application/json" \
    -d '{"query": "{ site { config { title } } }"}' 2>/dev/null | grep -o '"title"' || true)

if [ -n "$INIT_CHECK" ]; then
    log "Wiki.js already initialized, skipping setup wizard"
    exit 0
fi

# Wait for Wiki.js to be ready
log "Waiting for Wiki.js to be ready..."
MAX_WAIT=60
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$WIKIJS_PORT/" 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
        break
    fi
    sleep 2
    WAITED=$((WAITED + 2))
done

if [ $WAITED -ge $MAX_WAIT ]; then
    error "Wiki.js not responding after ${MAX_WAIT}s"
fi

# Run finalize setup
log "Running setup wizard..."
RESULT=$(curl -s "http://localhost:$WIKIJS_PORT/finalize" -X POST \
    -H "Content-Type: application/json" \
    -d "{
        \"adminEmail\": \"$WIKIJS_ADMIN_EMAIL\",
        \"adminPassword\": \"$WIKIJS_ADMIN_PASSWORD\",
        \"adminPasswordConfirm\": \"$WIKIJS_ADMIN_PASSWORD\",
        \"siteUrl\": \"http://localhost:$WIKIJS_PORT\",
        \"telemetry\": false
    }" 2>/dev/null)

# Check result
if echo "$RESULT" | grep -q '"ok":true'; then
    log "Setup wizard completed successfully!"
elif echo "$RESULT" | grep -q "already been installed"; then
    log "Wiki.js already installed"
else
    warn "Setup response: $RESULT"
    # Try to verify by checking if we can query
    sleep 3
    VERIFY=$(curl -s "http://localhost:$WIKIJS_PORT/graphql" -X POST \
        -H "Content-Type: application/json" \
        -d '{"query": "{ site { config { title } } }"}' 2>/dev/null)
    if echo "$VERIFY" | grep -q '"title"'; then
        log "Verification successful - Wiki.js is running"
    else
        error "Setup verification failed"
    fi
fi

# Write credentials to .env for E2E tests
if [ -f "$PROJECT_ROOT/.env" ]; then
    for VAR_LINE in "WIKIJS_ADMIN_EMAIL=$WIKIJS_ADMIN_EMAIL" "WIKIJS_ADMIN_PASSWORD=$WIKIJS_ADMIN_PASSWORD"; do
        VAR_NAME="${VAR_LINE%%=*}"
        if grep -q "^${VAR_NAME}=" "$PROJECT_ROOT/.env" 2>/dev/null; then
            sed -i "s|^${VAR_NAME}=.*|${VAR_LINE}|" "$PROJECT_ROOT/.env"
        else
            echo "$VAR_LINE" >> "$PROJECT_ROOT/.env"
        fi
    done
    log "  Updated WIKIJS_ADMIN_EMAIL + WIKIJS_ADMIN_PASSWORD in .env"
fi

log "Database initialization complete"
