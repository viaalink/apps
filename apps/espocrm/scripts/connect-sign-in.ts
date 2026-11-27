#!/usr/bin/env bun
/**
 * Package: espocrm
 * Purpose: connect EspoCRM to Authentik, without a person. It has Authentik
 *          make the sign-in client (id and secret land in .env) and stores
 *          client, addresses and the sign-in method in EspoCRM's settings,
 *          through EspoCRM's own config classes. Whoever Authentik lets in
 *          gets an EspoCRM account at the first sign-in; the administrator
 *          from .env keeps signing in with the password.
 *          With no Authentik in the project, or with Authentik not running,
 *          nothing changes. Safe to repeat.
 * Usage:   bun packages/espocrm/scripts/connect-sign-in.ts
 * Called by: app.yaml (setup step)
 * Exit:    0 when connected or when there is no Authentik to connect to,
 *          1 when Authentik runs and the connection could not be made.
 *
 * @module
 */
import { php } from "./_espo.ts";
import { authentikScript, envGet, fromEnvFile, ts } from "./_setup-env.ts";

const CALLBACK = "/oauth-callback.php";

function fail(message: string): never {
  console.error(`[espocrm] ERROR: ${message}`);
  process.exit(1);
}

const makeClient = authentikScript("oidc-client.ts", "EspoCRM");
if (!makeClient) process.exit(0);
const made = Bun.spawnSync(["bun", makeClient, "espocrm", `--redirect-path=${CALLBACK}`, "--name=EspoCRM"], {
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env },
});
if (made.exitCode !== 0) fail("Authentik could not make the sign-in for EspoCRM.");

// The browser goes to Authentik's address: its published one, else this machine.
// EspoCRM's own calls (token, keys) go to Authentik's container on the apps network.
const published = envGet("AUTHENTIK_URL").replace(/\/+$/, "");
const authentikPort = envGet("AUTHENTIK_PORT");
const browser = /^https?:\/\//.test(published) ? published : authentikPort ? `http://localhost:${authentikPort}` : "";
if (!browser) fail("neither AUTHENTIK_URL nor AUTHENTIK_PORT is in .env.");
const inside = `http://${envGet("CONTAINER_PREFIX")}authentik:9000`;
const ownUrl = envGet("ESPOCRM_URL").replace(/\/+$/, "");
const site = /^https?:\/\//.test(ownUrl) ? ownUrl : `http://localhost:${envGet("ESPOCRM_PORT")}`;
const clientId = fromEnvFile("ESPOCRM_OAUTH_CLIENT_ID");
const clientSecret = fromEnvFile("ESPOCRM_OAUTH_CLIENT_SECRET");
if (!clientId || !clientSecret) fail("ESPOCRM_OAUTH_CLIENT_ID / ESPOCRM_OAUTH_CLIENT_SECRET are not in .env.");

const wanted: Record<string, unknown> = {
  siteUrl: site,
  // Case matters: EspoCRM knows the method as "Oidc".
  authenticationMethod: "Oidc",
  oidcClientId: clientId,
  oidcClientSecret: clientSecret,
  oidcAuthorizationEndpoint: `${browser}/application/o/authorize/`,
  oidcTokenEndpoint: `${inside}/application/o/token/`,
  oidcJwksEndpoint: `${inside}/application/o/espocrm/jwks/`,
  oidcLogoutUrl: `${browser}/application/o/espocrm/end-session/`,
  oidcScopes: ["openid", "profile", "email"],
  oidcUsernameClaim: "preferred_username",
  oidcCreateUser: true,
  oidcSync: true,
  // The administrator from .env keeps the password login.
  oidcFallback: true,
};

const stored = php(
  `$out = []; foreach (array_keys($input) as $key) { $out[$key] = $config->get($key); } echo json_encode($out);`,
  wanted,
);
if (!stored.ok) fail(`EspoCRM did not give its settings: ${stored.err}`);
let current: Record<string, unknown> = {};
try {
  current = JSON.parse(stored.out.slice(stored.out.lastIndexOf("{")));
} catch {
  fail(`EspoCRM's settings could not be read: ${stored.out.slice(0, 200)}`);
}
const differing = Object.keys(wanted).filter((key) => JSON.stringify(current[key]) !== JSON.stringify(wanted[key]));
if (!differing.length) {
  ts("✓ Sign-in through Authentik is already connected.");
  process.exit(0);
}
for (const key of ["siteUrl", "oidcAuthorizationEndpoint"]) {
  if (differing.includes(key) && current[key]) ts(`    ${key}: ${String(current[key])} -> ${String(wanted[key])}`);
}
const saved = php(
  `$writer = $factory->create(\\Espo\\Core\\Utils\\Config\\ConfigWriter::class);
$writer->setMultiple($input);
$writer->save();
$app->getContainer()->getByClass(\\Espo\\Core\\DataManager::class)->clearCache();
echo "VIA_SAVED";`,
  Object.fromEntries(differing.map((key) => [key, wanted[key]])),
);
if (!saved.ok || !saved.out.includes("VIA_SAVED")) fail(`EspoCRM refused the sign-in settings: ${saved.err}`);
ts(`✓ Sign-in settings stored in EspoCRM (${differing.join(", ")}).`);

// EspoCRM's web processes pick the new settings up within a few seconds (PHP rereads the settings file).
const port = envGet("ESPOCRM_PORT");
let seen = "";
for (let waited = 0; waited < 60; waited += 2) {
  try {
    const offered = await fetch(`http://127.0.0.1:${port}/api/v1/Oidc/authorizationData`, {
      headers: { connection: "close" },
    });
    const data = (await offered.json().catch(() => ({}))) as { clientId?: string; redirectUri?: string };
    if (offered.ok && data.clientId === clientId) {
      ts(`✓ EspoCRM offers sign-in through Authentik; Authentik answers at ${data.redirectUri}.`);
      process.exit(0);
    }
    seen = `HTTP ${offered.status}`;
  } catch (error) {
    seen = error instanceof Error ? error.message : String(error);
  }
  await Bun.sleep(2000);
}
fail(`EspoCRM does not offer sign-in through Authentik (${seen}).`);
