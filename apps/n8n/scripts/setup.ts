#!/usr/bin/env bun
/**
 * Package: n8n
 * Purpose: set n8n up after it started, without a person: make the owner
 *          account when n8n has none, and make sure a working API key is in
 *          .env. Safe to run on every start: each part skips what is done.
 * Usage:   bun packages/n8n/scripts/setup.ts   (from the project folder)
 * Called by: `via app setup n8n` (app.yaml), which the start recipe runs.
 * Needs:   N8N_PORT in .env. Owner account: N8N_ADMIN_EMAIL and
 *          N8N_ADMIN_PASSWORD (else the project's ADMIN_EMAIL / ADMIN_PASSWORD).
 * Exit:    0 when n8n has an owner and .env holds a working API key, 1 otherwise.
 *
 * @module
 */
import { randomBytes } from "node:crypto";
import { envGet, setEnv, ts } from "./_setup-env.ts";

const port = envGet("N8N_PORT");
if (!port) {
  console.error("[n8n] ERROR: N8N_PORT is not in .env");
  process.exit(1);
}
const base = `http://127.0.0.1:${port}`;
const email = envGet("N8N_ADMIN_EMAIL") || envGet("ADMIN_EMAIL");
let password = envGet("N8N_ADMIN_PASSWORD") || envGet("ADMIN_PASSWORD");

interface Settings {
  data?: { userManagement?: { showSetupOnFirstLoad?: boolean } };
}

/** n8n answers /healthz before its REST API; wait for real JSON. */
async function waitSettings(seconds: number): Promise<Settings | null> {
  for (let waited = 0; waited < seconds; waited += 2) {
    try {
      const r = await fetch(`${base}/rest/settings`);
      const body = (await r.json()) as Settings;
      if (body.data) return body;
    } catch {
      // not ready yet
    }
    // A container that keeps restarting will never answer: say why instead of waiting it out.
    const state = Bun.spawnSync(["docker", "inspect", "--format", "{{.RestartCount}}", `${envGet("CONTAINER_PREFIX")}n8n`], { stdout: "pipe", stderr: "pipe" });
    if (Number(state.stdout.toString().trim()) >= 3) {
      const last = Bun.spawnSync(["docker", "logs", "--tail", "40", `${envGet("CONTAINER_PREFIX")}n8n`], { stdout: "pipe", stderr: "pipe" });
      const reason = (last.stdout.toString() + last.stderr.toString()).split("\n").filter((l) => /error|EACCES|denied|refused/i.test(l)).pop() ?? "";
      console.error(`[n8n] ERROR: the n8n container keeps restarting${reason ? `: ${reason.trim().slice(0, 200)}` : ""}`);
      process.exit(1);
    }
    await Bun.sleep(2000);
  }
  return null;
}

/** What n8n's public API answers to a key: 200 works, 401 refused, 403 accepted but without this permission, 0 no answer. */
async function keyStatus(key: string): Promise<number> {
  if (!key) return 401;
  try {
    return (await fetch(`${base}/api/v1/workflows?limit=1`, { headers: { "X-N8N-API-KEY": key } })).status;
  } catch {
    return 0;
  }
}

/** A key n8n accepts. 403 counts: n8n knows the key, it only lacks the permission to list workflows. */
async function keyWorks(key: string): Promise<boolean> {
  const status = await keyStatus(key);
  return status === 200 || status === 403;
}

/** One SQL statement in n8n's own database; the text is sent on stdin, so nothing needs escaping for a shell. */
function sql(statement: string): { ok: boolean; out: string; err: string } {
  const container = envGet("N8N_POSTGRES_CONTAINER_NAME") || `${envGet("CONTAINER_PREFIX")}n8n-postgres`;
  const r = Bun.spawnSync(
    ["docker", "exec", "-i", container, "psql", "-v", "ON_ERROR_STOP=1", "-U", envGet("N8N_POSTGRES_USER", "n8n"), "-d", envGet("N8N_POSTGRES_DB", "n8n"), "-tA"],
    { stdin: Buffer.from(`${statement}\n`), stdout: "pipe", stderr: "pipe" },
  );
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim().split("\n").pop() ?? "" };
}

/** The keys n8n stores in its own database, newest first, for an instance whose owner cannot log in with a password. */
function keysFromDatabase(): string[] {
  const r = sql(`SELECT "apiKey" FROM user_api_keys WHERE "apiKey" IS NOT NULL ORDER BY "createdAt" DESC;`);
  return r.ok ? r.out.split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

/** What the tooling around n8n needs: workflows and what belongs to them. No user management. */
const KEY_SCOPES = [
  "workflow:create", "workflow:delete", "workflow:list", "workflow:move", "workflow:read", "workflow:update",
  "workflow:activate", "workflow:deactivate", "workflowTags:update", "workflowTags:list",
  "tag:create", "tag:delete", "tag:list", "tag:read", "tag:update",
  "execution:delete", "execution:read", "execution:retry", "execution:list", "executionTags:update", "executionTags:list",
  "credential:create", "credential:delete", "credential:list", "credential:move", "credential:update",
  "variable:create", "variable:delete", "variable:list", "variable:update",
  "project:create", "project:delete", "project:list", "project:update",
];
const KEY_LABEL = "via-setup";

/**
 * A key for the owner, stored straight in n8n's database: for an instance where nobody has a
 * password (everyone signs in through single sign-on), so no login can make one. n8n accepts
 * a stored key that starts with n8n_api_ as it is.
 */
function keyIntoDatabase(): { key: string; error: string } {
  const owner = sql(`SELECT id FROM "user" WHERE disabled IS NOT TRUE ORDER BY ("roleSlug" = 'global:owner') DESC, "createdAt" ASC LIMIT 1;`);
  if (!owner.ok || !owner.out) return { key: "", error: `no owner found in n8n's database${owner.err ? `: ${owner.err}` : ""}` };
  const key = `n8n_api_${randomBytes(40).toString("hex")}`;
  const id = randomBytes(8).toString("hex");
  const made = sql(
    `INSERT INTO user_api_keys (id, "userId", label, "apiKey", scopes, audience)
     VALUES ('${id}', '${owner.out}', '${KEY_LABEL}', '${key}', '${JSON.stringify(KEY_SCOPES)}', 'public-api')
     ON CONFLICT ("userId", label) DO UPDATE SET "apiKey" = EXCLUDED."apiKey", scopes = EXCLUDED.scopes, "updatedAt" = CURRENT_TIMESTAMP(3);`,
  );
  return made.ok ? { key, error: "" } : { key: "", error: `n8n's database refused the key: ${made.err}` };
}

/** Log in as the owner and make a new API key with every scope n8n offers. */
async function createKey(): Promise<string> {
  const login = await fetch(`${base}/rest/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ emailOrLdapLoginId: email, password }),
  });
  if (!login.ok) throw new Error(`the owner login was refused (HTTP ${login.status})`);
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .find((c) => c.startsWith("n8n-auth="));
  if (!cookie) throw new Error("the owner login gave no session");
  const headers = { cookie, "content-type": "application/json" };

  let scopes = ["workflow:read"];
  const offered = await fetch(`${base}/rest/api-keys/scopes`, { headers });
  if (offered.ok) {
    const body = (await offered.json()) as { data?: string[] };
    if (Array.isArray(body.data) && body.data.length) scopes = body.data;
  }
  const label = `via-setup-${Date.now()}`;
  const made = await fetch(`${base}/rest/api-keys`, {
    method: "POST",
    headers,
    // n8n wants an end date; null means the key does not expire.
    body: JSON.stringify({ label, scopes, expiresAt: null }),
  });
  const body = (await made.json()) as { data?: { rawApiKey?: string; apiKey?: string }; message?: string };
  const key = body.data?.rawApiKey ?? body.data?.apiKey ?? "";
  if (!made.ok || !key || key.includes("*")) throw new Error(`n8n made no API key (HTTP ${made.status}): ${body.message ?? ""}`);
  return key;
}

// A first start fills the database before the REST API answers; on a slow machine that takes minutes.
const settings = await waitSettings(600);
if (!settings) {
  console.error(`[n8n] ERROR: n8n does not answer at ${base}/rest/settings`);
  process.exit(1);
}

if (settings.data?.userManagement?.showSetupOnFirstLoad) {
  if (!email || !password) {
    console.error("[n8n] ERROR: n8n has no owner yet; N8N_ADMIN_EMAIL and N8N_ADMIN_PASSWORD must be in .env");
    process.exit(1);
  }
  // n8n wants 8 characters with a capital and a digit.
  if (!/[A-Z]/.test(password) || !/[0-9]/.test(password) || password.length < 8) password = `${password}Aa1aA1aA`;
  ts("Making the owner account...");
  const r = await fetch(`${base}/rest/owner/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      firstName: envGet("ADMIN_FIRSTNAME", "Admin"),
      lastName: envGet("ADMIN_LASTNAME", "Owner"),
      password,
    }),
  });
  const body = (await r.json()) as { data?: { id?: string }; message?: string };
  if (!r.ok || !body.data?.id) {
    console.error(`[n8n] ERROR: n8n refused the owner account (HTTP ${r.status}): ${body.message ?? ""}`);
    process.exit(1);
  }
  await setEnv("N8N_ADMIN_EMAIL", email);
  await setEnv("N8N_ADMIN_PASSWORD", password);
  ts(`  ✓ Owner account made for ${email}; its password is in .env (N8N_ADMIN_PASSWORD).`);
} else {
  ts("n8n already has an owner.");
}

const inEnv = envGet("N8N_API_KEY");
const inEnvStatus = await keyStatus(inEnv);
if (inEnvStatus === 200 || inEnvStatus === 403) {
  ts(inEnvStatus === 200 ? "  ✓ The API key in .env works." : "  ✓ n8n accepts the API key in .env (it has no permission to list workflows).");
} else {
  // What was tried and what n8n answered, so a failure names its cause.
  const tried: string[] = [inEnv ? `the key in .env: HTTP ${inEnvStatus}` : "no key in .env"];
  let key = "";
  try {
    key = await createKey();
    if (!(await keyWorks(key))) {
      tried.push(`a new key: HTTP ${await keyStatus(key)}`);
      key = "";
    }
  } catch (error) {
    tried.push((error as Error).message);
  }
  if (!key) {
    const stored = keysFromDatabase();
    const statuses: number[] = [];
    for (const candidate of stored) {
      const status = await keyStatus(candidate);
      statuses.push(status);
      if (status === 200 || status === 403) {
        key = candidate;
        break;
      }
    }
    if (!key) tried.push(stored.length ? `${stored.length} key(s) in n8n's database: HTTP ${[...new Set(statuses)].join(", ")}` : "no key in n8n's database");
  }
  if (!key) {
    // An instance where nobody has a password (everyone signs in through single sign-on) can
    // never make a key through a login. That is a valid way to run n8n: it is set up, without a key.
    const withPassword = sql(`SELECT count(*) FROM "user" WHERE password IS NOT NULL AND password <> '';`);
    if (withPassword.ok && withPassword.out === "0") {
      if (envGet("N8N_KEY_WITHOUT_LOGIN") !== "yes") {
        ts("  ✓ This n8n has no password login (single sign-on only) and no API key; left as it is.");
        ts("    Tooling that needs N8N_API_KEY does not work until there is one. To give the owner a key");
        ts("    without a login, put N8N_KEY_WITHOUT_LOGIN=yes in .env and run this step again.");
        ts("n8n is set up.");
        process.exit(0);
      }
      const stored = keyIntoDatabase();
      if (stored.key && (await keyWorks(stored.key))) {
        key = stored.key;
        ts(`  ✓ No password login on this n8n; a key for the owner was stored in n8n's database (label ${KEY_LABEL}).`);
      } else {
        tried.push(stored.error || `a key stored in n8n's database: HTTP ${await keyStatus(stored.key)}`);
      }
    }
  }
  if (!key) {
    console.error(`[n8n] ERROR: no working API key (${tried.join("; ")})`);
    if (inEnvStatus === 404) console.error("[n8n]        HTTP 404 means n8n's public API is switched off (N8N_PUBLIC_API_DISABLED).");
    process.exit(1);
  }
  await setEnv("N8N_API_KEY", key);
  ts("  ✓ Working API key saved in .env (N8N_API_KEY).");
}
ts("n8n is set up.");
