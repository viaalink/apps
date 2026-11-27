#!/usr/bin/env bun
/**
 * Package: erpnext
 * Purpose: set ERPNext up after it started, without a person:
 *          1. Nobody makes an account for themselves: the sign-up form on the
 *             website is switched off.
 *          2. The administrator has an API key, kept in .env as
 *             ERPNEXT_API_KEY and ERPNEXT_API_SECRET, for whatever talks to
 *             ERPNext's API. A key in .env that still works is kept.
 *          The site itself and the administrator's password
 *          (ERPNEXT_ADMIN_PASSWORD) are made by ERPNext's own start. ERPNext's
 *          setup pages (company, country, currency) are left for the
 *          administrator: only someone who is signed in gets them.
 *          Safe to run on every start: each part skips what is already done.
 * Usage:   bun packages/erpnext/scripts/setup.ts   (from the project folder)
 * Called by: `via app setup erpnext` (app.yaml), which the start recipe runs.
 * Needs:   ERPNEXT_PORT in .env.
 * Exit:    0 when ERPNext is set up, 1 otherwise.
 *
 * @module
 */
import { fail, inSite } from "./_frappe.ts";
import { envGet, setEnv, ts } from "./_setup-env.ts";

const port = envGet("ERPNEXT_PORT");
if (!port) fail("ERPNEXT_PORT must be in .env");

// 1. The website's sign-up form.
const signUp = inSite(`
if not frappe.utils.cint(frappe.db.get_single_value("Website Settings", "disable_signup")):
    frappe.db.set_single_value("Website Settings", "disable_signup", 1)
    frappe.clear_cache()
    print("VIA closed")
`);
ts(signUp.includes("closed") ? "✓ Sign-up on the website switched off." : "✓ Sign-up on the website is off.");

// 2. The administrator's API key.
async function keyWorks(key: string, secret: string): Promise<boolean> {
  if (!key || !secret) return false;
  const r = await fetch(`http://127.0.0.1:${port}/api/method/frappe.auth.get_logged_user`, {
    headers: { authorization: `token ${key}:${secret}` },
  });
  return r.status === 200;
}
if (await keyWorks(envGet("ERPNEXT_API_KEY"), envGet("ERPNEXT_API_SECRET"))) {
  ts("✓ The administrator's API key in .env works.");
} else {
  const made = inSite(`
from frappe.core.doctype.user.user import generate_keys
user = frappe.get_doc("User", "Administrator")
secret = generate_keys("Administrator")["api_secret"]
print("VIA key " + frappe.db.get_value("User", "Administrator", "api_key"))
print("VIA secret " + secret)
`);
  const key = made.find((line) => line.startsWith("key "))?.slice(4) ?? "";
  const secret = made.find((line) => line.startsWith("secret "))?.slice(7) ?? "";
  if (!key || !secret) fail("ERPNext made no API key for the administrator");
  if (!(await setEnv("ERPNEXT_API_KEY", key)) || !(await setEnv("ERPNEXT_API_SECRET", secret)))
    fail("could not write the API key to .env");
  if (!(await keyWorks(key, secret))) fail("the API key ERPNext just made is refused by its API");
  ts("✓ API key made for the administrator (ERPNEXT_API_KEY and ERPNEXT_API_SECRET in .env).");
}
