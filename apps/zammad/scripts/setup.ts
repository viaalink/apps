#!/usr/bin/env bun
/**
 * Package: zammad
 * Purpose: set Zammad up after it started, without a person: make the first
 *          administrator when there is none (otherwise the first visitor of a
 *          published Zammad makes themselves administrator), close the
 *          first-run wizard, and put a working API token in .env.
 *          Safe to run on every start: when the token works it changes nothing.
 * Usage:   bun packages/zammad/scripts/setup.ts   (from the project folder)
 * Called by: `via app setup zammad` (app.yaml), which the start recipe runs.
 * Needs:   ZAMMAD_PORT in .env. First administrator: ZAMMAD_ADMIN_EMAIL and
 *          ZAMMAD_ADMIN_PASSWORD (else ADMIN_EMAIL; the password is made when missing).
 * Exit:    0 when Zammad has an administrator and .env holds a working token, 1 otherwise.
 *
 * @module
 */
import { randomBytes } from "node:crypto";
import { envGet, setEnv, ts } from "./_setup-env.ts";

const port = envGet("ZAMMAD_PORT");
const rails = `${envGet("CONTAINER_PREFIX")}zammad-rails`;
if (!port) {
  console.error("[zammad] ERROR: ZAMMAD_PORT is not in .env");
  process.exit(1);
}

function fail(message: string): never {
  console.error(`[zammad] ERROR: ${message}`);
  process.exit(1);
}

async function tokenWorks(token: string): Promise<boolean> {
  if (!token) return false;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/users/me`, { headers: { authorization: `Token token=${token}` } });
    return r.ok;
  } catch {
    return false;
  }
}

if (await tokenWorks(envGet("ZAMMAD_API_TOKEN"))) {
  ts("✓ The API token in .env works; nothing to do.");
  process.exit(0);
}

const email = envGet("ZAMMAD_ADMIN_EMAIL") || envGet("ADMIN_EMAIL");
let password = envGet("ZAMMAD_ADMIN_PASSWORD");
if (!password) password = `${randomBytes(18).toString("base64url")}aA1bB2`;

// One run of Zammad's own console; it prints lines that start with VIA.
const ruby = `
admin_role = Role.find_by(name: 'Admin')
agent_role = Role.find_by(name: 'Agent')
wanted = [admin_role&.id, agent_role&.id].compact
u = User.joins(:roles).where(roles: { name: 'Admin' }, active: true).where.not(login: '-').order(:id).first
unless u
  email = ENV['VIA_ADMIN_EMAIL'].to_s
  abort('VIA no-email') if email.empty?
  u = User.find_by(login: email)
  if u
    u.role_ids = (u.role_ids + wanted).uniq
    u.save!
  else
    u = User.create!(login: email, email: email, firstname: 'Admin', lastname: 'Owner',
      password: ENV['VIA_ADMIN_PASSWORD'], active: true, role_ids: wanted,
      updated_by_id: 1, created_by_id: 1)
    puts 'VIA admin-made ' + email
  end
end
group = Group.find_by(name: 'Users') || Group.first
if group && !u.group_ids_access('full').include?(group.id)
  u.user_groups.find_or_create_by!(group: group, access: 'full')
end
unless Setting.get('system_init_done')
  Setting.set('system_init_done', true)
  puts 'VIA wizard-closed'
end
perms = Permission.where(active: true).pluck(:name)
t = Token.create!(action: 'api', user_id: u.id, persistent: true,
  name: "via-setup #{Time.now.to_i}", preferences: { permission: perms })
puts 'VIA token ' + t.token
`;

ts("Setting Zammad up through its console (takes about a minute)...");
const run = Bun.spawnSync(
  ["docker", "exec", "-w", "/opt/zammad", "-e", `VIA_ADMIN_EMAIL=${email}`, "-e", `VIA_ADMIN_PASSWORD=${password}`, rails, "bin/rails", "runner", ruby],
  { stdout: "pipe", stderr: "pipe" },
);
const said = (run.stdout.toString() + run.stderr.toString()).split("\n").filter((l) => l.startsWith("VIA "));
if (said.includes("VIA no-email")) fail("Zammad has no administrator yet; ZAMMAD_ADMIN_EMAIL must be in .env");
if (run.exitCode !== 0) fail(`Zammad's console failed (exit ${run.exitCode}): ${run.stderr.toString().trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`);

const made = said.find((l) => l.startsWith("VIA admin-made "));
if (made) {
  await setEnv("ZAMMAD_ADMIN_EMAIL", email);
  await setEnv("ZAMMAD_ADMIN_PASSWORD", password);
  ts(`  ✓ Administrator ${made.split(" ")[2]} made; its password is in .env (ZAMMAD_ADMIN_PASSWORD).`);
}
if (said.includes("VIA wizard-closed")) ts("  ✓ First-run wizard closed.");

const token = said.find((l) => l.startsWith("VIA token "))?.slice("VIA token ".length).trim() ?? "";
if (!(await tokenWorks(token))) fail("Zammad does not accept the API token it made");
await setEnv("ZAMMAD_API_TOKEN", token);
ts("  ✓ API token saved in .env (ZAMMAD_API_TOKEN).");
ts("Zammad is set up.");
