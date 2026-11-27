#!/usr/bin/env bun
/**
 * Package: espocrm
 * Purpose: check EspoCRM after it started, without a person. The first start
 *          installs EspoCRM and makes the administrator with the name and
 *          password from .env; this step proves that account signs in, so a
 *          start that left EspoCRM half installed, or with another password
 *          than .env holds, is reported instead of found later.
 *          Safe to run on every start: it changes nothing.
 * Usage:   bun packages/espocrm/scripts/setup.ts   (from the project folder)
 * Called by: `via app setup espocrm` (app.yaml), which the start recipe runs.
 * Needs:   ESPOCRM_PORT, ESPOCRM_ADMIN_USERNAME, ESPOCRM_ADMIN_PASSWORD in .env.
 * Exit:    0 when the administrator from .env signs in, 1 otherwise.
 *
 * @module
 */
import { container } from "./_espo.ts";
import { envGet, ts } from "./_setup-env.ts";

const port = envGet("ESPOCRM_PORT");
const user = envGet("ESPOCRM_ADMIN_USERNAME");
const password = envGet("ESPOCRM_ADMIN_PASSWORD");
if (!port || !user || !password) {
  console.error("[espocrm] ERROR: ESPOCRM_PORT, ESPOCRM_ADMIN_USERNAME and ESPOCRM_ADMIN_PASSWORD must be in .env");
  process.exit(1);
}

const auth = btoa(`${user}:${password}`);
let last = "";
// The web server answers a moment before the installation is complete.
for (let waited = 0; waited < 180; waited += 3) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/App/user`, {
      headers: { authorization: `Basic ${auth}`, "espo-authorization": auth, connection: "close" },
    });
    if (r.ok) {
      const who = (await r.json().catch(() => ({}))) as { user?: { userName?: string; type?: string } };
      if (who.user?.type === "admin") {
        ts(`✓ EspoCRM is installed; ${who.user.userName} from .env is its administrator.`);
        process.exit(0);
      }
      last = `${user} signs in but is not an administrator`;
      break;
    }
    last = `HTTP ${r.status}`;
    // A refused password does not get better by asking again, and EspoCRM blocks an address that keeps trying.
    if (r.status === 401 && waited >= 30) break;
  } catch (error) {
    last = error instanceof Error ? error.message : String(error);
  }
  await Bun.sleep(3000);
}
console.error(
  `[espocrm] ERROR: the administrator from .env does not sign in (${last}). Read why: docker logs ${container}`,
);
process.exit(1);
