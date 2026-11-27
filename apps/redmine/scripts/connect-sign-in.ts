#!/usr/bin/env bun
/**
 * Package: redmine
 * Purpose: connect Redmine to Authentik, without a person. Redmine's sign-in
 *          plugin (redmine_oauth) keeps its configuration in Redmine's
 *          database, so this runs as a setup step after Redmine is up:
 *          Authentik makes the sign-in client, and the plugin's "Authentik"
 *          provider is made or brought up to date through Redmine's own
 *          console. Works with the plugin version that keeps providers in a
 *          table and with the older one that keeps one provider in settings.
 *          Only the addresses and the client id and secret are managed. On a
 *          provider that exists already, how users are matched and every
 *          other option stay as they are.
 *          With no Authentik in the project, or with Authentik not running,
 *          nothing changes. Safe to repeat.
 * Usage:   bun packages/redmine/scripts/connect-sign-in.ts
 * Called by: app.yaml (setup step)
 * Exit:    0 when connected or when there is no Authentik to connect to,
 *          1 when Authentik runs and the connection could not be made.
 *
 * @module
 */
import { dirname, join } from "node:path";
import { authentikScript, envGet, fromEnvFile, ts } from "./_setup-env.ts";

const appDir = process.env["VIA_APP_DIR"] ?? dirname(import.meta.dir);
const prefix = envGet("CONTAINER_PREFIX");
const container = envGet("REDMINE_CONTAINER_NAME") || `${prefix}redmine`;

function fail(message: string): never {
  console.error(`[redmine] ERROR: ${message}`);
  process.exit(1);
}

const makeClient = authentikScript("oidc-client.ts", "Redmine");
if (!makeClient) process.exit(0);
const made = Bun.spawnSync(
  [
    "bun",
    makeClient,
    "redmine",
    "--redirect-path=/oauth2callback",
    "--name=Redmine",
    `--mappings=${join(appDir, "scripts", "sign-in-mappings.json")}`,
  ],
  { stdout: "inherit", stderr: "inherit", env: { ...process.env } },
);
if (made.exitCode !== 0) fail("Authentik could not make the sign-in for Redmine.");

const web = (value: string): string => (/^https?:\/\//.test(value) ? value.replace(/\/+$/, "") : "");
// The browser goes to Authentik's published address (its local one when it has none);
// Redmine itself reaches Authentik over the network the apps share.
const browser = web(envGet("AUTHENTIK_URL")) || web(fromEnvFile("AUTHENTIK_LOCAL_URL"));
const clientId = fromEnvFile("REDMINE_OAUTH_CLIENT_ID");
const clientSecret = fromEnvFile("REDMINE_OAUTH_CLIENT_SECRET");
if (!browser) fail("no address for Authentik in .env (AUTHENTIK_URL or AUTHENTIK_PORT).");
if (!clientId || !clientSecret) fail("REDMINE_OAUTH_CLIENT_ID / REDMINE_OAUTH_CLIENT_SECRET are not in .env.");
const inside = `http://${prefix}authentik:9000`;

// One run of Redmine's own console; the values come in through the environment, the answer is a line that starts with VIA.
const ruby = `
id, secret, browser, inside = ENV.values_at('VIA_CLIENT_ID', 'VIA_CLIENT_SECRET', 'VIA_BROWSER', 'VIA_INSIDE')
if defined?(OauthProvider) && OauthProvider.table_exists?
  managed = {
    'client_id' => id, 'client_secret' => secret,
    'custom_auth_endpoint' => browser + '/application/o/authorize/',
    'custom_token_endpoint' => inside + '/application/o/token/',
    'custom_profile_endpoint' => inside + '/application/o/userinfo/'
  }
  provider = OauthProvider.find_by(custom_name: 'Authentik')
  if provider.nil?
    fresh = managed.merge(
      'oauth_name' => 'Custom', 'custom_name' => 'Authentik', 'site' => '', 'tenant_id' => '',
      'custom_scope' => 'openid email profile', 'custom_uid_field' => 'preferred_username',
      'custom_email_field' => 'email', 'identify_user_by' => 'email', 'oauth_version' => 'v2.0',
      'button_text' => 'Authentik'
    ).select { |column, _| OauthProvider.column_names.include?(column) }
    provider = OauthProvider.new(fresh)
    if provider.save
      puts 'VIA made'
      # Whoever Authentik lets in gets an account at the first sign-in. This is the plugin's own
      # switch; Redmine's public registration form is a separate setting and is not touched.
      options = (Setting.plugin_redmine_oauth || {}).to_h.transform_keys(&:to_s)
      if options['self_registration'].to_s.empty? || options['self_registration'].to_s == '0'
        Setting.plugin_redmine_oauth = options.merge('self_registration' => '3')
        puts 'VIA accounts-on'
      end
    else
      puts 'VIA failed ' + provider.errors.full_messages.join('; ')
    end
  else
    differing = managed.select { |column, value| provider.has_attribute?(column) && provider[column] != value }
    if differing.empty?
      puts 'VIA same'
    elsif (before = differing.keys.to_h { |column| [column, provider[column].to_s] }) && provider.update(differing)
      puts 'VIA updated ' + differing.keys.join(',')
      differing.each { |column, value| puts 'VIA was ' + column + ': ' + before[column] + ' -> ' + value unless column.include?('client') }
    else
      puts 'VIA failed ' + provider.errors.full_messages.join('; ')
    end
  end
else
  current = (Setting.plugin_redmine_oauth || {}).to_h.transform_keys(&:to_s)
  managed = { 'site' => browser, 'client_id' => id, 'client_secret' => secret }
  if current['client_id'].to_s.empty?
    Setting.plugin_redmine_oauth = current.merge(managed).merge(
      'oauth_name' => 'Custom', 'custom_name' => 'Authentik',
      'custom_auth_endpoint' => '/application/o/authorize/', 'custom_token_endpoint' => '/application/o/token/',
      'custom_profile_endpoint' => '/application/o/userinfo/', 'custom_scope' => 'openid email profile',
      'custom_email_field' => 'email', 'custom_uid_field' => 'preferred_username', 'identify_user_by' => 'email',
      'enabled' => '1'
    )
    puts 'VIA made'
  else
    differing = managed.reject { |key, value| current[key] == value }
    if differing.empty?
      puts 'VIA same'
    else
      Setting.plugin_redmine_oauth = current.merge(differing)
      puts 'VIA updated ' + differing.keys.join(',')
      differing.each { |key, value| puts 'VIA was ' + key + ': ' + current[key].to_s + ' -> ' + value unless key.include?('client') }
    end
  end
end
`;
const KEY_BASE = 'export SECRET_KEY_BASE="${SECRET_KEY_BASE:-${REDMINE_SECRET_KEY_BASE:-via-setup-console}}";';
const run = Bun.spawnSync(
  [
    "docker",
    "exec",
    "-e",
    `VIA_CLIENT_ID=${clientId}`,
    "-e",
    `VIA_CLIENT_SECRET=${clientSecret}`,
    "-e",
    `VIA_BROWSER=${browser}`,
    "-e",
    `VIA_INSIDE=${inside}`,
    container,
    "sh",
    "-c",
    `${KEY_BASE} exec bundle exec rails runner -e production "$0"`,
    ruby,
  ],
  { stdout: "pipe", stderr: "pipe" },
);
const answer = (run.stdout.toString() + run.stderr.toString()).split("\n").find((l) => l.startsWith("VIA ")) ?? "";
if (run.exitCode !== 0 || !answer)
  fail(
    `Redmine's console gave no answer (exit ${run.exitCode}): ${run.stderr.toString().trim().split("\n").slice(-2).join(" | ").slice(0, 300)}`,
  );
if (answer.startsWith("VIA failed"))
  fail(`Redmine refused the sign-in provider: ${answer.slice("VIA failed ".length)}`);
if (answer === "VIA made") ts("✓ Sign-in provider Authentik made in Redmine.");
if (run.stdout.toString().includes("VIA accounts-on"))
  ts("✓ A user Authentik lets in gets a Redmine account at the first sign-in.");
else if (answer.startsWith("VIA updated"))
  ts(`✓ Sign-in provider Authentik brought up to date (${answer.slice("VIA updated ".length)}).`);
for (const line of run.stdout.toString().split("\n"))
  if (line.startsWith("VIA was ")) ts(`    ${line.slice("VIA was ".length)}`);
  else ts("✓ Sign-in through Authentik is already connected.");
