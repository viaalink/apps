#!/usr/bin/env bun
/**
 * Package: s3
 * Purpose: point `via vault` at this storage. Where the vault keeps its secrets
 *          is a setting of the person, not of a project (a project you cloned
 *          must not be able to send your secrets to its own bucket), so this is
 *          a command you run yourself and not a setup step. It sets four values
 *          with `via config set`; the key comes from this project's .env
 *          (S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY), where `via vault` finds it.
 *          Secrets already in another store are not moved: `via vault export`
 *          before, `via vault import` after.
 * Usage:   bun packages/s3/scripts/use-for-vault.ts          (from the project folder)
 *          bun packages/s3/scripts/use-for-vault.ts --undo   (back to the store on this machine)
 * Exit:    0 when the settings are in place, 1 otherwise.
 *
 * @module
 */
import { envGet, ts } from "./_setup-env.ts";

const via = process.env["VIA_BIN"] || "via";
const port = envGet("S3_PORT");
const bucket = envGet("S3_VAULT_BUCKET");
if (!port || !bucket) {
  console.error("[s3] ERROR: S3_PORT and S3_VAULT_BUCKET must be in .env (run this from the project folder)");
  process.exit(1);
}

function set(key: string, value: string): void {
  const run = Bun.spawnSync([via, "config", "set", key, value], { stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) {
    console.error(
      `[s3] ERROR: via config set ${key} failed: ${(run.stderr.toString() || run.stdout.toString()).trim()}`,
    );
    process.exit(1);
  }
}

if (process.argv.includes("--undo")) {
  set("vault.provider", "local");
  ts("✓ The vault keeps its secrets on this machine again. What is in the bucket stays there.");
  process.exit(0);
}
set("vault.s3.bucket", bucket);
set("vault.s3.endpoint", `http://127.0.0.1:${port}`);
set("vault.s3.region", envGet("S3_REGION") || "us-east-1");
set("vault.provider", "s3");
ts(`✓ via vault now keeps its secrets in bucket ${bucket} of this storage (http://127.0.0.1:${port}).`);
ts("  They are encrypted on this machine before they are sent; the storage never sees a value.");
ts("  Run vault commands from this project folder: the key is read from its .env.");
