#!/usr/bin/env bun
/**
 * Package: mattermost
 * Purpose: connect Mattermost to Authentik before it starts, without a person.
 *          Mattermost reads its sign-in settings only when its containers
 *          start, so this runs as a `prepare` step of `via app start`:
 *          Authentik makes the sign-in client: its id and secret land in .env,
 *          and so does Authentik's local address, for the browser to go to
 *          when Authentik has no published one.
 *          With no Authentik in the project, or with Authentik not running,
 *          nothing changes: Mattermost starts with what .env holds, and with
 *          its own login when there is no sign-in client. Safe to repeat.
 * Usage:   bun packages/mattermost/scripts/connect-sign-in.ts
 * Called by: app.yaml (prepare step)
 * Exit:    0 when connected or when there is no Authentik to connect to,
 *          1 when Authentik runs and the connection could not be made.
 *
 * @module
 */
import { dirname, join } from "node:path";
import { authentikScript, ts } from "./_setup-env.ts";

const appDir = process.env["VIA_APP_DIR"] ?? dirname(import.meta.dir);
const makeClient = authentikScript("oidc-client.ts", "Mattermost");
if (!makeClient) process.exit(0);

const made = Bun.spawnSync(
  [
    "bun",
    makeClient,
    "mattermost",
    "--redirect-path=/signup/gitlab/complete",
    "--redirect-path=/login/gitlab/complete",
    "--name=Mattermost",
    // Mattermost signs in through its GitLab settings: it wants the user as GitLab would describe one, with a number as id.
    "--sub-mode=user_id",
    `--mappings=${join(appDir, "scripts", "sign-in-mappings.json")}`,
  ],
  {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  },
);
if (made.exitCode !== 0) {
  console.error("[mattermost] ERROR: Authentik could not make the sign-in for Mattermost.");
  process.exit(1);
}

ts("✓ Sign-in through Authentik is connected; Mattermost starts with it.");
