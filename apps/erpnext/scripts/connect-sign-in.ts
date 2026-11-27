#!/usr/bin/env bun
/**
 * Package: erpnext
 * Purpose: connect ERPNext to Authentik, without a person. ERPNext keeps its
 *          sign-in methods in its database (a "Social Login Key"), so this
 *          runs as a setup step after ERPNext is up: Authentik makes the
 *          sign-in client, and ERPNext's key for it is made or brought up to
 *          date through ERPNext's own code.
 *          Managed: the client id and secret, Authentik's addresses (the one
 *          the browser goes to, and Authentik's container for ERPNext itself),
 *          that the method is on, and the address ERPNext knows itself by
 *          (the sign-in comes back there).
 *          Not managed, and kept on an instance that has them: who may come
 *          in. A new key lets in only people who already have an account in
 *          ERPNext; nobody gets one by signing in.
 *          With no Authentik in the project, or with Authentik not running,
 *          nothing changes. Safe to repeat.
 * Usage:   bun packages/erpnext/scripts/connect-sign-in.ts
 * Called by: app.yaml (setup step)
 * Exit:    0 when connected or when there is no Authentik to connect to,
 *          1 when Authentik runs and the connection could not be made.
 *
 * @module
 */
import { fail, inSite, ownAddress } from "./_frappe.ts";
import { authentikScript, envGet, fromEnvFile, ts } from "./_setup-env.ts";

const CALLBACK = "/api/method/frappe.integrations.oauth2_logins.custom/authentik";
const makeClient = authentikScript("oidc-client.ts", "ERPNext");
if (!makeClient) process.exit(0);

const made = Bun.spawnSync(
  ["bun", makeClient, "erpnext", `--redirect-path=${CALLBACK}`, "--name=ERPNext", "--sub-mode=user_username"],
  {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  },
);
if (made.exitCode !== 0) fail("Authentik could not make the sign-in for ERPNext.");

const web = (value: string): string => (/^https?:\/\//.test(value) ? value.replace(/\/+$/, "") : "");
// The browser goes to Authentik's published address, or its local port when it has none.
const browser = web(envGet("AUTHENTIK_URL")) || web(fromEnvFile("AUTHENTIK_LOCAL_URL"));
const clientId = fromEnvFile("ERPNEXT_OAUTH_CLIENT_ID");
const clientSecret = fromEnvFile("ERPNEXT_OAUTH_CLIENT_SECRET");
if (!browser) fail("neither AUTHENTIK_URL nor AUTHENTIK_LOCAL_URL is in .env.");
if (!clientId || !clientSecret)
  fail("ERPNEXT_OAUTH_CLIENT_ID and ERPNEXT_OAUTH_CLIENT_SECRET are not in .env after Authentik made the client.");
// ERPNext itself asks Authentik's container directly: both are on the project's network.
const internal = `http://${envGet("CONTAINER_PREFIX")}authentik:9000`;

const said = inSite(
  `
from frappe.installer import update_site_config
wanted = {
    "client_id": os.environ["VIA_CLIENT_ID"],
    "base_url": os.environ["VIA_BROWSER"],
    "custom_base_url": 1,
    "authorize_url": "/application/o/authorize/",
    "access_token_url": os.environ["VIA_INTERNAL"] + "/application/o/token/",
    "api_endpoint": os.environ["VIA_INTERNAL"] + "/application/o/userinfo/",
    "enable_social_login": 1,
}
name = frappe.db.get_value("Social Login Key", {"provider_name": ["in", ["authentik", "Authentik"]]}, "name")
if name:
    key = frappe.get_doc("Social Login Key", name)
    differing = [field for field, value in wanted.items() if (key.get(field) or "") != value and str(key.get(field) or "") != str(value)]
    if key.get_password("client_secret", raise_exception=False) != os.environ["VIA_CLIENT_SECRET"]:
        differing.append("client_secret")
    if differing:
        key.update(wanted)
        key.client_secret = os.environ["VIA_CLIENT_SECRET"]
        key.save(ignore_permissions=True)
        print("VIA updated " + ",".join(differing))
else:
    key = frappe.new_doc("Social Login Key")
    key.update(wanted)
    key.update({
        "social_login_provider": "Custom",
        "provider_name": "authentik",
        "client_secret": os.environ["VIA_CLIENT_SECRET"],
        "redirect_url": os.environ["VIA_CALLBACK"],
        "auth_url_data": '{"response_type": "code", "scope": "openid email profile"}',
        "icon": "fa fa-key",
        # Only people who already have an account in ERPNext come in.
        "sign_ups": "Deny",
    })
    key.insert(ignore_permissions=True)
    print("VIA made " + key.name)
# The address ERPNext knows itself by: the sign-in comes back there.
if frappe.conf.get("host_name") != os.environ["VIA_OWN"]:
    print("VIA address " + os.environ["VIA_OWN"] + " (was " + str(frappe.conf.get("host_name") or "not set") + ")")
    update_site_config("host_name", os.environ["VIA_OWN"])
frappe.clear_cache()
`,
  {
    VIA_CLIENT_ID: clientId,
    VIA_CLIENT_SECRET: clientSecret,
    VIA_BROWSER: browser,
    VIA_INTERNAL: internal,
    VIA_CALLBACK: CALLBACK,
    VIA_OWN: ownAddress(),
  },
);
const madeKey = said.find((line) => line.startsWith("made "));
const updated = said.find((line) => line.startsWith("updated "));
const address = said.find((line) => line.startsWith("address "));
if (madeKey) ts("✓ Sign-in through Authentik made in ERPNext (a Social Login Key).");
if (updated) ts(`✓ ERPNext's sign-in settings brought up to date (${updated.slice("updated ".length)}).`);
if (address) ts(`✓ ERPNext now knows itself as ${address.slice("address ".length)}.`);
if (!madeKey && !updated && !address) ts("✓ Sign-in through Authentik is already connected.");

// Connected means that ERPNext's login page really offers the sign-in, and sends it to Authentik.
const port = envGet("ERPNEXT_PORT");
if (port) {
  const wanted = `${browser}/application/o/authorize/`;
  const until = Date.now() + 120_000;
  for (;;) {
    let seen = "";
    try {
      const page = await (await fetch(`http://127.0.0.1:${port}/login`)).text();
      seen = (page.match(/href="([^"]*\/application\/o\/authorize\/[^"]*)"/)?.[1] ?? "").replace(/&amp;/g, "&");
    } catch (error) {
      seen = `no answer (${(error as Error).message})`;
    }
    if (seen.startsWith(wanted)) break;
    if (Date.now() > until)
      fail(
        `ERPNext's login page does not offer the sign-in through Authentik${seen ? `; its button goes to: ${seen.slice(0, 200)}` : ""}`,
      );
    await Bun.sleep(3000);
  }
  ts("✓ ERPNext's login page offers the sign-in, and it goes to Authentik.");
}
