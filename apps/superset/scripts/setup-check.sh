#!/usr/bin/env bash
# Package: superset
# Purpose: prove Superset is set up after a start. The database upgrade, the
#          administrator account and the roles are made by the app's own init
#          container on every start (docker-compose.yaml, superset-init); this
#          waits until that is done and an active administrator exists.
# Usage:   bash packages/superset/scripts/setup-check.sh   (from the project folder)
# Called by: `via app setup superset` (app.yaml), which the start recipe runs.
# Exit:    0 when an active administrator exists, 1 when not within 15 minutes.

set -uo pipefail

# A value from the environment, else from .env in the current directory.
env_value() {
  if [[ -n "${!1:-}" ]]; then echo "${!1}"; return; fi
  grep "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true
}

PG="$(env_value CONTAINER_PREFIX)superset-postgres"
DB_USER="$(env_value SUPERSET_POSTGRES_USER)"
DB_NAME="$(env_value SUPERSET_POSTGRES_DB)"
QUERY="SELECT count(*) FROM ab_user u JOIN ab_user_role ur ON ur.user_id = u.id JOIN ab_role r ON r.id = ur.role_id WHERE r.name = 'Admin' AND u.active"

for _ in $(seq 1 180); do
  COUNT="$(docker exec "$PG" psql -U "${DB_USER:-superset}" -d "${DB_NAME:-superset}" -tAc "$QUERY" 2>/dev/null | tr -d '[:space:]')"
  if [[ "${COUNT:-0}" =~ ^[0-9]+$ ]] && (( COUNT > 0 )); then
    echo "[superset] ✓ Database is set up and has $COUNT active administrator(s)."
    exit 0
  fi
  sleep 5
done
echo "[superset] ERROR: no administrator after 15 minutes; see: docker logs $(env_value CONTAINER_PREFIX)superset-init" >&2
exit 1
