#!/usr/bin/env bun
/**
 * Package: langfuse
 * Purpose: connect Langfuse to Authentik before it starts, without a person.
 *          Langfuse reads its sign-in settings only when its containers start,
 *          so this runs as a `prepare` step of `via app start`: it has
 *          Authentik make the sign-in client (id and secret land in .env) and,
 *          when Authentik has an https address, writes that address for
 *          Langfuse to .env (LANGFUSE_OIDC_ISSUER), which switches the sign-in
 *          on. Langfuse accepts Authentik over https only: with an Authentik
 *          that is not published the client is made and waits.
 *          Who may sign in does not change: people the administrator invited,
 *          matched by e-mail address. Nobody gets an account by signing in.
 *          With no Authentik in the project, or with Authentik not running,
 *          nothing changes and Langfuse starts with what .env holds.
 *          Safe to repeat.
 * Usage:   bun packages/langfuse/scripts/connect-sign-in.ts
 * Called by: app.yaml (prepare step)
 * Exit:    0 when connected or when there is no Authentik to connect to,
 *          1 when Authentik runs and the connection could not be made.
 *
 * @module
 */
import { authentikScript, envGet, setEnv, ts } from "./_setup-env.ts";

const makeClient = authentikScript("oidc-client.ts", "Langfuse");
if (!makeClient) process.exit(0);

const made = Bun.spawnSync(
  ["bun", makeClient, "langfuse", "--redirect-path=/api/auth/callback/authentik", "--name=Langfuse"],
  {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  },
);
if (made.exitCode !== 0) {
  console.error("[langfuse] ERROR: Authentik could not make the sign-in for Langfuse.");
  process.exit(1);
}

// Langfuse takes Authentik's address only as an https one, and refuses to start with
// another. So the sign-in is switched on once Authentik is published; until then the
// client waits in Authentik and Langfuse keeps its own login.
const published = envGet("AUTHENTIK_URL").replace(/\/+$/, "");
if (!published.startsWith("https://")) {
  ts(
    "Authentik has no https address yet; Langfuse keeps its own login until Authentik is published (via net apply --caddy --tunnel).",
  );
  process.exit(0);
}
const issuer = `${published}/application/o/langfuse`;
if (envGet("LANGFUSE_OIDC_ISSUER") === issuer) {
  ts("✓ Sign-in through Authentik is already connected.");
} else {
  if (!(await setEnv("LANGFUSE_OIDC_ISSUER", issuer))) {
    console.error("[langfuse] ERROR: could not write LANGFUSE_OIDC_ISSUER to .env.");
    process.exit(1);
  }
  ts(`✓ LANGFUSE_OIDC_ISSUER set to ${issuer}`);
  ts("Sign-in through Authentik is connected; Langfuse starts with it.");
}
