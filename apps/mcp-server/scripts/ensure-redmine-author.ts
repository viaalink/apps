#!/usr/bin/env bun
/**
 * Package: mcp-server
 * Purpose: say who writes in Redmine when a tool call names nobody: fill
 *          REDMINE_DEFAULT_AUTHOR in .env, but only from a signal that cannot
 *          be wrong. Without one it stays empty and the ticket tools refuse to
 *          write until a person is named, which is better than a history
 *          attributed to the wrong person.
 *
 *          Order:
 *            1. REDMINE_DEFAULT_AUTHOR already set -> kept.
 *            2. The API key belongs to an ordinary user -> that user.
 *            3. `git config user.email` equals a Redmine user's mail -> that user.
 *            4. $USER equals a Redmine login -> that user.
 *            5. None of these -> left empty, with a line that says what to do.
 *
 *          With no Redmine in the project (no REDMINE_API_KEY) nothing changes.
 *          Safe to repeat.
 * Usage:   bun packages/mcp-server/scripts/ensure-redmine-author.ts
 * Called by: app.yaml (prepare step)
 * Exit:    0 always: the server starts without a default author too.
 *
 * @module
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const projectRoot = process.cwd();
const envPath = join(projectRoot, ".env");

if (!existsSync(envPath)) {
  console.log("[WARN] .env not found, skipping REDMINE_DEFAULT_AUTHOR check");
  process.exit(0);
}

const envContent = readFileSync(envPath, "utf8");

/** A value from the environment (where a secret kept in the vault arrives), else from .env. */
function readEnv(key: string): string {
  if (process.env[key]) return process.env[key] as string;
  const m = envContent.match(new RegExp(`^${key}=(.*)$`, "m"));
  return m?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
}

const current = readEnv("REDMINE_DEFAULT_AUTHOR");
if (current) {
  console.log(`[OK] REDMINE_DEFAULT_AUTHOR already set to '${current}'`);
  process.exit(0);
}

const apiKey = readEnv("REDMINE_API_KEY");
if (!apiKey) {
  console.log("[OK] No Redmine API key in .env: no default author to work out.");
  process.exit(0);
}

// Prefer REDMINE_API_URL (host-side localhost:PORT). Fall back to REDMINE_PORT.
const redmineHostUrl =
  readEnv("REDMINE_API_URL") ||
  (() => {
    const port = readEnv("REDMINE_PORT");
    return port ? `http://localhost:${port}` : "";
  })();

if (!redmineHostUrl) {
  console.log(
    "[WARN] No reachable Redmine URL (REDMINE_API_URL/REDMINE_PORT missing) - " +
      "cannot auto-resolve REDMINE_DEFAULT_AUTHOR. Skipping.",
  );
  process.exit(0);
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { "X-Redmine-API-Key": apiKey } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${url}`);
  }
  return res.json();
}

function gitUserEmail(): string | null {
  try {
    const out = execSync("git config user.email", {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function shellUser(): string | null {
  const u = process.env["USER"] || process.env["LOGNAME"];
  return u && u !== "root" ? u : null;
}

function persist(resolved: string, reason: string): void {
  let updated: string;
  if (envContent.match(/^REDMINE_DEFAULT_AUTHOR=.*$/m)) {
    updated = envContent.replace(/^REDMINE_DEFAULT_AUTHOR=.*$/m, `REDMINE_DEFAULT_AUTHOR=${resolved}`);
  } else {
    updated = `${envContent.trimEnd()}\nREDMINE_DEFAULT_AUTHOR=${resolved}\n`;
  }
  writeFileSync(envPath, updated);
  console.log(`[OK] Resolved REDMINE_DEFAULT_AUTHOR=${resolved} (${reason})`);
}

try {
  // 1. Identify API key owner.
  const me = await fetchJson(`${redmineHostUrl}/users/current.json`);
  const ownerLogin: string | undefined = me?.user?.login;
  const ownerIsAdmin: boolean = me?.user?.admin === true;
  if (!ownerLogin) {
    console.log("[WARN] Could not identify API key owner - skipping");
    process.exit(0);
  }

  // 2. Personal token: owner IS the operator.
  if (!ownerIsAdmin) {
    persist(ownerLogin, `API key owner is non-admin (personal token)`);
    process.exit(0);
  }

  // Shared admin key -> need a deterministic host signal.
  // Pull active user list once for matching against git email and $USER.
  const list = await fetchJson(`${redmineHostUrl}/users.json?status=1&limit=100`);
  const users: Array<{ login: string; mail?: string }> = (list?.users ?? [])
    .filter((u: any) => u?.status === 1 && u?.login)
    .map((u: any) => ({ login: String(u.login), mail: u.mail }));

  // 3. git config user.email exact match (case-insensitive).
  const gitEmail = gitUserEmail();
  if (gitEmail) {
    const match = users.find((u) => u.mail && u.mail.toLowerCase() === gitEmail.toLowerCase());
    if (match) {
      persist(match.login, `git user.email '${gitEmail}' matches Redmine user.mail`);
      process.exit(0);
    }
    console.log(`[INFO] git user.email '${gitEmail}' has no Redmine match; trying $USER`);
  }

  // 4. $USER exact match against Redmine login (case-insensitive).
  const sysUser = shellUser();
  if (sysUser) {
    const match = users.find((u) => u.login.toLowerCase() === sysUser.toLowerCase());
    if (match) {
      persist(match.login, `$USER '${sysUser}' matches Redmine user.login`);
      process.exit(0);
    }
    console.log(`[INFO] $USER '${sysUser}' has no Redmine match`);
  }

  // 5. No deterministic signal. Leave empty; ticket-cli.py errors on writes.
  const candidates = users
    .map((u) => u.login)
    .slice(0, 10)
    .join(", ");
  console.log(
    `[WARN] Could not auto-resolve REDMINE_DEFAULT_AUTHOR. ` +
      `API key owner is admin (${ownerLogin}); git user.email and $USER ` +
      `do not match any Redmine account. Available logins: ${candidates}` +
      (users.length > 10 ? ` (+${users.length - 10} more)` : "") +
      `. Set REDMINE_DEFAULT_AUTHOR=<login> in .env, or pass --switch-user / ` +
      `author_login per call. Write operations will fail until resolved.`,
  );
} catch (e: any) {
  console.log(
    `[WARN] Could not auto-resolve REDMINE_DEFAULT_AUTHOR: ${e?.message ?? e}. ` +
      "Container will still start; pass author_login per MCP call or set the var manually.",
  );
  process.exit(0);
}
