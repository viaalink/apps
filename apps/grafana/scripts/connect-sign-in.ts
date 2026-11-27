#!/usr/bin/env bun
/**
 * Package: grafana
 * Purpose: connect Grafana to Authentik before it starts, without a person.
 *          Grafana reads its sign-in settings only when its container starts,
 *          so this runs as a `prepare` step of `via app start`: it has
 *          Authentik make the sign-in client (id and secret land in .env),
 *          turns the sign-in on (GRAFANA_OAUTH_ENABLED) and writes where
 *          signing out leads (GRAFANA_SIGNOUT_URL).
 *          With no Authentik in the project, or with Authentik not running,
 *          nothing changes and Grafana starts with what .env holds.
 *          Safe to repeat.
 * Usage:   bun packages/grafana/scripts/connect-sign-in.ts
 * Called by: app.yaml (prepare step)
 * Exit:    0 when connected or when there is no Authentik to connect to,
 *          1 when Authentik runs and the connection could not be made.
 *
 * @module
 */
import { authentikScript, envGet, fromEnvFile, setEnv, ts } from "./_setup-env.ts";

const makeClient = authentikScript("oidc-client.ts", "Grafana");
if (!makeClient) process.exit(0);

const made = Bun.spawnSync(["bun", makeClient, "grafana", "--redirect-path=/login/generic_oauth", "--name=Grafana"], {
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env },
});
if (made.exitCode !== 0) {
  console.error("[grafana] ERROR: Authentik could not make the sign-in for Grafana.");
  process.exit(1);
}

// Authentik as the browser reaches it: its published address, else its local one
// (written to .env by Authentik's own script just now).
const web = (value: string): string => (/^https?:\/\//.test(value) ? value.replace(/\/+$/, "") : "");
const browser = web(envGet("AUTHENTIK_URL")) || web(fromEnvFile("AUTHENTIK_LOCAL_URL"));
if (!browser) {
  console.error("[grafana] ERROR: neither AUTHENTIK_URL nor AUTHENTIK_LOCAL_URL is in .env.");
  process.exit(1);
}
const wanted: Record<string, string> = {
  GRAFANA_OAUTH_ENABLED: "true",
  GRAFANA_SIGNOUT_URL: `${browser}/application/o/grafana/end-session/`,
};
let wrote = false;
for (const [key, value] of Object.entries(wanted)) {
  if (fromEnvFile(key) === value) continue;
  if (!(await setEnv(key, value))) {
    console.error(`[grafana] ERROR: could not write ${key} to .env.`);
    process.exit(1);
  }
  ts(`✓ ${key} set to ${value}`);
  wrote = true;
}
ts(
  wrote
    ? "Sign-in through Authentik is connected; Grafana starts with it."
    : "✓ Sign-in through Authentik is already connected.",
);
