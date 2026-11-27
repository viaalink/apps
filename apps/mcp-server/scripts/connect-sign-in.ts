#!/usr/bin/env bun
/**
 * Package: mcp-server
 * Purpose: connect the MCP server's sign-in to Authentik, without a person.
 *          The server is its own OAuth 2.1 authorization server (an assistant
 *          registers itself and gets a token); who the person is, it asks
 *          Authentik. This has Authentik make the sign-in client and writes
 *          client id, secret and Authentik's address to .env; the container
 *          that starts next reads them.
 *          With no Authentik in the project, or with Authentik not running,
 *          nothing changes: the server then takes its keys only. Safe to repeat.
 * Usage:   bun packages/mcp-server/scripts/connect-sign-in.ts
 * Called by: app.yaml (prepare step)
 * Exit:    0 when connected or when there is no Authentik to connect to,
 *          1 when Authentik runs and the connection could not be made.
 *
 * @module
 */
import { authentikScript, envGet, fromEnvFile, setEnv, ts } from "./_setup-env.ts";

// Where the server takes Authentik's answer: for an assistant that connects by address,
// and for the two pages that hand a signed-in person a key of their own.
const CALLBACKS = ["/oauth/authentik/callback", "/oauth/callback", "/setup/callback"];

function fail(message: string): never {
  console.error(`[mcp-server] ERROR: ${message}`);
  process.exit(1);
}

const makeClient = authentikScript("oidc-client.ts", "the MCP server");
if (!makeClient) process.exit(0);

// An installation from before this app has a client already (its secret is MCP_OAUTH_CLIENT_SECRET).
// With its id in .env, Authentik's script keeps that client instead of making a second one.
if (!envGet("MCP_SERVER_OAUTH_CLIENT_ID") && envGet("MCP_OAUTH_CLIENT_SECRET"))
  await setEnv("MCP_SERVER_OAUTH_CLIENT_ID", envGet("OAUTH_CLIENT_ID") || "mcp-server");

const made = Bun.spawnSync(
  ["bun", makeClient, "mcp-server", ...CALLBACKS.map((path) => `--redirect-path=${path}`), "--name=MCP Server"],
  { stdout: "inherit", stderr: "inherit", env: { ...process.env } },
);
if (made.exitCode !== 0) fail("Authentik could not make the sign-in for the MCP server.");

// Where the server sends a browser to sign in. Published: Authentik's public address.
// Not published: authentik.localhost, which a browser resolves to this machine. The server
// itself asks Authentik's container, on the network the apps share.
const published = envGet("AUTHENTIK_URL").replace(/\/+$/, "");
const port = envGet("AUTHENTIK_PORT");
const base = /^https?:\/\//.test(published) ? published : port ? `http://authentik.localhost:${port}` : "";
if (!base) fail("neither AUTHENTIK_URL nor AUTHENTIK_PORT is in .env.");
if (!fromEnvFile("MCP_SERVER_OAUTH_CLIENT_ID") || !fromEnvFile("MCP_SERVER_OAUTH_CLIENT_SECRET"))
  fail("MCP_SERVER_OAUTH_CLIENT_ID / MCP_SERVER_OAUTH_CLIENT_SECRET are not in .env.");

if (fromEnvFile("MCP_SERVER_AUTHENTIK_URL") === base) ts("✓ Sign-in through Authentik is already connected.");
else {
  await setEnv("MCP_SERVER_AUTHENTIK_URL", base);
  ts(`✓ Sign-in through Authentik is connected (${base}); the MCP server reads it at this start.`);
}
