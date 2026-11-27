#!/usr/bin/env bun
/**
 * Package: vaultwarden
 * Purpose: connect Vaultwarden to Authentik, without a person. It has
 *          Authentik make the sign-in client and writes client id, secret and
 *          Authentik's address to .env; the container that starts next reads
 *          them and offers "Use single sign-on" on its login page.
 *          Whether people may also keep a login of Vaultwarden's own is a
 *          choice of the installation: VAULTWARDEN_SSO_ONLY in .env (off by
 *          default).
 *          With no Authentik in the project, or with Authentik not running,
 *          nothing changes. Safe to repeat.
 * Usage:   bun packages/vaultwarden/scripts/connect-sign-in.ts
 * Called by: app.yaml (prepare step)
 * Exit:    0 when connected or when there is no Authentik to connect to,
 *          1 when Authentik runs and the connection could not be made.
 *
 * @module
 */
import { dirname, join } from "node:path";
import { authentikScript, envGet, fromEnvFile, setEnv, ts } from "./_setup-env.ts";

// Where Vaultwarden takes Authentik's answer.
const CALLBACK = "/identity/connect/oidc-signin";

function fail(message: string): never {
  console.error(`[vaultwarden] ERROR: ${message}`);
  process.exit(1);
}

const makeClient = authentikScript("oidc-client.ts", "Vaultwarden");
if (!makeClient) process.exit(0);
// A client the installation already uses (its id in .env) is kept by Authentik's script.
if (!envGet("VAULTWARDEN_OAUTH_CLIENT_ID") && envGet("VAULTWARDEN_SSO_CLIENT_ID")) {
  await setEnv("VAULTWARDEN_OAUTH_CLIENT_ID", envGet("VAULTWARDEN_SSO_CLIENT_ID"));
  await setEnv("VAULTWARDEN_OAUTH_CLIENT_SECRET", envGet("VAULTWARDEN_SSO_CLIENT_SECRET"));
}
// Vaultwarden wants the e-mail address marked as verified, and a refresh token.
const mappings = join(dirname(import.meta.path), "sign-in-mappings.json");
const made = Bun.spawnSync(
  ["bun", makeClient, "vaultwarden", `--redirect-path=${CALLBACK}`, "--name=Vaultwarden", `--mappings=${mappings}`],
  { stdout: "inherit", stderr: "inherit", env: { ...process.env } },
);
if (made.exitCode !== 0) fail("Authentik could not make the sign-in for Vaultwarden.");

// Authentik's address must be the same for the browser and for the Vaultwarden container.
// Published: its public address. Not published: authentik.localhost, which a browser
// resolves to this machine and the container reaches through its extra_hosts entry.
const published = envGet("AUTHENTIK_URL").replace(/\/+$/, "");
const port = envGet("AUTHENTIK_PORT");
const base = /^https?:\/\//.test(published) ? published : port ? `http://authentik.localhost:${port}` : "";
if (!base) fail("neither AUTHENTIK_URL nor AUTHENTIK_PORT is in .env.");
const clientId = fromEnvFile("VAULTWARDEN_OAUTH_CLIENT_ID");
const clientSecret = fromEnvFile("VAULTWARDEN_OAUTH_CLIENT_SECRET");
if (!clientId || !clientSecret) fail("VAULTWARDEN_OAUTH_CLIENT_ID / VAULTWARDEN_OAUTH_CLIENT_SECRET are not in .env.");

const wanted: Record<string, string> = {
  VAULTWARDEN_SSO_CLIENT_ID: clientId,
  VAULTWARDEN_SSO_CLIENT_SECRET: clientSecret,
  VAULTWARDEN_SSO_AUTHORITY: `${base}/application/o/vaultwarden/`,
};
const changed: string[] = [];
for (const [key, value] of Object.entries(wanted)) {
  if (fromEnvFile(key) === value) continue;
  if (key === "VAULTWARDEN_SSO_AUTHORITY" && fromEnvFile(key))
    ts(`    Authentik's address: ${fromEnvFile(key)} -> ${value}`);
  await setEnv(key, value);
  changed.push(key);
}
ts(
  changed.length
    ? `✓ Sign-in settings written to .env (${changed.join(", ")}); Vaultwarden reads them at this start.`
    : "✓ Sign-in through Authentik is already connected.",
);
