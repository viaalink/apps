#!/usr/bin/env bun
/**
 * Package: mautic
 * Purpose: connect Mautic to Authentik with SAML, without a person. Mautic
 *          keeps its sign-in settings in its settings file (config/local.php),
 *          so this runs as a setup step after Mautic is installed: Authentik
 *          makes the SAML provider (with the first and last name Mautic wants
 *          for a new account), and Mautic gets Authentik's description
 *          (metadata: its sign-in address and signing certificate).
 *          Managed: that description, kept up to date. On a Mautic that had
 *          no SAML settings yet, also which attributes hold the e-mail
 *          address and the names. Every other SAML setting stays as it is,
 *          among them the role a newcomer gets: without one, only people who
 *          already have an account in Mautic can sign in through Authentik.
 *          With no Authentik in the project, or with Authentik not running,
 *          nothing changes. Safe to repeat.
 * Usage:   bun packages/mautic/scripts/connect-sign-in.ts
 * Called by: app.yaml (setup step)
 * Exit:    0 when connected or when there is no Authentik to connect to,
 *          1 when Authentik runs and the connection could not be made.
 *
 * @module
 */
import { join } from "node:path";
import { authentikScript, envGet, fromEnvFile, ts } from "./_setup-env.ts";

const prefix = envGet("CONTAINER_PREFIX");
const container = `${prefix}mautic`;
// The first and last name Mautic wants for a new account; Authentik does not send them by itself.
const mappings = join(import.meta.dir, "../config/saml-mappings.json");
const EMAIL_ATTRIBUTE = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress";

function fail(message: string): never {
  console.error(`[mautic] ERROR: ${message}`);
  process.exit(1);
}

const makeClient = authentikScript("saml-client.ts", "Mautic");
if (!makeClient) process.exit(0);

const made = Bun.spawnSync(
  [
    "bun",
    makeClient,
    "mautic",
    "--acs-path=/s/saml/login_check",
    "--audience-path=/saml/metadata.xml",
    "--name=Mautic",
    `--mappings=${mappings}`,
  ],
  { stdout: "pipe", stderr: "inherit", env: { ...process.env } },
);
const lines = made.stdout.toString().split("\n");
for (const line of lines) if (line && !line.startsWith("VIA_SAML ")) console.log(line);
const answerLine = lines.find((l) => l.startsWith("VIA_SAML "));
if (made.exitCode !== 0 || !answerLine) fail("Authentik could not make the SAML sign-in for Mautic.");
const saml = JSON.parse(answerLine.slice("VIA_SAML ".length)) as { slug: string };

const web = (value: string): string => (/^https?:\/\//.test(value) ? value.replace(/\/+$/, "") : "");
const authentikPort = envGet("AUTHENTIK_PORT");
if (!authentikPort) fail("AUTHENTIK_PORT is not in .env.");
const local = `http://localhost:${authentikPort}`;
// The browser goes to Authentik's published address, or its local port when it has none.
const browser = web(envGet("AUTHENTIK_URL")) || web(fromEnvFile("AUTHENTIK_LOCAL_URL")) || local;

// Authentik's description of itself for this app. It names its addresses by the host it was
// asked on, so what was asked locally is rewritten to the address the browser uses.
let metadata = "";
try {
  const r = await fetch(`${local}/application/saml/${saml.slug}/metadata/`, { redirect: "follow" });
  metadata = r.ok ? await r.text() : "";
  if (!metadata.includes("EntityDescriptor"))
    fail(`Authentik gave no SAML description for ${saml.slug} (HTTP ${r.status}).`);
} catch (error) {
  fail(`Authentik does not answer on ${local}: ${(error as Error).message}`);
}
metadata = metadata.split(local).join(browser).split(`http://127.0.0.1:${authentikPort}`).join(browser).trim();

// One run of PHP in Mautic's container: values come in through the environment, answers are lines that start with VIA.
const php = `
$file = '/var/www/html/config/local.php';
include $file;
$wanted = ['saml_idp_metadata' => base64_encode(getenv('VIA_METADATA'))];
$plain = function ($value) { return preg_replace('/\\s+/', '', (string) base64_decode((string) $value)); };
$had = !empty($parameters['saml_idp_metadata']);
if ($had && $plain($parameters['saml_idp_metadata']) === $plain($wanted['saml_idp_metadata'])) { echo "VIA same\\n"; exit(0); }
if (!$had) {
    // A first connection: which attributes of Authentik's answer hold what.
    $wanted += [
        'saml_idp_email_attribute' => getenv('VIA_EMAIL_ATTRIBUTE'),
        'saml_idp_username_attribute' => getenv('VIA_EMAIL_ATTRIBUTE'),
        'saml_idp_firstname_attribute' => 'first_name',
        'saml_idp_lastname_attribute' => 'last_name',
    ];
}
$content = file_get_contents($file);
$block = '';
foreach ($wanted as $key => $value) {
    $content = preg_replace("/^\\s*'" . $key . "' => .*,\\s*\\n/m", '', $content);
    $block .= "\\t'" . $key . "' => " . var_export($value, true) . ",\\n";
}
$at = strrpos($content, ');');
if ($at === false) { fwrite(STDERR, "local.php has no closing );\\n"); exit(1); }
if (file_put_contents($file, substr($content, 0, $at) . $block . substr($content, $at)) === false) { fwrite(STDERR, "local.php could not be written\\n"); exit(1); }
echo $had ? "VIA updated\\n" : "VIA made\\n";
`;
const run = Bun.spawnSync(
  [
    "docker",
    "exec",
    "--user",
    "www-data",
    "-e",
    `VIA_METADATA=${metadata}`,
    "-e",
    `VIA_EMAIL_ATTRIBUTE=${EMAIL_ATTRIBUTE}`,
    container,
    "php",
    "-r",
    php,
  ],
  { stdout: "pipe", stderr: "pipe" },
);
const said = run.stdout
  .toString()
  .split("\n")
  .filter((l) => l.startsWith("VIA "));
if (run.exitCode !== 0 || !said.length)
  fail(
    `Mautic's settings could not be written (exit ${run.exitCode}): ${run.stderr.toString().trim().split("\n").slice(-2).join(" | ").slice(0, 300)}`,
  );

if (said.includes("VIA same")) {
  ts("✓ Sign-in through Authentik is already connected.");
} else {
  // Mautic reads its settings file into a cache; the web server keeps compiled files in memory.
  const cleared = Bun.spawnSync(
    [
      "docker",
      "exec",
      "--user",
      "www-data",
      "--workdir",
      "/var/www/html",
      container,
      "php",
      "bin/console",
      "cache:clear",
      "--no-interaction",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (cleared.exitCode !== 0)
    fail(`Mautic's cache could not be cleared: ${cleared.stderr.toString().trim().split("\n").pop() ?? ""}`);
  Bun.spawnSync(["docker", "exec", container, "apache2ctl", "graceful"], { stdout: "ignore", stderr: "ignore" });
  ts(
    said.includes("VIA made")
      ? "✓ SAML sign-in through Authentik made in Mautic."
      : "✓ Authentik's description (address, certificate) brought up to date in Mautic.",
  );
}

/** Where Mautic sends a sign-in right now, asked the way a browser starts one (Mautic first passes it on to itself, then answers with a page that posts the request). */
async function signInGoesTo(own: string): Promise<string> {
  let url = `${own}/s/saml/login`;
  let cookie = "";
  for (let hop = 0; hop < 5; hop++) {
    const r = await fetch(url, { redirect: "manual", headers: cookie ? { cookie } : {} });
    const set = r.headers
      .getSetCookie()
      .map((line) => line.split(";")[0])
      .join("; ");
    if (set) cookie = set;
    const next = r.headers.get("location");
    if (!next) {
      // The last step is a page that posts the sign-in request to Authentik by itself.
      const action = /<form[^>]*method="post"[^>]*action="([^"]+)"/i.exec(await r.text())?.[1];
      return action
        ? action.replace(/&amp;/g, "&")
        : `no sign-in request (HTTP ${r.status} at ${new URL(url).pathname})`;
    }
    const target = new URL(next, url);
    if (target.origin !== new URL(own).origin) return target.toString();
    url = target.toString();
  }
  return "nowhere (Mautic keeps passing the sign-in on to itself)";
}

// Connected means that a sign-in started in Mautic really goes to Authentik.
const port = envGet("MAUTIC_PORT");
if (port) {
  const wanted = `${browser}/application/saml/${saml.slug}/`;
  const until = Date.now() + 120_000;
  let goesTo = "";
  for (;;) {
    try {
      goesTo = await signInGoesTo(`http://localhost:${port}`);
    } catch (error) {
      goesTo = `no answer (${(error as Error).message})`;
    }
    if (goesTo.startsWith(wanted)) break;
    if (Date.now() > until)
      fail(`Mautic still does not send a sign-in to Authentik; it goes to: ${goesTo.slice(0, 200)}`);
    await Bun.sleep(3000);
  }
  ts("✓ A sign-in started in Mautic goes to Authentik.");
}
