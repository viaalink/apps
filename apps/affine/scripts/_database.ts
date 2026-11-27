/**
 * Package: affine
 * Purpose: one statement in AFFiNE's own database, for the setup scripts of this package.
 * Used by: setup.ts, connect-sign-in.ts
 *
 * @module
 */
import { envGet } from "./_setup-env.ts";

/** Run one statement; the text goes over stdin, so nothing needs escaping for a shell. */
export function sql(statement: string): { ok: boolean; out: string; err: string } {
  const database = envGet("AFFINE_POSTGRES_CONTAINER") || `${envGet("CONTAINER_PREFIX")}affine-postgres`;
  const r = Bun.spawnSync(
    [
      "docker",
      "exec",
      "-i",
      database,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      envGet("AFFINE_POSTGRES_USER", "affine"),
      "-d",
      envGet("AFFINE_POSTGRES_DB", "affine"),
      "-tA",
    ],
    { stdin: Buffer.from(`${statement}\n`), stdout: "pipe", stderr: "pipe" },
  );
  return {
    ok: r.exitCode === 0,
    out: r.stdout.toString().trim(),
    err: r.stderr.toString().trim().split("\n").pop() ?? "",
  };
}
