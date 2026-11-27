#!/usr/bin/env bun
/**
 * Package: prometheus
 * Purpose: write Prometheus's configuration before it starts, without a person:
 *          prometheus.yml in the app's data folder, with the scrape jobs for
 *          Prometheus itself and the two exporters that come with it
 *          (node-exporter for the machine, cAdvisor for the containers), under
 *          the container names of this project.
 *          The file belongs to the app and is written again at every start.
 *          Your own additions go in two folders next to it, one file each:
 *          scrape/*.yml (scrape jobs) and alerts/*.yml (alert rules).
 *          Also makes the folder node-exporter reads *.prom files from.
 * Usage:   bun packages/prometheus/scripts/ensure-config.ts   (from the project folder)
 * Called by: app.yaml (prepare step), scripts/hooks/ensure-workspace.ts
 * Exit:    0 when the configuration is in place, 1 otherwise.
 *
 * @module
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { envGet, ts } from "./_setup-env.ts";

const dataDir = process.env["VIA_APP_DATA_DIR"];
if (!dataDir) {
  console.error(
    "[prometheus] ERROR: VIA_APP_DATA_DIR is not set. This script is a step of `via app start prometheus`, which sets it.",
  );
  process.exit(1);
}
const configFile = join(dataDir, "prometheus.yml");
const prefix = envGet("CONTAINER_PREFIX");

const wanted = `# Written by the prometheus app (scripts/ensure-config.ts) at every start.
# Do not edit: put your own scrape jobs in scrape/*.yml and your own alert rules
# in alerts/*.yml, next to this file.
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - /etc/prometheus/alerts/*.yml

scrape_config_files:
  - /etc/prometheus/scrape/*.yml

scrape_configs:
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']

  - job_name: 'node-exporter'
    static_configs:
      - targets: ['${prefix}node-exporter:9100']

  - job_name: 'cadvisor'
    static_configs:
      - targets: ['${prefix}cadvisor:8080']
`;

try {
  for (const dir of [dataDir, join(dataDir, "alerts"), join(dataDir, "scrape"), join(dirname(dataDir), "metrics")])
    mkdirSync(dir, { recursive: true });
  // Docker makes a folder where a mounted file is missing; an earlier failed start can leave one.
  if (existsSync(configFile) && statSync(configFile).isDirectory()) {
    ts("prometheus.yml is a folder (left by a start without the file); removing it.");
    rmSync(configFile, { recursive: true });
  }
  if (existsSync(configFile) && readFileSync(configFile, "utf8") === wanted) {
    ts("✓ prometheus.yml is up to date.");
  } else {
    // Written in place when the file exists: a running Prometheus has this very file mounted.
    if (existsSync(configFile)) writeFileSync(configFile, wanted);
    else {
      writeFileSync(`${configFile}.tmp`, wanted, { mode: 0o644 });
      renameSync(`${configFile}.tmp`, configFile);
    }
    ts(`✓ prometheus.yml written (containers ${prefix || "without a prefix"}).`);
  }
} catch (error) {
  console.error(`[prometheus] ERROR: ${(error as Error).message}`);
  process.exit(1);
}
