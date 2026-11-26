#!/usr/bin/env bun
/**
 * Package: superset
 * Purpose: connect Superset to Authentik before it starts, without a person.
 *          Superset reads its sign-in settings only when its containers
 *          start, so this runs as a `prepare` step of `via app start`:
 *          Authentik makes the sign-in client: its id and secret land in .env,
 *          and so does Authentik's local address, for the browser to go to
 *          when Authentik has no published one.
 *          With no Authentik in the project, or with Authentik not running,
 *          nothing changes: Superset starts with what .env holds, and with
 *          its own login when there is no sign-in client. Safe to repeat.
 * Usage:   bun packages/superset/scripts/connect-sign-in.ts
 * Called by: app.yaml (prepare step)
 * Exit:    0 when connected or when there is no Authentik to connect to,
 *          1 when Authentik runs and the connection could not be made.
 *
 * @module
 */
import { authentikScript, ts } from "./_setup-env.ts";

const makeClient = authentikScript("oidc-client.ts", "Superset");
if (!makeClient) process.exit(0);

const made = Bun.spawnSync(["bun", makeClient, "superset", "--redirect-path=/oauth-authorized/authentik", "--name=Superset"], {
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env },
});
if (made.exitCode !== 0) {
  console.error("[superset] ERROR: Authentik could not make the sign-in for Superset.");
  process.exit(1);
}

ts("✓ Sign-in through Authentik is connected; Superset starts with it.");
