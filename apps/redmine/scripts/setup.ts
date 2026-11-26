#!/usr/bin/env bun
/**
 * Package: redmine
 * Purpose: set Redmine up after it started, without a person:
 *            - load Redmine's own default data (trackers, statuses, roles)
 *              when the database has none;
 *            - replace the administrator's well-known first password
 *              (admin / admin) by the one in .env;
 *            - switch the REST API on and put a working API key in .env.
 *          Safe to run on every start: when the key works and the first
 *          password is gone, it changes nothing.
 * Usage:   bun packages/redmine/scripts/setup.ts   (from the project folder)
 * Called by: `via app setup redmine` (app.yaml), which the start recipe runs.
 * Needs:   REDMINE_PORT in .env. REDMINE_ADMIN_PASSWORD is made when missing.
 *          Optional: REDMINE_ADMIN_EMAIL (the administrator's address).
 * Exit:    0 when Redmine is set up, 1 otherwise.
 *
 * @module
 */
import { randomBytes } from "node:crypto";
import { envGet, setEnv, ts } from "./_setup-env.ts";

const port = envGet("REDMINE_PORT");
const container = envGet("REDMINE_CONTAINER_NAME") || `${envGet("CONTAINER_PREFIX")}redmine`;
if (!port) {
  console.error("[redmine] ERROR: REDMINE_PORT is not in .env");
  process.exit(1);
}
const base = `http://127.0.0.1:${port}`;

function fail(message: string): never {
  console.error(`[redmine] ERROR: ${message}`);
  process.exit(1);
}

async function status(headers: Record<string, string>): Promise<number> {
  try {
    return (await fetch(`${base}/users/current.json`, { headers, redirect: "manual" })).status;
  } catch {
    return 0;
  }
}

const keyWorks = async (key: string): Promise<boolean> => !!key && (await status({ "X-Redmine-API-Key": key })) === 200;
/** Anything but "not allowed" means admin / admin still opens the door. */
const firstPasswordGone = async (): Promise<boolean> => (await status({ authorization: `Basic ${btoa("admin:admin")}` })) === 401;

if ((await keyWorks(envGet("REDMINE_API_KEY"))) && (await firstPasswordGone())) {
  ts("✓ The API key in .env works and the first password is gone; nothing to do.");
  process.exit(0);
}

// One run of Redmine's own console does the rest; it prints lines that start with VIA.
const ruby = `
# Redmine itself knows which plugin has migrations that did not run yet.
pending = Redmine::Plugin.all.select do |plugin|
  (plugin.latest_migration || 0).to_i > (Redmine::Plugin::Migrator.current_version(plugin) rescue 0).to_i
end
puts 'VIA plugin-migrations-pending ' + pending.map { |plugin| plugin.id.to_s }.join(',') unless pending.empty?
if Tracker.count == 0 && IssueStatus.count == 0
  Redmine::DefaultData::Loader.load('en')
  puts 'VIA default-data-loaded'
end
admin = User.where(admin: true, type: 'User').order(:id).first
abort('VIA no-admin') unless admin
if admin.check_password?('admin')
  abort('VIA no-password') if ENV['VIA_ADMIN_PASSWORD'].to_s.empty?
  admin.password = ENV['VIA_ADMIN_PASSWORD']
  admin.password_confirmation = ENV['VIA_ADMIN_PASSWORD']
  admin.must_change_passwd = false
  admin.save!
  puts 'VIA password-set ' + admin.login
end
mail = ENV['VIA_ADMIN_EMAIL'].to_s
if !mail.empty? && admin.mail != mail
  admin.mail = mail
  admin.save!
  puts 'VIA email-set'
end
Setting.rest_api_enabled = '1' unless Setting.rest_api_enabled?
token = Token.where(user_id: admin.id, action: 'api').first || Token.create!(user: admin, action: 'api')
puts 'VIA key ' + token.value
`;

// Rails wants a session secret even for a console run; the container holds it under Redmine's own name.
const KEY_BASE = 'export SECRET_KEY_BASE="${SECRET_KEY_BASE:-${REDMINE_SECRET_KEY_BASE:-via-setup-console}}";';

function console_(...extra: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["docker", "exec", ...extra, container, "sh", "-c", `${KEY_BASE} exec bundle exec rails runner -e production "$0"`, ruby], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode ?? 1, out: r.stdout.toString() + r.stderr.toString(), err: r.stderr.toString().trim() };
}

ts("Setting Redmine up through its console (takes about half a minute)...");
// An install from before this key existed has none; make one, so the first password can always be replaced.
let password = envGet("REDMINE_ADMIN_PASSWORD");
if (!password) {
  password = `${randomBytes(18).toString("base64url")}aA1`;
  await setEnv("REDMINE_ADMIN_PASSWORD", password);
}
const run = console_("-e", `VIA_ADMIN_PASSWORD=${password}`, "-e", `VIA_ADMIN_EMAIL=${envGet("REDMINE_ADMIN_EMAIL")}`);
const said = run.out.split("\n").filter((l) => l.startsWith("VIA "));
if (said.includes("VIA no-admin")) fail("Redmine has no administrator account");
if (said.includes("VIA no-password")) fail("the administrator still has the first password; REDMINE_ADMIN_PASSWORD must be in .env");
if (run.code !== 0) fail(`Redmine's console failed (exit ${run.code}): ${run.err.split("\n").slice(-3).join(" | ").slice(0, 400)}`);

const PENDING = "VIA plugin-migrations-pending ";
const pendingPlugins = said.find((l) => l.startsWith(PENDING))?.slice(PENDING.length).trim() ?? "";
if (pendingPlugins) {
  ts(`  Plugin migrations did not run yet (${pendingPlugins}); running them...`);
  const migrate = Bun.spawnSync(["docker", "exec", container, "sh", "-c", `${KEY_BASE} exec bundle exec rake redmine:plugins:migrate RAILS_ENV=production`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (migrate.exitCode !== 0) fail(`the plugin migrations failed: ${migrate.stderr.toString().trim().split("\n").pop() ?? ""}`);
  ts("  ✓ Plugin migrations done.");
}
if (said.includes("VIA default-data-loaded")) ts("  ✓ Default trackers, statuses and roles loaded.");
const passwordSet = said.find((l) => l.startsWith("VIA password-set "));
if (passwordSet) ts(`  ✓ First password of ${passwordSet.split(" ")[2]} replaced by REDMINE_ADMIN_PASSWORD from .env.`);
if (said.includes("VIA email-set")) ts("  ✓ Administrator's address set.");

const key = said.find((l) => l.startsWith("VIA key "))?.slice("VIA key ".length).trim() ?? "";
// Redmine reads changed settings at its next request; give it a moment.
let ok = false;
for (let i = 0; i < 15 && !ok; i++) {
  ok = await keyWorks(key);
  if (!ok) await Bun.sleep(2000);
}
if (!ok) fail("Redmine does not accept the API key it made");
if (!(await firstPasswordGone())) fail("admin / admin still works after setup");
await setEnv("REDMINE_API_KEY", key);
ts("  ✓ API key saved in .env (REDMINE_API_KEY).");
ts("Redmine is set up.");
