#!/usr/bin/env bun
/**
 * Package: alloy
 * Purpose: write Alloy's configuration before it starts, without a person:
 *          config.alloy in the app's data folder. Alloy reads the logs of
 *          every container on this machine through the Docker socket and
 *          sends them to Loki: the Loki app of this project
 *          (<container prefix>loki), or the address in ALLOY_LOKI_URL when
 *          .env holds one. Each line carries the container's name, and the
 *          app's name as `service` for the containers of this project.
 *          The file belongs to the app and is written again at every start.
 * Usage:   bun packages/alloy/scripts/ensure-config.ts   (from the project folder)
 * Called by: app.yaml (prepare step)
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
    "[alloy] ERROR: VIA_APP_DATA_DIR is not set. This script is a step of `via app start alloy`, which sets it.",
  );
  process.exit(1);
}
const appDir = process.env["VIA_APP_DIR"] ?? dirname(import.meta.dir);
const configFile = join(dataDir, "config.alloy");
const prefix = envGet("CONTAINER_PREFIX");
const loki = (envGet("ALLOY_LOKI_URL") || `http://${prefix}loki:3100`).replace(/\/+$/, "");
const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\\\$&");

const wanted = `// Written by the alloy app (scripts/ensure-config.ts) at every start. Do not edit.
// Docker container logs -> Loki.

logging {
  level  = "info"
  format = "logfmt"
}

// Every container on this machine.
discovery.docker "containers" {
  host = "unix:///var/run/docker.sock"
}

discovery.relabel "docker_labels" {
  targets = discovery.docker.containers.targets

  // container: the container's name.
  rule {
    source_labels = ["__meta_docker_container_name"]
    regex         = "/(.*)"
    target_label  = "container"
  }

  // service: the app a container of this project belongs to (its name up to the first dash).
  rule {
    source_labels = ["__meta_docker_container_name"]
    regex         = "/${escaped}([^-]+).*"
    target_label  = "service"
  }

  rule {
    replacement  = "docker"
    target_label = "job"
  }
}

loki.source.docker "docker_logs" {
  host          = "unix:///var/run/docker.sock"
  targets       = discovery.relabel.docker_labels.output
  forward_to    = [loki.process.docker_logs.receiver]
  refresh_interval = "5s"
}

// Read level and message from lines written as JSON.
loki.process "docker_logs" {
  stage.json {
    expressions = {
      level   = "level",
      msg     = "msg",
      message = "message",
    }
  }

  stage.label_drop {
    values = ["filename"]
  }

  forward_to = [loki.write.local.receiver]
}

loki.write "local" {
  endpoint {
    url = "${loki}/loki/api/v1/push"
  }
}
`;

try {
  mkdirSync(dataDir, { recursive: true });
  // Docker makes a folder where a mounted file is missing; an earlier failed start can leave one.
  if (existsSync(configFile) && statSync(configFile).isDirectory()) {
    ts("config.alloy is a folder (left by a start without the file); removing it.");
    rmSync(configFile, { recursive: true });
  }
  if (existsSync(configFile) && readFileSync(configFile, "utf8") === wanted) {
    ts("✓ config.alloy is up to date.");
  } else {
    // Written in place when the file exists: a running Alloy has this very file mounted.
    if (existsSync(configFile)) writeFileSync(configFile, wanted);
    else {
      writeFileSync(`${configFile}.tmp`, wanted, { mode: 0o644 });
      renameSync(`${configFile}.tmp`, configFile);
    }
    ts(`✓ config.alloy written: logs go to ${loki}.`);
  }
  if (!envGet("ALLOY_LOKI_URL") && !existsSync(join(dirname(appDir), "loki", "app.yaml"))) {
    ts("The Loki app is not installed in this project; Alloy keeps trying until Loki is there (via app install loki).");
  }
} catch (error) {
  console.error(`[alloy] ERROR: ${(error as Error).message}`);
  process.exit(1);
}
