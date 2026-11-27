#!/usr/bin/env bun
/**
 * Package: grafana
 * Purpose: have a running Grafana read its start files again, so a data source
 *          written since it started (the Prometheus or Loki app was installed
 *          later) or a new dashboard folder counts without a restart.
 *          Uses the admin account from .env. When that account has another
 *          password by now (changed in Grafana itself), nothing is reloaded
 *          and the line says so; Grafana reads the files at its next start.
 * Usage:   bun packages/grafana/scripts/reload.ts   (from the project folder)
 * Called by: `via app setup grafana` (app.yaml), which the start recipe runs.
 * Needs:   GRAFANA_PORT, GRAFANA_ADMIN_USER and GRAFANA_ADMIN_PASSWORD in .env.
 * Exit:    0 when Grafana read the files or the admin account could not be used,
 *          1 when Grafana refused a file.
 *
 * @module
 */
import { envGet, ts } from "./_setup-env.ts";

const port = envGet("GRAFANA_PORT");
const user = envGet("GRAFANA_ADMIN_USER", "admin");
const password = envGet("GRAFANA_ADMIN_PASSWORD");
if (!port || !password) {
  console.error("[grafana] ERROR: GRAFANA_PORT and GRAFANA_ADMIN_PASSWORD must be in .env");
  process.exit(1);
}
const headers = { authorization: `Basic ${btoa(`${user}:${password}`)}` };
try {
  for (const what of ["datasources", "dashboards"]) {
    const r = await fetch(`http://127.0.0.1:${port}/api/admin/provisioning/${what}/reload`, {
      method: "POST",
      headers,
    });
    if (r.status === 401 || r.status === 403) {
      ts(
        `Not reloaded: the admin account in .env (${user}) is refused by Grafana, its password was changed there. New data sources count after Grafana's next start.`,
      );
      process.exit(0);
    }
    if (!r.ok) {
      console.error(
        `[grafana] ERROR: Grafana refused its ${what} files (HTTP ${r.status}): ${(await r.text()).slice(0, 400)}`,
      );
      process.exit(1);
    }
  }
  ts("✓ Grafana read its data sources and dashboard folders.");
} catch (error) {
  console.error(`[grafana] ERROR: Grafana does not answer on port ${port}: ${(error as Error).message}`);
  process.exit(1);
}
