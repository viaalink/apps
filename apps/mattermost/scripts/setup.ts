#!/usr/bin/env bun
/**
 * Package: mattermost
 * Purpose: set Mattermost up after it started, without a person: make the
 *          first administrator when there are no users (otherwise the first
 *          visitor of a published Mattermost becomes administrator), make a
 *          default team when there is none, and make sure a working access
 *          token of an administrator is in .env. Safe to run on every start.
 * Usage:   bun packages/mattermost/scripts/setup.ts   (from the project folder)
 * Called by: `via app setup mattermost` (app.yaml), which the start recipe runs.
 * Needs:   MATTERMOST_PORT in .env. First administrator: MATTERMOST_ADMIN_EMAIL
 *          and MATTERMOST_ADMIN_PASSWORD (else ADMIN_EMAIL / ADMIN_PASSWORD).
 * Exit:    0 when all three are in place, 1 otherwise.
 *
 * @module
 */
import { envGet, setEnv, ts } from "./_setup-env.ts";

const port = envGet("MATTERMOST_PORT");
const container = envGet("MATTERMOST_CONTAINER_NAME") || `${envGet("CONTAINER_PREFIX")}mattermost`;
if (!port) {
  console.error("[mattermost] ERROR: MATTERMOST_PORT is not in .env");
  process.exit(1);
}

/** Mattermost's own admin tool over its local socket: needs no account. */
function mmctl(...args: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["docker", "exec", container, "mmctl", "--local", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? 1, out: r.stdout.toString(), err: r.stderr.toString().trim() };
}

function list<T>(...args: string[]): T[] {
  const r = mmctl(...args, "--json");
  if (r.code !== 0) throw new Error(`mmctl ${args.join(" ")} failed: ${r.err.slice(0, 200)}`);
  try {
    const parsed = JSON.parse(r.out || "[]") as T[] | T | null;
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    return [];
  }
}

interface User {
  email: string;
  username: string;
  roles: string;
}

function fail(message: string): never {
  console.error(`[mattermost] ERROR: ${message}`);
  process.exit(1);
}

try {
  // --- 1. First administrator -------------------------------------------
  let users = list<User>("user", "list", "--all");
  let admin = users.find((u) => u.roles.includes("system_admin"));
  if (!admin) {
    const email = envGet("MATTERMOST_ADMIN_EMAIL") || envGet("ADMIN_EMAIL");
    let password = envGet("MATTERMOST_ADMIN_PASSWORD") || envGet("ADMIN_PASSWORD");
    if (!email || !password) fail("there is no administrator yet; MATTERMOST_ADMIN_EMAIL and MATTERMOST_ADMIN_PASSWORD must be in .env");
    // The default password rules ask for a small letter, a capital, a digit and a symbol.
    if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
      password = `${password}aA1!`;
    }
    const username = envGet("MATTERMOST_ADMIN_USERNAME", "admin");
    ts("Making the first administrator...");
    const made = mmctl("user", "create", "--email", email, "--username", username, "--password", password, "--system-admin", "--email-verified");
    if (made.code !== 0) fail(`Mattermost refused the administrator: ${made.err.slice(0, 300)}`);
    await setEnv("MATTERMOST_ADMIN_EMAIL", email);
    await setEnv("MATTERMOST_ADMIN_PASSWORD", password);
    users = list<User>("user", "list", "--all");
    admin = users.find((u) => u.roles.includes("system_admin"));
    if (!admin) fail("the administrator was made but Mattermost does not list it");
    ts(`  ✓ Administrator ${admin.username} made; its password is in .env (MATTERMOST_ADMIN_PASSWORD).`);
  } else {
    ts(`Mattermost already has an administrator (${admin.username}).`);
  }

  // --- 2. Default team ---------------------------------------------------
  if (list<{ name: string }>("team", "list").length === 0) {
    const team = mmctl("team", "create", "--name", "main", "--display-name", "Main", "--email", admin.email);
    if (team.code !== 0) fail(`Mattermost refused the default team: ${team.err.slice(0, 300)}`);
    mmctl("team", "users", "add", "main", admin.email);
    ts("  ✓ Default team \"main\" made.");
  }

  // --- 3. Access token ---------------------------------------------------
  const tokenWorks = async (token: string): Promise<boolean> => {
    if (!token) return false;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/v4/users/me`, { headers: { authorization: `Bearer ${token}` } });
      return r.ok;
    } catch {
      return false;
    }
  };
  if (await tokenWorks(envGet("MATTERMOST_API_TOKEN"))) {
    ts("  ✓ The access token in .env works.");
  } else {
    const made = list<{ token?: string }>("token", "generate", admin.email, "via-setup");
    const token = made[0]?.token ?? "";
    if (!(await tokenWorks(token))) fail("Mattermost gave no working access token (are personal access tokens switched on?)");
    await setEnv("MATTERMOST_API_TOKEN", token);
    ts("  ✓ Access token made and saved in .env (MATTERMOST_API_TOKEN).");
  }
  ts("Mattermost is set up.");
} catch (error) {
  fail((error as Error).message);
}
