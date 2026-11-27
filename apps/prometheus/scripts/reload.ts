#!/usr/bin/env bun
/**
 * Package: prometheus
 * Purpose: have a running Prometheus read its configuration again, so a scrape
 *          job or alert rule added since the last start counts without a
 *          restart. A file with a mistake in it makes Prometheus refuse the
 *          reload and keep what it had; that is reported as an error.
 * Usage:   bun packages/prometheus/scripts/reload.ts   (from the project folder)
 * Called by: `via app setup prometheus` (app.yaml), which the start recipe runs.
 * Needs:   PROMETHEUS_PORT in .env.
 * Exit:    0 when Prometheus read its configuration, 1 otherwise.
 *
 * @module
 */
import { envGet, ts } from "./_setup-env.ts";

const port = envGet("PROMETHEUS_PORT");
if (!port) {
  console.error("[prometheus] ERROR: PROMETHEUS_PORT must be in .env");
  process.exit(1);
}
try {
  const r = await fetch(`http://127.0.0.1:${port}/-/reload`, { method: "POST" });
  if (!r.ok) {
    console.error(
      `[prometheus] ERROR: Prometheus refused its configuration (HTTP ${r.status}): ${(await r.text()).slice(0, 400)}`,
    );
    process.exit(1);
  }
  ts("✓ Prometheus read its configuration.");
} catch (error) {
  console.error(`[prometheus] ERROR: Prometheus does not answer on port ${port}: ${(error as Error).message}`);
  process.exit(1);
}
