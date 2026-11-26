#!/usr/bin/env bun
/**
 * Package: wikijs
 * Purpose: set Wiki.js up after it started, without a person: finish the
 *          first-run wizard with the admin account from .env, make sure a
 *          working API key is in .env, and apply the Mermaid 11 injection.
 *          Safe to run on every start: each part skips what is already done.
 * Usage:   bun packages/wikijs/scripts/setup.ts   (from the project folder)
 * Called by: `via app setup wikijs` (app.yaml), which the start recipe runs.
 * Needs:   WIKIJS_PORT, WIKIJS_ADMIN_EMAIL, WIKIJS_ADMIN_PASSWORD in .env.
 * Exit:    0 when Wiki.js is set up, 1 otherwise.
 *
 * @module
 */
import { join } from "node:path";
import { envGet, ts } from "./_setup-env.ts";

const port = envGet("WIKIJS_PORT");
const email = envGet("WIKIJS_ADMIN_EMAIL");
const password = envGet("WIKIJS_ADMIN_PASSWORD");
if (!port || !email || !password) {
  console.error("[WIKIJS] ERROR: WIKIJS_PORT, WIKIJS_ADMIN_EMAIL and WIKIJS_ADMIN_PASSWORD must be in .env");
  process.exit(1);
}
const base = `http://127.0.0.1:${port}`;

/** True once the wizard is done: only then does GraphQL know the site. */
async function isInstalled(): Promise<boolean> {
  try {
    const r = await fetch(`${base}/graphql`, {
      method: "POST",
      // In wizard mode Wiki.js answers this with a broken connection; do not keep it for the next call.
      headers: { "content-type": "application/json", connection: "close" },
      // One of the few queries Wiki.js answers without a login.
      body: JSON.stringify({ query: "{ authentication { activeStrategies { key } } }" }),
    });
    return (await r.text()).includes('"activeStrategies"');
  } catch {
    return false;
  }
}

async function waitInstalled(seconds: number): Promise<boolean> {
  for (let waited = 0; waited < seconds; waited += 2) {
    if (await isInstalled()) return true;
    await Bun.sleep(2000);
  }
  return false;
}

if (await isInstalled()) {
  ts("First-run wizard already done.");
} else {
  ts("Finishing the first-run wizard...");
  let status = 0;
  let body = "";
  // A connection the wizard dropped is tried again; an answer from Wiki.js is final.
  for (let attempt = 1; attempt <= 3 && !status; attempt++) {
    try {
      const r = await fetch(`${base}/finalize`, {
        method: "POST",
        headers: { "content-type": "application/json", connection: "close" },
        body: JSON.stringify({
          adminEmail: email,
          adminPassword: password,
          adminPasswordConfirm: password,
          siteUrl: envGet("WIKIJS_SITE_URL", `http://localhost:${port}`),
          telemetry: false,
        }),
      });
      status = r.status;
      body = await r.text();
    } catch (error) {
      body = String(error);
      if (await isInstalled()) break;
      await Bun.sleep(2000);
    }
  }
  // Wiki.js restarts itself after the wizard; it is done when GraphQL knows the site.
  if (!(await waitInstalled(180))) {
    console.error(`[WIKIJS] ERROR: the wizard did not finish (HTTP ${status}): ${body.slice(0, 300)}`);
    process.exit(1);
  }
  ts("  ✓ Wizard finished, admin account made.");
}

for (const script of ["configure.ts", "configure-mermaid.ts"]) {
  const run = Bun.spawnSync(["bun", join(import.meta.dir, script)], { stdout: "inherit", stderr: "inherit" });
  if (run.exitCode !== 0) {
    console.error(`[WIKIJS] ERROR: ${script} failed (exit ${run.exitCode})`);
    process.exit(1);
  }
}
ts("Wiki.js is set up.");
