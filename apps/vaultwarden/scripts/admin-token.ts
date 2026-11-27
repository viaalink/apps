#!/usr/bin/env bun
/**
 * Package: vaultwarden
 * Purpose: give Vaultwarden's admin page a token, without a person, before
 *          the container starts. Nobody can make an account for themselves, so
 *          the admin page is how the first person is invited (see setup.ts).
 *          The page wants the token as an argon2 hash: the hash goes to
 *          secrets.env in the app's data folder (the container reads it at
 *          start), the token itself to the project's .env as
 *          VAULTWARDEN_ADMIN_TOKEN_PLAIN. It is never printed.
 *          A token that is already in secrets.env is left exactly as it is.
 *          Safe to repeat: with a token in place it changes nothing.
 * Usage:   bun packages/vaultwarden/scripts/admin-token.ts   (from the project folder)
 * Called by: app.yaml (prepare step)
 * Exit:    0 when the admin page has a token, 1 otherwise.
 *
 * @module
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envGet, setEnv, ts } from "./_setup-env.ts";

const dataDir = process.env["VIA_APP_DATA_DIR"];
if (!dataDir) {
  console.error(
    "[vaultwarden] ERROR: VIA_APP_DATA_DIR is not set. This script is a step of `via app start vaultwarden`, which sets it.",
  );
  process.exit(1);
}
const file = join(dataDir, "secrets.env");
mkdirSync(dataDir, { recursive: true });
const content = existsSync(file) ? readFileSync(file, "utf8") : "";
if (/^\s*ADMIN_TOKEN\s*=\s*\S/m.test(content)) {
  ts("✓ The admin page has its token already.");
  process.exit(0);
}

// A token .env already holds is the one that gets hashed; else a new one.
let token = envGet("VAULTWARDEN_ADMIN_TOKEN_PLAIN");
if (!token) {
  token = randomBytes(36).toString("base64url");
  if (!(await setEnv("VAULTWARDEN_ADMIN_TOKEN_PLAIN", token))) {
    console.error("[vaultwarden] ERROR: could not write VAULTWARDEN_ADMIN_TOKEN_PLAIN to .env");
    process.exit(1);
  }
}
// The settings Vaultwarden's own `hash` command uses for its "bitwarden" preset.
const hash = await Bun.password.hash(token, { algorithm: "argon2id", memoryCost: 65540, timeCost: 3 });
// Single quotes: Compose would otherwise read the $ signs of the hash as variables.
const line = `ADMIN_TOKEN='${hash}'\n`;
writeFileSync(file, content && !content.endsWith("\n") ? `${content}\n${line}` : `${content}${line}`, { mode: 0o600 });
ts("✓ Admin page token made: its hash is in the app's secrets.env, the token in .env (VAULTWARDEN_ADMIN_TOKEN_PLAIN).");
