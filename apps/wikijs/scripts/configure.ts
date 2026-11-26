#!/usr/bin/env bun
/**
 * Wiki.js: configure site settings + create API key.
 *
 * TS port of configure.sh (#3899, Epic #3896).
 *
 * Flow:
 *   1. If WIKIJS_API_KEY (env or .asd/workspace/wikijs/api-key.txt) is set
 *      AND GraphQL accepts it, reuse and exit 0 (idempotent).
 *   2. Otherwise: login via strategy="local" (admin created by init-db.sh),
 *      apply site config, enable GraphQL API, create a 365-day fullAccess key
 *      (group 1 = Administrators), persist to .asd/workspace/wikijs/api-key.txt.
 *
 * Audit note (api-key.md): init-db.sh always creates a local admin via
 *   /finalize before any OAuth2 strategy is registered. The local strategy
 *   keeps working after connect-sign-in.ts adds OAuth2 — Wiki.js runs both
 *   strategies in parallel. So this script does not need a manual fallback.
 *
 * Required .env: WIKIJS_PORT, WIKIJS_ADMIN_EMAIL, WIKIJS_ADMIN_PASSWORD.
 * Optional:      WIKIJS_SITE_TITLE, WIKIJS_SITE_DESCRIPTION, WIKIJS_COMPANY.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { envGet, setEnv, ts } from "./_setup-env.ts";

const pmaPath = process.env["PMA_PATH"] ?? process.cwd();
const port = process.env["WIKIJS_PORT"] ?? envGet("WIKIJS_PORT");
if (!port) {
  console.error("[WIKIJS] ERROR: WIKIJS_PORT not set in .env");
  process.exit(1);
}
const base = `http://localhost:${port}`;
const keyfile = join(pmaPath, ".asd/workspace/wikijs/api-key.txt");

interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function gql<T>(
  query: string,
  variables?: Record<string, unknown>,
  bearer?: string,
): Promise<GqlResponse<T>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
  const r = await fetch(`${base}/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables: variables ?? {} }),
  });
  return (await r.json()) as GqlResponse<T>;
}

async function isKeyValid(key: string): Promise<boolean> {
  try {
    const r = await gql<{ site: { config: { title: string } } }>(
      "{ site { config { title } } }",
      {},
      key,
    );
    return !!r.data?.site?.config;
  } catch {
    return false;
  }
}

function loadExistingKey(): string {
  const fromEnv = envGet("WIKIJS_API_KEY");
  if (fromEnv) return fromEnv;
  if (existsSync(keyfile)) return readFileSync(keyfile, "utf8").trim();
  return "";
}

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

ts("Configuring Wiki.js...");

// --- 1. Idempotency check -----------------------------------------------
const existingKey = loadExistingKey();
if (existingKey) {
  ts(`  Existing API key found (sha256:${shortHash(existingKey)}), validating...`);
  if (await isKeyValid(existingKey)) {
    ts("  ✓ Existing key is valid — reusing, nothing to do.");
    process.exit(0);
  }
  ts("  Existing key is INVALID, will regenerate.");
}

// --- 2. Login via local strategy ----------------------------------------
const adminEmail = process.env["WIKIJS_ADMIN_EMAIL"] ?? envGet("WIKIJS_ADMIN_EMAIL");
const adminPassword = process.env["WIKIJS_ADMIN_PASSWORD"] ?? envGet("WIKIJS_ADMIN_PASSWORD");
if (!adminEmail || !adminPassword) {
  console.error("[WIKIJS] ERROR: WIKIJS_ADMIN_EMAIL / WIKIJS_ADMIN_PASSWORD not set");
  process.exit(1);
}

ts("Authenticating (strategy=local)...");
const loginRes = await gql<{ authentication: { login: { jwt?: string; responseResult: { succeeded: boolean; message: string } } } }>(
  `mutation Login($u: String!, $p: String!) {
    authentication { login(username: $u, password: $p, strategy: "local") {
      responseResult { succeeded message }
      jwt
    } }
  }`,
  { u: adminEmail, p: adminPassword },
);
const jwt = loginRes.data?.authentication?.login?.jwt;
if (!jwt) {
  const msg = loginRes.data?.authentication?.login?.responseResult?.message
    ?? loginRes.errors?.[0]?.message
    ?? JSON.stringify(loginRes);
  console.error(`[WIKIJS] ERROR: login failed: ${msg}`);
  process.exit(1);
}
ts("  ✓ Authentication successful");

// --- 3. Site config -----------------------------------------------------
const title = envGet("WIKIJS_SITE_TITLE", "ASD Wiki");
const description = envGet("WIKIJS_SITE_DESCRIPTION", "Documentation for ASD Platform");
const company = envGet("WIKIJS_COMPANY", "ASD");
ts("Updating site configuration...");
const siteRes = await gql<{ site: { updateConfig: { responseResult: { succeeded: boolean; message: string } } } }>(
  `mutation Cfg($t: String!, $d: String!, $c: String!) {
    site { updateConfig(title: $t, description: $d, company: $c) {
      responseResult { succeeded message }
    } }
  }`,
  { t: title, d: description, c: company },
  jwt,
);
if (siteRes.data?.site?.updateConfig?.responseResult?.succeeded) {
  ts("  ✓ Site configuration updated");
} else {
  ts(`  ! Site config: ${siteRes.data?.site?.updateConfig?.responseResult?.message ?? JSON.stringify(siteRes)}`);
}

// --- 4. Enable API ------------------------------------------------------
ts("Enabling GraphQL API...");
const apiRes = await gql<{ authentication: { setApiState: { responseResult: { succeeded: boolean; message: string } } } }>(
  `mutation { authentication { setApiState(enabled: true) {
    responseResult { succeeded message }
  } } }`,
  {},
  jwt,
);
if (apiRes.data?.authentication?.setApiState?.responseResult?.succeeded) {
  ts("  ✓ API enabled");
} else {
  ts(`  ! API state: ${apiRes.data?.authentication?.setApiState?.responseResult?.message ?? JSON.stringify(apiRes)}`);
}

// --- 5. Create API key --------------------------------------------------
ts("Creating API key (365d, fullAccess, group=1)...");
// Wiki.js 2.x uses jsonwebtoken under the hood: `expiration` must be a
// jsonwebtoken-style timespan ("1d", "20h", "365d") or a number of seconds.
// An ISO-8601 datetime is rejected with "expiresIn should be a number of
// seconds or string representing a timespan". #3899 legacy bug carried from
// configure.sh; surfaced by #3900 validation on vs100 (2026-05-17).
const expiry = "365d";
const keyRes = await gql<{ authentication: { createApiKey: { key?: string; responseResult: { succeeded: boolean; message: string } } } }>(
  `mutation MkKey($name: String!, $exp: String!) {
    authentication { createApiKey(name: $name, expiration: $exp, fullAccess: true, group: 1) {
      responseResult { succeeded message }
      key
    } }
  }`,
  { name: "asd-pma-integration", exp: expiry },
  jwt,
);
const newKey = keyRes.data?.authentication?.createApiKey?.key;
if (!newKey) {
  const msg = keyRes.data?.authentication?.createApiKey?.responseResult?.message
    ?? keyRes.errors?.[0]?.message
    ?? JSON.stringify(keyRes);
  console.error(`[WIKIJS] ERROR: createApiKey failed: ${msg}`);
  process.exit(1);
}

// The key lives in .env. The office tooling also reads a copy from its workspace
// folder; a project without that folder gets no stray file.
await setEnv("WIKIJS_API_KEY", newKey);
if (existsSync(join(pmaPath, ".asd/workspace"))) {
  mkdirSync(dirname(keyfile), { recursive: true });
  writeFileSync(keyfile, `${newKey}\n`, { mode: 0o600 });
}
ts(`  ✓ API key created (sha256:${shortHash(newKey)}), saved in .env`);

// --- 6. Smoke-test the new key ------------------------------------------
if (!(await isKeyValid(newKey))) {
  console.error("[WIKIJS] ERROR: newly created key does not authenticate");
  process.exit(1);
}
ts("  ✓ New API key validated against GraphQL");
ts("Configuration complete!");
