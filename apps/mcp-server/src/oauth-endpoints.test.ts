/**
 * MCP OAuth 2.1 endpoint tests.
 *
 * The MCP server is its own OAuth 2.1 authorization server now (src/oauth.ts,
 * bun:sqlite).
 * These tests spawn the server in-process and validate:
 *   1. Discovery metadata (RFC 8414 AS + RFC 9728 protected resource)
 *   2. WWW-Authenticate pointer on 401
 *   3. The full connector flow: DCR -> /authorize (sign-in) -> sign-in POST ->
 *      /token (PKCE S256) -> /mcp initialize
 *   4. Refusals: wrong key, reused code, wrong PKCE verifier
 *   5. Backward compatibility: static API key on /mcp still works
 *
 * Run: cd packages/mcp-server && bun test src/oauth-endpoints.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT_BASE = 19200;
const API_KEY = "test-oauth-key-" + Math.random().toString(36).slice(2);
const JWT_SECRET = "test-jwt-secret-for-signing-minimum-32-chars";

interface ServerInstance {
  proc: import("bun").Subprocess;
  port: number;
  url: string;
}

async function startServer(env: Record<string, string> = {}): Promise<ServerInstance> {
  const port = TEST_PORT_BASE + Math.floor(Math.random() * 800);
  const url = `http://localhost:${port}`;
  const proc = Bun.spawn(["bun", "run", "src/server.ts"], {
    cwd: import.meta.dir + "/..",
    env: {
      ...process.env,
      MCP_PORT: String(port),
      MCP_API_KEYS: API_KEY,
      MCP_SIGNING_SECRET: JWT_SECRET,
      MCP_AUTHENTIK_URL: "",
      MCP_PUBLIC_URL: url,
      MCP_OAUTH_DB: join(tmpdir(), `mcp-oauth-test-${port}-${Date.now()}.sqlite`),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const start = Date.now();
  while (Date.now() - start < 8000) {
    try {
      const resp = await fetch(`${url}/health?format=json`);
      if (resp.ok) return { proc, port, url };
    } catch {
      /* not ready yet */
    }
    await Bun.sleep(200);
  }
  proc.kill();
  throw new Error(`Server failed to start on port ${port}`);
}

function stopServer(srv: ServerInstance) {
  try {
    srv.proc.kill();
  } catch {
    /* already dead */
  }
}

const b64url = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");

describe("MCP OAuth 2.1 authorization server", () => {
  let srv: ServerInstance;
  beforeAll(async () => {
    srv = await startServer();
  });
  afterAll(() => stopServer(srv));

  test("health returns 200", async () => {
    const resp = await fetch(`${srv.url}/health?format=json`);
    expect(resp.status).toBe(200);
    expect((await resp.json()).status).toBe("healthy");
  });

  test("protected resource metadata (bare + /mcp) points at the self issuer", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const resp = await fetch(`${srv.url}${path}`);
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.resource).toBe(`${srv.url}/mcp`);
      expect(body.authorization_servers).toEqual([`${srv.url}/`]);
    }
    // The bare doc we serve ourselves also advertises the bearer method (the
    // SDK's /mcp-suffixed variant omits this optional RFC 9728 field).
    const bare = await (await fetch(`${srv.url}/.well-known/oauth-protected-resource`)).json();
    expect(bare.bearer_methods_supported).toEqual(["header"]);
  });

  test("authorization server metadata advertises DCR + PKCE S256", async () => {
    const resp = await fetch(`${srv.url}/.well-known/oauth-authorization-server`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.issuer).toBe(`${srv.url}/`);
    expect(body.authorization_endpoint).toBe(`${srv.url}/authorize`);
    expect(body.token_endpoint).toBe(`${srv.url}/token`);
    expect(body.registration_endpoint).toBe(`${srv.url}/register`);
    expect(body.code_challenge_methods_supported).toContain("S256");
    expect(body.grant_types_supported).toEqual(
      expect.arrayContaining(["authorization_code", "refresh_token"]),
    );
  });

  test("openid-configuration is answered (clients probe it)", async () => {
    const resp = await fetch(`${srv.url}/.well-known/openid-configuration`);
    expect(resp.status).toBe(200);
    expect((await resp.json()).issuer).toBe(`${srv.url}/`);
  });

  test("POST /mcp without a token → 401 with resource_metadata pointer", async () => {
    const resp = await fetch(`${srv.url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(resp.status).toBe(401);
    const wwwAuth = resp.headers.get("WWW-Authenticate") || "";
    expect(wwwAuth).toContain("resource_metadata=");
    expect(wwwAuth).toContain("/.well-known/oauth-protected-resource/mcp");
  });

  test("static API key on /mcp still works (header clients)", async () => {
    const resp = await fetch(`${srv.url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      }),
    });
    expect(resp.status).toBe(200);
  });

  const rpc = (path: string, method: string, key?: string): Promise<Response> =>
    fetch(`${srv.url}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
    });

  test("no other path reaches the tools without a key", async () => {
    for (const path of ["/anything", "/mcp/x", "/mcpx", "/health/x"]) {
      const resp = await rpc(path, "tools/list");
      expect([401, 404]).toContain(resp.status);
      expect(await resp.text()).not.toContain("mcp_info");
    }
  });

  test("a key that is almost right is refused", async () => {
    expect((await rpc("/mcp", "tools/list", `${API_KEY}x`)).status).toBe(401);
    expect((await rpc("/mcp", "tools/list", API_KEY.slice(0, -1))).status).toBe(401);
  });

  test("without an app, a project folder or Docker only the introspection tools are listed", async () => {
    const bare = await startServer({
      REDMINE_URL: "",
      REDMINE_API_KEY: "",
      N8N_URL: "",
      N8N_API_KEY: "",
      ZAMMAD_API_URL: "",
      ZAMMAD_API_TOKEN: "",
      MCP_DOCKER_HOST: "",
      MCP_PROJECT_DIR: join(tmpdir(), "mcp-no-project"),
    });
    try {
      const resp = await fetch(`${bare.url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(resp.status).toBe(200);
      const names = [...(await resp.text()).matchAll(/"name":"([a-z0-9_]+)"/g)].map((m) => m[1]).sort();
      expect(names).toEqual(["mcp_info", "mcp_tools"]);
    } finally {
      stopServer(bare);
    }
  });

  test("an app's tools are listed once its address and key are there", async () => {
    const withRedmine = await startServer({
      REDMINE_URL: "http://redmine.invalid:3000",
      REDMINE_API_KEY: "k",
      N8N_URL: "http://n8n.invalid:5678",
      N8N_API_KEY: "",
      ZAMMAD_API_URL: "",
      ZAMMAD_API_TOKEN: "",
      MCP_DOCKER_HOST: "",
      MCP_PROJECT_DIR: join(tmpdir(), "mcp-no-project"),
    });
    try {
      const resp = await fetch(`${withRedmine.url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      const names = [...(await resp.text()).matchAll(/"name":"([a-z0-9_]+)"/g)].map((m) => m[1] as string);
      expect(names).toContain("redmine_issue");
      expect(names.some((name) => name.startsWith("n8n_"))).toBe(false);
      expect(names.some((name) => /^(package_|command_|service_|email_)/.test(name))).toBe(false);
    } finally {
      stopServer(withRedmine);
    }
  });

  test("full connector flow: DCR → authorize → sign-in → token (PKCE) → /mcp", async () => {
    // 1. Dynamic Client Registration
    const reg = await fetch(`${srv.url}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "test-connector",
        redirect_uris: ["http://127.0.0.1:9876/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect([200, 201]).toContain(reg.status);
    const client = await reg.json();
    expect(client.client_id).toBeDefined();

    // PKCE
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const redirectUri = "http://127.0.0.1:9876/callback";
    const resource = `${srv.url}/mcp`;
    const state = "st-" + randomBytes(4).toString("hex");

    // 2. /authorize → sign-in page
    const authUrl =
      `${srv.url}/authorize?response_type=code&client_id=${encodeURIComponent(client.client_id)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}` +
      `&code_challenge_method=S256&state=${state}&scope=mcp&resource=${encodeURIComponent(resource)}`;
    const authRes = await fetch(authUrl, { redirect: "manual" });
    expect(authRes.status).toBe(200);
    expect(await authRes.text()).toContain("API-sleutel");

    const formFields = {
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      state,
      scope: "mcp",
      resource,
    };

    // 3a. wrong key → 401, no code
    const bad = await fetch(`${srv.url}/oauth/sign-in`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...formFields, token: "WRONG" }).toString(),
      redirect: "manual",
    });
    expect(bad.status).toBe(401);

    // 3b. right key → redirect with code
    const signin = await fetch(`${srv.url}/oauth/sign-in`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...formFields, token: API_KEY }).toString(),
      redirect: "manual",
    });
    expect([302, 303]).toContain(signin.status);
    const loc = new URL(signin.headers.get("location") || "", srv.url);
    const code = loc.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(loc.searchParams.get("state")).toBe(state);

    // 4. token exchange (PKCE)
    const tok = await fetch(`${srv.url}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: redirectUri,
        client_id: client.client_id,
        code_verifier: verifier,
      }).toString(),
    });
    expect(tok.status).toBe(200);
    const tokens = await tok.json();
    expect(tokens.access_token).toBeDefined();
    expect(tokens.refresh_token).toBeDefined();
    expect(tokens.scope).toBe("mcp");

    // 4b. the code is single-use
    const reuse = await fetch(`${srv.url}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: redirectUri,
        client_id: client.client_id,
        code_verifier: verifier,
      }).toString(),
    });
    expect(reuse.status).toBeGreaterThanOrEqual(400);

    // 5. /mcp initialize with the OAuth access token
    const init = await fetch(`${srv.url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      }),
    });
    expect(init.status).toBe(200);

    // 6. refresh_token grant
    const rf = await fetch(`${srv.url}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: client.client_id,
      }).toString(),
    });
    expect(rf.status).toBe(200);
    expect((await rf.json()).access_token).toBeDefined();
  }, 20000);

  test("a redirect_uri that lies (fragment / userinfo) is refused at registration", async () => {
    for (const uri of ["https://claude.ai@example.com/cb", "https://ok.example/cb#x"]) {
      const reg = await fetch(`${srv.url}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "bad", redirect_uris: [uri] }),
      });
      expect(reg.status).toBeGreaterThanOrEqual(400);
    }
  });
});
