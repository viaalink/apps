# Apache Superset with database drivers and OAuth dependencies
# The upstream image lacks authlib (needed for OAuth SSO) and database
# drivers for MySQL/PostgreSQL.

ARG SUPERSET_BASE_VERSION=6.0.0
FROM apache/superset:${SUPERSET_BASE_VERSION}

USER root

# Install build dependencies for database drivers (needed for mysqlclient compilation)
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config \
    default-libmysqlclient-dev \
    build-essential \
    patch \
    && rm -rf /var/lib/apt/lists/*

# Install database drivers and OAuth dependencies into the editable venv
# (Superset 6.0.0+ uses /app/.venv managed by uv; system pip can't write there).
RUN uv pip install --python /app/.venv/bin/python --no-cache \
    psycopg2-binary \
    mysqlclient \
    pymysql \
    authlib

# Apply PMA patches against the editable Superset source at /app/superset.
# See packages/superset/docker/patches/*.patch for context. Patches must
# apply with -p1 from /app and exit non-zero on failure to fail the build.
COPY patches /tmp/pma-patches
RUN set -eux; \
    for p in /tmp/pma-patches/*.patch; do \
        echo "Applying $p"; \
        patch -p1 -d /app < "$p"; \
    done; \
    rm -rf /tmp/pma-patches

USER superset
