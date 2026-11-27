/**
 * Package: openproject
 * Purpose: run Ruby in OpenProject's own console and sign in through its login
 *          form, for the setup scripts of this package.
 * Used by: setup.ts
 *
 * @module
 */
import { envGet } from "./_setup-env.ts";

export const container = envGet("OPENPROJECT_CONTAINER_NAME") || `${envGet("CONTAINER_PREFIX")}openproject`;
export const base = `http://localhost:${envGet("OPENPROJECT_PORT")}`;

/**
 * One run of OpenProject's console. Values go in through the environment
 * (names that start with VIA_), the answer is the lines that start with VIA.
 */
export function rails(ruby: string, values: Record<string, string>): { ok: boolean; said: string[]; err: string } {
  const pass = Object.keys(values).flatMap((key) => ["-e", key]);
  const run = Bun.spawnSync(
    ["docker", "exec", "-i", "-u", "app", ...pass, container, "bash", "-c", "cd /app && bundle exec rails runner -"],
    {
      stdin: Buffer.from(ruby),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...values },
    },
  );
  const out = run.stdout.toString();
  return {
    ok: run.exitCode === 0,
    said: out
      .split("\n")
      .filter((line) => line.startsWith("VIA "))
      .map((line) => line.slice(4).trim()),
    err: `${run.stderr.toString()}\n${out}`.trim().split("\n").slice(-6).join("\n"),
  };
}

/** Sign in through the login form; the login OpenProject then says is signed in, or "". */
export async function signedInAs(login: string, password: string): Promise<string> {
  const jar = new Map<string, string>();
  const keep = (r: Response): void => {
    for (const line of r.headers.getSetCookie()) {
      const pair = line.split(";")[0] as string;
      jar.set(pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1));
    }
  };
  const cookie = (): string => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const form = await fetch(`${base}/login`, { redirect: "manual" });
  keep(form);
  const token = (await form.text()).match(/name="authenticity_token" value="([^"]+)"/)?.[1] ?? "";
  if (!token) return "";
  let answer = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: cookie(), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ authenticity_token: token, username: login, password }).toString(),
  });
  keep(answer);
  // A right password is sent on, through OpenProject's second-step check, to the start page.
  for (let hop = 0; hop < 6 && answer.status >= 300 && answer.status < 400; hop++) {
    const next = answer.headers.get("location");
    if (!next) break;
    answer = await fetch(new URL(next, base), { redirect: "manual", headers: { cookie: cookie() } });
    keep(answer);
  }
  const me = await fetch(`${base}/api/v3/users/me`, {
    headers: { cookie: cookie(), "X-Requested-With": "XMLHttpRequest" },
  });
  if (!me.ok) return "";
  return ((await me.json()) as { login?: string }).login ?? "";
}
