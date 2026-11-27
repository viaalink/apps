#!/usr/bin/env bun
/**
 * Package: mautic
 * Purpose: set Mautic up after its containers started, without a person:
 *          1. Wait until Mautic's console works.
 *          2. A new Mautic is installed through its own console command: the
 *             database tables, the first administrator (admin, with
 *             MAUTIC_ADMIN_EMAIL and MAUTIC_ADMIN_PASSWORD from .env) and the
 *             address it knows itself by. After that the install wizard in
 *             the browser no longer opens.
 *          3. The database gets the changes of the Mautic version that now
 *             runs (its migrations), and the Administrator role if it is
 *             missing.
 *          4. Mautic knows itself by its own address (MAUTIC_URL when it is
 *             published, else http://localhost:<MAUTIC_PORT>).
 *          Safe to run on every start: each part skips what is already done.
 *          An existing administrator keeps the password he has.
 * Usage:   bun packages/mautic/scripts/setup.ts   (from the project folder)
 * Called by: `via app setup mautic` (app.yaml), which the start recipe runs.
 * Needs:   MAUTIC_PORT, MAUTIC_ADMIN_EMAIL, MAUTIC_ADMIN_PASSWORD and the
 *          MAUTIC_MYSQL_* keys in .env.
 * Exit:    0 when Mautic is installed and up to date, 1 otherwise.
 *
 * @module
 */
import { envGet, ts } from "./_setup-env.ts";

const prefix = envGet("CONTAINER_PREFIX");
const web = `${prefix}mautic`;
const db = `${prefix}mautic-mysql`;
const port = envGet("MAUTIC_PORT");
const adminEmail = envGet("MAUTIC_ADMIN_EMAIL");
const adminPassword = envGet("MAUTIC_ADMIN_PASSWORD");
const dbUser = envGet("MAUTIC_MYSQL_USER");
const dbPassword = envGet("MAUTIC_MYSQL_PASSWORD");
const dbName = envGet("MAUTIC_MYSQL_DATABASE");

function fail(message: string): never {
  console.error(`[mautic] ERROR: ${message}`);
  process.exit(1);
}
if (!port || !adminEmail || !adminPassword || !dbUser || !dbPassword || !dbName) {
  fail(
    "MAUTIC_PORT, MAUTIC_ADMIN_EMAIL, MAUTIC_ADMIN_PASSWORD, MAUTIC_MYSQL_USER, MAUTIC_MYSQL_PASSWORD and MAUTIC_MYSQL_DATABASE must be in .env",
  );
}
const published = envGet("MAUTIC_URL").replace(/\/+$/, "");
const siteUrl = /^https?:\/\//.test(published) ? published : `http://localhost:${port}`;

interface Ran {
  ok: boolean;
  out: string;
}
/** Run something in a container; PHP's own start-up warnings are left out of the output. */
function inContainer(
  container: string,
  argv: string[],
  options: { user?: string; env?: Record<string, string> } = {},
): Ran {
  const flags = [
    ...(options.user ? ["--user", options.user] : []),
    ...Object.entries(options.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
  ];
  const r = Bun.spawnSync(
    ["docker", "exec", "--workdir", container === web ? "/var/www/html" : "/", ...flags, container, ...argv],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = (r.stdout.toString() + r.stderr.toString())
    .split("\n")
    .filter((line) => line.trim() && !/Unable to load dynamic library|PHP Warning:\s+Module/.test(line))
    .join("\n");
  return { ok: r.exitCode === 0, out };
}
const console_ = (args: string[]): Ran =>
  inContainer(web, ["php", "bin/console", ...args, "--no-interaction"], { user: "www-data" });
const lastLines = (text: string, count = 4): string => text.split("\n").slice(-count).join(" | ").slice(0, 500);
/** One SQL statement against Mautic's database; the rows as tab-separated lines. */
const sql = (statement: string): Ran =>
  inContainer(db, ["mariadb", `-u${dbUser}`, dbName, "-N", "-B", "-e", statement], { env: { MYSQL_PWD: dbPassword } });
/** PHP run in the web container with local.php loaded as $parameters; values come in through the environment. */
const php = (code: string, env: Record<string, string> = {}): Ran =>
  inContainer(web, ["php", "-r", `$file = '/var/www/html/config/local.php'; include $file; ${code}`], {
    user: "www-data",
    env,
  });

// 1. The console answers once the container's own start checks are done.
ts("Waiting for Mautic's console...");
let ready = false;
for (let waited = 0; waited < 300 && !ready; waited += 5) {
  ready = console_(["--version"]).ok;
  if (!ready) await Bun.sleep(5000);
}
if (!ready) fail(`Mautic's console does not work in ${web} after 5 minutes: ${lastLines(console_(["--version"]).out)}`);

// 2. Installed means: Mautic knows its own address and has at least one user.
const knowsAddress = php("echo empty($parameters['site_url']) ? 'no' : 'yes';").out.trim() === "yes";
const users = sql("SELECT COUNT(*) FROM users");
const hasUsers = users.ok && Number(users.out.trim()) > 0;
let changed = false;
if (!knowsAddress || !hasUsers) {
  ts("Installing Mautic (tables, the first administrator); this takes a few minutes...");
  const install = console_([
    "mautic:install",
    siteUrl,
    "--admin_username=admin",
    `--admin_email=${adminEmail}`,
    `--admin_password=${adminPassword}`,
    "--admin_firstname=Admin",
    "--admin_lastname=User",
    "--force",
  ]);
  const after = sql("SELECT COUNT(*) FROM users");
  if (!install.ok || !after.ok || Number(after.out.trim()) === 0)
    fail(`mautic:install did not finish: ${lastLines(install.out)}`);
  ts(`✓ Mautic installed; the first administrator is admin (${adminEmail}), with MAUTIC_ADMIN_PASSWORD from .env.`);
  changed = true;
}

// 3. The database follows the version Mautic runs. A fresh install has these to do as well.
const migrations = console_(["doctrine:migrations:migrate"]);
if (!migrations.ok) fail(`the database changes of this Mautic version could not be made: ${lastLines(migrations.out)}`);
// Mautic passes over the changes its tables already have, without noting that: only real changes count.
if (Number(/(\d+) sql queries/.exec(migrations.out)?.[1] ?? "0") > 0) {
  ts("✓ Database brought to this Mautic version.");
  changed = true;
}

// Without the Administrator role (id 1) nobody new can be let in.
const role = sql("SELECT COUNT(*) FROM roles WHERE id = 1");
if (role.ok && role.out.trim() === "0") {
  const made = sql(
    "INSERT INTO roles (id, is_published, date_added, name, description, is_admin, readable_permissions, uuid) VALUES (1, 1, NOW(), 'Administrator', 'Full system access', 1, 'a:0:{}', UUID())",
  );
  if (!made.ok) fail(`the Administrator role is missing and could not be made: ${lastLines(made.out)}`);
  ts("✓ Administrator role made.");
  changed = true;
}

// 4. The address Mautic knows itself by: links in mail and the sign-in go there.
const current = php("echo $parameters['site_url'] ?? '';").out.trim();
if (current !== siteUrl) {
  const set = php(
    `$content = file_get_contents($file);
$line = "\\t'site_url' => " . var_export(getenv('VIA_SITE_URL'), true) . ",\\n";
$count = 0;
$content = preg_replace("/^\\s*'site_url' => .*,\\s*$/m", rtrim($line), $content, 1, $count);
if (!$count) { $at = strrpos($content, ');'); if ($at === false) { fwrite(STDERR, 'local.php has no closing );'); exit(1); } $content = substr($content, 0, $at) . $line . substr($content, $at); }
if (file_put_contents($file, $content) === false) { exit(1); }
echo 'VIA written';`,
    { VIA_SITE_URL: siteUrl },
  );
  if (!set.ok || !set.out.includes("VIA written"))
    fail(`could not write Mautic's own address to its settings: ${lastLines(set.out)}`);
  ts(`✓ Mautic now knows itself as ${siteUrl}${current ? ` (was ${current})` : ""}.`);
  changed = true;
}

if (changed) {
  const cleared = console_(["cache:clear"]);
  if (!cleared.ok) fail(`Mautic's cache could not be cleared: ${lastLines(cleared.out)}`);
  // The web server keeps compiled files in memory; it reads the new ones after this.
  inContainer(web, ["apache2ctl", "graceful"]);
  ts("✓ Cache cleared.");
} else {
  ts("✓ Mautic is installed and up to date.");
}
