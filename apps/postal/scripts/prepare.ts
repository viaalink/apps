#!/usr/bin/env bun
/**
 * Package: postal
 * Purpose: write what Postal reads when its containers start, without a person.
 *          Postal 3 takes its settings from /config/postal.yml and a signing
 *          key, not from the environment, so this runs as a `prepare` step of
 *          `via app start`: it makes the signing key once, and writes
 *          postal.yml from .env (address, database, queue, optional relay).
 *          When Authentik runs in the project under an https address it first has
 *          Authentik make the sign-in client, and the file then carries it.
 *          Safe to repeat: the same .env gives the same file.
 * Usage:   bun packages/postal/scripts/prepare.ts   (from the project folder)
 * Called by: app.yaml (prepare step)
 * Needs:   POSTAL_PORT, POSTAL_SECRET_KEY, POSTAL_MARIADB_PASSWORD, POSTAL_RABBITMQ_PASSWORD in .env.
 * Exit:    0 when the configuration is in place, 1 otherwise.
 *
 * @module
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { authentikScript, envGet, fromEnvFile, setEnv, ts } from "./_setup-env.ts";

const CALLBACK = "/auth/oidc/callback";
const dataDir = process.env["VIA_APP_DATA_DIR"];
if (!dataDir) {
  console.error(
    "[postal] ERROR: VIA_APP_DATA_DIR is not set. This script is a step of `via app start postal`, which sets it.",
  );
  process.exit(1);
}
const configDir = join(dataDir, "config");
mkdirSync(configDir, { recursive: true });

const port = envGet("POSTAL_PORT");
const secretKey = envGet("POSTAL_SECRET_KEY");
const dbPassword = envGet("POSTAL_MARIADB_PASSWORD");
const queuePassword = envGet("POSTAL_RABBITMQ_PASSWORD");
if (!port || !secretKey || !dbPassword || !queuePassword) {
  console.error(
    "[postal] ERROR: POSTAL_PORT, POSTAL_SECRET_KEY, POSTAL_MARIADB_PASSWORD and POSTAL_RABBITMQ_PASSWORD must be in .env",
  );
  process.exit(1);
}

// The key Postal signs with (DKIM, webhooks). Made once and never replaced.
const signingKey = join(configDir, "signing.key");
if (!existsSync(signingKey)) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(signingKey, privateKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o644 });
  // The containers read it as another user.
  chmodSync(signingKey, 0o644);
  ts("✓ Signing key made");
}

// Sign-in through Authentik, when it runs here under an https address: Postal asks
// Authentik for its settings over https only, so an unpublished Authentik cannot be used.
const authentik = envGet("AUTHENTIK_URL").replace(/\/+$/, "");
const authentikIsHttps = authentik.startsWith("https://");
const makeClient = authentikScript("oidc-client.ts", "Postal");
if (makeClient && !authentikIsHttps) {
  ts(
    "Authentik has no https address yet; Postal keeps its own login until Authentik is published (via net apply --caddy --tunnel).",
  );
}
// The client is made either way, so it is ready the moment Authentik gets its address.
const connect = Boolean(makeClient);
if (makeClient) {
  const made = Bun.spawnSync(["bun", makeClient, "postal", `--redirect-path=${CALLBACK}`, "--name=Postal"], {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  });
  if (made.exitCode !== 0) {
    console.error("[postal] ERROR: Authentik could not make the sign-in for Postal.");
    process.exit(1);
  }
}

// Where people reach Postal: its published address, else this machine.
const published = envGet("POSTAL_URL").replace(/\/+$/, "");
const isPublished = /^https?:\/\//.test(published);
const address = new URL(isPublished ? published : `http://localhost:${port}`);
const protocol = address.protocol.replace(":", "");
const prefix = envGet("CONTAINER_PREFIX");

const clientId = connect ? fromEnvFile("POSTAL_OAUTH_CLIENT_ID") : envGet("POSTAL_OAUTH_CLIENT_ID");
const clientSecret = connect ? fromEnvFile("POSTAL_OAUTH_CLIENT_SECRET") : envGet("POSTAL_OAUTH_CLIENT_SECRET");
const withSignIn = Boolean(clientId && clientSecret && authentikIsHttps);
const relay = envGet("POSTAL_SMTP_RELAY");

const lines = [
  "# Written by the Postal app's prepare step from .env on every start; change .env, not this file.",
  "version: 2",
  "postal:",
  `  web_hostname: ${address.host}`,
  `  web_protocol: ${protocol}`,
  `  smtp_hostname: ${address.hostname}`,
  `  secret_key: ${secretKey}`,
  ...(relay ? ["  smtp_relays:", `    - ${relay}`] : []),
  "  trusted_proxies:",
  "    - 127.0.0.1",
  "    - 172.16.0.0/12",
  "    - 10.0.0.0/8",
  "    - 192.168.0.0/16",
  ...(withSignIn
    ? [
        "oidc:",
        "  enabled: true",
        "  name: Authentik",
        `  issuer: ${authentik}/application/o/postal/`,
        `  identifier: ${clientId}`,
        `  secret: ${clientSecret}`,
        "  uid_field: email",
        "  scopes:",
        "    - openid",
        "    - profile",
        "    - email",
      ]
    : []),
  "main_db:",
  `  host: ${prefix}postal-mariadb`,
  "  port: 3306",
  "  username: root",
  `  password: ${dbPassword}`,
  "  database: postal",
  "message_db:",
  `  host: ${prefix}postal-mariadb`,
  "  port: 3306",
  "  username: root",
  `  password: ${dbPassword}`,
  "  prefix: postal",
  "rabbitmq:",
  `  host: ${prefix}postal-rabbitmq`,
  "  port: 5672",
  "  username: postal",
  `  password: ${queuePassword}`,
  "",
];
const wanted = lines.join("\n");
const file = join(configDir, "postal.yml");
const before = existsSync(file) ? readFileSync(file, "utf8") : "";
if (before !== wanted) {
  writeFileSync(file, wanted, { mode: 0o644 });
  ts(`✓ postal.yml written (address ${address.host}, sign-in through Authentik: ${withSignIn ? "yes" : "no"})`);
} else {
  ts("✓ postal.yml is up to date");
}

// The compose file tells Postal to treat requests as https only behind a published https address.
if (envGet("POSTAL_WEB_PROTOCOL") !== protocol) await setEnv("POSTAL_WEB_PROTOCOL", protocol);

// Postal reads the file only when it starts: containers that run with the old one are restarted.
if (before && before !== wanted) {
  for (const name of ["postal-web", "postal-smtp", "postal-worker"]) {
    const container = `${prefix}${name}`;
    const running = Bun.spawnSync(["docker", "inspect", "--format", "{{.State.Running}}", container], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (running.stdout.toString().trim() !== "true") continue;
    const restarted = Bun.spawnSync(["docker", "restart", container], { stdout: "pipe", stderr: "pipe" });
    ts(
      restarted.exitCode === 0
        ? `↻ ${container} restarted with the new configuration`
        : `⚠ could not restart ${container}: ${restarted.stderr.toString().trim()}`,
    );
  }
}
