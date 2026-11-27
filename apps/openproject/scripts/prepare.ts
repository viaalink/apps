#!/usr/bin/env bun
/**
 * Package: openproject
 * Purpose: tell OpenProject which address it is served on, before it starts.
 *          OpenProject builds its links and checks its cookies against that
 *          address, and reads it only when its container starts. Published:
 *          the address in OPENPROJECT_URL. Not published: this machine and
 *          the app's port, over plain http. Safe to repeat.
 * Usage:   bun packages/openproject/scripts/prepare.ts
 * Called by: app.yaml (prepare step)
 * Exit:    0 when .env holds the address, 1 when it could not be written.
 *
 * @module
 */
import { envGet, fromEnvFile, setEnv, ts } from "./_setup-env.ts";

const published = envGet("OPENPROJECT_URL").replace(/\/+$/, "");
const port = envGet("OPENPROJECT_PORT");
const isWeb = /^https?:\/\//.test(published);
const wanted: Record<string, string> = {
  OPENPROJECT_HOST_NAME: isWeb ? new URL(published).host : `localhost:${port}`,
  OPENPROJECT_HTTPS: isWeb && published.startsWith("https://") ? "true" : "false",
};
for (const [key, value] of Object.entries(wanted)) {
  const had = fromEnvFile(key);
  if (had === value) continue;
  if (!(await setEnv(key, value))) {
    console.error(`[openproject] ERROR: could not write ${key} to .env.`);
    process.exit(1);
  }
  ts(`${key}: ${had || "(empty)"} -> ${value}`);
}
