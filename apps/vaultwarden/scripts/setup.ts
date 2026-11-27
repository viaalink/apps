#!/usr/bin/env bun
/**
 * Package: vaultwarden
 * Purpose: let the first person in, without opening the door. Nobody can make
 *          an account for themselves; a new account comes from a first sign-in
 *          through Authentik, or from an invitation. This step invites the
 *          address in VAULTWARDEN_FIRST_USER_EMAIL through the admin page's
 *          own invite call; that person then registers with a master password
 *          of their own, which nobody else ever sees.
 *          Safe to run on every start: an address that is invited or has an
 *          account already is left alone.
 * Usage:   bun packages/vaultwarden/scripts/setup.ts   (from the project folder)
 * Called by: `via app setup vaultwarden` (app.yaml), which the start recipe runs.
 * Needs:   VAULTWARDEN_PORT in .env; VAULTWARDEN_ADMIN_TOKEN_PLAIN to invite.
 * Exit:    0 when there is nobody to invite or the address is invited, 1 otherwise.
 *
 * @module
 */
import { envGet, ts } from "./_setup-env.ts";

const port = envGet("VAULTWARDEN_PORT");
const email = envGet("VAULTWARDEN_FIRST_USER_EMAIL").trim().toLowerCase();
const token = envGet("VAULTWARDEN_ADMIN_TOKEN_PLAIN");
const base = `http://127.0.0.1:${port}`;

function fail(message: string): never {
  console.error(`[vaultwarden] ERROR: ${message}`);
  process.exit(1);
}

if (!email) {
  if (envGet("VAULTWARDEN_SIGNUPS_ALLOWED") === "true")
    ts("Anyone who reaches the page can make an account (VAULTWARDEN_SIGNUPS_ALLOWED=true).");
  else if (envGet("VAULTWARDEN_SSO_CLIENT_ID"))
    ts("✓ New accounts come from a first sign-in through Authentik; nobody else can register.");
  else
    ts(
      "Nobody can register yet: set VAULTWARDEN_FIRST_USER_EMAIL in .env to invite the first person, or add Authentik to the project.",
    );
  process.exit(0);
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
  fail(`VAULTWARDEN_FIRST_USER_EMAIL "${email}" is not an e-mail address.`);
if (!token)
  fail(
    "VAULTWARDEN_ADMIN_TOKEN_PLAIN is not in .env, so the first person cannot be invited. Put the admin page's token there.",
  );

const login = await fetch(`${base}/admin`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ token }).toString(),
  redirect: "manual",
});
const cookie = (login.headers.getSetCookie?.() ?? [])
  .map((c) => c.split(";")[0])
  .find((c) => c?.startsWith("VW_ADMIN="));
if (!cookie)
  fail(
    `the admin page refuses the token from .env (HTTP ${login.status}). Is VAULTWARDEN_ADMIN_TOKEN_PLAIN the token whose hash is in the app's secrets.env?`,
  );

const listed = await fetch(`${base}/admin/users`, { headers: { cookie } });
const users = (await listed.json().catch(() => null)) as { email?: string; Email?: string }[] | null;
if (!listed.ok || !Array.isArray(users))
  fail(`the admin page did not give its list of people (HTTP ${listed.status}).`);
if (users.some((user) => (user.email ?? user.Email ?? "").toLowerCase() === email)) {
  ts(`✓ ${email} is invited or has an account already.`);
  process.exit(0);
}
const invited = await fetch(`${base}/admin/invite`, {
  method: "POST",
  headers: { cookie, "content-type": "application/json" },
  body: JSON.stringify({ email }),
});
if (!invited.ok)
  fail(`the admin page did not invite ${email} (HTTP ${invited.status}): ${(await invited.text()).slice(0, 200)}`);
ts(
  `✓ ${email} is invited: that person makes the account on Vaultwarden's "Create account" page, with a master password of their own.`,
);
