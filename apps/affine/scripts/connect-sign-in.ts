#!/usr/bin/env bun
/**
 * Package: affine
 * Purpose: connect AFFiNE to Authentik, without a person. It has Authentik
 *          make the sign-in client (id and secret land in .env), with an
 *          e-mail scope that marks addresses as verified, which AFFiNE
 *          insists on, and stores client and issuer in AFFiNE's own settings
 *          table. AFFiNE reads those when it starts, so it is restarted when
 *          something changed. With no Authentik in the project, or with
 *          Authentik not running, nothing changes. Safe to repeat.
 * Usage:   bun packages/affine/scripts/connect-sign-in.ts
 * Called by: app.yaml (setup step)
 * Exit:    0 when connected or when there is no Authentik to connect to,
 *          1 when Authentik runs and the connection could not be made.
 *
 * @module
 */
import { dirname, join } from "node:path";
import { sql } from "./_database.ts";
import { authentikScript, envGet, fromEnvFile, ts } from "./_setup-env.ts";

const CALLBACK = "/oauth/callback";
const prefix = envGet("CONTAINER_PREFIX");
const affine = envGet("AFFINE_CONTAINER_NAME") || `${prefix}affine`;

function fail(message: string): never {
  console.error(`[affine] ERROR: ${message}`);
  process.exit(1);
}

const makeClient = authentikScript("oidc-client.ts", "AFFiNE");
if (!makeClient) process.exit(0);
const mappings = join(dirname(import.meta.path), "sign-in-mappings.json");
const made = Bun.spawnSync(
  ["bun", makeClient, "affine", `--redirect-path=${CALLBACK}`, "--name=AFFiNE", `--mappings=${mappings}`],
  {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  },
);
if (made.exitCode !== 0) fail("Authentik could not make the sign-in for AFFiNE.");

// Authentik's address must be the same for the browser and for the AFFiNE container.
// Published: its public address. Not published: authentik.localhost, which a browser
// resolves to this machine and the container reaches through its extra_hosts entry.
const published = envGet("AUTHENTIK_URL").replace(/\/+$/, "");
const port = envGet("AUTHENTIK_PORT");
const base = /^https?:\/\//.test(published) ? published : port ? `http://authentik.localhost:${port}` : "";
if (!base) fail("neither AUTHENTIK_URL nor AUTHENTIK_PORT is in .env.");
const clientId = fromEnvFile("AFFINE_OAUTH_CLIENT_ID");
const clientSecret = fromEnvFile("AFFINE_OAUTH_CLIENT_SECRET");
if (!clientId || !clientSecret) fail("AFFINE_OAUTH_CLIENT_ID / AFFINE_OAUTH_CLIENT_SECRET are not in .env.");

// No slash at the end: AFFiNE adds "/.well-known/openid-configuration" to it as text.
const wanted: Record<string, string> = {
  "oauth.providers.oidc.clientId": clientId,
  "oauth.providers.oidc.clientSecret": clientSecret,
  "oauth.providers.oidc.issuer": `${base}/application/o/affine`,
};

const quote = (text: string): string => {
  if (text.includes("$via$")) fail("a sign-in value contains $via$");
  return `$via$${text}$via$`;
};

const found = sql(`SELECT id || '=' || value::text FROM app_configs WHERE id LIKE 'oauth.providers.oidc.%';`);
if (!found.ok) fail(`AFFiNE's database did not answer: ${found.err}`);
const stored = new Map(
  found.out
    .split("\n")
    .filter(Boolean)
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const differing = Object.entries(wanted).filter(([key, value]) => stored.get(key) !== JSON.stringify(value));
if (!differing.length) {
  ts("✓ Sign-in through Authentik is already connected.");
  process.exit(0);
}
for (const [key, value] of differing) {
  const saved = sql(
    `INSERT INTO app_configs (id, value, created_at, updated_at) VALUES (${quote(key)}, ${quote(JSON.stringify(value))}::jsonb, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();`,
  );
  if (!saved.ok) fail(`AFFiNE's database refused ${key}: ${saved.err}`);
  if (key.endsWith("issuer")) ts(`    issuer: ${(stored.get(key) ?? "").replace(/"/g, "")} -> ${value}`);
}
ts(`✓ Sign-in settings stored in AFFiNE (${differing.map(([key]) => key.split(".").pop()).join(", ")}).`);

// AFFiNE reads them when it starts.
const restarted = Bun.spawnSync(["docker", "restart", affine], { stdout: "pipe", stderr: "pipe" });
if (restarted.exitCode !== 0) fail(`could not restart ${affine}: ${restarted.stderr.toString().trim()}`);
const own = envGet("AFFINE_PORT");
for (let waited = 0; waited < 240; waited += 3) {
  try {
    const r = await fetch(`http://127.0.0.1:${own}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json", connection: "close" },
      body: JSON.stringify({ query: "{ serverConfig { oauthProviders } }" }),
    });
    if ((await r.text()).includes("OIDC")) {
      ts("✓ AFFiNE restarted; it offers sign-in through Authentik.");
      process.exit(0);
    }
  } catch {
    // not up yet
  }
  await Bun.sleep(3000);
}
fail(`AFFiNE was restarted but does not offer sign-in through Authentik. Read why: docker logs ${affine}`);
