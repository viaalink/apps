#!/usr/bin/env bun
/**
 * Package: wikijs
 * Purpose: connect Wiki.js to Authentik, without a person. Wiki.js keeps its
 *          sign-in methods in its database, so this runs as a setup step
 *          after Wiki.js is up: Authentik makes the sign-in client, and the
 *          "Authentik" sign-in method in Wiki.js is made or brought up to
 *          date with it. Wiki.js is restarted only when something changed.
 *          Only the addresses and the client id and secret are managed here.
 *          On a sign-in method that exists already, who may register and
 *          which groups new users get stay as they are. A new one gives new
 *          users no group: an administrator decides what they may do.
 *          With no Authentik in the project, or with Authentik not running,
 *          nothing changes. Safe to repeat.
 * Usage:   bun packages/wikijs/scripts/connect-sign-in.ts
 * Called by: app.yaml (setup step)
 * Exit:    0 when connected or when there is no Authentik to connect to,
 *          1 when Authentik runs and the connection could not be made.
 *
 * @module
 */
import { authentikScript, envGet, fromEnvFile, ts } from "./_setup-env.ts";

const CALLBACK = "/login/oauth2/callback";
const prefix = envGet("CONTAINER_PREFIX");
const wiki = envGet("WIKIJS_CONTAINER_NAME") || `${prefix}wikijs`;
const database = envGet("WIKIJS_POSTGRES_CONTAINER") || `${prefix}wikijs-postgres`;

function fail(message: string): never {
  console.error(`[WIKIJS] ERROR: ${message}`);
  process.exit(1);
}

const makeClient = authentikScript("oidc-client.ts", "Wiki.js");
if (!makeClient) process.exit(0);
const made = Bun.spawnSync(["bun", makeClient, "wikijs", `--redirect-path=${CALLBACK}`, "--name=Wiki.js"], { stdout: "inherit", stderr: "inherit", env: { ...process.env } });
if (made.exitCode !== 0) fail("Authentik could not make the sign-in for Wiki.js.");

/** One statement in Wiki.js's own database; the text goes over stdin, so nothing needs escaping for a shell. */
function sql(statement: string): { ok: boolean; out: string; err: string } {
  const r = Bun.spawnSync(
    ["docker", "exec", "-i", database, "psql", "-v", "ON_ERROR_STOP=1", "-U", envGet("WIKIJS_POSTGRES_USER", "wikijs"), "-d", envGet("WIKIJS_POSTGRES_DB", "wikijs"), "-tA"],
    { stdin: Buffer.from(`${statement}\n`), stdout: "pipe", stderr: "pipe" },
  );
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim().split("\n").pop() ?? "" };
}

const web = (value: string): string => (/^https?:\/\//.test(value) ? value.replace(/\/+$/, "") : "");
// The browser goes to Authentik's published address (its local one when it has none);
// Wiki.js itself reaches Authentik over the network the apps share.
const authentik = web(envGet("AUTHENTIK_URL")) || web(fromEnvFile("AUTHENTIK_LOCAL_URL"));
const own = web(envGet("WIKIJS_URL")) || (envGet("WIKIJS_PORT") ? `http://localhost:${envGet("WIKIJS_PORT")}` : "");
const clientId = fromEnvFile("WIKIJS_OAUTH_CLIENT_ID");
const clientSecret = fromEnvFile("WIKIJS_OAUTH_CLIENT_SECRET");
if (!authentik || !own) fail("no address for Authentik or Wiki.js in .env (AUTHENTIK_URL or AUTHENTIK_PORT, WIKIJS_URL or WIKIJS_PORT).");
if (!clientId || !clientSecret) fail("WIKIJS_OAUTH_CLIENT_ID / WIKIJS_OAUTH_CLIENT_SECRET are not in .env.");

const managed: Record<string, string> = {
  clientId,
  clientSecret,
  authorizationURL: `${authentik}/application/o/authorize/`,
  tokenURL: `http://${prefix}authentik:9000/application/o/token/`,
  userInfoURL: `http://${prefix}authentik:9000/application/o/userinfo/`,
  callbackURL: `${own}${CALLBACK}`,
};

const found = sql(`SELECT config::text FROM authentication WHERE key = 'oauth2';`);
if (!found.ok) fail(`Wiki.js's database did not answer: ${found.err}`);

// The dollar-quoted text cannot end early: the tag is not something a value contains.
const quote = (text: string): string => {
  if (text.includes("$via$")) fail("a sign-in value contains $via$");
  return `$via$${text}$via$`;
};

let changed = false;
if (!found.out) {
  const config = {
    scope: "openid profile email",
    userIdClaim: "sub",
    emailClaim: "email",
    displayNameClaim: "name",
    groupsClaim: "groups",
    // Off on purpose: with it on, Wiki.js takes a user's groups away when Authentik sends none.
    mapGroups: false,
    logoutURL: "",
    enableCSRFProtection: false,
    useQueryStringForAccessToken: false,
    ...managed,
  };
  const order = sql(`SELECT COALESCE(MAX("order"), 0) + 1 FROM authentication;`);
  const added = sql(
    `INSERT INTO authentication (key, "isEnabled", config, "selfRegistration", "domainWhitelist", "autoEnrollGroups", "strategyKey", "displayName", "order")
     VALUES ('oauth2', true, ${quote(JSON.stringify(config))}::json, true, '{"v":[]}'::json, '{"v":[]}'::json, 'oauth2', 'Authentik', ${Number(order.out) || 1});`,
  );
  if (!added.ok) fail(`Wiki.js's database refused the sign-in method: ${added.err}`);
  ts("✓ Sign-in method Authentik made in Wiki.js. New users get no group until an administrator gives them one.");
  changed = true;
} else {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(found.out) as Record<string, unknown>;
  } catch {
    fail("the sign-in method in Wiki.js's database is not readable.");
  }
  const differing = Object.entries(managed).filter(([key, value]) => config[key] !== value).map(([key]) => key);
  if (differing.length) {
    const updated = sql(`UPDATE authentication SET config = ${quote(JSON.stringify({ ...config, ...managed }))}::json, "isEnabled" = true WHERE key = 'oauth2';`);
    if (!updated.ok) fail(`Wiki.js's database refused the change: ${updated.err}`);
    ts(`✓ Sign-in method Authentik brought up to date (${differing.join(", ")}).`);
    for (const key of differing) if (!key.startsWith("client")) ts(`    ${key}: ${String(config[key] ?? "")} -> ${managed[key]}`);
    changed = true;
  }
}

if (!changed) {
  ts("✓ Sign-in through Authentik is already connected.");
  process.exit(0);
}

// Wiki.js reads its sign-in methods when it starts.
const restarted = Bun.spawnSync(["docker", "restart", wiki], { stdout: "pipe", stderr: "pipe" });
if (restarted.exitCode !== 0) fail(`could not restart ${wiki}: ${restarted.stderr.toString().trim()}`);
const port = envGet("WIKIJS_PORT");
for (let waited = 0; waited < 180; waited += 3) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/login/oauth2`, { redirect: "manual", headers: { connection: "close" } });
    const to = r.headers.get("location") ?? "";
    if (r.status === 302 && to.startsWith(managed["authorizationURL"] as string)) {
      ts("✓ Wiki.js restarted; its sign-in goes to Authentik.");
      process.exit(0);
    }
  } catch {
    // not up yet
  }
  await Bun.sleep(3000);
}
fail(`Wiki.js was restarted but /login/oauth2 does not go to ${managed["authorizationURL"]}.`);
