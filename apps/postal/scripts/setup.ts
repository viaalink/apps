#!/usr/bin/env bun
/**
 * Package: postal
 * Purpose: set Postal up after it started, without a person: make its
 *          database tables, make the first administrator from .env, and, when
 *          sign-in through Authentik is configured, let existing accounts sign
 *          in with it (Postal matches an Authentik user to an account by
 *          e-mail address and does not make accounts itself).
 *          Safe to run on every start: each part skips what is already done.
 * Usage:   bun packages/postal/scripts/setup.ts   (from the project folder)
 * Called by: `via app setup postal` (app.yaml), which the start recipe runs.
 * Needs:   POSTAL_PORT, POSTAL_ADMIN_EMAIL, POSTAL_ADMIN_PASSWORD in .env.
 * Exit:    0 when Postal is set up, 1 otherwise.
 *
 * @module
 */
import { connect } from "node:net";
import { envGet, ts } from "./_setup-env.ts";

const port = envGet("POSTAL_PORT");
const email = envGet("POSTAL_ADMIN_EMAIL");
const password = envGet("POSTAL_ADMIN_PASSWORD");
if (!port || !email || !password) {
  console.error("[postal] ERROR: POSTAL_PORT, POSTAL_ADMIN_EMAIL and POSTAL_ADMIN_PASSWORD must be in .env");
  process.exit(1);
}
const web = `${envGet("CONTAINER_PREFIX")}postal-web`;

function fail(message: string): never {
  console.error(`[postal] ERROR: ${message}`);
  process.exit(1);
}

/** True when something listens on the port. Postal refuses plain HTTP probes with another host name, so the port is the sign. */
function portOpen(): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port: Number(port), timeout: 2000 });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
    socket.once("timeout", () => {
      socket.destroy();
      done(false);
    });
  });
}

/** Run Ruby in Postal's own console; values travel in the environment, never in the script text. */
function consoleRun(ruby: string, env: Record<string, string> = {}): { ok: boolean; out: string } {
  const flags = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const run = Bun.spawnSync(["docker", "exec", "-i", ...flags, web, "postal", "console"], {
    stdin: Buffer.from(`${ruby}\nexit\n`),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 180_000,
  });
  return { ok: run.exitCode === 0, out: run.stdout.toString() + run.stderr.toString() };
}

// 1. The database tables. `postal initialize` loads or migrates the schema; done already, it changes nothing.
ts("Making the database tables...");
let initialized = false;
let said = "";
for (let attempt = 1; attempt <= 20 && !initialized; attempt++) {
  const run = Bun.spawnSync(["docker", "exec", web, "postal", "initialize"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 300_000,
  });
  said = (run.stdout.toString() + run.stderr.toString()).trim();
  initialized = run.exitCode === 0;
  // The container may still be waiting for its database.
  if (!initialized) await Bun.sleep(6000);
}
if (!initialized) fail(`postal initialize failed:\n${said.split("\n").slice(-8).join("\n")}`);
ts("✓ Database tables are in place");

// 2. The web server answers (it started before the tables existed and may have restarted).
let open = false;
for (let waited = 0; waited < 300 && !open; waited += 3) {
  open = await portOpen();
  if (!open) await Bun.sleep(3000);
}
if (!open) fail(`nothing listens on port ${port} after 5 minutes. Read why: docker logs ${web}`);

// 3. The first administrator, and sign-in through Authentik for the accounts that exist.
const authentik = envGet("AUTHENTIK_URL").replace(/\/+$/, "");
const issuer =
  envGet("POSTAL_OAUTH_CLIENT_ID") && authentik.startsWith("https://") ? `${authentik}/application/o/postal/` : "";
const ruby = `
email = ENV.fetch("SETUP_EMAIL")
made = false
if User.where(admin: true).none?
  user = User.find_by(email_address: email) || User.new(first_name: "Admin", last_name: "User", email_address: email)
  user.password = ENV.fetch("SETUP_PASSWORD")
  user.password_confirmation = ENV.fetch("SETUP_PASSWORD")
  user.admin = true
  user.email_verified_at ||= Time.now
  user.save!
  made = true
end
linked = 0
issuer = ENV["SETUP_ISSUER"].to_s
unless issuer.empty?
  linked = User.where("oidc_uid IS NULL OR oidc_uid = '' OR oidc_issuer IS NULL OR oidc_issuer <> ?", issuer).update_all(["oidc_uid = email_address, oidc_issuer = ?", issuer])
end
puts "SETUP_RESULT made=#{made} linked=#{linked} admins=#{User.where(admin: true).count}"
`;
let result = "";
let consoleSaid = "";
for (let attempt = 1; attempt <= 10 && !result; attempt++) {
  const run = consoleRun(ruby, { SETUP_EMAIL: email, SETUP_PASSWORD: password, SETUP_ISSUER: issuer });
  consoleSaid = run.out;
  result = run.out.match(/SETUP_RESULT made=(true|false) linked=(\d+) admins=(\d+)/)?.[0] ?? "";
  if (!result) await Bun.sleep(6000);
}
if (!result) fail(`Postal's console did not make the administrator:\n${consoleSaid.split("\n").slice(-8).join("\n")}`);
const [, made, linked, admins] = result.match(/made=(\w+) linked=(\d+) admins=(\d+)/) ?? [];
if (admins === "0") fail("Postal has no administrator after setup.");
ts(
  made === "true"
    ? `✓ First administrator made: ${email} (password in .env as POSTAL_ADMIN_PASSWORD)`
    : "✓ An administrator exists already",
);
if (issuer)
  ts(
    linked !== "0" ? `✓ ${linked} account(s) can now sign in through Authentik` : "✓ Accounts are linked to Authentik",
  );
