#!/usr/bin/env bun
/**
 * Package: grafana
 * Purpose: get Grafana's start files right before it starts, without a person:
 *          1. Data sources for the Prometheus and Loki apps installed in the
 *             same project (provisioning/datasources/apps.yaml). With neither
 *             installed the file lists none, and Grafana works without them.
 *             An app taken out of the project loses its data source.
 *          2. A dashboard folder that shows every JSON file in the app's
 *             dashboards folder (provisioning/dashboards/apps.yaml), unless
 *             another file there already does that.
 *          3. The published host name as an address Grafana trusts queries
 *             from (GRAFANA_CSRF_TRUSTED_ORIGINS in .env, from GRAFANA_URL).
 *          Only its own files (apps.yaml) are written; others are left alone.
 *          Safe to repeat.
 * Usage:   bun packages/grafana/scripts/prepare.ts   (from the project folder)
 * Called by: app.yaml (prepare step)
 * Exit:    0 when the files are in place, 1 otherwise.
 *
 * @module
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { envGet, setEnv, ts } from "./_setup-env.ts";

const dataDir = process.env["VIA_APP_DATA_DIR"];
if (!dataDir) {
  console.error(
    "[grafana] ERROR: VIA_APP_DATA_DIR is not set. This script is a step of `via app start grafana`, which sets it.",
  );
  process.exit(1);
}
const appDir = process.env["VIA_APP_DIR"] ?? dirname(import.meta.dir);
const provisioning = join(dataDir, "provisioning");
const prefix = envGet("CONTAINER_PREFIX");

/** An app counts as installed when its package is next to this one and .env holds its port. */
const installed = (app: string, portKey: string): boolean =>
  existsSync(join(dirname(appDir), app, "app.yaml")) && envGet(portKey) !== "";

/** Write a file only when its content differs; true when it was written. */
function put(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return false;
  writeFileSync(path, content, { mode: 0o644 });
  return true;
}

try {
  for (const dir of ["datasources", "dashboards", "alerting", "plugins"])
    mkdirSync(join(provisioning, dir), { recursive: true });
  mkdirSync(join(dataDir, "dashboards"), { recursive: true });

  // 1. Data sources. The uids are fixed (prometheus, loki) so dashboards can name them.
  const sources: string[] = [];
  const found: string[] = [];
  if (installed("prometheus", "PROMETHEUS_PORT")) {
    found.push("Prometheus");
    sources.push(`  - name: Prometheus
    type: prometheus
    uid: prometheus
    access: proxy
    url: http://${prefix}prometheus:9090
    isDefault: true
    editable: false
    jsonData:
      timeInterval: "15s"
      httpMethod: POST
`);
  }
  if (installed("loki", "LOKI_PORT")) {
    found.push("Loki");
    sources.push(`  - name: Loki
    type: loki
    uid: loki
    access: proxy
    url: http://${prefix}loki:3100
    isDefault: ${found.length === 1}
    editable: false
    jsonData:
      maxLines: 1000
`);
  }
  const datasources = `# Written by the grafana app (scripts/prepare.ts) at every start. Do not edit:
# put data sources of your own in another file in this folder.
apiVersion: 1

# A data source this file listed before and no longer lists is removed.
prune: true

datasources:${sources.length ? `\n${sources.join("\n")}` : " []\n"}`;
  if (put(join(provisioning, "datasources", "apps.yaml"), datasources)) {
    ts(
      found.length
        ? `✓ Data sources written: ${found.join(" and ")}.`
        : "✓ No Prometheus or Loki app in this project; Grafana starts without data sources.",
    );
  } else ts(`✓ Data sources are up to date (${found.join(" and ") || "none"}).`);

  // 2. The dashboards folder, unless a file of the user's own already provides one.
  const ownProvider = join(provisioning, "dashboards", "apps.yaml");
  const others = readdirSync(join(provisioning, "dashboards")).filter(
    (file) => file !== "apps.yaml" && /\.ya?ml$/.test(file),
  );
  if (others.length) {
    if (existsSync(ownProvider)) rmSync(ownProvider);
    ts(`✓ Dashboards are provided by ${others.join(", ")}.`);
  } else if (
    put(
      ownProvider,
      `# Written by the grafana app (scripts/prepare.ts). Shows every dashboard (a JSON file)
# put in the app's dashboards folder.
apiVersion: 1

providers:
  - name: Dashboards
    orgId: 1
    type: file
    disableDeletion: false
    updateIntervalSeconds: 30
    allowUiUpdates: true
    options:
      path: /var/lib/grafana/dashboards
`,
    )
  ) {
    ts("✓ Dashboard folder written.");
  }

  // 3. The published host name, without scheme and path.
  const host = envGet("GRAFANA_URL")
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .trim();
  if (host && envGet("GRAFANA_CSRF_TRUSTED_ORIGINS") !== host) {
    if (!(await setEnv("GRAFANA_CSRF_TRUSTED_ORIGINS", host)))
      throw new Error("could not write GRAFANA_CSRF_TRUSTED_ORIGINS to .env");
    ts(`✓ GRAFANA_CSRF_TRUSTED_ORIGINS set to ${host}`);
  }
} catch (error) {
  console.error(`[grafana] ERROR: ${(error as Error).message}`);
  process.exit(1);
}
