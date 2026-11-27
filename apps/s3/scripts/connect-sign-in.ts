#!/usr/bin/env bun
/**
 * Package: s3
 * Purpose: connect the storage to Authentik, without a person. It has
 *          Authentik make the sign-in client (id and secret land in .env) and
 *          writes the settings the storage reads when its container starts.
 *          After that a token from Authentik can be traded at the storage for
 *          temporary keys (AssumeRoleWithWebIdentity). Authentik names the
 *          policy in the token (sign-in-mappings.json): "signed-in", which the
 *          setup step makes: a folder of one's own in the people's bucket,
 *          nothing else. Nobody becomes administrator through Authentik.
 *          With no Authentik in the project, or with Authentik not running,
 *          the settings file stays as it is. Safe to repeat.
 * Usage:   bun packages/s3/scripts/connect-sign-in.ts
 * Called by: app.yaml (prepare step)
 * Exit:    0 when connected or when there is no Authentik to connect to,
 *          1 when Authentik runs and the connection could not be made.
 *
 * @module
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { authentikScript, envGet, fromEnvFile, ts } from "./_setup-env.ts";

// The address MinIO's console answers a sign-in on; Authentik wants one registered.
const CALLBACK = "/oauth_callback";
const dataDir = process.env["VIA_APP_DATA_DIR"];
if (!dataDir) {
  console.error("[s3] ERROR: VIA_APP_DATA_DIR is not set. This script is a step of `via app start s3`, which sets it.");
  process.exit(1);
}
const file = join(dataDir, "openid.env");
mkdirSync(dataDir, { recursive: true });
if (!existsSync(file)) writeFileSync(file, "", { mode: 0o600 });

function fail(message: string): never {
  console.error(`[s3] ERROR: ${message}`);
  process.exit(1);
}

const makeClient = authentikScript("oidc-client.ts", "the S3 storage");
if (!makeClient) process.exit(0);
const consoleUrl = envGet("S3_CONSOLE_URL").replace(/\/+$/, "");
const consolePort = envGet("S3_CONSOLE_PORT");
const redirectBase = /^https?:\/\//.test(consoleUrl) ? consoleUrl : `http://localhost:${consolePort}`;
// Authentik puts the name of the storage policy in every token for this client.
const mappings = join(dirname(import.meta.path), "sign-in-mappings.json");
const made = Bun.spawnSync(
  [
    "bun",
    makeClient,
    "s3",
    `--redirect-path=${CALLBACK}`,
    "--name=S3 storage",
    `--url=${redirectBase}`,
    `--mappings=${mappings}`,
  ],
  {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  },
);
if (made.exitCode !== 0) fail("Authentik could not make the sign-in for the S3 storage.");

// Authentik's address must be the same for whoever asks for a token and for the storage's
// container. Published: its public address. Not published: authentik.localhost, which this
// machine resolves to itself and the container reaches through its extra_hosts entry.
const published = envGet("AUTHENTIK_URL").replace(/\/+$/, "");
const port = envGet("AUTHENTIK_PORT");
const base = /^https?:\/\//.test(published) ? published : port ? `http://authentik.localhost:${port}` : "";
if (!base) fail("neither AUTHENTIK_URL nor AUTHENTIK_PORT is in .env.");
const clientId = fromEnvFile("S3_OAUTH_CLIENT_ID");
const clientSecret = fromEnvFile("S3_OAUTH_CLIENT_SECRET");
if (!clientId || !clientSecret) fail("S3_OAUTH_CLIENT_ID / S3_OAUTH_CLIENT_SECRET are not in .env.");

const wanted = `${[
  `MINIO_IDENTITY_OPENID_CONFIG_URL=${base}/application/o/s3/.well-known/openid-configuration`,
  `MINIO_IDENTITY_OPENID_CLIENT_ID=${clientId}`,
  `MINIO_IDENTITY_OPENID_CLIENT_SECRET=${clientSecret}`,
  "MINIO_IDENTITY_OPENID_SCOPES=openid,profile,email",
  "MINIO_IDENTITY_OPENID_DISPLAY_NAME=Authentik",
  // The token names the policy (see sign-in-mappings.json): "signed-in", made by the setup step.
  "MINIO_IDENTITY_OPENID_CLAIM_NAME=policy",
  `MINIO_IDENTITY_OPENID_REDIRECT_URI=${redirectBase}${CALLBACK}`,
].join("\n")}\n`;
if (readFileSync(file, "utf8") === wanted) {
  ts("✓ Sign-in through Authentik is already connected.");
  process.exit(0);
}
writeFileSync(file, wanted, { mode: 0o600 });
ts(`✓ Sign-in settings written; the storage reads them at this start (Authentik at ${base}).`);
