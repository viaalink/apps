#!/usr/bin/env bun
/**
 * Package: zammad
 * Purpose: connect Zammad to Authentik with SAML, without a person. Zammad
 *          keeps its sign-in settings in its database, so this runs as a
 *          setup step after Zammad is up: Authentik makes the SAML provider,
 *          and Zammad's SAML settings are made or brought up to date through
 *          Zammad's own console.
 *          Managed: Authentik's sign-in address and signing certificate,
 *          that SAML sign-in is on, and the address Zammad knows itself by
 *          (SAML answers are sent there). Every other SAML option on an
 *          instance that already has them stays as it is.
 *          With no Authentik in the project, or with Authentik not running,
 *          nothing changes. Safe to repeat.
 * Usage:   bun packages/zammad/scripts/connect-sign-in.ts
 * Called by: app.yaml (setup step)
 * Exit:    0 when connected or when there is no Authentik to connect to,
 *          1 when Authentik runs and the connection could not be made.
 *
 * @module
 */
import { authentikScript, envGet, fromEnvFile, ts } from "./_setup-env.ts";

const prefix = envGet("CONTAINER_PREFIX");
const rails = `${prefix}zammad-rails`;

function fail(message: string): never {
  console.error(`[zammad] ERROR: ${message}`);
  process.exit(1);
}

const makeClient = authentikScript("saml-client.ts", "Zammad");
if (!makeClient) process.exit(0);

const made = Bun.spawnSync(
  [
    "bun",
    makeClient,
    "zammad",
    "--acs-path=/auth/saml/callback",
    "--audience-path=/auth/saml/metadata",
    "--name=Zammad",
  ],
  {
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env },
  },
);
const lines = made.stdout.toString().split("\n");
for (const line of lines) if (line && !line.startsWith("VIA_SAML ")) console.log(line);
const answerLine = lines.find((l) => l.startsWith("VIA_SAML "));
if (made.exitCode !== 0 || !answerLine) fail("Authentik could not make the SAML sign-in for Zammad.");
const saml = JSON.parse(answerLine.slice("VIA_SAML ".length)) as { slug: string; certificate: string };

const web = (value: string): string => (/^https?:\/\//.test(value) ? value.replace(/\/+$/, "") : "");
// The browser goes to Authentik's published address, or its local port when it has none.
const browser =
  web(envGet("AUTHENTIK_URL")) ||
  web(fromEnvFile("AUTHENTIK_LOCAL_URL")) ||
  (envGet("AUTHENTIK_PORT") ? `http://localhost:${envGet("AUTHENTIK_PORT")}` : "");
const own = web(envGet("ZAMMAD_URL")) || (envGet("ZAMMAD_PORT") ? `http://localhost:${envGet("ZAMMAD_PORT")}` : "");
if (!browser || !own)
  fail("no address for Authentik or Zammad in .env (AUTHENTIK_URL or AUTHENTIK_PORT, ZAMMAD_URL or ZAMMAD_PORT).");
const address = new URL(own);

// One run of Zammad's own console; values come in through the environment, answers are lines that start with VIA.
const ruby = `
sso, slo, cert, fqdn, scheme = ENV.values_at('VIA_SSO', 'VIA_SLO', 'VIA_CERT', 'VIA_FQDN', 'VIA_SCHEME')
plain = ->(text) { text.to_s.gsub(/\\s+/, '') }
current = (Setting.get('auth_saml_credentials') || {}).to_h.transform_keys(&:to_s)
if current['idp_sso_target_url'].to_s.empty?
  Setting.set('auth_saml_credentials', current.merge(
    'display_name' => 'Authentik', 'idp_sso_target_url' => sso, 'idp_slo_service_url' => slo, 'idp_cert' => cert,
    'name_identifier_format' => 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'
  ))
  puts 'VIA made'
else
  differing = {}
  # An address that already points at this application in Authentik stays, whichever binding it names.
  differing['idp_sso_target_url'] = sso unless current['idp_sso_target_url'].to_s.start_with?(ENV['VIA_PREFIX'])
  differing['idp_cert'] = cert if plain.call(current['idp_cert']) != plain.call(cert)
  unless differing.empty?
    Setting.set('auth_saml_credentials', current.merge(differing))
    puts 'VIA updated ' + differing.keys.join(',')
    puts 'VIA was idp_sso_target_url: ' + current['idp_sso_target_url'].to_s + ' -> ' + sso if differing.key?('idp_sso_target_url')
  end
end
unless Setting.get('auth_saml') == true
  Setting.set('auth_saml', true)
  puts 'VIA switched-on'
end
if Setting.get('fqdn') != fqdn || Setting.get('http_type') != scheme
  puts 'VIA was own address: ' + Setting.get('http_type').to_s + '://' + Setting.get('fqdn').to_s + ' -> ' + scheme + '://' + fqdn
  Setting.set('fqdn', fqdn)
  Setting.set('http_type', scheme)
  puts 'VIA address ' + scheme + '://' + fqdn
end
puts 'VIA done'
`;
const run = Bun.spawnSync(
  [
    "docker",
    "exec",
    "-w",
    "/opt/zammad",
    "-e",
    `VIA_SSO=${browser}/application/saml/${saml.slug}/sso/binding/redirect/`,
    "-e",
    `VIA_PREFIX=${browser}/application/saml/${saml.slug}/`,
    "-e",
    `VIA_SLO=${browser}/application/saml/${saml.slug}/slo/binding/redirect/`,
    "-e",
    `VIA_CERT=${saml.certificate.trim()}`,
    "-e",
    `VIA_FQDN=${address.host}`,
    "-e",
    `VIA_SCHEME=${address.protocol.replace(":", "")}`,
    rails,
    "bin/rails",
    "runner",
    ruby,
  ],
  { stdout: "pipe", stderr: "pipe" },
);
const said = run.stdout
  .toString()
  .split("\n")
  .filter((l) => l.startsWith("VIA "));
if (run.exitCode !== 0 || !said.includes("VIA done")) {
  fail(
    `Zammad's console failed (exit ${run.exitCode}): ${run.stderr.toString().trim().split("\n").slice(-2).join(" | ").slice(0, 300)}`,
  );
}
if (said.includes("VIA made")) ts("✓ SAML sign-in through Authentik made in Zammad.");
const updated = said.find((l) => l.startsWith("VIA updated "));
if (updated) ts(`✓ SAML settings brought up to date (${updated.slice("VIA updated ".length)}).`);
if (said.includes("VIA switched-on")) ts("✓ SAML sign-in switched on.");
const addressSet = said.find((l) => l.startsWith("VIA address "));
if (addressSet) ts(`✓ Zammad now knows itself as ${addressSet.slice("VIA address ".length)}.`);
for (const line of said) if (line.startsWith("VIA was ")) ts(`    ${line.slice("VIA was ".length)}`);
if (said.length === 1) ts("✓ Sign-in through Authentik is already connected.");

/** Where Zammad's web process sends a sign-in right now, asked the way a browser starts one. */
async function signInGoesTo(local: string): Promise<string> {
  const show = await fetch(`${local}/api/v1/signshow`);
  const cookie = show.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  const started = await fetch(`${local}/auth/saml`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ authenticity_token: show.headers.get("csrf-token") ?? "" }).toString(),
  });
  return started.headers.get("location") ?? "";
}

// The console wrote the settings; Zammad's web process takes them over a little later.
// Connected means that a sign-in started now really goes to Authentik.
const port = envGet("ZAMMAD_PORT");
if (port) {
  const wanted = `${browser}/application/saml/${saml.slug}/`;
  const until = Date.now() + 180_000;
  let goesTo = "";
  for (;;) {
    try {
      goesTo = await signInGoesTo(`http://localhost:${port}`);
    } catch (error) {
      goesTo = `no answer (${(error as Error).message})`;
    }
    if (goesTo.startsWith(wanted)) break;
    if (Date.now() > until)
      fail(`Zammad still does not send a sign-in to Authentik; it goes to: ${goesTo.slice(0, 200) || "nowhere"}`);
    await Bun.sleep(3000);
  }
  ts("✓ A sign-in started in Zammad goes to Authentik.");
}
