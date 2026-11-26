#!/usr/bin/env bun
/**
 * Package: n8n
 * Purpose: get n8n's settings file (n8n.env in its data directory) right
 *          before the containers start, without a person. n8n reads that file
 *          only when its container is created, so this runs as a `prepare`
 *          step of `via app start`:
 *          - the folders and the sign-in hook file the containers mount exist;
 *          - N8N_ENCRYPTION_KEY in n8n.env follows the key n8n's own data
 *            holds (after a restore they can differ, and n8n then refuses to start);
 *          - when Authentik runs in this project, Authentik makes the sign-in
 *            client and its settings are written to n8n.env.
 *          With no Authentik, sign-in settings already in .env are still
 *          carried over; otherwise n8n starts with its own login. Safe to repeat.
 * Usage:   bun packages/n8n/scripts/ensure-config.ts
 * Called by: app.yaml (prepare step), scripts/hooks/ensure-workspace.ts
 * Exit:    0 when n8n.env is right, 1 when Authentik runs and the sign-in
 *          could not be made, or the file could not be written.
 *
 * @module
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { envGet, fromEnvFile, projectRoot, ts } from "./_setup-env.ts";

const CALLBACK = "/rest/oidc/callback";
const appDir = process.env["VIA_APP_DIR"] ?? dirname(import.meta.dir);
const dataDir = process.env["VIA_APP_DATA_DIR"] ?? join(projectRoot, ".asd/workspace/n8n");
const envFile = join(dataDir, "n8n.env");

function fail(message: string): never {
  console.error(`[n8n] ERROR: ${message}`);
  process.exit(1);
}

// The folders the database and the hook file are mounted from must exist before the containers do.
mkdirSync(join(dataDir, "oidc"), { recursive: true });
mkdirSync(join(dataDir, "postgres"), { recursive: true });
const hooksFile = join(dataDir, "oidc", "hooks.js");
const hooksTemplate = join(appDir, "config", "oidc", "hooks.js.template");
if (existsSync(hooksTemplate) && (!existsSync(hooksFile) || statSync(hooksFile).size < 100)) {
  copyFileSync(hooksTemplate, hooksFile);
  ts("✓ Sign-in hook file placed.");
}

let lines = existsSync(envFile) ? readFileSync(envFile, "utf8").split(/\r?\n/) : [];
const before = lines.join("\n");
const current = (key: string): string =>
  lines
    .filter((l) => l.startsWith(`${key}=`))
    .pop()
    ?.slice(key.length + 1) ?? "";
function set(key: string, value: string): void {
  if (!value || current(key) === value) return;
  const kept = lines.filter((l) => !l.startsWith(`${key}=`));
  while (kept.length && kept[kept.length - 1] === "") kept.pop();
  lines = [...kept, `${key}=${value}`, ""];
}

// The key n8n's own data holds is the one that opens its stored credentials.
const keyInFile = current("N8N_ENCRYPTION_KEY");
if (keyInFile) {
  let keyInData = "";
  try {
    keyInData = (JSON.parse(readFileSync(join(dataDir, "data", "config"), "utf8")) as { encryptionKey?: string }).encryptionKey ?? "";
  } catch {
    // No data yet, or not readable from here: .env decides.
  }
  const wanted = keyInData || fromEnvFile("N8N_ENCRYPTION_KEY");
  if (wanted && wanted !== keyInFile) {
    set("N8N_ENCRYPTION_KEY", wanted);
    ts(`✓ N8N_ENCRYPTION_KEY in n8n.env now follows ${keyInData ? "n8n's own data" : ".env"}.`);
  }
}

// Sign-in through Authentik, when it runs in this project.
const prefix = envGet("CONTAINER_PREFIX");
const makeClient = join(dirname(appDir), "authentik", "scripts", "oidc-client.ts");
let authentikRuns = false;
if (existsSync(makeClient)) {
  const state = Bun.spawnSync(["docker", "inspect", "--format", "{{.State.Running}}", `${prefix}authentik`], { stdout: "pipe", stderr: "pipe" });
  authentikRuns = state.stdout.toString().trim() === "true";
  if (!authentikRuns) ts("Authentik is not running; sign-in is connected at the next start after Authentik is up.");
}
if (authentikRuns) {
  const made = Bun.spawnSync(["bun", makeClient, "n8n", `--redirect-path=${CALLBACK}`], { stdout: "inherit", stderr: "inherit", env: { ...process.env } });
  if (made.exitCode !== 0) fail("Authentik could not make the sign-in for n8n.");
}

const clientId = fromEnvFile("N8N_OAUTH_CLIENT_ID");
const clientSecret = fromEnvFile("N8N_OAUTH_CLIENT_SECRET");
if (clientId && clientSecret) {
  const web = (value: string): string => (/^https?:\/\//.test(value) ? value.replace(/\/+$/, "") : "");
  // The browser goes to Authentik's public address (its local port when it has none);
  // n8n itself reaches Authentik over the network the apps share.
  const authentik = web(envGet("AUTHENTIK_URL")) || (envGet("AUTHENTIK_PORT") ? `http://localhost:${envGet("AUTHENTIK_PORT")}` : "");
  const own = web(envGet("N8N_URL")) || (envGet("N8N_PORT") ? `http://localhost:${envGet("N8N_PORT")}` : "");
  const publicIssuer = web(envGet("N8N_OIDC_PUBLIC_ISSUER")) ? `${web(envGet("N8N_OIDC_PUBLIC_ISSUER"))}/` : authentik ? `${authentik}/application/o/n8n/` : "";
  const redirect = web(envGet("N8N_OIDC_REDIRECT_URI")) || (own ? `${own}${CALLBACK}` : "");
  if (!publicIssuer || !redirect) fail("no address for Authentik or n8n in .env (AUTHENTIK_URL or AUTHENTIK_PORT, N8N_URL or N8N_PORT).");
  set("OIDC_CLIENT_ID", clientId);
  set("OIDC_CLIENT_SECRET", clientSecret);
  set("OIDC_ISSUER_URL", `http://${prefix}authentik:9000/application/o/n8n/`);
  set("OIDC_PUBLIC_ISSUER_URL", publicIssuer);
  set("OIDC_REDIRECT_URI", redirect);
  set("OIDC_SCOPES", "openid email profile");
  set("EXTERNAL_HOOK_FILES", "/home/node/.n8n/hooks.js");
  set("EXTERNAL_FRONTEND_HOOKS_URLS", "/assets/oidc-frontend-hook.js");
}

const after = lines.join("\n");
if (after === before && existsSync(envFile)) {
  ts(clientId && clientSecret ? "✓ n8n.env is right; sign-in through Authentik is connected." : "✓ n8n.env is right; n8n uses its own login.");
  process.exit(0);
}
try {
  const tmp = `${envFile}.n8n-prepare.tmp`;
  writeFileSync(tmp, after, { mode: existsSync(envFile) ? statSync(envFile).mode & 0o777 : 0o600 });
  renameSync(tmp, envFile);
} catch (error) {
  fail(`could not write ${envFile}: ${error instanceof Error ? error.message : String(error)}`);
}
ts(clientId && clientSecret ? "✓ n8n.env updated; n8n starts with sign-in through Authentik." : "✓ n8n.env written.");
