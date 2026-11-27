/**
 * Package: alloy
 * Purpose: the few helpers the setup scripts of this package need, kept inside
 *          the package so it works as a `via app` package on its own (no
 *          imports from the project it is installed in).
 * Used by: ensure-config.ts
 *
 * @module
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The project the app is installed in: `via app setup` runs its steps there. */
export const projectRoot = process.cwd();
const envPath = join(projectRoot, ".env");

/**
 * A value from the environment, else from the project's .env (last line wins), else the default.
 * A value that names other keys, like ${CONTAINER_PREFIX}app, is filled in.
 */
export function envGet(key: string, defaultVal = "", depth = 0): string {
  const raw = rawEnvGet(key);
  if (!raw) return defaultVal;
  if (depth > 5 || !raw.includes("${")) return raw;
  return raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) =>
    envGet(name, fallback ?? "", depth + 1),
  );
}

function rawEnvGet(key: string): string {
  const fromProcess = process.env[key];
  if (fromProcess) return fromProcess;
  const defaultVal = "";
  let content = "";
  try {
    content = readFileSync(envPath, "utf8");
  } catch {
    return defaultVal;
  }
  const line = content
    .split(/\r?\n/)
    .filter((l) => l.startsWith(`${key}=`))
    .pop();
  const value = line
    ? line
        .slice(key.length + 1)
        .replace(/^["']|["']$/g, "")
        .trim()
    : "";
  return value || defaultVal;
}

/** Set one key in the project's .env (replace its line or add one); written to a temp file and renamed. */
export async function setEnv(key: string, value: string): Promise<boolean> {
  const clean = value.trim();
  if (!clean || clean === "None" || clean === "null") return false;
  const lines = existsSync(envPath) ? readFileSync(envPath, "utf8").split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const at = lines.findLastIndex((l) => l.startsWith(`${key}=`));
  if (at >= 0) lines[at] = `${key}=${clean}`;
  else lines.push(`${key}=${clean}`);
  const tmp = `${envPath}.alloy-setup.tmp`;
  const mode = existsSync(envPath) ? statSync(envPath).mode & 0o777 : 0o600;
  writeFileSync(tmp, `${lines.join("\n")}\n`, { mode });
  renameSync(tmp, envPath);
  process.env[key] = clean;
  return true;
}

/** A key as .env holds it now: another script may have written it after this process started. */
export function fromEnvFile(key: string): string {
  let content = "";
  try {
    content = readFileSync(envPath, "utf8");
  } catch {
    return envGet(key);
  }
  const line = content
    .split(/\r?\n/)
    .filter((l) => l.startsWith(`${key}=`))
    .pop();
  const value = line
    ? line
        .slice(key.length + 1)
        .replace(/^["']|["']$/g, "")
        .trim()
    : "";
  // A vault address is not the value; the environment holds that.
  return !value || value.startsWith("via://") ? envGet(key) : value;
}

/** Log line with the package prefix. */
export function ts(msg: string): void {
  console.log(`[alloy] ${msg}`);
}
