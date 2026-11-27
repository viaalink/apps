/**
 * Package: erpnext
 * Purpose: run a piece of Python inside ERPNext, with the site loaded, for the
 *          setup scripts of this package. The Python gets its values through
 *          the environment and answers with lines that start with `VIA `.
 * Used by: setup.ts, connect-sign-in.ts
 *
 * @module
 */
import { envGet } from "./_setup-env.ts";

/** The container ERPNext's own code runs in. */
export const backend = `${envGet("CONTAINER_PREFIX")}erpnext-backend`;

/** ERPNext's address: its published one, else its local port. */
export function ownAddress(): string {
  const published = envGet("ERPNEXT_URL").replace(/\/+$/, "");
  return /^https?:\/\//.test(published) ? published : `http://localhost:${envGet("ERPNEXT_PORT")}`;
}

export function fail(message: string): never {
  console.error(`[erpnext] ERROR: ${message}`);
  process.exit(1);
}

/**
 * Run Python in the backend container with the site connected (`frappe` is imported, the
 * site's name is in SITE_NAME). What the code changes is saved when it ends without an error.
 * Returns the `VIA ` lines it printed, without that prefix; any other outcome ends the script.
 */
export function inSite(code: string, values: Record<string, string> = {}): string[] {
  const program = `
import os
import frappe
frappe.init(site=os.environ["SITE_NAME"], sites_path="/home/frappe/frappe-bench/sites")
frappe.connect()
try:
${code
  .trim()
  .split("\n")
  .map((line) => `    ${line}`)
  .join("\n")}
    frappe.db.commit()
    print("VIA done")
finally:
    frappe.destroy()
`;
  const run = Bun.spawnSync(
    [
      "docker",
      "exec",
      "-i",
      "--workdir",
      "/home/frappe/frappe-bench/sites",
      ...Object.entries(values).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      backend,
      "/home/frappe/frappe-bench/env/bin/python",
      "-",
    ],
    { stdin: Buffer.from(program), stdout: "pipe", stderr: "pipe" },
  );
  const said = run.stdout
    .toString()
    .split("\n")
    .filter((line) => line.startsWith("VIA "))
    .map((line) => line.slice(4));
  if (run.exitCode !== 0 || said.pop() !== "done") {
    fail(
      `ERPNext's own code failed in ${backend} (exit ${run.exitCode}): ${run.stderr.toString().trim().split("\n").slice(-2).join(" | ").slice(0, 400)}`,
    );
  }
  return said;
}
