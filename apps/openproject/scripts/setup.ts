#!/usr/bin/env bun
/**
 * Package: openproject
 * Purpose: close OpenProject's front door after it started, without a person.
 *          A fresh OpenProject has an administrator "admin"; this makes sure
 *          it signs in with the password from .env and not with the
 *          well-known first one (admin / admin), and that nobody is asked to
 *          pick a new password in the browser. Safe to run on every start:
 *          when the door is closed it changes nothing.
 * Usage:   bun packages/openproject/scripts/setup.ts   (from the project folder)
 * Called by: `via app setup openproject` (app.yaml), which the start recipe runs.
 * Needs:   OPENPROJECT_PORT and OPENPROJECT_ADMIN_PASSWORD in .env.
 * Exit:    0 when OpenProject is set up, 1 otherwise.
 *
 * @module
 */
import { rails, signedInAs } from "./_rails.ts";
import { envGet, ts } from "./_setup-env.ts";

function fail(message: string): never {
  console.error(`[openproject] ERROR: ${message}`);
  process.exit(1);
}

const password = envGet("OPENPROJECT_ADMIN_PASSWORD");
if (!envGet("OPENPROJECT_PORT")) fail("OPENPROJECT_PORT is not in .env");
if (!password) fail("OPENPROJECT_ADMIN_PASSWORD is not in .env");

const closed = async (): Promise<boolean> =>
  (await signedInAs("admin", password)) === "admin" && (await signedInAs("admin", "admin")) === "";
if (await closed()) {
  ts("✓ The administrator signs in with the password from .env and the first password is gone; nothing to do.");
  process.exit(0);
}

const ruby = `
admin = User.not_builtin.where(admin: true).order(:id).first
abort('VIA no-admin') unless admin
wanted = ENV.fetch('VIA_ADMIN_PASSWORD')
unless admin.check_password?(wanted)
  admin.password = wanted
  admin.password_confirmation = wanted
  puts 'VIA password-set ' + admin.login
end
admin.force_password_change = false
admin.first_login = false if admin.respond_to?(:first_login=)
mail = ENV['VIA_ADMIN_EMAIL'].to_s
admin.mail = mail if !mail.empty? && admin.mail != mail
if admin.changed? || admin.password.present?
  admin.save!(validate: false)
  puts 'VIA saved'
end
puts 'VIA done ' + admin.login
`;
const run = rails(ruby, { VIA_ADMIN_PASSWORD: password, VIA_ADMIN_EMAIL: envGet("OPENPROJECT_ADMIN_EMAIL") });
if (!run.ok || !run.said.some((line) => line.startsWith("done ")))
  fail(`OpenProject's console did not set the administrator up:\n${run.err}`);
if (run.said.some((line) => line.startsWith("password-set")))
  ts("✓ The administrator's password is now the one in .env (OPENPROJECT_ADMIN_PASSWORD).");
if (!(await closed()))
  fail("the administrator does not sign in with the password from .env, or still signs in with admin / admin.");
ts('✓ OpenProject is set up: the administrator "admin" signs in with the password from .env.');
