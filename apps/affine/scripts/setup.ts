#!/usr/bin/env bun
/**
 * Package: affine
 * Purpose: set AFFiNE up after it started, without a person: make the first
 *          administrator from .env, so the first visitor does not get the
 *          "create admin account" page.
 *          Safe to run on every start: with an account in place it changes nothing.
 * Usage:   bun packages/affine/scripts/setup.ts   (from the project folder)
 * Called by: `via app setup affine` (app.yaml), which the start recipe runs.
 * Needs:   AFFINE_PORT, AFFINE_ADMIN_EMAIL, AFFINE_ADMIN_PASSWORD in .env.
 * Exit:    0 when AFFiNE has its administrator, 1 otherwise.
 *
 * @module
 */
import { sql } from "./_database.ts";
import { envGet, ts } from "./_setup-env.ts";

const port = envGet("AFFINE_PORT");
const email = envGet("AFFINE_ADMIN_EMAIL");
const password = envGet("AFFINE_ADMIN_PASSWORD");
if (!port || !email || !password) {
  console.error("[affine] ERROR: AFFINE_PORT, AFFINE_ADMIN_EMAIL and AFFINE_ADMIN_PASSWORD must be in .env");
  process.exit(1);
}

function fail(message: string): never {
  console.error(`[affine] ERROR: ${message}`);
  process.exit(1);
}

const users = sql("SELECT count(*) FROM users;");
if (!users.ok) fail(`AFFiNE's database did not answer: ${users.err}`);
if (users.out !== "0") {
  ts("✓ AFFiNE has its accounts already.");
  process.exit(0);
}

// AFFiNE's own first-run call: it makes the administrator and closes itself once an account exists.
const made = await fetch(`http://127.0.0.1:${port}/api/setup/create-admin-user`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
  signal: AbortSignal.timeout(30_000),
}).catch((error: Error) => fail(`AFFiNE did not take the first administrator: ${error.message}`));
if (!made.ok)
  fail(`AFFiNE refused the first administrator (HTTP ${made.status}): ${(await made.text()).slice(0, 200)}`);

// The address is ours, not a visitor's: nothing to confirm by mail.
const verified = sql(`UPDATE users SET email_verified = NOW() WHERE email_verified IS NULL;`);
if (!verified.ok) fail(`could not mark the administrator's address as verified: ${verified.err}`);
ts(`✓ First administrator made: ${email} (password in .env as AFFINE_ADMIN_PASSWORD)`);
