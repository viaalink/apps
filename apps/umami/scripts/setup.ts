#!/usr/bin/env bun
/**
 * Package: umami
 * Purpose: close Umami's door after it started, without a person. A new Umami
 *          has one account, admin, with a password everybody knows (umami).
 *          This replaces it with UMAMI_ADMIN_PASSWORD from .env.
 *          Safe to run on every start: once the known password is refused
 *          there is nothing left to do.
 * Usage:   bun packages/umami/scripts/setup.ts   (from the project folder)
 * Called by: `via app setup umami` (app.yaml), which the start recipe runs.
 * Needs:   UMAMI_PORT and UMAMI_ADMIN_PASSWORD in .env.
 * Exit:    0 when the known first password no longer signs in, 1 otherwise.
 *
 * @module
 */
import { envGet, ts } from "./_setup-env.ts";

const FIRST_PASSWORD = "umami";
const port = envGet("UMAMI_PORT");
const password = envGet("UMAMI_ADMIN_PASSWORD");
if (!port || !password) {
  console.error("[umami] ERROR: UMAMI_PORT and UMAMI_ADMIN_PASSWORD must be in .env");
  process.exit(1);
}
if (password === FIRST_PASSWORD) {
  console.error(
    "[umami] ERROR: UMAMI_ADMIN_PASSWORD is the password every new Umami starts with; put another one in .env",
  );
  process.exit(1);
}
const base = `http://127.0.0.1:${port}`;

/** Sign in as admin; the token when the password is right, "" when it is refused. */
async function signIn(pass: string): Promise<string> {
  const r = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: pass }),
  });
  if (r.status === 401) return "";
  if (!r.ok) throw new Error(`Umami answered the sign-in with HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return ((await r.json()) as { token?: string }).token ?? "";
}

try {
  const first = await signIn(FIRST_PASSWORD);
  if (first) {
    ts("The admin account still has its first password; replacing it...");
    const changed = await fetch(`${base}/api/me/password`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${first}` },
      body: JSON.stringify({ currentPassword: FIRST_PASSWORD, newPassword: password }),
    });
    if (!changed.ok)
      throw new Error(
        `Umami refused the new password (HTTP ${changed.status}): ${(await changed.text()).slice(0, 200)}`,
      );
    if (await signIn(FIRST_PASSWORD)) throw new Error("the first password still signs in after it was replaced");
    if (!(await signIn(password))) throw new Error("the new password does not sign in after it was set");
    ts("✓ admin now signs in with UMAMI_ADMIN_PASSWORD from .env.");
  } else if (await signIn(password)) {
    ts("✓ The first password is refused; admin signs in with UMAMI_ADMIN_PASSWORD from .env.");
  } else {
    // Someone gave admin another password in Umami itself. The door is closed; that password is theirs.
    ts(
      "✓ The first password is refused. admin has a password that is not the one in .env (changed in Umami itself); left as it is.",
    );
  }
} catch (error) {
  console.error(`[umami] ERROR: ${(error as Error).message}`);
  process.exit(1);
}
