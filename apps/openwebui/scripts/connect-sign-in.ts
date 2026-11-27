#!/usr/bin/env bun
/**
 * Package: openwebui
 * Purpose: connect Open WebUI to Authentik before it starts, without a person.
 *          Open WebUI reads its sign-in settings only when its container
 *          starts, so this runs as a `prepare` step of `via app start`:
 *          it has Authentik make the sign-in client (id and secret land in
 *          .env) and writes Authentik's address for Open WebUI to .env.
 *          With no Authentik in the project, or with Authentik not running,
 *          nothing changes and Open WebUI starts with what .env holds.
 *          Safe to repeat.
 * Usage:   bun packages/openwebui/scripts/connect-sign-in.ts
 * Called by: app.yaml (prepare step)
 * Exit:    0 when connected or when there is no Authentik to connect to,
 *          1 when Authentik runs and the connection could not be made.
 *
 * @module
 */
import { authentikScript, envGet, setEnv, ts } from "./_setup-env.ts";

const CALLBACK = "/oauth/oidc/callback";
const makeClient = authentikScript("oidc-client.ts", "Open WebUI");
if (!makeClient) process.exit(0);

const made = Bun.spawnSync(["bun", makeClient, "openwebui", `--redirect-path=${CALLBACK}`, "--name=Open WebUI"], {
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env },
});
if (made.exitCode !== 0) {
  console.error("[openwebui] ERROR: Authentik could not make the sign-in for Open WebUI.");
  process.exit(1);
}

// Authentik's address must be the same for the browser and for the Open WebUI container.
// Published: its public address. Not published: authentik.localhost, which a browser
// resolves to this machine and the container reaches through its extra_hosts entry.
const published = envGet("AUTHENTIK_URL").replace(/\/+$/, "");
const port = envGet("AUTHENTIK_PORT");
const base = /^https?:\/\//.test(published) ? published : port ? `http://authentik.localhost:${port}` : "";
if (!base) {
  console.error("[openwebui] ERROR: neither AUTHENTIK_URL nor AUTHENTIK_PORT is in .env.");
  process.exit(1);
}
const wanted: Record<string, string> = {
  OPENWEBUI_OIDC_PROVIDER_URL: `${base}/application/o/openwebui/.well-known/openid-configuration`,
};
const own = envGet("OPENWEBUI_URL").replace(/\/+$/, "");
if (/^https?:\/\//.test(own)) wanted["OPENWEBUI_OIDC_REDIRECT_URI"] = `${own}${CALLBACK}`;

let wrote = false;
for (const [key, value] of Object.entries(wanted)) {
  if (envGet(key) === value) continue;
  if (!(await setEnv(key, value))) {
    console.error(`[openwebui] ERROR: could not write ${key} to .env.`);
    process.exit(1);
  }
  ts(`✓ ${key} set to ${value}`);
  wrote = true;
}
ts(
  wrote
    ? "Sign-in through Authentik is connected; Open WebUI starts with it."
    : "✓ Sign-in through Authentik is already connected.",
);
