#!/usr/bin/env bun
/**
 * Package: openwebui
 * Purpose: turn the open sign-up form off, on a fresh and on an existing
 *          instance, without anyone opening the admin panel. Accounts come from
 *          single sign-on (ENABLE_OAUTH_SIGNUP stays on).
 *
 *          Open WebUI reads ENABLE_SIGNUP from the environment only until the
 *          value is stored in its database; after that the stored value wins.
 *          So this step writes the stored value itself and then checks what the
 *          running app reports. Needs only Docker on the machine: the database
 *          is changed with the Python that Open WebUI's own container has.
 * Usage:   bun packages/openwebui/scripts/enforce-signup-off.ts
 * Called by: `via app setup openwebui` (app.yaml) and just openwebui-signup-off
 * Exit:    0 when /api/config reports enable_signup false, 1 otherwise.
 *
 * @module
 */
import { envGet, ts } from "./_setup-env.ts";

const port = envGet("OPENWEBUI_PORT");
const container = `${envGet("CONTAINER_PREFIX")}openwebui`;
if (!port) {
  console.error("[openwebui] ERROR: OPENWEBUI_PORT is not set");
  process.exit(1);
}
if (envGet("OPENWEBUI_ENABLE_SIGNUP") === "true") {
  ts("OPENWEBUI_ENABLE_SIGNUP=true: the sign-up form is left as it is");
  process.exit(0);
}
const base = `http://127.0.0.1:${port}`;

/** What the running app says: true, false, or "" when it does not answer. */
async function reported(): Promise<string> {
  try {
    const r = await fetch(`${base}/api/config`);
    const body = (await r.json()) as { features?: { enable_signup?: boolean } };
    return String(body.features?.enable_signup ?? "");
  } catch {
    return "";
  }
}

if ((await reported()) === "false") {
  ts("✅ sign-up form is off");
  process.exit(0);
}

// Two layouts exist: one row per setting (0.11 and later) and one JSON document
// (before that). The second is read once at start, so it needs a restart.
const python = `
import json, sqlite3, time
c = sqlite3.connect("/app/backend/data/webui.db", timeout=30)
cols = [r[1] for r in c.execute("PRAGMA table_info(config)")]
if "key" in cols:
    c.execute(
        "INSERT INTO config(key, value, updated_at) VALUES('ui.enable_signup', 'false', ?) "
        "ON CONFLICT(key) DO UPDATE SET value='false', updated_at=excluded.updated_at",
        (int(time.time()),),
    )
    c.commit()
    print("rows")
elif "data" in cols:
    row = c.execute("SELECT id, data FROM config ORDER BY id DESC LIMIT 1").fetchone()
    if row is None:
        print("unstored")
    else:
        data = json.loads(row[1])
        data.setdefault("ui", {})["enable_signup"] = False
        c.execute("UPDATE config SET data=? WHERE id=?", (json.dumps(data), row[0]))
        c.commit()
        print("document")
else:
    print("unknown")
`;
const changed = Bun.spawnSync(["docker", "exec", "-i", container, "python3", "-"], {
  stdin: Buffer.from(python),
  stdout: "pipe",
  stderr: "pipe",
});
const result = changed.stdout.toString().trim().split("\n").pop() ?? "";
if (changed.exitCode !== 0 || !["rows", "document", "unstored"].includes(result)) {
  console.error(
    result === "unknown"
      ? "[openwebui] ERROR: Open WebUI's settings table has a layout this step does not know; sign-up was not changed"
      : `[openwebui] ERROR: could not change the setting in Open WebUI's database: ${changed.stderr.toString().trim().split("\n").pop() ?? ""}`,
  );
  process.exit(1);
}
if (result !== "rows") {
  // Nothing stored yet means the running process still holds the value it
  // started with; a restart makes it read ENABLE_SIGNUP=false from compose.
  Bun.spawnSync(["docker", "restart", container], { stdout: "ignore", stderr: "ignore" });
  for (let waited = 0; waited < 180; waited += 2) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {
      // not up yet
    }
    await Bun.sleep(2000);
  }
}

const now = await reported();
if (now === "false") {
  ts("✅ sign-up form turned off");
  process.exit(0);
}
console.error(`[openwebui] ERROR: Open WebUI still reports enable_signup=${now || "nothing"}`);
process.exit(1);
