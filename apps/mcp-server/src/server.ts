/**
 * MCP Server
 *
 * Model Context Protocol server: gives AI agents tools for the apps of the
 * project it runs in (Redmine, n8n, Zammad), and, when the installation opts
 * in, for the project's recipes and its containers.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, createOAuthMetadata } from "@modelcontextprotocol/sdk/server/auth/router.js";
import express from "express";
import { execSync } from "child_process";
import { z } from "zod";
import { createHmac, createHash, randomBytes, timingSafeEqual } from "crypto";
import {
  initOAuthDb,
  oauthProvider,
  signInPage,
  grantCode,
  savePending,
  takePending,
  SIGN_IN_PATH,
  SCOPE as OAUTH_SCOPE,
} from "./oauth.ts";
import { capabilitiesFrom, isListed, projectDir } from "./capabilities.ts";
import { containerLogs, containersOf, dockerBase, listContainers } from "./docker.ts";

// Configuration
const PORT = parseInt(process.env.MCP_PORT || "9125");
const API_KEYS = (process.env.MCP_API_KEYS || "")
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);
const CLIENT_VERSION = "1.8.0";  // Update this when releasing new client versions

// What this server was given: decides which tools are listed.
const CAPS = capabilitiesFrom();
const PROJECT_DIR = projectDir();
// Where the copy of the Redmine ticket helper lives in the image.
const TICKET_CLI = process.env.MCP_TICKET_CLI || "/app/tools/ticket-cli.py";
const CONTAINER_PREFIX = process.env.CONTAINER_PREFIX || "";
const DOCKER_HOST = process.env.MCP_DOCKER_HOST || "";
// The containers the service tools show: the project's own (its network, its container prefix).
const DOCKER_SCOPE = { prefix: CONTAINER_PREFIX, network: process.env.MCP_APPS_NETWORK || "" };

// Sign-in through Authentik. The browser is sent to MCP_AUTHENTIK_URL; this server
// itself asks Authentik at MCP_AUTHENTIK_INTERNAL_URL (its container on the apps'
// network), because a name under .localhost means this container to the runtime.
const AUTHENTIK_URL = (process.env.MCP_AUTHENTIK_URL || "").replace(/\/+$/, "");
const AUTHENTIK_INTERNAL_URL = (process.env.MCP_AUTHENTIK_INTERNAL_URL || AUTHENTIK_URL).replace(/\/+$/, "");
const OAUTH_CLIENT_ID = process.env.MCP_AUTHENTIK_CLIENT_ID || "";
const OAUTH_CLIENT_SECRET = process.env.MCP_AUTHENTIK_CLIENT_SECRET || "";
const OAUTH_INTROSPECT_URL = `${AUTHENTIK_INTERNAL_URL}/application/o/introspect/`;
const OAUTH_AUTHORIZE_URL = AUTHENTIK_URL ? `${AUTHENTIK_URL}/application/o/authorize/` : "";
const OAUTH_TOKEN_URL = AUTHENTIK_URL ? `${AUTHENTIK_INTERNAL_URL}/application/o/token/` : "";
// The pages that hand a signed-in person a key of their own exist only with Authentik connected.
const OAUTH_ENABLED = Boolean(AUTHENTIK_URL && OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET);

// The address pages and sign-in links carry: the server's one public address. Not read
// from request headers: TLS ends before the edge, so those would say http.
function getBaseUrl(_req: import("http").IncomingMessage): string {
  return PUBLIC_URL.origin;
}

// Token cache to avoid frequent introspection calls
const tokenCache = new Map<string, { valid: boolean; user: string; userInfo?: OAuthUserInfo; exp: number }>();
const TOKEN_CACHE_TTL = 300000; // 5 minutes

// Setup token store: temp tokens for Windows installer download (5 min TTL)
const setupTokens = new Map<string, { apiKey: string; baseUrl: string; expiresAt: number }>();
const SETUP_TOKEN_TTL = 1800000; // 30 minutes

// API Key Configuration: the secret that signs the keys people get after signing in.
const JWT_SECRET = process.env.MCP_SIGNING_SECRET || "";
if (JWT_SECRET.length < 32) throw new Error("MCP_SIGNING_SECRET must be set (at least 32 characters)");
const API_KEY_EXPIRY_DAYS = parseInt(process.env.API_KEY_EXPIRY_DAYS || "365"); // 1 year default

// API Key generation and validation
interface ApiKeyPayload {
  sub: string;      // user id
  email: string;
  name: string;
  iat: number;      // issued at
  exp: number;      // expiry
  type: "api_key";
}

function generateApiKey(user: { sub: string; email: string; name: string }): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: ApiKeyPayload = {
    sub: user.sub,
    email: user.email,
    name: user.name,
    iat: now,
    exp: now + (API_KEY_EXPIRY_DAYS * 24 * 60 * 60),
    type: "api_key"
  };

  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", JWT_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");

  return `${header}.${body}.${signature}`;
}

function validateApiKey(token: string): { valid: boolean; user?: ApiKeyPayload } {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return { valid: false };

    const [header, body, signature] = parts;

    // Verify signature
    const expectedSig = createHmac("sha256", JWT_SECRET)
      .update(`${header}.${body}`)
      .digest("base64url");

    const given = Buffer.from(signature);
    const expected = Buffer.from(expectedSig);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { valid: false };

    // Decode and validate payload
    const payload: ApiKeyPayload = JSON.parse(Buffer.from(body, "base64url").toString());

    // Check expiry
    if (payload.exp < Math.floor(Date.now() / 1000)) return { valid: false };

    // Check type
    if (payload.type !== "api_key") return { valid: false };

    return { valid: true, user: payload };
  } catch {
    return { valid: false };
  }
}

// ---------------------------------------------------------------------------
// Self-contained OAuth 2.1 authorization server (RFC 7591 DCR + PKCE) so that
// Claude/ChatGPT connectors — which cannot paste an API key — can authorize by
// URL. Storage + provider live in oauth.ts (bun:sqlite). The public issuer is
// fixed and never taken from request headers (they arrive as http through the
// TLS-terminating edge): it comes from MCP_PUBLIC_URL (the published address,
// or localhost on the port this machine reaches the server at).
const PUBLIC_URL = new URL(process.env.MCP_PUBLIC_URL || `http://localhost:${PORT}`);
const OAUTH_REDIRECT_URI = `${PUBLIC_URL.origin}/oauth/callback`;
const RESOURCE_URL = new URL("/mcp", PUBLIC_URL); // resource identifier = <origin>/mcp
const OAUTH_SCOPES = [OAUTH_SCOPE];

// --- Upstream identity: chained login via Authentik ------------------------
// Dynamic client registration stays on OUR side (Authentik exposes no DCR, which
// hosted connectors require); Authentik only logs the human in. When configured,
// /authorize bounces the browser to Authentik instead of the API-key page, and
// the signed-in user's identity (email) travels code -> token -> tool call.
const AK_CLIENT_ID = OAUTH_CLIENT_ID;
const AK_CLIENT_SECRET = OAUTH_CLIENT_SECRET;
const AK_AUTHORIZE_URL = OAUTH_AUTHORIZE_URL;
const AK_TOKEN_URL = OAUTH_TOKEN_URL;
const AK_USERINFO_URL = AUTHENTIK_URL ? `${AUTHENTIK_INTERNAL_URL}/application/o/userinfo/` : "";
const AK_CALLBACK_PATH = "/oauth/authentik/callback";
const AK_CALLBACK = `${PUBLIC_URL.origin}${AK_CALLBACK_PATH}`;
const AUTHENTIK_LOGIN = OAUTH_ENABLED;

const b64url = (b: Buffer): string => b.toString("base64url");

// /authorize handler: park the connector's request, bounce the browser to
// Authentik (with our own PKCE on the upstream leg), resume in the callback.
function authorizeViaAuthentik(client: any, params: any, res: any): void {
  const akVerifier = b64url(randomBytes(32));
  const akChallenge = b64url(createHash("sha256").update(akVerifier).digest());
  const id = savePending({
    clientId: client.client_id,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    state: params.state,
    scope: params.scopes?.length ? params.scopes.join(" ") : undefined,
    resource: params.resource?.href,
    akVerifier,
  });
  const u = new URL(AK_AUTHORIZE_URL);
  u.searchParams.set("client_id", AK_CLIENT_ID);
  u.searchParams.set("redirect_uri", AK_CALLBACK);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("code_challenge", akChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", id);
  res.redirect(u.href);
}

initOAuthDb();
const OAUTH_PROVIDER = oauthProvider(
  AUTHENTIK_LOGIN ? { authorize: authorizeViaAuthentik } : {},
);

/** Compare two secrets without telling, by the time it takes, how much of a guess was right. */
function sameSecret(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

/**
 * Resolve a pasted key (sign-in page) or a Bearer token (/mcp) to an
 * identity string. A key is either a static MCP_API_KEYS entry or a self-issued
 * HS256 api-key. Returns null when the token is not one of ours.
 */
function resolvePersonalToken(token: string): string | null {
  if (!token) return null;
  if (API_KEYS.some((key) => sameSecret(key, token))) return "api-key-user";
  const r = validateApiKey(token);
  if (r.valid && r.user) return r.user.email;
  return null;
}

// Helper functions

/**
 * Shell-quote a user-supplied string for safe interpolation into a command
 * passed to `execSync` (which runs through `/bin/sh -c …`). Wraps the value
 * in single quotes and escapes any embedded single quote via the standard
 * `'\''` trick. Single-quoted strings disable backtick command substitution,
 * `$VAR` expansion, and every other shell metacharacter, so values like
 * "Title with `just bootstrap-local` inside" no longer get executed.
 *
 * Ticket subjects and descriptions that contain a recipe name would otherwise
 * run as shell commands and corrupt the resulting ticket.
 */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Run a Redmine ticket command, or a recipe of the project.
 * Ticket commands go to the ticket helper this image carries; everything else
 * is a `just` recipe in the mounted project folder.
 */
function execJust(command: string, options: { json?: boolean; timeout?: number } = {}): { success: boolean; data?: any; error?: string } {
  const { json = true, timeout = 30000 } = options;

  if (command.startsWith("ticket ")) {
    const ticketArgs = command.replace("ticket ", "");
    const fullCommand = json ? `python3 ${TICKET_CLI} --json ${ticketArgs}` : `python3 ${TICKET_CLI} ${ticketArgs}`;

    try {
      const output = execSync(fullCommand, {
        encoding: "utf-8",
        timeout,
        cwd: "/app",
        env: { ...process.env }
      }).trim();

      if (json) {
        return { success: true, data: JSON.parse(output) };
      }
      return { success: true, data: output };
    } catch (err: any) {
      const errorMsg = err.stderr?.toString() || err.stdout?.toString() || err.message || "Command failed";
      return { success: false, error: errorMsg };
    }
  }

  // A recipe: only with a project folder. The tools that get here are not listed without one.
  if (!CAPS.project) {
    return { success: false, error: "No project folder is mounted, so there are no recipes to run." };
  }
  const fullCommand = json ? `just ${command} --json` : `just ${command}`;

  try {
    const output = execSync(fullCommand, {
      encoding: "utf-8",
      timeout,
      cwd: PROJECT_DIR,
      env: {
        ...process.env,
        FORCE_COLOR: "0",  // Disable colors for clean output
        PWD: PROJECT_DIR,  // Required by some just recipes
        HOME: "/root",     // Required for some tools
        // What the project's own scripts expect to find their folders by.
        PACKAGES_DIR: `${PROJECT_DIR}/packages`,
        PYTHONPATH: PROJECT_DIR,
        // Recipes that ask Docker reach it through the read-only proxy, when that is on.
        ...(DOCKER_HOST ? { DOCKER_HOST } : {})
      }
    }).trim();

    if (json) {
      return { success: true, data: JSON.parse(output) };
    }
    return { success: true, data: output };
  } catch (err: any) {
    const errorMsg = err.stderr?.toString() || err.message || "Command failed";
    return { success: false, error: errorMsg };
  }
}

// n8n REST API helper
async function n8nApi(path: string, options: { method?: string; body?: any; timeout?: number } = {}): Promise<{ success: boolean; data?: any; error?: string }> {
  const baseUrl = process.env.N8N_URL || "";
  const apiKey = process.env.N8N_API_KEY;
  if (!apiKey) {
    return { success: false, error: "N8N_API_KEY not configured. Generate one in n8n Settings > API." };
  }
  try {
    const resp = await fetch(`${baseUrl}/api/v1${path}`, {
      method: options.method || "GET",
      headers: {
        "X-N8N-API-KEY": apiKey,
        "Accept": "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options.timeout || 15000),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { success: false, error: `n8n API ${resp.status}: ${text}` };
    }
    const data = await resp.json();
    return { success: true, data };
  } catch (err: any) {
    return { success: false, error: err.message || "n8n API call failed" };
  }
}

// Zammad REST API helper
async function zammadApi(path: string, options: { method?: string; body?: any; timeout?: number } = {}): Promise<{ success: boolean; data?: any; error?: string }> {
  const baseUrl = process.env.ZAMMAD_API_URL || "";
  const token = process.env.ZAMMAD_API_TOKEN;
  if (!token) {
    return { success: false, error: "ZAMMAD_API_TOKEN not configured. Generate one in Zammad > Admin > API > Token Access." };
  }
  try {
    const method = (options.method || "GET").toUpperCase();
    let expandParam = "";
    if (method === "GET" && !path.includes("expand=")) {
      const separator = path.includes("?") ? "&" : "?";
      expandParam = `${separator}expand=true`;
    }
    const resp = await fetch(`${baseUrl}/api/v1${path}${expandParam}`, {
      method: options.method || "GET",
      headers: {
        "Authorization": `Token token=${token}`,
        "Accept": "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options.timeout || 15000),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { success: false, error: `Zammad API ${resp.status}: ${text}` };
    }
    const data = await resp.json();
    return { success: true, data };
  } catch (err: any) {
    return { success: false, error: err.message || "Zammad API call failed" };
  }
}

// Zammad write operations via n8n workflows (centralizes business logic + side-effects)
// Workflow IDs are stored in env vars, set after n8n workflows are created
async function triggerZammadWorkflow(action: string, data: Record<string, any>): Promise<{ success: boolean; data?: any; error?: string }> {
  const workflowEnvMap: Record<string, string> = {
    create_ticket: "ZAMMAD_N8N_CREATE_WORKFLOW_URL",
    update_ticket: "ZAMMAD_N8N_UPDATE_WORKFLOW_URL",
    add_article: "ZAMMAD_N8N_ARTICLE_WORKFLOW_URL",
    manage_tags: "ZAMMAD_N8N_TAGS_WORKFLOW_URL",
  };
  const envKey = workflowEnvMap[action];
  if (!envKey) return { success: false, error: `Unknown Zammad workflow action: ${action}` };

  // The workflows live in the project's n8n unless the installation names another address.
  const path = `mcp-zammad-${{ create_ticket: "create", update_ticket: "update", add_article: "article", manage_tags: "tags" }[action]}`;
  const webhookUrl = process.env[envKey] || (process.env.N8N_URL ? `${process.env.N8N_URL}/webhook/${path}` : "");
  if (!webhookUrl) return { success: false, error: `${envKey} not configured (n8n workflow not set up yet)` };

  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { success: false, error: `n8n workflow ${resp.status}: ${text}` };
    }
    const result = await resp.json();
    return { success: true, data: result };
  } catch (err: any) {
    return { success: false, error: err.message || "n8n Zammad workflow call failed" };
  }
}

// OAuth2 Token Validation
interface OAuthUserInfo {
  sub: string;
  email: string;
  name: string;
  username: string;
}

async function validateOAuthToken(token: string): Promise<{ valid: boolean; user?: string; userInfo?: OAuthUserInfo }> {
  // Check cache first
  const cached = tokenCache.get(token);
  if (cached && cached.exp > Date.now()) {
    return { valid: cached.valid, user: cached.user, userInfo: cached.userInfo };
  }

  try {
    // Introspect token with Authentik
    const response = await fetch(OAUTH_INTROSPECT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${Buffer.from(`${OAUTH_CLIENT_ID}:${OAUTH_CLIENT_SECRET}`).toString("base64")}`
      },
      body: new URLSearchParams({ token })
    });

    if (!response.ok) {
      console.error(`OAuth introspect failed: ${response.status}`);
      return { valid: false };
    }

    const data = await response.json();

    if (data.active !== true) {
      return { valid: false };
    }

    // Introspect may not have all user info, try userinfo endpoint
    let userInfo: OAuthUserInfo = {
      sub: data.sub || "unknown",
      email: data.email || data.preferred_username || "unknown@unknown",
      name: data.name || data.preferred_username || "Unknown User",
      username: data.preferred_username || data.username || "unknown"
    };

    // If email is unknown, fetch from userinfo endpoint
    if (userInfo.email === "unknown@unknown" || userInfo.name === "Unknown User") {
      try {
        const userinfoUrl = AK_USERINFO_URL;
        const userinfoResp = await fetch(userinfoUrl, {
          headers: { "Authorization": `Bearer ${token}` }
        });
        if (userinfoResp.ok) {
          const userinfoData = await userinfoResp.json();
          userInfo = {
            sub: userinfoData.sub || userInfo.sub,
            email: userinfoData.email || userinfoData.preferred_username || userInfo.email,
            name: userinfoData.name || userinfoData.preferred_username || userInfo.name,
            username: userinfoData.preferred_username || userinfoData.username || userInfo.username
          };
        }
      } catch (e) {
        // Ignore userinfo errors, use introspect data
      }
    }

    const result = {
      valid: true,
      user: userInfo.sub,
      userInfo
    };

    // Cache the result
    tokenCache.set(token, {
      ...result,
      exp: Date.now() + TOKEN_CACHE_TTL
    });

    return result;
  } catch (error) {
    console.error("OAuth validation error:", error);
    return { valid: false };
  }
}

// Exchange authorization code for tokens
async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<any> {
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  return response.json();
}

// Create MCP Server
async function createMcpServer(): Promise<McpServer> {
  const server = new McpServer({
    name: "mcp-server",
    version: "1.0.0"
  });

  // A tool is registered only when what it works with is there (its app's
  // address and key, a project folder, read access to Docker): see capabilities.ts.
  const register = server.tool.bind(server) as (...args: any[]) => unknown;
  (server as any).tool = (name: string, ...rest: any[]) =>
    isListed(name, CAPS) ? register(name, ...rest) : undefined;

  // ============================================
  // PACKAGE TOOLS
  // ============================================

  server.tool(
    "package_list",
    "List all available packages with their status",
    {
      category: z.string().optional().describe("Filter by category (e.g., 'monitoring', 'core', 'crm')"),
      status: z.enum(["running", "stopped", "available"]).optional().describe("Filter by status")
    },
    async (args: { category?: string; status?: string }) => {
      // DRY: Delegate to just package list --json (single source of truth)
      const result = execJust("package list");

      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }

      // Apply optional filters
      let packages = result.data.packages || [];
      if (args.category) {
        packages = packages.filter((p: any) => p.category === args.category);
      }
      if (args.status) {
        packages = packages.filter((p: any) => p.status === args.status);
      }

      return { content: [{ type: "text", text: JSON.stringify({ packages, total: packages.length }, null, 2) }] };
    }
  );

  server.tool(
    "package_info",
    "Get detailed information about a specific package",
    {
      name: z.string().describe("Package name (e.g., 'grafana', 'n8n')")
    },
    async (args: { name: string }) => {
      // DRY: Delegate to just package info --json (single source of truth)
      const result = execJust(`package info ${args.name}`);

      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }

      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "package_search",
    "Search packages by query string",
    {
      query: z.string().describe("Search query (matches name, description, tags)")
    },
    async (args: { query: string }) => {
      // DRY: Delegate to just package search --json (single source of truth)
      const result = execJust(`package search ${args.query}`);

      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }

      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  // ============================================
  // COMMAND DISCOVERY TOOLS (in-memory contract)
  // ============================================

  // Helper to load contract.
  // No on-disk artifact. We spawn the generator and parse stdout
  // in-memory. Result is cached for the lifetime of the MCP server process
  // (restarted on every release, so staleness is bounded by the deploy
  // cadence). Subsequent calls reuse the parsed object.
  let cachedContract: { commands: Record<string, any[]>; stats: any } | null = null;
  function loadContract(): { commands: Record<string, any[]>; stats: any } | null {
    if (cachedContract) return cachedContract;
    try {
      const yaml = require("yaml");
      const { spawnSync } = require("node:child_process");
      const root = PROJECT_DIR;
      const result = spawnSync(
        "python3",
        [`${root}/scripts/util/contract_generate.py`, "--stdout"],
        { cwd: root, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
      );
      if (result.status !== 0 || !result.stdout) return null;
      cachedContract = yaml.parse(result.stdout);
      return cachedContract;
    } catch (e) {
      return null;
    }
  }

  server.tool(
    "command_list",
    "List available just commands from the contract",
    {
      module: z.string().optional().describe("Filter by module (e.g., 'ticket', 'package', 'health')")
    },
    async (args: { module?: string }) => {
      const contract = loadContract();
      if (!contract) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Contract generation failed. Verify python3 + scripts/util/contract_generate.py are available in container." }) }] };
      }

      let result: any[] = [];
      const modules = args.module ? { [args.module]: contract.commands[args.module] } : contract.commands;

      for (const [mod, commands] of Object.entries(modules)) {
        if (!commands) continue;
        for (const cmd of commands as any[]) {
          result.push({
            command: `just ${cmd.name}`,
            module: mod,
            args: cmd.args || null,
            description: cmd.description || null,
            deprecated: cmd.deprecated || false
          });
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            commands: result,
            total: result.length,
            modules: Object.keys(contract.commands)
          }, null, 2)
        }]
      };
    }
  );

  server.tool(
    "command_search",
    "Search commands by name or description",
    {
      query: z.string().describe("Search query (matches command name or description)")
    },
    async (args: { query: string }) => {
      const contract = loadContract();
      if (!contract) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Contract generation failed. Verify python3 + scripts/util/contract_generate.py are available in container." }) }] };
      }

      const query = args.query.toLowerCase();
      let results: any[] = [];

      for (const [mod, commands] of Object.entries(contract.commands)) {
        for (const cmd of commands as any[]) {
          const nameMatch = cmd.name.toLowerCase().includes(query);
          const descMatch = cmd.description?.toLowerCase().includes(query);
          if (nameMatch || descMatch) {
            results.push({
              command: `just ${cmd.name}`,
              module: mod,
              args: cmd.args || null,
              description: cmd.description || null,
              match: nameMatch ? "name" : "description"
            });
          }
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ results, total: results.length }, null, 2)
        }]
      };
    }
  );

  server.tool(
    "command_modules",
    "List available command modules with counts",
    {},
    async () => {
      const contract = loadContract();
      if (!contract) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Contract generation failed. Verify python3 + scripts/util/contract_generate.py are available in container." }) }] };
      }

      const modules = Object.entries(contract.commands).map(([name, commands]) => ({
        module: name,
        count: (commands as any[]).length,
        deprecated: (commands as any[]).filter((c: any) => c.deprecated).length
      })).sort((a, b) => b.count - a.count);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            modules,
            total_commands: contract.stats?.total_commands || modules.reduce((a, m) => a + m.count, 0)
          }, null, 2)
        }]
      };
    }
  );

  // ============================================
  // SERVICE TOOLS
  // ============================================
  // With a project folder these run its recipes (which know its services).
  // Without one they read the project's containers straight from Docker.

  const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
  async function ownContainers(service: string) {
    try {
      const containers = containersOf(await listContainers(dockerBase(DOCKER_HOST), DOCKER_SCOPE), CONTAINER_PREFIX, service);
      if (!containers.length) return asText({ error: `No container found for service: ${service}` });
      return asText({
        service,
        running: containers.every((c) => c.state === "running"),
        healthy: containers.every((c) => c.state === "running" && c.health !== "unhealthy"),
        main_container: containers[0]?.name,
        containers
      });
    } catch (err: any) {
      return asText({ error: err.message });
    }
  }

  server.tool(
    "service_status",
    "Get the status of a running service",
    {
      name: z.string().describe("Service name")
    },
    async (args: { name: string }) => {
      if (!CAPS.project) return ownContainers(args.name);
      // Use service registry for status (includes runtime info from Docker)
      const result = execJust(`registry ${args.name} --json`, { json: true });

      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }

      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "service_health",
    "Run health check on a service",
    {
      name: z.string().describe("Service name")
    },
    async (args: { name: string }) => {
      if (!CAPS.project) return ownContainers(args.name);
      // Use service registry - includes health status from Docker
      const result = execJust(`registry ${args.name} --json`, { json: true });

      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }

      // Extract health-relevant info
      const data = result.data;
      const healthInfo = {
        service: data.name,
        running: data.running,
        healthy: data.healthy,
        main_container: data.main_container,
        containers: data.containers?.map((c: any) => ({
          name: c.name,
          status: c.status,
          health: c.health
        }))
      };

      return { content: [{ type: "text", text: JSON.stringify(healthInfo, null, 2) }] };
    }
  );

  server.tool(
    "service_logs",
    "Get recent logs from a service",
    {
      name: z.string().describe("Service name"),
      lines: z.number().optional().describe("Number of log lines to retrieve (default: 50)")
    },
    async (args: { name: string; lines?: number }) => {
      if (!CAPS.project) {
        try {
          const main = containersOf(await listContainers(dockerBase(DOCKER_HOST), DOCKER_SCOPE), CONTAINER_PREFIX, args.name)[0];
          if (!main) return asText({ error: `No container found for service: ${args.name}` });
          const lines = args.lines || 50;
          return asText({ service: args.name, container: main.name, lines, logs: await containerLogs(dockerBase(DOCKER_HOST), main.name, lines) });
        } catch (err: any) {
          return asText({ error: err.message });
        }
      }
      // First get the main container name from registry
      const regResult = execJust(`registry ${args.name} --json`, { json: true });

      if (!regResult.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: regResult.error }) }] };
      }

      const mainContainer = regResult.data?.main_container;
      if (!mainContainer) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `No container found for service: ${args.name}` }) }] };
      }

      // Get logs directly from Docker
      const lines = args.lines || 50;
      try {
        const { spawnSync } = require("child_process");
        const ran = spawnSync("docker", ["logs", String(mainContainer), "--tail", String(Math.floor(Number(lines)) || 50)], {
          encoding: "utf-8",
          timeout: 30000,
          env: { ...process.env, ...(DOCKER_HOST ? { DOCKER_HOST } : {}) }
        });
        if (ran.error) throw ran.error;
        // A container writes to both streams; the order between them is not kept.
        const logs = `${ran.stdout || ""}${ran.stderr || ""}`;

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              service: args.name,
              container: mainContainer,
              lines: lines,
              logs: logs.split("\n")
            }, null, 2)
          }]
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }] };
      }
    }
  );

  // ============================================
  // ECOSYSTEM TOOLS
  // ============================================

  server.tool(
    "ecosystem_health",
    "Get overall ecosystem health summary",
    {},
    async () => {
      if (!CAPS.project) {
        try {
          const containers = await listContainers(dockerBase(DOCKER_HOST), DOCKER_SCOPE);
          const down = containers.filter((c) => c.state !== "running" || c.health === "unhealthy");
          return asText({ healthy: down.length === 0, total: containers.length, not_healthy: down.map((c) => c.name), containers });
        } catch (err: any) {
          return asText({ error: err.message });
        }
      }
      // DRY: Delegate to just health --json (single source of truth)
      const result = execJust("health");

      if (!result.success) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: result.error })
          }]
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result.data, null, 2)
        }]
      };
    }
  );

  // ============================================
  // REDMINE TOOLS
  // ============================================

  server.tool(
    "redmine_epics",
    "List all epics (tracker_id=4) from Redmine",
    {
      status: z.enum(["open", "closed", "all"]).optional().describe("Filter by status (default: open)"),
      limit: z.number().optional().describe("Max results (default: 100)")
    },
    async (args: { status?: string; limit?: number }) => {
      // DRY: Delegate to just ticket epics --json (single source of truth)
      // Build command with filter arguments
      let cmd = "ticket epics";

      if (args.status) {
        cmd += ` --status=${args.status}`;
      }
      if (args.limit) {
        cmd += ` --limit=${args.limit}`;
      }

      const result = execJust(cmd);

      if (!result.success) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: result.error })
          }]
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result.data, null, 2)
        }]
      };
    }
  );

  server.tool(
    "redmine_issues",
    "Search issues in Redmine",
    {
      query: z.string().optional().describe("Search query (searches in subject)"),
      project: z.string().optional().describe("Project identifier"),
      tracker: z.enum(["bug", "feature", "support", "epic"]).optional().describe("Tracker type"),
      status: z.enum(["open", "closed", "all"]).optional().describe("Status filter"),
      limit: z.number().optional().describe("Max results (default: 25)"),
      search_body: z.boolean().optional().describe("Also search in description (slower)"),
      search_journals: z.boolean().optional().describe("Also search in journals/notes (slowest, implies search_body)")
    },
    async (args: { query?: string; project?: string; tracker?: string; status?: string; limit?: number; search_body?: boolean; search_journals?: boolean }) => {
      // DRY: Delegate to just ticket list --json (single source of truth)
      // Build command with filter arguments
      let cmd = "ticket list";

      if (args.tracker) {
        cmd += ` --tracker=${args.tracker}`;
      }
      if (args.status) {
        cmd += ` --status=${args.status}`;
      }
      if (args.limit) {
        cmd += ` --limit=${args.limit}`;
      }
      if (args.query) {
        cmd += ` --query=${shQuote(args.query)}`;  // shell-safe
      }
      if (args.search_journals) {
        cmd += ` --search-journals`;  // implies --search-body
      } else if (args.search_body) {
        cmd += ` --search-body`;
      }

      const result = execJust(cmd);

      if (!result.success) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: result.error })
          }]
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result.data, null, 2)
        }]
      };
    }
  );

  server.tool(
    "redmine_issue",
    "Get detailed information about a specific issue",
    {
      id: z.number().describe("Issue ID")
    },
    async (args: { id: number }) => {
      // DRY: Delegate to just ticket show --json (single source of truth)
      const result = execJust(`ticket show ${args.id}`);

      if (!result.success) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: result.error })
          }]
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result.data, null, 2)
        }]
      };
    }
  );

  // ============================================
  // REDMINE WRITE OPERATIONS (DRY - via just commands)
  // ============================================
  // All Redmine operations now delegate to just ticket commands.
  // Workflow-aware logic (idempotent close/reopen, auto-reopen) is handled
  // in scripts/ticket-cli.py as the single source of truth.
  //
  // Response contract — every successful write-tool response below
  // (redmine_create_ticket, redmine_update_ticket, redmine_close_ticket,
  // redmine_reopen_ticket, redmine_add_note) carries:
  //   - author_login: string
  //       The Redmine login the action was attributed to. Resolved from
  //       (1) explicit author_login arg, (2) REDMINE_DEFAULT_AUTHOR env,
  //       (3) REDMINE_DEFAULT_AUTHOR in .env file, in that order.
  //   - author_hint?: string
  //       Present only when the resolved author is an admin user. Surfaces
  //       silent-fallback attribution (e.g. REDMINE_DEFAULT_AUTHOR=akadmin
  //       because the pre_start hook couldn't match git user.email or $USER
  //       to a real user) and tells the agent how to attribute the next
  //       call to a non-admin instead.
  // Failure paths (no author resolvable for a write) are blocked upstream
  // by ticket-cli's _require_author_for_write — no silent fallback to admin.

  server.tool(
    "redmine_create_ticket",
    "Create a new ticket in Redmine",
    {
      subject: z.string().describe("Ticket subject/title"),
      tracker: z.enum(["bug", "feature", "support", "epic"]).optional().describe("Tracker type (default: feature)"),
      epic_id: z.number().optional().describe("Parent epic ID (required for bug/feature/support, not needed for epic)"),
      description: z.string().optional().describe("Ticket description"),
      assigned_to: z.string().optional().describe("Assignee login or 'me'"),
      ai_agent: z.string().optional().describe("AI agent that created this ticket (e.g., 'Claude Code', 'Cursor')"),
      ai_session_id: z.string().optional().describe("AI session ID for traceability"),
      author_login: z.string().optional().describe("Redmine login to attribute the ticket to via X-Redmine-Switch-User (admin API key required); falls back to REDMINE_DEFAULT_AUTHOR env, then admin")
    },
    async (args: { subject: string; tracker?: string; epic_id?: number; description?: string; assigned_to?: string; ai_agent?: string; ai_session_id?: string; author_login?: string }) => {
      // DRY: Delegate to just ticket create --json (single source of truth)
      // Build command with arguments
      // Shell-safe: single-quote all user-supplied free-form strings.
      let cmd = `ticket create ${shQuote(args.subject)} --tracker=${args.tracker || "feature"}`;
      if (args.epic_id) {
        cmd += ` --epic=${args.epic_id}`;
      }
      if (args.description) {
        // Write description to temp file to avoid quoting issues
        const fs = require("fs");
        const tmpFile = `/tmp/mcp_desc_${Date.now()}.txt`;
        fs.writeFileSync(tmpFile, args.description);
        cmd += ` --desc-file=${tmpFile}`;
      }
      if (args.assigned_to) {
        cmd += ` --assign=${shQuote(args.assigned_to)}`;
      }
      if (args.ai_agent) {
        cmd += ` --ai-agent=${shQuote(args.ai_agent)}`;
      }
      if (args.ai_session_id) {
        cmd += ` --ai-session=${shQuote(args.ai_session_id)}`;
      }
      if (args.author_login) {
        cmd += ` --switch-user=${shQuote(args.author_login)}`;
      }

      const result = execJust(cmd);

      if (!result.success) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: result.error })
          }]
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result.data, null, 2)
        }]
      };
    }
  );

  server.tool(
    "redmine_update_ticket",
    "Update an existing ticket (auto-reopens if closed)",
    {
      id: z.number().describe("Issue ID"),
      subject: z.string().optional().describe("New subject"),
      description: z.string().optional().describe("New description"),
      notes: z.string().optional().describe("Journal note to add"),
      status: z.enum(["new", "in_progress", "resolved", "feedback", "closed", "rejected"]).optional().describe("New status"),
      priority: z.enum(["low", "normal", "high", "urgent", "immediate"]).optional().describe("Priority level"),
      assigned_to: z.string().optional().describe("Assignee login or 'me'"),
      epic_id: z.number().optional().describe("Change parent epic (use 0 to remove parent)"),
      author_login: z.string().optional().describe("Redmine login to attribute the update to via X-Redmine-Switch-User (admin API key required)")
    },
    async (args: { id: number; subject?: string; description?: string; notes?: string; status?: string; priority?: string; assigned_to?: string; epic_id?: number; author_login?: string }) => {
      // DRY: Delegate to just ticket update --json (single source of truth)
      // The just command handles auto-reopen internally
      // Shell-safe: single-quote all user-supplied free-form strings.
      let cmd = `ticket update ${args.id}`;

      if (args.subject) {
        cmd += ` --subject=${shQuote(args.subject)}`;
      }
      if (args.description) {
        const fs = require("fs");
        const tmpFile = `/tmp/mcp_desc_${Date.now()}.txt`;
        fs.writeFileSync(tmpFile, args.description);
        cmd += ` --desc-file=${tmpFile}`;
      }
      if (args.notes) {
        const fs = require("fs");
        const tmpFile = `/tmp/mcp_notes_${Date.now()}.txt`;
        fs.writeFileSync(tmpFile, args.notes);
        cmd += ` --notes-file=${tmpFile}`;
      }
      if (args.assigned_to) {
        cmd += ` --assign=${shQuote(args.assigned_to)}`;
      }
      if (args.priority) {
        cmd += ` --priority=${args.priority}`;
      }
      if (args.epic_id !== undefined) {
        cmd += ` --epic=${args.epic_id}`;
      }
      if (args.status) {
        cmd += ` --status=${args.status}`;
      }
      if (args.author_login) {
        cmd += ` --switch-user=${shQuote(args.author_login)}`;
      }

      const result = execJust(cmd);

      if (!result.success) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: result.error })
          }]
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result.data, null, 2)
        }]
      };
    }
  );

  server.tool(
    "redmine_close_ticket",
    "Close a ticket (idempotent - returns success if already closed)",
    {
      id: z.number().describe("Issue ID"),
      notes: z.string().optional().describe("Closing notes"),
      author_login: z.string().optional().describe("Redmine login to attribute the close to via X-Redmine-Switch-User (admin API key required)")
    },
    async (args: { id: number; notes?: string; author_login?: string }) => {
      // DRY: Delegate to just ticket close --json (single source of truth)
      // The just command handles idempotent close internally
      // Shell-safe: single-quote all user-supplied free-form strings.
      let cmd = `ticket close ${args.id}`;
      if (args.notes) {
        cmd += ` --notes=${shQuote(args.notes)}`;
      }
      if (args.author_login) {
        cmd += ` --switch-user=${shQuote(args.author_login)}`;
      }

      const result = execJust(cmd);

      if (!result.success) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: result.error })
          }]
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result.data, null, 2)
        }]
      };
    }
  );

  server.tool(
    "redmine_reopen_ticket",
    "Reopen a closed ticket (idempotent - returns success if already open)",
    {
      id: z.number().describe("Issue ID"),
      notes: z.string().optional().describe("Reopening notes"),
      author_login: z.string().optional().describe("Redmine login to attribute the reopen to via X-Redmine-Switch-User (admin API key required)")
    },
    async (args: { id: number; notes?: string; author_login?: string }) => {
      // DRY: Delegate to just ticket reopen --json (single source of truth)
      // The just command handles idempotent reopen internally
      let cmd = `ticket reopen ${args.id}`;
      if (args.author_login) {
        cmd += ` --switch-user=${shQuote(args.author_login)}`;  // shell-safe
      }
      const result = execJust(cmd);

      if (!result.success) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: result.error })
          }]
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result.data, null, 2)
        }]
      };
    }
  );

  server.tool(
    "redmine_add_note",
    "Add a note/journal entry to a ticket (auto-reopens if closed)",
    {
      id: z.number().describe("Issue ID"),
      note: z.string().describe("Note text to add"),
      author_login: z.string().optional().describe("Redmine login to attribute the note to via X-Redmine-Switch-User (admin API key required)")
    },
    async (args: { id: number; note: string; author_login?: string }) => {
      // DRY: Delegate to just ticket note --json (single source of truth)
      // The just command handles auto-reopen internally
      // Write note to temp file to avoid quoting issues
      const fs = require("fs");
      const tmpFile = `/tmp/mcp_note_${Date.now()}.txt`;
      fs.writeFileSync(tmpFile, args.note);

      let cmd = `ticket note ${args.id} --file=${tmpFile}`;
      if (args.author_login) {
        cmd += ` --switch-user=${shQuote(args.author_login)}`;  // shell-safe
      }
      const result = execJust(cmd);

      // Cleanup temp file
      try { fs.unlinkSync(tmpFile); } catch {}

      if (!result.success) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: result.error })
          }]
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result.data, null, 2)
        }]
      };
    }
  );

  server.tool(
    "redmine_attach_file",
    "Upload a file and attach it to a Redmine ticket. Two-step Redmine REST flow: POST /uploads.json then PUT /issues/<id>.json with uploads[]. Verifies the attachment is linked via GET /issues/<id>.json?include=attachments. Returns structured JSON with attachment_id, filesize, content_type, content_url and the attribution chain. Default max size 5 MiB (Redmine attachment_max_size).",
    {
      id: z.number().describe("Ticket ID to attach the file to"),
      file_path: z.string().describe("Absolute path on the mcp-server host to the file to upload"),
      filename: z.string().optional().describe("Override displayed filename in Redmine (default: basename of file_path)"),
      description: z.string().optional().describe("Optional attachment description shown next to the file"),
      content_type: z.string().optional().describe("Override MIME content-type (default: auto-detect from filename)"),
      max_size_bytes: z.number().optional().describe("Override max upload size in bytes (default: 5 MiB)"),
      author_login: z.string().optional().describe("Redmine login to attribute the upload to via X-Redmine-Switch-User (admin API key required); falls back to REDMINE_DEFAULT_AUTHOR env. Hard-fails if rejected — no silent fallback to admin.")
    },
    async (args: {
      id: number;
      file_path: string;
      filename?: string;
      description?: string;
      content_type?: string;
      max_size_bytes?: number;
      author_login?: string;
    }) => {
      // DRY: delegate to ticket-cli.py via `just ticket attach --json` — same
      // SSOT path as redmine_add_note (the MCP tool reuses the existing
      // implementation, no duplicate REST code in the MCP layer).
      // Shell-safe: single-quote all user-supplied free-form strings.
      let cmd = `ticket attach ${args.id} ${shQuote(args.file_path)} --json`;
      if (args.filename) cmd += ` --filename=${shQuote(args.filename)}`;
      if (args.description) cmd += ` --description=${shQuote(args.description)}`;
      if (args.content_type) cmd += ` --content-type=${shQuote(args.content_type)}`;
      if (typeof args.max_size_bytes === "number") cmd += ` --max-size=${args.max_size_bytes}`;
      if (args.author_login) cmd += ` --switch-user=${shQuote(args.author_login)}`;

      const result = execJust(cmd);
      if (!result.success) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: false, error: result.error })
          }]
        };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result.data, null, 2)
        }]
      };
    }
  );

  // ============================================================================
  // Email Tools
  // ============================================================================

  server.tool(
    "email_send",
    "Send email notification (for development alerts, status updates)",
    {
      to: z.string().describe("Recipient email address"),
      subject: z.string().describe("Email subject"),
      body: z.string().describe("Email body text"),
      html: z.boolean().optional().describe("Treat body as HTML (default: false)")
    },
    async (args: { to: string; subject: string; body: string; html?: boolean }) => {
      // Write body to temp file to avoid shell escaping issues
      const fs = require("fs");
      const tmpFile = `/tmp/mcp_email_${Date.now()}.txt`;
      fs.writeFileSync(tmpFile, args.body);

      const htmlFlag = args.html ? " --html" : "";
      // shell-safe single-quote `to` + `subject`.
      const result = execJust(`email-send-file ${shQuote(args.to)} ${shQuote(args.subject)} ${shQuote(tmpFile)}${htmlFlag}`, { json: false });

      // Cleanup temp file
      try { fs.unlinkSync(tmpFile); } catch {}

      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }
      // Recipe outputs JSON directly
      return { content: [{ type: "text", text: typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "email_health",
    "Check email infrastructure health (Gmail, Postal, Mailserver)",
    {},
    async () => {
      const result = execJust("email-health", { json: false });
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }
      return { content: [{ type: "text", text: typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "email_test",
    "Send test email to verify configuration",
    {
      to: z.string().optional().describe("Recipient (default: ADMIN_EMAIL env var)")
    },
    async (args: { to?: string }) => {
      const recipient = args.to || process.env["ADMIN_EMAIL"] || "";
      const result = execJust(`email-test "${recipient}"`, { json: false });
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }
      return { content: [{ type: "text", text: typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "email_logs",
    "View recent email logs from Postal SMTP",
    {
      lines: z.number().optional().describe("Number of log lines (default: 50)")
    },
    async (args: { lines?: number }) => {
      const lineCount = args.lines || 50;
      const result = execJust(`email-logs ${lineCount}`, { json: false });
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }
      return { content: [{ type: "text", text: typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2) }] };
    }
  );

  // ============================================
  // N8N WORKFLOW TOOLS
  // ============================================

  server.tool(
    "n8n_list_workflows",
    "List all n8n workflows with status (active/inactive)",
    {
      active: z.boolean().optional().describe("Filter by active status")
    },
    async (args: { active?: boolean }) => {
      let path = "/workflows";
      if (args.active !== undefined) {
        path += `?active=${args.active}`;
      }
      const result = await n8nApi(path);
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }
      const workflows = (result.data?.data || result.data || []).map((w: any) => ({
        id: w.id,
        name: w.name,
        active: w.active,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
        tags: w.tags?.map((t: any) => t.name) || []
      }));
      return { content: [{ type: "text", text: JSON.stringify({ workflows, total: workflows.length }, null, 2) }] };
    }
  );

  server.tool(
    "n8n_get_workflow",
    "Get detailed information about a specific n8n workflow (nodes, connections, settings)",
    {
      id: z.string().describe("Workflow ID")
    },
    async (args: { id: string }) => {
      const result = await n8nApi(`/workflows/${args.id}`);
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "n8n_trigger_workflow",
    "Manually trigger/run an n8n workflow with optional input data. Workflow must have a Webhook trigger node.",
    {
      id: z.string().describe("Workflow ID to trigger"),
      data: z.record(z.any()).optional().describe("Input data to pass to the workflow")
    },
    async (args: { id: string; data?: Record<string, any> }) => {
      // Step 1: Fetch workflow to find webhook node
      const wfResult = await n8nApi(`/workflows/${args.id}`);
      if (!wfResult.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Failed to fetch workflow: ${wfResult.error}` }) }] };
      }
      const workflow = wfResult.data;
      const webhookNode = workflow.nodes?.find((n: any) => n.type === "n8n-nodes-base.webhook");
      if (!webhookNode) {
        return { content: [{ type: "text", text: JSON.stringify({
          error: "Workflow has no Webhook trigger node. Add a Webhook node to make it triggerable via API.",
          workflow_name: workflow.name,
          trigger_types: workflow.nodes?.filter((n: any) => n.type?.includes("trigger") || n.type?.includes("Trigger")).map((n: any) => n.type) || []
        }) }] };
      }
      if (!workflow.active) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Workflow is not active. Activate it first with n8n_activate_workflow.", workflow_name: workflow.name }) }] };
      }

      // Step 2: Build webhook URL from node parameters
      const webhookPath = webhookNode.parameters?.path || webhookNode.webhookId || args.id;
      const httpMethod = (webhookNode.parameters?.httpMethod || "POST").toUpperCase();
      const baseUrl = process.env.N8N_URL || "";
      const webhookUrl = `${baseUrl}/webhook/${webhookPath}`;

      // Step 3: Call the webhook
      try {
        const fetchOptions: any = {
          method: httpMethod,
          headers: { "Accept": "application/json" },
          signal: AbortSignal.timeout(30000),
        };
        if (args.data && httpMethod !== "GET") {
          fetchOptions.headers["Content-Type"] = "application/json";
          fetchOptions.body = JSON.stringify(args.data);
        }
        const resp = await fetch(webhookUrl, fetchOptions);
        const contentType = resp.headers.get("content-type") || "";
        const responseData = contentType.includes("json") ? await resp.json() : await resp.text();
        if (!resp.ok) {
          return { content: [{ type: "text", text: JSON.stringify({ error: `Webhook returned ${resp.status}`, response: responseData }) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify({ workflow: workflow.name, webhook_path: webhookPath, method: httpMethod, response: responseData }, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Webhook call failed: ${err.message}` }) }] };
      }
    }
  );

  server.tool(
    "n8n_workflow_executions",
    "List recent executions of n8n workflows (status, duration, errors)",
    {
      workflowId: z.string().optional().describe("Filter by workflow ID"),
      limit: z.number().optional().describe("Max results (default: 20)"),
      status: z.enum(["error", "success", "waiting"]).optional().describe("Filter by execution status")
    },
    async (args: { workflowId?: string; limit?: number; status?: string }) => {
      const params = new URLSearchParams();
      if (args.workflowId) params.set("workflowId", args.workflowId);
      if (args.status) params.set("status", args.status);
      params.set("limit", String(args.limit || 20));
      const result = await n8nApi(`/executions?${params.toString()}`);
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }
      const executions = (result.data?.data || result.data || []).map((e: any) => ({
        id: e.id,
        workflowId: e.workflowId,
        status: e.status,
        startedAt: e.startedAt,
        stoppedAt: e.stoppedAt,
        finished: e.finished,
        mode: e.mode,
        workflowName: e.workflowData?.name
      }));
      return { content: [{ type: "text", text: JSON.stringify({ executions, total: executions.length }, null, 2) }] };
    }
  );

  server.tool(
    "n8n_create_workflow",
    "Create a new n8n workflow",
    {
      name: z.string().describe("Workflow name"),
      nodes: z.array(z.record(z.string(), z.any())).optional().describe("Workflow nodes (n8n node format)"),
      connections: z.record(z.string(), z.any()).optional().describe("Node connections")
    },
    async (args: { name: string; nodes?: any[]; connections?: Record<string, any> }) => {
      const body: any = {
        name: args.name,
        nodes: args.nodes || [],
        connections: args.connections || {},
        settings: {}
      };
      const result = await n8nApi("/workflows", { method: "POST", body });
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "n8n_update_workflow",
    "Update an existing n8n workflow (name, nodes, connections)",
    {
      id: z.string().describe("Workflow ID"),
      name: z.string().optional().describe("New workflow name"),
      nodes: z.array(z.record(z.string(), z.any())).optional().describe("Updated nodes"),
      connections: z.record(z.string(), z.any()).optional().describe("Updated connections"),
      active: z.boolean().optional().describe("Set active status")
    },
    async (args: { id: string; name?: string; nodes?: any[]; connections?: Record<string, any>; active?: boolean }) => {
      // n8n PUT API requires full workflow body (nodes, connections, settings).
      // Fetch existing workflow first, then merge caller's changes.
      const existing = await n8nApi(`/workflows/${args.id}`);
      if (!existing.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Failed to fetch workflow: ${existing.error}` }) }] };
      }
      const body: any = {
        name: existing.data.name,
        nodes: existing.data.nodes || [],
        connections: existing.data.connections || {},
        settings: existing.data.settings || {},
      };
      // Apply caller's overrides
      if (args.name !== undefined) body.name = args.name;
      if (args.nodes !== undefined) body.nodes = args.nodes;
      if (args.connections !== undefined) body.connections = args.connections;
      if (args.active !== undefined) body.active = args.active;
      const result = await n8nApi(`/workflows/${args.id}`, { method: "PUT", body });
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "n8n_delete_workflow",
    "Delete an n8n workflow (destructive, cannot be undone)",
    {
      id: z.string().describe("Workflow ID to delete")
    },
    async (args: { id: string }) => {
      const result = await n8nApi(`/workflows/${args.id}`, { method: "DELETE" });
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ deleted: true, id: args.id }, null, 2) }] };
    }
  );

  server.tool(
    "n8n_activate_workflow",
    "Activate an n8n workflow (enable triggers and schedules)",
    {
      id: z.string().describe("Workflow ID to activate")
    },
    async (args: { id: string }) => {
      const result = await n8nApi(`/workflows/${args.id}/activate`, { method: "POST" });
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "n8n_deactivate_workflow",
    "Deactivate an n8n workflow (disable triggers and schedules)",
    {
      id: z.string().describe("Workflow ID to deactivate")
    },
    async (args: { id: string }) => {
      const result = await n8nApi(`/workflows/${args.id}/deactivate`, { method: "POST" });
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "n8n_execution_details",
    "Get full execution details including input/output data per node",
    {
      id: z.string().describe("Execution ID")
    },
    async (args: { id: string }) => {
      const result = await n8nApi(`/executions/${args.id}`);
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "n8n_delete_execution",
    "Delete an execution record (destructive, cannot be undone)",
    {
      id: z.string().describe("Execution ID to delete")
    },
    async (args: { id: string }) => {
      const result = await n8nApi(`/executions/${args.id}`, { method: "DELETE" });
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ deleted: true, id: args.id }, null, 2) }] };
    }
  );

  server.tool(
    "n8n_list_credentials",
    "List available n8n credentials (names and types only, no secrets)",
    {},
    async () => {
      const result = await n8nApi("/credentials");
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }
      const credentials = (result.data?.data || result.data || []).map((c: any) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt
      }));
      return { content: [{ type: "text", text: JSON.stringify({ credentials, total: credentials.length }, null, 2) }] };
    }
  );

  // ============================================
  // ZAMMAD HELPDESK TOOLS
  // ============================================

  // --- Tier 1: Essential ---

  server.tool(
    "zammad_tickets",
    "Search/list Zammad helpdesk tickets with optional filters",
    {
      query: z.string().optional().describe("Free-text search query"),
      state: z.string().optional().describe("Filter by state (e.g., 'new', 'open', 'closed')"),
      group_name: z.string().optional().describe("Filter by group name"),
      owner: z.string().optional().describe("Filter by owner (login or email)"),
      limit: z.number().optional().describe("Max results (default: 25)"),
      page: z.number().optional().describe("Page number for pagination (default: 1)")
    },
    async (args: { query?: string; state?: string; group_name?: string; owner?: string; limit?: number; page?: number }) => {
      // If query provided, use search endpoint
      if (args.query) {
        const params = new URLSearchParams();
        params.set("query", args.query);
        params.set("limit", String(args.limit || 25));
        if (args.page) params.set("page", String(args.page));
        const result = await zammadApi(`/tickets/search?${params.toString()}`);
        if (!result.success) {
          return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
        }
        const tickets = (Array.isArray(result.data) ? result.data : result.data?.assets?.Ticket ? Object.values(result.data.assets.Ticket) : []).map((t: any) => ({
          id: t.id, number: t.number, title: t.title,
          state: t.state, group: t.group, owner: t.owner,
          customer: t.customer, priority: t.priority,
          created_at: t.created_at, updated_at: t.updated_at
        }));
        return { content: [{ type: "text", text: JSON.stringify({ tickets, total: tickets.length }, null, 2) }] };
      }

      // Otherwise list with filters
      const params = new URLSearchParams();
      params.set("per_page", String(args.limit || 25));
      if (args.page) params.set("page", String(args.page));
      const result = await zammadApi(`/tickets?${params.toString()}`);
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }
      let tickets = (Array.isArray(result.data) ? result.data : []).map((t: any) => ({
        id: t.id, number: t.number, title: t.title,
        state: t.state, group: t.group, owner: t.owner,
        customer: t.customer, priority: t.priority,
        created_at: t.created_at, updated_at: t.updated_at
      }));
      // Client-side filtering (Zammad list API has limited filter support)
      if (args.state) tickets = tickets.filter((t: any) => t.state?.toLowerCase() === args.state!.toLowerCase());
      if (args.group_name) tickets = tickets.filter((t: any) => t.group?.toLowerCase() === args.group_name!.toLowerCase());
      if (args.owner) tickets = tickets.filter((t: any) => t.owner?.toLowerCase().includes(args.owner!.toLowerCase()));
      return { content: [{ type: "text", text: JSON.stringify({ tickets, total: tickets.length }, null, 2) }] };
    }
  );

  server.tool(
    "zammad_ticket",
    "Get detailed information about a specific Zammad ticket including all articles/messages",
    {
      id: z.number().describe("Ticket ID")
    },
    async (args: { id: number }) => {
      // Fetch ticket and articles in parallel
      const [ticketResult, articlesResult] = await Promise.all([
        zammadApi(`/tickets/${args.id}`),
        zammadApi(`/ticket_articles/by_ticket/${args.id}`)
      ]);
      if (!ticketResult.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: ticketResult.error }) }] };
      }
      const ticket = ticketResult.data;
      const articles = articlesResult.success ? (Array.isArray(articlesResult.data) ? articlesResult.data : []).map((a: any) => ({
        id: a.id, type: a.type, sender: a.sender, from: a.from, to: a.to,
        subject: a.subject, body: a.body, internal: a.internal,
        created_at: a.created_at, updated_at: a.updated_at,
        created_by: a.created_by
      })) : [];
      return { content: [{ type: "text", text: JSON.stringify({
        id: ticket.id, number: ticket.number, title: ticket.title,
        state: ticket.state, group: ticket.group, owner: ticket.owner,
        customer: ticket.customer, organization: ticket.organization,
        priority: ticket.priority, note: ticket.note,
        first_response_at: ticket.first_response_at,
        close_at: ticket.close_at,
        created_at: ticket.created_at, updated_at: ticket.updated_at,
        tags: ticket.tags,
        article_count: articles.length,
        articles
      }, null, 2) }] };
    }
  );

  server.tool(
    "zammad_create_ticket",
    "Create a new Zammad helpdesk ticket. Note: new tickets are automatically analyzed by AI and synced to ERPNext via n8n workflows.",
    {
      title: z.string().describe("Ticket title/subject"),
      group: z.string().optional().describe("Group/queue name (default: 'Users')"),
      customer: z.string().optional().describe("Customer email address"),
      body: z.string().describe("Initial article/message body"),
      type: z.enum(["note", "phone", "email"]).optional().describe("Article type (default: 'note')"),
      priority: z.string().optional().describe("Priority: '1 low', '2 normal', '3 high' (default: '2 normal')"),
      state: z.string().optional().describe("Initial state (default: 'new')"),
      owner: z.string().optional().describe("Owner login or email"),
      tags: z.string().optional().describe("Comma-separated tags to add")
    },
    async (args: { title: string; group?: string; customer?: string; body: string; type?: string; priority?: string; state?: string; owner?: string; tags?: string }) => {
      // Try n8n workflow first (handles side-effects: AI analysis, ERPNext sync, notifications)
      const n8nResult = await triggerZammadWorkflow("create_ticket", {
        title: args.title,
        group: args.group || "Users",
        customer: args.customer,
        body: args.body,
        type: args.type || "note",
        priority: args.priority || "2 normal",
        state: args.state || "new",
        owner: args.owner,
        tags: args.tags
      });
      if (n8nResult.success) {
        return { content: [{ type: "text", text: JSON.stringify(n8nResult.data, null, 2) }] };
      }
      // Fallback to direct API if n8n workflow not available
      const ticketBody: any = {
        title: args.title,
        group: args.group || "Users",
        state: args.state || "new",
        priority: args.priority || "2 normal",
        article: {
          subject: args.title,
          body: args.body,
          type: args.type || "note",
          internal: false
        }
      };
      if (args.customer) ticketBody.customer = args.customer;
      if (args.owner) ticketBody.owner = args.owner;
      if (args.tags) ticketBody.tags = args.tags;
      const result = await zammadApi("/tickets", { method: "POST", body: ticketBody, timeout: 30000 });
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ created: true, id: result.data.id, number: result.data.number, title: result.data.title, note: "Created via direct API (n8n workflow unavailable - side-effects like AI analysis may not trigger)" }, null, 2) }] };
    }
  );

  server.tool(
    "zammad_update_ticket",
    "Update a Zammad ticket (status, priority, owner, group). Changes are notified to relevant channels via n8n.",
    {
      id: z.number().describe("Ticket ID"),
      state: z.string().optional().describe("New state (e.g., 'open', 'closed', 'pending reminder')"),
      priority: z.string().optional().describe("New priority: '1 low', '2 normal', '3 high'"),
      owner: z.string().optional().describe("New owner login or email"),
      group: z.string().optional().describe("New group name"),
      title: z.string().optional().describe("New title"),
      note: z.string().optional().describe("Optional note to add with the update")
    },
    async (args: { id: number; state?: string; priority?: string; owner?: string; group?: string; title?: string; note?: string }) => {
      // Try n8n workflow first (handles notifications)
      const n8nResult = await triggerZammadWorkflow("update_ticket", args);
      if (n8nResult.success) {
        return { content: [{ type: "text", text: JSON.stringify(n8nResult.data, null, 2) }] };
      }
      // Fallback to direct API
      const body: any = {};
      if (args.state !== undefined) body.state = args.state;
      if (args.priority !== undefined) body.priority = args.priority;
      if (args.owner !== undefined) body.owner = args.owner;
      if (args.group !== undefined) body.group = args.group;
      if (args.title !== undefined) body.title = args.title;
      if (args.note !== undefined) {
        body.article = { body: args.note, type: "note", internal: true };
      }
      const result = await zammadApi(`/tickets/${args.id}`, { method: "PUT", body });
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ updated: true, id: result.data.id, state: result.data.state, priority: result.data.priority, owner: result.data.owner, note: "Updated via direct API (n8n workflow unavailable - notifications may not trigger)" }, null, 2) }] };
    }
  );

  server.tool(
    "zammad_add_article",
    "Add a note, reply, or phone note to a Zammad ticket. Tip: prefix body with '@ticket' to automatically create a Redmine issue via n8n workflow.",
    {
      ticket_id: z.number().describe("Ticket ID to add the article to"),
      body: z.string().describe("Article body text. Prefix with '@ticket' to trigger Redmine sync."),
      type: z.enum(["note", "phone", "email"]).optional().describe("Article type (default: 'note')"),
      internal: z.boolean().optional().describe("Internal note (not visible to customer, default: true)"),
      subject: z.string().optional().describe("Article subject (optional)"),
      to: z.string().optional().describe("Recipient email (required for type 'email')")
    },
    async (args: { ticket_id: number; body: string; type?: string; internal?: boolean; subject?: string; to?: string }) => {
      // Try n8n workflow first (handles @ticket→Redmine logic + notifications)
      const n8nResult = await triggerZammadWorkflow("add_article", args);
      if (n8nResult.success) {
        return { content: [{ type: "text", text: JSON.stringify(n8nResult.data, null, 2) }] };
      }
      // Fallback to direct API
      const articleBody: any = {
        ticket_id: args.ticket_id,
        body: args.body,
        type: args.type || "note",
        internal: args.internal !== undefined ? args.internal : true
      };
      if (args.subject) articleBody.subject = args.subject;
      if (args.to) articleBody.to = args.to;
      const result = await zammadApi("/ticket_articles", { method: "POST", body: articleBody });
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ created: true, article_id: result.data.id, ticket_id: args.ticket_id, note: "Created via direct API (n8n workflow unavailable - @ticket Redmine sync may not trigger)" }, null, 2) }] };
    }
  );

  server.tool(
    "zammad_search",
    "Full-text search across Zammad tickets, users, and organizations",
    {
      query: z.string().describe("Search query (supports Zammad search syntax)"),
      limit: z.number().optional().describe("Max results (default: 25)")
    },
    async (args: { query: string; limit?: number }) => {
      const params = new URLSearchParams();
      params.set("query", args.query);
      params.set("limit", String(args.limit || 25));
      const result = await zammadApi(`/search?${params.toString()}`);
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  // --- Tier 2: Context & Intelligence ---

  server.tool(
    "zammad_ticket_overview",
    "Get a helpdesk dashboard with open tickets per group/state/priority, unassigned tickets, and recent activity",
    {},
    async () => {
      // Fetch multiple data points in parallel
      const [ticketsResult, groupsResult, statesResult] = await Promise.all([
        zammadApi("/tickets/search?query=state:open OR state:new OR state:pending*&limit=200"),
        zammadApi("/groups"),
        zammadApi("/ticket_states")
      ]);
      if (!ticketsResult.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: ticketsResult.error }) }] };
      }
      const tickets = Array.isArray(ticketsResult.data) ? ticketsResult.data : [];

      // Aggregate by group
      const byGroup: Record<string, number> = {};
      const byState: Record<string, number> = {};
      const byPriority: Record<string, number> = {};
      const unassigned: any[] = [];

      for (const t of tickets) {
        const group = t.group || "Unknown";
        const state = t.state || "Unknown";
        const priority = t.priority || "Unknown";
        byGroup[group] = (byGroup[group] || 0) + 1;
        byState[state] = (byState[state] || 0) + 1;
        byPriority[priority] = (byPriority[priority] || 0) + 1;
        if (!t.owner || t.owner === "-") {
          unassigned.push({ id: t.id, number: t.number, title: t.title, group: t.group, priority: t.priority, created_at: t.created_at });
        }
      }

      // Sort by most recent
      const recent = [...tickets]
        .sort((a: any, b: any) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
        .slice(0, 10)
        .map((t: any) => ({ id: t.id, number: t.number, title: t.title, state: t.state, group: t.group, owner: t.owner, updated_at: t.updated_at }));

      return { content: [{ type: "text", text: JSON.stringify({
        total_open: tickets.length,
        by_group: byGroup,
        by_state: byState,
        by_priority: byPriority,
        unassigned: { count: unassigned.length, tickets: unassigned.slice(0, 10) },
        recently_updated: recent
      }, null, 2) }] };
    }
  );

  server.tool(
    "zammad_users",
    "List or search Zammad users (customers, agents, admins)",
    {
      query: z.string().optional().describe("Search query (name, email, login)"),
      limit: z.number().optional().describe("Max results (default: 25)")
    },
    async (args: { query?: string; limit?: number }) => {
      let result;
      if (args.query) {
        const params = new URLSearchParams();
        params.set("query", args.query);
        params.set("limit", String(args.limit || 25));
        result = await zammadApi(`/users/search?${params.toString()}`);
      } else {
        result = await zammadApi(`/users?per_page=${args.limit || 25}`);
      }
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }
      const users = (Array.isArray(result.data) ? result.data : []).map((u: any) => ({
        id: u.id, login: u.login, firstname: u.firstname, lastname: u.lastname,
        email: u.email, organization: u.organization, role_ids: u.role_ids,
        active: u.active, verified: u.verified
      }));
      return { content: [{ type: "text", text: JSON.stringify({ users, total: users.length }, null, 2) }] };
    }
  );

  server.tool(
    "zammad_user",
    "Get detailed information about a specific Zammad user",
    {
      id: z.number().describe("User ID")
    },
    async (args: { id: number }) => {
      const result = await zammadApi(`/users/${args.id}`);
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "zammad_organizations",
    "List or search Zammad organizations",
    {
      query: z.string().optional().describe("Search query"),
      limit: z.number().optional().describe("Max results (default: 25)")
    },
    async (args: { query?: string; limit?: number }) => {
      let result;
      if (args.query) {
        const params = new URLSearchParams();
        params.set("query", args.query);
        params.set("limit", String(args.limit || 25));
        result = await zammadApi(`/organizations/search?${params.toString()}`);
      } else {
        result = await zammadApi(`/organizations?per_page=${args.limit || 25}`);
      }
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }
      const orgs = (Array.isArray(result.data) ? result.data : []).map((o: any) => ({
        id: o.id, name: o.name, shared: o.shared, domain: o.domain,
        domain_assignment: o.domain_assignment, active: o.active, note: o.note,
        member_ids: o.member_ids
      }));
      return { content: [{ type: "text", text: JSON.stringify({ organizations: orgs, total: orgs.length }, null, 2) }] };
    }
  );

  server.tool(
    "zammad_ticket_history",
    "Get the audit trail / change history of a Zammad ticket",
    {
      id: z.number().describe("Ticket ID")
    },
    async (args: { id: number }) => {
      const result = await zammadApi(`/ticket_history/${args.id}`);
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  // --- Tier 3: Workflow & Metadata ---

  server.tool(
    "zammad_tags",
    "Manage tags on a Zammad ticket (list, add, remove). Adding tag 'mattermost' triggers an automatic Mattermost post via n8n workflow.",
    {
      ticket_id: z.number().describe("Ticket ID"),
      action: z.enum(["list", "add", "remove"]).describe("Action: list, add, or remove tags"),
      tag: z.string().optional().describe("Tag name (required for add/remove)")
    },
    async (args: { ticket_id: number; action: string; tag?: string }) => {
      if (args.action === "list") {
        const result = await zammadApi(`/tags?object=Ticket&o_id=${args.ticket_id}`);
        if (!result.success) {
          return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
      }
      if (!args.tag) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Tag name required for add/remove action" }) }] };
      }
      if (args.action === "add") {
        // Try n8n workflow for add (handles mattermost tag → post logic)
        const n8nResult = await triggerZammadWorkflow("manage_tags", { ticket_id: args.ticket_id, action: "add", tag: args.tag });
        if (n8nResult.success) {
          return { content: [{ type: "text", text: JSON.stringify(n8nResult.data, null, 2) }] };
        }
        // Fallback to direct API
        const result = await zammadApi("/tags/add", { method: "POST", body: { object: "Ticket", o_id: args.ticket_id, item: args.tag } });
        if (!result.success) {
          return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify({ added: true, ticket_id: args.ticket_id, tag: args.tag, note: "Added via direct API (n8n workflow unavailable - mattermost tag may not trigger notification)" }, null, 2) }] };
      }
      if (args.action === "remove") {
        const result = await zammadApi("/tags/remove", { method: "DELETE", body: { object: "Ticket", o_id: args.ticket_id, item: args.tag } });
        if (!result.success) {
          return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify({ removed: true, ticket_id: args.ticket_id, tag: args.tag }, null, 2) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown action: ${args.action}` }) }] };
    }
  );

  server.tool(
    "zammad_groups",
    "List all Zammad helpdesk groups/queues",
    {},
    async () => {
      const result = await zammadApi("/groups");
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }
      const groups = (Array.isArray(result.data) ? result.data : []).map((g: any) => ({
        id: g.id, name: g.name, active: g.active, note: g.note
      }));
      return { content: [{ type: "text", text: JSON.stringify({ groups, total: groups.length }, null, 2) }] };
    }
  );

  server.tool(
    "zammad_states",
    "List all Zammad ticket states",
    {},
    async () => {
      const result = await zammadApi("/ticket_states");
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }
      const states = (Array.isArray(result.data) ? result.data : []).map((s: any) => ({
        id: s.id, name: s.name, state_type: s.state_type, active: s.active,
        next_state: s.next_state, ignore_escalation: s.ignore_escalation
      }));
      return { content: [{ type: "text", text: JSON.stringify({ states, total: states.length }, null, 2) }] };
    }
  );

  server.tool(
    "zammad_priorities",
    "List all Zammad ticket priorities",
    {},
    async () => {
      const result = await zammadApi("/ticket_priorities");
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
      }
      const priorities = (Array.isArray(result.data) ? result.data : []).map((p: any) => ({
        id: p.id, name: p.name, default_create: p.default_create, active: p.active, note: p.note
      }));
      return { content: [{ type: "text", text: JSON.stringify({ priorities, total: priorities.length }, null, 2) }] };
    }
  );

  // ============================================
  // DEVELOPER TOOLS
  // ============================================

  server.tool(
    "developer_hook_setup",
    "Get Claude Code hook template for ticket validation. Use mode='help' (default) to see what this does, mode='full' to get the complete setup files.",
    {
      mode: z.enum(["help", "full"]).optional().describe("help = uitleg wat dit doet (default), full = complete setup met bestanden")
    },
    async (args: { mode?: "help" | "full" }) => {
      const mode = args.mode || "help";
      const fs = require("fs");
      const path = require("path");

      // Help mode: explain what this tool does
      if (mode === "help") {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              tool: "developer_hook_setup",
              description: "Setup Claude Code hook voor git commit ticket validatie",
              what_it_does: [
                "Blokkeert git commits ZONDER ticket referentie (#123)",
                "Hook draait VOOR git - Claude ziet directe feedback",
                "Claude corrigeert zichzelf door ticket toe te voegen",
                "Werkt met Redmine tickets via mcp__mcp-server__redmine_create_ticket"
              ],
              files_created: [
                ".claude/hooks/validate-git-commit.sh - het hook script",
                ".claude/settings.json - Claude Code configuratie (merge met bestaand)"
              ],
              how_it_works: {
                "1": "Claude probeert: git commit -m 'fix bug'",
                "2": "Hook checkt op #[0-9]+ pattern",
                "3": "Geen ticket → exit 2 → BLOCK met error",
                "4": "Claude ziet: 'COMMIT BLOCKED: Geen ticket referentie!'",
                "5": "Claude corrigeert: git commit -m 'fix bug (#123)'"
              },
              next_step: "Roep deze tool aan met mode='full' voor de complete setup bestanden",
              usage: "mcp__mcp-server__developer_hook_setup met mode='full'"
            }, null, 2)
          }]
        };
      }

      // Full mode: return complete setup files
      // Resolve hook paths from runtime roots instead of build-time __dirname.
      const runtimeRoots = [PROJECT_DIR];

      const possiblePaths = runtimeRoots.map((root) =>
        path.join(root, ".claude/hooks/validate-git-commit.sh")
      );

      let hookScript = "";
      let foundPath = "";
      for (const p of possiblePaths) {
        try {
          hookScript = fs.readFileSync(p, "utf-8");
          foundPath = p;
          break;
        } catch (e) {
          // Try next path
        }
      }

      if (!hookScript) {
        // Fallback: embedded script
        hookScript = `#!/usr/bin/env bash
#
# Claude Code Hook: Valideer git commit op ticket referentie
#
# Blokkeert git commits ZONDER #TICKET referentie
# Exit code 2 = BLOCK (toont error aan Claude)
#
set -e

# Read JSON input from stdin
INPUT=$(cat)

# Extract tool info
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

# Alleen git commit commands controleren
if [[ "$TOOL_NAME" != "Bash" ]]; then
    exit 0
fi

# Check of het een git commit is
if [[ ! "$COMMAND" =~ git[[:space:]]+commit ]]; then
    exit 0
fi

# Skip als het een amend is van een eerdere commit (die al ticket had)
if [[ "$COMMAND" =~ --amend ]]; then
    exit 0
fi

# Ticket pattern: #123, (#456), fixes #789
TICKET_PATTERN='#[0-9]+'

# Controleer of ticket in command staat
if echo "$COMMAND" | grep -qE "$TICKET_PATTERN"; then
    exit 0  # Ticket gevonden, doorgaan
fi

# BLOCK: Geen ticket gevonden
cat >&2 << 'EOF'

╔══════════════════════════════════════════════════════════════╗
║  COMMIT BLOCKED: Geen ticket referentie gevonden!            ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Elke commit MOET een ticket referentie bevatten.            ║
║                                                              ║
║  Formaat: git commit -m "beschrijving (#TICKET)"             ║
║                                                              ║
║  Geen ticket? Maak er eerst een aan:                         ║
║  → Gebruik: mcp__mcp-server__redmine_create_ticket                  ║
║  → Of: just ticket create "Subject" --tracker=X --epic=Y     ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝

EOF

exit 2
`;
      }

      const settingsSnippet = {
        hooks: {
          PreToolUse: [{
            matcher: "Bash",
            hooks: [{
              type: "command",
              command: ".claude/hooks/validate-git-commit.sh",
              timeout: 5
            }]
          }]
        }
      };

      const instructions = `
# Claude Code Hook Setup voor Ticket Validation

Dit zorgt ervoor dat Claude Code git commits blokkeert zonder ticket referentie (#123).

## Stap 1: Maak hook directory
\`\`\`bash
mkdir -p .claude/hooks
\`\`\`

## Stap 2: Maak hook script
Sla het script op als \`.claude/hooks/validate-git-commit.sh\`
(zie hook_script veld hieronder)

## Stap 3: Maak executable
\`\`\`bash
chmod +x .claude/hooks/validate-git-commit.sh
\`\`\`

## Stap 4: Update .claude/settings.json
Voeg het hooks object toe aan je settings.json (of maak het bestand aan).
Merge met bestaande settings als het bestand al bestaat.

## Hoe het werkt
1. Claude probeert \`git commit\` via Bash tool
2. Claude Code draait hook VOORDAT git het ziet
3. Hook checkt op #[0-9]+ pattern
4. Zonder ticket: exit 2 = BLOCK met foutmelding
5. Claude corrigeert zichzelf door ticket toe te voegen

## Tickets maken via MCP
Gebruik: mcp__mcp-server__redmine_create_ticket
`;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            mode: "full",
            instructions,
            hook_script: hookScript,
            hook_script_source: foundPath || "embedded fallback",
            settings_snippet: settingsSnippet,
            files_to_create: [
              {
                path: ".claude/hooks/validate-git-commit.sh",
                content: hookScript,
                executable: true,
                description: "Hook script dat git commits valideert op ticket referentie"
              },
              {
                path: ".claude/settings.json",
                action: "merge with existing or create new",
                snippet: settingsSnippet,
                description: "Claude Code configuratie - voeg hooks sectie toe"
              }
            ],
            quick_setup: [
              "mkdir -p .claude/hooks",
              "# Schrijf hook_script naar .claude/hooks/validate-git-commit.sh",
              "chmod +x .claude/hooks/validate-git-commit.sh",
              "# Merge settings_snippet in .claude/settings.json"
            ]
          }, null, 2)
        }]
      };
    }
  );

  // ============================================
  // MCP INTROSPECTION TOOLS
  // ============================================

  // Server start time for uptime calculation
  const serverStartTime = Date.now();

  // Tool registry for introspection
  const TOOL_REGISTRY = [
    // Package tools
    { name: "package_list", category: "packages", permission: "read", description: "List all available packages with their status" },
    { name: "package_info", category: "packages", permission: "read", description: "Get detailed information about a specific package" },
    { name: "package_search", category: "packages", permission: "read", description: "Search packages by query string" },
    // Command discovery tools
    { name: "command_list", category: "commands", permission: "read", description: "List available just commands from the contract" },
    { name: "command_search", category: "commands", permission: "read", description: "Search commands by name or description" },
    { name: "command_modules", category: "commands", permission: "read", description: "List available command modules with counts" },
    // Service tools
    { name: "service_status", category: "services", permission: "read", description: "Get the status of a running service" },
    { name: "service_health", category: "services", permission: "read", description: "Run health check on a service" },
    { name: "service_logs", category: "services", permission: "read", description: "Get recent logs from a service" },
    { name: "ecosystem_health", category: "services", permission: "read", description: "Get overall ecosystem health summary" },
    // Redmine tools
    { name: "redmine_epics", category: "redmine", permission: "read", description: "List all epics from Redmine" },
    { name: "redmine_issues", category: "redmine", permission: "read", description: "Search issues in Redmine" },
    { name: "redmine_issue", category: "redmine", permission: "read", description: "Get detailed information about a specific issue" },
    { name: "redmine_create_ticket", category: "redmine", permission: "write", description: "Create a new ticket in Redmine" },
    { name: "redmine_update_ticket", category: "redmine", permission: "write", description: "Update an existing ticket" },
    { name: "redmine_close_ticket", category: "redmine", permission: "write", description: "Close a ticket" },
    { name: "redmine_reopen_ticket", category: "redmine", permission: "write", description: "Reopen a closed ticket" },
    { name: "redmine_add_note", category: "redmine", permission: "write", description: "Add a note to a ticket" },
    { name: "redmine_attach_file", category: "redmine", permission: "write", description: "Upload and attach a file to a Redmine ticket" },
    // Email tools
    { name: "email_send", category: "email", permission: "write", description: "Send email notification" },
    { name: "email_health", category: "email", permission: "read", description: "Check email infrastructure health" },
    { name: "email_test", category: "email", permission: "write", description: "Send test email to verify configuration" },
    { name: "email_logs", category: "email", permission: "read", description: "View recent email logs from Postal SMTP" },
    // n8n workflow tools
    { name: "n8n_list_workflows", category: "n8n", permission: "read", description: "List all n8n workflows with status" },
    { name: "n8n_get_workflow", category: "n8n", permission: "read", description: "Get detailed workflow information" },
    { name: "n8n_trigger_workflow", category: "n8n", permission: "write", description: "Manually trigger a workflow" },
    { name: "n8n_workflow_executions", category: "n8n", permission: "read", description: "List recent workflow executions" },
    { name: "n8n_create_workflow", category: "n8n", permission: "write", description: "Create a new workflow" },
    { name: "n8n_update_workflow", category: "n8n", permission: "write", description: "Update an existing workflow" },
    { name: "n8n_delete_workflow", category: "n8n", permission: "admin", description: "Delete a workflow (destructive)" },
    { name: "n8n_activate_workflow", category: "n8n", permission: "write", description: "Activate a workflow" },
    { name: "n8n_deactivate_workflow", category: "n8n", permission: "write", description: "Deactivate a workflow" },
    { name: "n8n_execution_details", category: "n8n", permission: "read", description: "Get full execution details per node" },
    { name: "n8n_delete_execution", category: "n8n", permission: "admin", description: "Delete an execution record (destructive)" },
    { name: "n8n_list_credentials", category: "n8n", permission: "read", description: "List available credentials (no secrets)" },
    // Zammad helpdesk tools
    { name: "zammad_tickets", category: "zammad", permission: "read", description: "Search/list helpdesk tickets" },
    { name: "zammad_ticket", category: "zammad", permission: "read", description: "Get ticket details with articles" },
    { name: "zammad_create_ticket", category: "zammad", permission: "write", description: "Create a new helpdesk ticket" },
    { name: "zammad_update_ticket", category: "zammad", permission: "write", description: "Update a helpdesk ticket" },
    { name: "zammad_add_article", category: "zammad", permission: "write", description: "Add note/reply to a ticket" },
    { name: "zammad_search", category: "zammad", permission: "read", description: "Full-text search across tickets, users, organizations" },
    { name: "zammad_ticket_overview", category: "zammad", permission: "read", description: "Helpdesk dashboard overview" },
    { name: "zammad_users", category: "zammad", permission: "read", description: "List/search helpdesk users" },
    { name: "zammad_user", category: "zammad", permission: "read", description: "Get user details" },
    { name: "zammad_organizations", category: "zammad", permission: "read", description: "List/search organizations" },
    { name: "zammad_ticket_history", category: "zammad", permission: "read", description: "Get ticket change history" },
    { name: "zammad_tags", category: "zammad", permission: "write", description: "Manage ticket tags (list/add/remove)" },
    { name: "zammad_groups", category: "zammad", permission: "read", description: "List helpdesk groups/queues" },
    { name: "zammad_states", category: "zammad", permission: "read", description: "List ticket states" },
    { name: "zammad_priorities", category: "zammad", permission: "read", description: "List ticket priorities" },
    // Developer tools
    { name: "developer_hook_setup", category: "developer", permission: "read", description: "Get Claude Code hook template for ticket validation" },
    // Introspection tools (self-referential)
    { name: "mcp_info", category: "introspection", permission: "read", description: "Get MCP server metadata and status" },
    { name: "mcp_tools", category: "introspection", permission: "read", description: "List all available MCP tools" },
  ].filter((tool) => isListed(tool.name, CAPS));

  server.tool(
    "mcp_info",
    "Get MCP server metadata and status",
    {},
    async () => {
      const uptimeMs = Date.now() - serverStartTime;
      const uptimeSeconds = Math.floor(uptimeMs / 1000);
      const uptimeMinutes = Math.floor(uptimeSeconds / 60);
      const uptimeHours = Math.floor(uptimeMinutes / 60);

      let uptimeString = "";
      if (uptimeHours > 0) {
        uptimeString = `${uptimeHours}h ${uptimeMinutes % 60}m`;
      } else if (uptimeMinutes > 0) {
        uptimeString = `${uptimeMinutes}m ${uptimeSeconds % 60}s`;
      } else {
        uptimeString = `${uptimeSeconds}s`;
      }

      // Count tools by category
      const categoryCount: Record<string, number> = {};
      for (const tool of TOOL_REGISTRY) {
        categoryCount[tool.category] = (categoryCount[tool.category] || 0) + 1;
      }

      const info = {
        server: "mcp-server",
        name: "MCP Server",
        version: CLIENT_VERSION,
        description: "Model Context Protocol server: tools for the apps of this project",
        connected: CAPS,
        uptime: uptimeString,
        uptime_ms: uptimeMs,
        tools_count: TOOL_REGISTRY.length,
        tools_by_category: categoryCount,
        auth: OAUTH_ENABLED ? "oauth2" : "api_key",
        endpoints: {
          mcp: "/mcp",
          health: "/health",
          oauth_login: OAUTH_ENABLED ? "/setup" : null
        }
      };

      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    }
  );

  server.tool(
    "mcp_tools",
    "List all available MCP tools",
    {
      category: z.string().optional().describe("Filter by category (packages, commands, services, redmine, email, n8n, developer, introspection)")
    },
    async (args: { category?: string }) => {
      let tools = TOOL_REGISTRY;

      if (args.category) {
        tools = tools.filter(t => t.category === args.category);
      }

      // Group by category for better readability
      const grouped: Record<string, typeof tools> = {};
      for (const tool of tools) {
        if (!grouped[tool.category]) {
          grouped[tool.category] = [];
        }
        grouped[tool.category].push(tool);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            tools: tools.map(t => ({ name: t.name, category: t.category, permission: t.permission, description: t.description })),
            total: tools.length,
            categories: Object.keys(grouped),
            by_category: grouped
          }, null, 2)
        }]
      };
    }
  );

  return server;
}

// HTTP Server with API Key auth
async function startServer() {
  console.log("🚀 Starting MCP Server...");

  // Start HTTP server with auth middleware
  const http = await import("http");
  const url = await import("url");

  // The pages around the MCP endpoint: landing page, /health, /version, /api-key,
  // the sign-in that hands a person a key of their own, and the client downloads.
  // The OAuth 2.1 surface and /mcp are handled by the Express app below, which
  // falls through to this for everything else.
  const legacyDispatch = async (req: any, res: any) => {
    // CORS headers (the edge sets them too; kept here for a server reached without one)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    const parsedUrl = url.parse(req.url || "", true);

    // Landing page (no auth) - help/getting started
    if (parsedUrl.pathname === "/" || parsedUrl.pathname === "") {
      const baseUrl = getBaseUrl(req);

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MCP Server</title>
  <style>
    :root { --primary: #1976d2; --success: #2e7d32; --bg: #f5f7fa; --card: #ffffff; --text: #333; --code-bg: #263238; --code: #4fc3f7; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 20px; background: var(--bg); color: var(--text); line-height: 1.6; }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { color: var(--primary); margin-bottom: 10px; }
    .subtitle { color: #666; margin-bottom: 30px; font-size: 1.1em; }
    .card { background: var(--card); border-radius: 12px; padding: 25px; margin-bottom: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .card h2 { margin-top: 0; color: var(--primary); border-bottom: 2px solid #e0e0e0; padding-bottom: 10px; }
    .code-block { background: var(--code-bg); color: var(--code); padding: 15px 20px; border-radius: 8px; font-family: 'Fira Code', 'Consolas', monospace; font-size: 14px; overflow-x: auto; margin: 15px 0; position: relative; }
    .code-block::before { content: attr(data-lang); position: absolute; top: 8px; right: 12px; font-size: 11px; color: #78909c; text-transform: uppercase; }
    .code-block code { color: inherit; }
    .copy-btn { position: absolute; top: 8px; right: 60px; background: #37474f; border: none; color: #90a4ae; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
    .copy-btn:hover { background: #455a64; color: #fff; }
    .tabs { display: flex; gap: 10px; margin-bottom: -1px; }
    .tab { padding: 10px 20px; background: #e0e0e0; border: none; border-radius: 8px 8px 0 0; cursor: pointer; font-size: 14px; font-weight: 500; }
    .tab.active { background: var(--code-bg); color: var(--code); }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .endpoint { display: flex; align-items: center; padding: 12px 0; border-bottom: 1px solid #eee; }
    .endpoint:last-child { border-bottom: none; }
    .endpoint .method { background: var(--success); color: white; padding: 4px 10px; border-radius: 4px; font-weight: 600; font-size: 12px; margin-right: 15px; min-width: 50px; text-align: center; }
    .endpoint .path { font-family: monospace; color: var(--primary); flex: 1; text-decoration: none; }
    a.path:hover { text-decoration: underline; background: #e3f2fd; padding: 2px 6px; margin: -2px -6px; border-radius: 4px; }
    .endpoint .desc { color: #666; font-size: 14px; }
    .status { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 20px; font-weight: 500; }
    .status.healthy { background: #e8f5e9; color: var(--success); }
    .feature-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-top: 15px; }
    .feature { background: #f8f9fa; padding: 15px; border-radius: 8px; }
    .feature h4 { margin: 0 0 8px 0; color: var(--primary); }
    .feature p { margin: 0; font-size: 14px; color: #666; }
    a { color: var(--primary); }
    footer { text-align: center; margin-top: 40px; color: #999; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔌 MCP Server</h1>
    <p class="subtitle">Model Context Protocol server voor AI agent toegang tot de apps van dit project</p>

    <div class="card">
      <h2>🚀 Aan de slag</h2>
      <p>Kies je platform:</p>

      <div class="tabs">
        <button class="tab active" onclick="showTab('claude')">🤖 Claude Desktop</button>
        <button class="tab" onclick="showTab('terminal')">💻 Terminal (CLI)</button>
      </div>

      <div id="claude" class="tab-content active">
        <p style="margin-bottom:15px">De snelste manier - geen installatie nodig!</p>
        <div style="background:linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding:25px; border-radius:12px; text-align:center;">
          <p style="color:white; margin:0 0 15px; font-size:16px;">Configureer Claude Desktop in 1 klik</p>
          <a href="${baseUrl}/setup" style="display:inline-block; padding:12px 30px; background:white; color:#667eea; border-radius:8px; text-decoration:none; font-weight:bold; font-size:15px;">🚀 Start Setup</a>
        </div>
        <p style="margin-top:15px; color:#666; font-size:13px; text-align:center;">Login via browser → API key wordt gegenereerd → Download config</p>
      </div>

      <div id="terminal" class="tab-content">
        <p style="margin-bottom:10px"><strong>Linux / macOS / WSL:</strong></p>
        <div class="code-block" data-lang="bash">
          <button class="copy-btn" onclick="copyCode(this)">Copy</button>
          <code>curl -sL ${baseUrl}/install | bash</code>
        </div>
        <p style="margin-top:15px; margin-bottom:10px"><strong>Windows PowerShell:</strong></p>
        <div class="code-block" data-lang="powershell">
          <button class="copy-btn" onclick="copyCode(this)">Copy</button>
          <code>iex (iwr ${baseUrl}/install).Content</code>
        </div>
        <p style="margin-top:15px; color:#666; font-size:13px">Detecteert automatisch je platform en start login.</p>
      </div>
    </div>

    <div class="card">
      <h2>📡 API Endpoints</h2>
      <div class="endpoint"><span class="method">GET</span><a href="${baseUrl}/health" class="path">/health</a><span class="desc">Server health check</span></div>
      <div class="endpoint"><span class="method">GET</span><a href="${baseUrl}/version" class="path">/version</a><span class="desc">Server & client versie info</span></div>
      <div class="endpoint"><span class="method">GET</span><a href="${baseUrl}/install" class="path">/install</a><span class="desc">Universal installer (auto-detect via User-Agent)</span></div>
      <div class="endpoint"><span class="method">GET</span><a href="${baseUrl}/install.ps1" class="path">/install.ps1</a><span class="desc">Explicit PowerShell installer</span></div>
      <div class="endpoint"><span class="method">GET</span><a href="${baseUrl}/client.sh" class="path">/client.sh</a><span class="desc">Bash client download</span></div>
      <div class="endpoint"><span class="method">GET</span><a href="${baseUrl}/client.ps1" class="path">/client.ps1</a><span class="desc">PowerShell client download</span></div>
      <div class="endpoint"><span class="method">GET</span><a href="${baseUrl}/setup" class="path">/setup</a><span class="desc">Claude Desktop setup wizard (1-click)</span></div>
      <div class="endpoint"><span class="method">GET</span><a href="${baseUrl}/claude-config" class="path">/claude-config</a><span class="desc">Claude Desktop config (zonder API key)</span></div>
      <div class="endpoint"><span class="method">GET</span><a href="${baseUrl}/oauth/config" class="path">/oauth/config</a><span class="desc">OAuth2 instellingen voor ontwikkelaars</span></div>
      <div class="endpoint"><span class="method">POST</span><a href="${baseUrl}/api-key" class="path">/api-key</a><span class="desc">Genereer permanente API key</span></div>
      <div class="endpoint"><span class="method">POST</span><a href="${baseUrl}/mcp" class="path">/mcp</a><span class="desc">MCP API documentatie & endpoint</span></div>
    </div>

    <div class="card">
      <h2>🛠️ Beschikbare Tools</h2>
      <div class="feature-grid">
        <div class="feature"><h4>📦 Packages</h4><p>List, search en info over alle packages</p></div>
        <div class="feature"><h4>🔍 Services</h4><p>Status, health checks en logs van draaiende services</p></div>
        <div class="feature"><h4>🎯 Ecosystem</h4><p>Overall health en overzicht van het hele systeem</p></div>
        <div class="feature"><h4>🎫 Redmine</h4><p>Epics, issues en ticket management</p></div>
      </div>
    </div>

    <footer>
      <span class="status healthy">● Server Healthy</span>
      <p>MCP Server v1.0.0 | Client v${CLIENT_VERSION}</p>
    </footer>
  </div>

  <script>
    function showTab(id) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.getElementById(id).classList.add('active');
      event.target.classList.add('active');
    }
    function copyCode(btn) {
      const code = btn.parentElement.querySelector('code').innerText;
      navigator.clipboard.writeText(code);
      btn.innerText = '✓ Copied';
      setTimeout(() => btn.innerText = 'Copy', 2000);
    }
  </script>
</body>
</html>`);
      return;
    }

    // PowerShell client download (no auth)
    if (parsedUrl.pathname === "/client" || parsedUrl.pathname === "/client.ps1") {
      try {
        const fs = await import("fs/promises");
        const path = await import("path");
        const scriptPath = path.join(process.cwd(), "mcp-client.ps1");
        const script = await fs.readFile(scriptPath, "utf-8");
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": "attachment; filename=mcp-client.ps1"
        });
        res.end(script);
      } catch (err) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Client script not found" }));
      }
      return;
    }

    // Universal installer script (no auth) - auto-detects PowerShell vs bash
    if (parsedUrl.pathname === "/install") {
      const baseUrl = getBaseUrl(req);

      // Detect PowerShell from User-Agent
      const userAgent = req.headers["user-agent"] || "";
      const isPowerShell = userAgent.toLowerCase().includes("powershell");

      if (isPowerShell) {
        // Return PowerShell script
        const psScript = `#
# MCP Client - Universal Installer (PowerShell)
# Automatisch gedetecteerd via User-Agent
#

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "╔════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║           MCP Client - Universal Installer             ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Detect WSL
if ($env:WSL_DISTRO_NAME) {
    Write-Host "  Platform: WSL ($env:WSL_DISTRO_NAME)" -ForegroundColor Green
    Write-Host ""
    Write-Host "  WSL gedetecteerd - gebruik bash:" -ForegroundColor Yellow
    Write-Host "  curl -sL ${baseUrl}/install | bash" -ForegroundColor Cyan
    Write-Host ""
    exit 0
}

Write-Host "  Platform: windows" -ForegroundColor Green

# Check for jq
if (-not (Get-Command jq -ErrorAction SilentlyContinue)) {
    Write-Host "  Warning: jq niet gevonden" -ForegroundColor Yellow
    Write-Host "  Installeer: winget install jqlang.jq"
}

Write-Host ""
Write-Host "  Downloaden..." -ForegroundColor Cyan

try {
    Invoke-WebRequest -Uri "${baseUrl}/client.ps1" -OutFile "mcp-client.ps1" -UseBasicParsing
    Unblock-File "mcp-client.ps1"
    Write-Host "  ✓ Client gedownload: mcp-client.ps1" -ForegroundColor Green
} catch {
    Write-Host "  ✗ Download mislukt: $_" -ForegroundColor Red
    exit 1
}

Write-Host ""
& ".\\mcp-client.ps1" version
Write-Host ""
Write-Host "Login starten..." -ForegroundColor Cyan
Write-Host ""
& ".\\mcp-client.ps1" login
`;
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(psScript);
        return;
      }

      // Return bash script (default)
      const installScript = `#!/bin/bash
#
# MCP Client - Universal Installer
# Detecteert automatisch je platform en installeert de juiste client
#

set -e

# Colors
RED='\\033[0;31m'
GREEN='\\033[0;32m'
YELLOW='\\033[1;33m'
CYAN='\\033[0;36m'
NC='\\033[0m'

echo ""
echo -e "\${CYAN}╔════════════════════════════════════════════════════════════╗\${NC}"
echo -e "\${CYAN}║           MCP Client - Universal Installer             ║\${NC}"
echo -e "\${CYAN}╚════════════════════════════════════════════════════════════╝\${NC}"
echo ""

# Detect OS
OS="unknown"
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    if grep -qi microsoft /proc/version 2>/dev/null; then
        OS="wsl"
    else
        OS="linux"
    fi
elif [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then
    OS="windows"
fi

echo -e "  Platform: \${GREEN}$OS\${NC}"

# Check for curl or wget
DOWNLOADER=""
if command -v curl &> /dev/null; then
    DOWNLOADER="curl"
elif command -v wget &> /dev/null; then
    DOWNLOADER="wget"
else
    echo -e "\${RED}Error: curl of wget is vereist\${NC}"
    exit 1
fi
echo -e "  Downloader: \${GREEN}$DOWNLOADER\${NC}"

# Check for jq
if ! command -v jq &> /dev/null; then
    echo -e "\${YELLOW}Warning: jq niet gevonden - sommige features werken niet\${NC}"
    echo "  Installeer met: sudo apt install jq (Linux) of brew install jq (macOS)"
fi

# Download URL
BASE_URL="${baseUrl}"

echo ""
echo -e "  \${CYAN}Downloaden...\${NC}"

# Download bash client
if [ "$DOWNLOADER" = "curl" ]; then
    curl -sL "$BASE_URL/client.sh" -o mcp-client.sh
else
    wget -q "$BASE_URL/client.sh" -O mcp-client.sh
fi

chmod +x mcp-client.sh

echo -e "  \${GREEN}✓ Client gedownload: mcp-client.sh\${NC}"
echo ""

# Show version
./mcp-client.sh version
echo ""

# Auto-start login
echo -e "\${CYAN}Login starten...\${NC}"
echo ""
./mcp-client.sh login
`;
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8"
      });
      res.end(installScript);
      return;
    }

    // Universal PowerShell installer (no auth)
    if (parsedUrl.pathname === "/install.ps1") {
      const baseUrl = getBaseUrl(req);
      const installScript = `#
# MCP Client - Universal Installer (PowerShell)
# Detecteert automatisch je platform en installeert de juiste client
#

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "╔════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║           MCP Client - Universal Installer             ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Detect environment
$IsWSL = $false
$Platform = "windows"

if ($env:WSL_DISTRO_NAME) {
    $Platform = "wsl"
    Write-Host "  Platform: " -NoNewline
    Write-Host "WSL ($env:WSL_DISTRO_NAME)" -ForegroundColor Green
    Write-Host ""
    Write-Host "  WSL gedetecteerd - gebruik bash installer:" -ForegroundColor Yellow
    Write-Host "  curl -sL ${baseUrl}/install | bash" -ForegroundColor Cyan
    Write-Host ""
    exit 0
}

Write-Host "  Platform: " -NoNewline
Write-Host "$Platform" -ForegroundColor Green

# Check for required tools
$hasJq = $null -ne (Get-Command jq -ErrorAction SilentlyContinue)
if (-not $hasJq) {
    Write-Host "  Warning: " -NoNewline -ForegroundColor Yellow
    Write-Host "jq niet gevonden - sommige features werken niet"
    Write-Host "  Installeer met: winget install jqlang.jq"
}

Write-Host ""
Write-Host "  Downloaden..." -ForegroundColor Cyan

# Download PowerShell client
$clientUrl = "${baseUrl}/client.ps1"
$outputFile = "mcp-client.ps1"

try {
    Invoke-WebRequest -Uri $clientUrl -OutFile $outputFile -UseBasicParsing
    Unblock-File $outputFile
    Write-Host "  ✓ Client gedownload: $outputFile" -ForegroundColor Green
} catch {
    Write-Host "  ✗ Download mislukt: $_" -ForegroundColor Red
    exit 1
}

Write-Host ""

# Show version
& ".\\$outputFile" version

Write-Host ""
Write-Host "Login starten..." -ForegroundColor Cyan
Write-Host ""
& ".\\$outputFile" login
`;
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8"
      });
      res.end(installScript);
      return;
    }

    // Claude Desktop config download (no auth)
    if (parsedUrl.pathname === "/claude-config") {
      const baseUrl = getBaseUrl(req);

      const config = {
        mcpServers: {
          "mcp-server": {
            command: "npx",
            args: ["-y", "mcp-remote", `${baseUrl}/mcp`],
            env: {
              MCP_API_KEY: "VERVANG_MET_JE_API_KEY"
            }
          }
        }
      };

      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Disposition": "attachment; filename=claude_desktop_config.json"
      });
      res.end(JSON.stringify(config, null, 2));
      return;
    }

    // /oauth/login → redirect to /setup
    if (parsedUrl.pathname === "/oauth/login") {
      res.writeHead(302, { Location: "/setup" });
      res.end();
      return;
    }

    // Windows installer script - serves personalized PowerShell with API key
    if (parsedUrl.pathname === "/setup/install.ps1") {
      const token = parsedUrl.query.t as string;
      const baseUrl = getBaseUrl(req);
      const setupUrl = `${baseUrl}/setup`;
      if (!token || !setupTokens.has(token)) {
        // PowerShell: toon fout + open browser naar /setup
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`# Setup link verlopen of ongeldig.\n# Er wordt automatisch een nieuwe setup pagina geopend...\nWrite-Host "Setup link verlopen. Browser wordt geopend voor nieuwe link..." -ForegroundColor Yellow\nStart-Process "${setupUrl}"\n`);
        return;
      }
      const setup = setupTokens.get(token)!;
      if (setup.expiresAt < Date.now()) {
        setupTokens.delete(token);
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`# Setup link verlopen (30 min).\n# Er wordt automatisch een nieuwe setup pagina geopend...\nWrite-Host "Setup link verlopen. Browser wordt geopend voor nieuwe link..." -ForegroundColor Yellow\nStart-Process "${setupUrl}"\n`);
        return;
      }

      // Split JWT into 3 parts for cmd.exe safety
      const keyParts = setup.apiKey.split(".");
      const mcpUrl = `${setup.baseUrl}/mcp`;
      // Derive config name: "mcp-server", or "mcp-server-dev" for dev/localhost
      const isDev = setup.baseUrl.includes("localhost") || setup.baseUrl.includes("dev-");
      const serverName = isDev ? "mcp-server-dev" : "mcp-server";

      const ps1 = `# MCP Server - Claude Desktop Setup (${serverName})
# Gegenereerd door ${setup.baseUrl}/setup
# Dit script verloopt na 30 minuten.

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=== MCP Server - Claude Desktop Setup ===" -ForegroundColor Cyan
Write-Host ""

# 0. Sluit Claude Desktop volledig af (inclusief achtergrondprocessen)
Write-Host "[0/5] Claude Desktop afsluiten..." -ForegroundColor Yellow
$claudeProcs = Get-Process -Name "*claude*","*Claude*" -ErrorAction SilentlyContinue
if ($claudeProcs) {
    $claudeProcs | Stop-Process -Force -ErrorAction SilentlyContinue
    Write-Host "  $($claudeProcs.Count) proces(sen) gestopt, wachten..." -ForegroundColor Gray
    Start-Sleep -Seconds 3
    # Controleer of alles echt weg is
    $remaining = Get-Process -Name "*claude*","*Claude*" -ErrorAction SilentlyContinue
    if ($remaining) {
        Write-Host "  Hardnekkige processen gevonden, forceer stop..." -ForegroundColor Yellow
        $remaining | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    Write-Host "[OK] Claude Desktop afgesloten" -ForegroundColor Green
} else {
    Write-Host "[OK] Claude Desktop was niet actief" -ForegroundColor Green
}

# 1. Check/install Node.js
$hasNode = $false
try { $null = node --version 2>&1; $hasNode = $true } catch {}
if (-not $hasNode) {
    Write-Host "  Node.js niet gevonden, installeren via winget..." -ForegroundColor Yellow
    try {
        winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
        # Refresh PATH zodat node vindbaar is in deze sessie
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
        $null = node --version 2>&1
        $hasNode = $true
    } catch {}
}
if (-not $hasNode) {
    Write-Host "[FOUT] Node.js kon niet automatisch geinstalleerd worden." -ForegroundColor Red
    Write-Host "  Installeer handmatig: https://nodejs.org" -ForegroundColor Yellow
    Write-Host "  Daarna dit script opnieuw uitvoeren." -ForegroundColor Yellow
    exit 1
}
Write-Host "[OK] Node.js gevonden: $(node --version)" -ForegroundColor Green

# 2. Install mcp-remote locally in a directory of its own
$clientDir = Join-Path $env:LOCALAPPDATA "mcp-server"
New-Item -ItemType Directory -Force -Path $clientDir | Out-Null
Write-Host "  mcp-remote installeren in $clientDir ..." -ForegroundColor Gray
Push-Location $clientDir
if (-not (Test-Path "package.json")) {
    npm init -y 2>&1 | Out-Null
}
npm install mcp-remote 2>&1 | Out-Null
Pop-Location
$proxyCheck = Join-Path $clientDir "node_modules\\mcp-remote\\dist\\proxy.js"
if (Test-Path $proxyCheck) {
    Write-Host "[OK] mcp-remote geinstalleerd" -ForegroundColor Green
} else {
    Write-Host "[FOUT] mcp-remote kon niet gevonden worden na installatie." -ForegroundColor Red
    exit 1
}

# 3. Create wrapper script

$wrapperContent = @"
const { spawn } = require("child_process");
const script = require.resolve("mcp-remote/dist/proxy.js");
const t = ["${keyParts[0]}","${keyParts[1]}","${keyParts[2]}"].join(".");
const c = spawn(process.execPath, [
  script, "${mcpUrl}",
  "--header", "Authorization:Bearer " + t
], { stdio: "inherit" });
c.on("exit", (code) => process.exit(code || 0));
"@

$wrapperPath = Join-Path $clientDir "${serverName}.js"
[System.IO.File]::WriteAllText($wrapperPath, $wrapperContent, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[OK] Wrapper script: $wrapperPath" -ForegroundColor Green

# 4. Update Claude Desktop config (detect Store vs Installer version)
$storeDir = Join-Path $env:LOCALAPPDATA "Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude"
$installerDir = Join-Path $env:APPDATA "Claude"

if (Test-Path $storeDir) {
    $claudeDir = $storeDir
    Write-Host "  Claude Desktop (Microsoft Store) gedetecteerd" -ForegroundColor Gray
} elseif (Test-Path $installerDir) {
    $claudeDir = $installerDir
    Write-Host "  Claude Desktop (Installer) gedetecteerd" -ForegroundColor Gray
} else {
    # Default: try Store first (newer), fallback to installer path
    $claudeDir = $installerDir
    Write-Host "  Claude Desktop config niet gevonden, maak aan in: $claudeDir" -ForegroundColor Yellow
}
New-Item -ItemType Directory -Force -Path $claudeDir | Out-Null
$configFile = Join-Path $claudeDir "claude_desktop_config.json"

$serverName = "${serverName}"
$serverEntry = @{
    _description = "MCP Server ($serverName) - verwijder dit blok om te deactiveren"
    command = "node"
    args = @($wrapperPath.Replace("\\", "\\\\"))
}

if (Test-Path $configFile) {
    $backupFile = "$configFile.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $configFile $backupFile
    Write-Host "  Backup: $backupFile" -ForegroundColor Gray

    $existing = Get-Content $configFile -Raw | ConvertFrom-Json
    if (-not $existing.mcpServers) {
        $existing | Add-Member -NotePropertyName "mcpServers" -NotePropertyValue @{} -Force
    }
    $existing.mcpServers | Add-Member -NotePropertyName $serverName -NotePropertyValue $serverEntry -Force
    $json = $existing | ConvertTo-Json -Depth 10
} else {
    $config = @{ mcpServers = @{ $serverName = $serverEntry } }
    $json = $config | ConvertTo-Json -Depth 10
}

[System.IO.File]::WriteAllText($configFile, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[OK] Claude Desktop config: $configFile" -ForegroundColor Green

Write-Host ""
Write-Host "=== Setup compleet! ===" -ForegroundColor Green
Write-Host ""

# 6. Start Claude Desktop automatisch
Write-Host "[5/5] Claude Desktop starten..." -ForegroundColor Yellow
$started = $false
# Methode 1: Installer versie via exe (meest voorkomend)
$installerExe = "$env:LOCALAPPDATA\\Programs\\Claude\\Claude.exe"
if (Test-Path $installerExe) {
    Start-Process $installerExe
    $started = $true
}
# Methode 2: Microsoft Store versie via App Package
if (-not $started) {
    try {
        $storeApp = Get-AppxPackage -Name "*Claude*" -ErrorAction Stop | Select-Object -First 1
        if ($storeApp) {
            $appId = ($storeApp.PackageFamilyName + "!Claude")
            Start-Process "explorer.exe" "shell:AppsFolder\\$appId"
            $started = $true
        }
    } catch {
        # Appx module niet beschikbaar - probeer bekende Store package name direct
    }
}
# Methode 3: Bekende Store package family name (als Appx module niet laadt)
if (-not $started) {
    $storePath = "$env:LOCALAPPDATA\\Packages\\Claude_pzs8sxrjxfjjc"
    if (Test-Path $storePath) {
        Start-Process "explorer.exe" "shell:AppsFolder\\Claude_pzs8sxrjxfjjc!Claude"
        $started = $true
    }
}
if ($started) {
    Write-Host "[OK] Claude Desktop gestart" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Wacht 10-15 seconden tot Claude Desktop volledig is opgestart." -ForegroundColor Gray
    Write-Host "  De '$serverName' MCP server verschijnt automatisch." -ForegroundColor Gray
} else {
    Write-Host "  Claude Desktop niet automatisch gevonden." -ForegroundColor Yellow
    Write-Host "  Open Claude Desktop handmatig." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "  Daarna kun je vragen:" -ForegroundColor White
Write-Host '    "Wat is de status van de services?"' -ForegroundColor Cyan
Write-Host '    "Toon mijn open tickets"' -ForegroundColor Cyan
Write-Host ""
`;

      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(ps1);
      return;
    }

    // Claude Desktop setup wizard - redirects to OAuth
    if (parsedUrl.pathname === "/setup") {
      if (!OAUTH_ENABLED) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<html><body><h1>OAuth niet geconfigureerd</h1></body></html>`);
        return;
      }

      const baseUrl = getBaseUrl(req);

      // Build OAuth authorize URL with setup state
      const params = new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
        redirect_uri: `${baseUrl}/setup/callback`,
        response_type: "code",
        scope: "openid profile email",
        state: "claude-setup"
      });

      const authUrl = `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
      res.writeHead(302, { Location: authUrl });
      res.end();
      return;
    }

    // Claude Desktop setup callback - generates API key and shows config
    if (parsedUrl.pathname === "/setup/callback") {
      const code = parsedUrl.query.code as string;
      const error = parsedUrl.query.error as string;

      const baseUrl = getBaseUrl(req);

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Setup Mislukt</title></head>
          <body style="font-family:sans-serif;padding:40px;text-align:center;">
          <h1 style="color:#c00;">Setup Mislukt</h1>
          <p>${parsedUrl.query.error_description || error}</p>
          <a href="${baseUrl}">← Terug</a>
          </body></html>`);
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Fout</title></head>
          <body style="font-family:sans-serif;padding:40px;text-align:center;">
          <h1>Geen authorization code</h1>
          <a href="${baseUrl}">← Terug</a>
          </body></html>`);
        return;
      }

      try {
        // Exchange code for tokens
        const tokens = await exchangeCodeForTokens(code, `${baseUrl}/setup/callback`);

        // Extract user info from id_token (JWT from Authentik with OpenID claims)
        let userInfo = { sub: "unknown", email: "unknown@unknown", name: "Unknown User" };
        if (tokens.id_token) {
          try {
            const payload = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString());
            userInfo = {
              sub: payload.sub || userInfo.sub,
              email: payload.email || payload.preferred_username || userInfo.email,
              name: payload.name || payload.preferred_username || userInfo.name
            };
          } catch (e) { /* id_token decode failed, use defaults */ }
        }

        // Generate permanent API key with user identity
        const apiKey = generateApiKey(userInfo);

        // Generate temp token for Windows installer download
        const setupToken = randomBytes(32).toString("hex");
        setupTokens.set(setupToken, { apiKey, baseUrl, expiresAt: Date.now() + SETUP_TOKEN_TTL });
        // Cleanup expired tokens
        for (const [k, v] of setupTokens) { if (v.expiresAt < Date.now()) setupTokens.delete(k); }

        // Derive config name: "mcp-server", or "mcp-server-dev" for dev/localhost
        const isDev = baseUrl.includes("localhost") || baseUrl.includes("dev-");
        const serverName = isDev ? "mcp-server-dev" : "mcp-server";

        // Create config with API key embedded
        // Note: Using --header CLI arg instead of MCP_HEADERS env var due to Claude Code issue 6204
        const config = {
          mcpServers: {
            [serverName]: {
              _description: `MCP Server (${serverName}) - verwijder dit blok om te deactiveren`,
              command: "npx",
              args: [
                "-y",
                "mcp-remote",
                `${baseUrl}/mcp`,
                "--header",
                `Authorization:Bearer ${apiKey}`
              ]
            }
          }
        };

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Claude Setup Compleet</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 40px; max-width: 700px; margin: 0 auto; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; }
    .card { background: white; padding: 40px; border-radius: 16px; box-shadow: 0 10px 40px rgba(0,0,0,0.2); }
    h1 { color: #2e7d32; margin-top: 0; font-size: 28px; }
    .step { background: #f8f9fa; padding: 20px; border-radius: 12px; margin: 20px 0; }
    .step-num { display: inline-block; width: 28px; height: 28px; background: #667eea; color: white; border-radius: 50%; text-align: center; line-height: 28px; font-weight: bold; margin-right: 10px; font-size: 14px; }
    .btn { display: inline-block; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 5px; cursor: pointer; border: none; font-size: 14px; }
    .btn-primary { background: #667eea; color: white; }
    .btn-primary:hover { background: #5a6fd6; }
    .btn-secondary { background: #e0e0e0; color: #333; }
    .btn-secondary:hover { background: #d0d0d0; }
    .success-icon { font-size: 50px; margin-bottom: 15px; }
    .platform-btns { display: flex; gap: 8px; flex-wrap: wrap; margin: 15px 0; }
    .platform-btn { padding: 10px 16px; border: 2px solid #e0e0e0; border-radius: 8px; background: white; cursor: pointer; font-size: 13px; transition: all 0.2s; }
    .platform-btn:hover { border-color: #667eea; }
    .platform-btn.active { border-color: #667eea; background: #f0f4ff; }
    .code-box { background: #1e1e1e; color: #d4d4d4; padding: 15px; border-radius: 8px; font-family: 'Consolas', 'Monaco', monospace; font-size: 12px; overflow-x: auto; margin: 10px 0; position: relative; line-height: 1.5; }
    .copy-btn { position: absolute; top: 8px; right: 8px; background: #333; border: none; color: #aaa; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 11px; }
    .copy-btn:hover { background: #444; color: #fff; }
    .copy-btn.copied { background: #2e7d32; color: white; }
    .note { font-size: 12px; color: #666; margin-top: 10px; }
    .details { margin-top: 25px; padding-top: 20px; border-top: 1px solid #eee; }
    .details summary { cursor: pointer; color: #667eea; font-size: 13px; }
    .api-key { background: #263238; color: #4fc3f7; padding: 10px; border-radius: 6px; font-family: monospace; font-size: 10px; word-break: break-all; margin: 10px 0; }
  </style>
</head>
<body>
  <div class="card">
    <div style="text-align:center;">
      <div class="success-icon">✅</div>
      <h1>Setup Compleet!</h1>
      <p style="color:#666;">Kopieer het commando en je bent klaar</p>
    </div>

    <div class="step">
      <span class="step-num">1</span>
      <strong>Kies je platform</strong>
      <div class="platform-btns">
        <button class="platform-btn" onclick="setPlatform('windows')">🪟 Windows</button>
        <button class="platform-btn" onclick="setPlatform('macos')">🍎 macOS</button>
        <button class="platform-btn" onclick="setPlatform('linux')">🖥️ Claude Code</button>
        <button class="platform-btn" onclick="setPlatform('custom')">📁 Custom</button>
      </div>
      <div id="customPath" style="display:none; margin-top:10px;">
        <input type="text" id="targetPath" placeholder="/home/user/project"
               style="width:100%; padding:10px; border:1px solid #ccc; border-radius:6px; font-family:monospace; font-size:13px;"
               oninput="updateCommand()">
      </div>
    </div>

    <div class="step">
      <span class="step-num">2</span>
      <strong>Voer uit in terminal</strong>
      <div class="code-box">
        <button class="copy-btn" onclick="copyCommand(this)">📋 Kopieer</button>
        <pre id="installCmd" style="margin:0; white-space:pre-wrap;"></pre>
      </div>
      <p class="note" id="platformNote"></p>
      <p class="note" id="jqHint" style="margin-top:5px;">💡 Bij bestaand bestand wordt <code>jq</code> gebruikt om te mergen. Installeer: <code>sudo apt install jq</code> of <code>brew install jq</code></p>
    </div>

    <div class="step" id="step3">
      <span class="step-num">3</span>
      <strong id="step3Title">Herstart Claude</strong>
      <p id="step3Desc" style="margin:10px 0 0; color:#666;">Herstart Claude Desktop of Claude Code. Daarna kun je vragen:</p>
      <ul style="color:#888; margin-top:8px; font-size:13px;">
        <li>"Wat is de status van de services?"</li>
        <li>"Toon mijn open tickets"</li>
      </ul>
    </div>

    <details class="details">
      <summary>🔑 API Key tonen (voor handmatige configuratie)</summary>
      <div class="api-key">${apiKey}</div>
      <button onclick="navigator.clipboard.writeText('${apiKey}')" class="btn btn-secondary" style="font-size:12px; padding:8px 16px;">📋 Kopieer Key</button>
    </details>

    <details class="details">
      <summary>🗑️ Later verwijderen?</summary>
      <p style="margin:10px 0; font-size:13px; color:#666;">Open je config bestand en verwijder het <code>"${serverName}": {...}</code> blok, of gebruik:</p>
      <div class="code-box" style="font-size:11px; padding:10px;">
        <code>jq 'del(.mcpServers["${serverName}"])' .mcp.json > tmp && mv tmp .mcp.json</code>
      </div>
      <p style="margin:8px 0 0; font-size:12px; color:#888;">Er is ook een backup gemaakt: <code>*.bak-YYYYMMDD-HHMMSS</code></p>
    </details>
  </div>

  <script>
    var serverName = '${serverName}';
    var serverConfig = ${JSON.stringify(config.mcpServers[serverName])};
    var fullConfig = ${JSON.stringify(config, null, 2)};
    var setupInstallUrl = '${baseUrl}/setup/install.ps1?t=${setupToken}';
    var currentPlatform = 'linux';

    var platforms = {
      windows: {
        path: '$env:APPDATA/Claude',
        file: 'claude_desktop_config.json',
        note: 'Open PowerShell en plak dit commando. Het script sluit Claude Desktop af, installeert de MCP verbinding, en start Claude Desktop weer op.',
        cmd: function() {
          return 'irm "' + setupInstallUrl + '" | iex';
        }
      },
      macos: {
        path: '~/Library/Application Support/Claude',
        file: 'claude_desktop_config.json',
        note: 'Voor Claude Desktop op macOS.',
        cmd: function() { return buildBashCmd('~/Library/Application\\\\ Support/Claude', 'claude_desktop_config.json'); }
      },
      linux: {
        path: '.',
        file: '.mcp.json',
        note: 'Voor Claude Code - voer uit in je project root.',
        cmd: function() { return buildMcpJsonCmd('.'); }
      },
      custom: {
        path: '',
        file: '.mcp.json',
        note: 'Vul het project pad in (waar .mcp.json moet komen).',
        cmd: function() {
          var p = document.getElementById('targetPath').value.trim() || '.';
          return buildMcpJsonCmd(p);
        }
      }
    };

    function buildBashCmd(path, filename) {
      var file = path + '/' + filename;
      var serverJson = JSON.stringify(serverConfig);
      var fullJson = JSON.stringify(fullConfig, null, 2);
      // Use jq to merge if file exists (preserves other settings like permissions)
      return 'mkdir -p ' + path + ' && \\\\\\n' +
        'FILE="' + file + '" && \\\\\\n' +
        'if [ -f "$FILE" ]; then \\\\\\n' +
        '  cp "$FILE" "$FILE.bak-$(date +%Y%m%d-%H%M%S)" && \\\\\\n' +
        '  jq \\'.mcpServers["' + serverName + '"] = ' + serverJson.replace(/'/g, "'\\''") + "\\' \\"$FILE\\" > \\"$FILE.tmp\\" && \\\\\\n" +
        '  mv "$FILE.tmp" "$FILE" && \\\\\\n' +
        '  echo "mcpServers.' + serverName + ' toegevoegd (bestaande settings behouden)"; \\\\\\n' +
        'else \\\\\\n' +
        "  cat > \\"$FILE\\" << 'EOF'\\n" + fullJson + "\\nEOF\\n" +
        '  echo "Nieuw bestand aangemaakt"; \\\\\\n' +
        'fi';
    }

    function buildMcpJsonCmd(path) {
      var file = path + '/.mcp.json';
      var settingsFile = path + '/.claude/settings.json';
      var serverJson = JSON.stringify(serverConfig);
      var fullJson = JSON.stringify(fullConfig, null, 2);
      // Create .mcp.json and add permissions to .claude/settings.json
      return '# Stap 1: .mcp.json configureren\\n' +
        'FILE="' + file + '" && \\\\\\n' +
        'if [ -f "$FILE" ]; then \\\\\\n' +
        '  cp "$FILE" "$FILE.bak-$(date +%Y%m%d-%H%M%S)" && \\\\\\n' +
        '  jq \\'.mcpServers["' + serverName + '"] = ' + serverJson.replace(/'/g, "'\\''") + "\\' \\"$FILE\\" > \\"$FILE.tmp\\" && \\\\\\n" +
        '  mv "$FILE.tmp" "$FILE" && \\\\\\n' +
        '  echo "✓ ' + serverName + ' toegevoegd aan .mcp.json"; \\\\\\n' +
        'else \\\\\\n' +
        "  cat > \\"$FILE\\" << 'EOF'\\n" + fullJson + "\\nEOF\\n" +
        '  echo "✓ .mcp.json aangemaakt"; \\\\\\n' +
        'fi && \\\\\\n\\n' +
        '# Stap 2: Permissions toevoegen aan .claude/settings.json\\n' +
        'SETTINGS="' + settingsFile + '" && \\\\\\n' +
        'mkdir -p "$(dirname "$SETTINGS")" && \\\\\\n' +
        'if [ -f "$SETTINGS" ]; then \\\\\\n' +
        '  if ! jq -e \\'.permissions.allow | index("mcp__' + serverName + '__*")\\' "$SETTINGS" > /dev/null 2>&1; then \\\\\\n' +
        '    cp "$SETTINGS" "$SETTINGS.bak-$(date +%Y%m%d-%H%M%S)" && \\\\\\n' +
        '    jq \\'.permissions.allow = ["mcp__' + serverName + '__*"] + .permissions.allow\\' "$SETTINGS" > "$SETTINGS.tmp" && \\\\\\n' +
        '    mv "$SETTINGS.tmp" "$SETTINGS" && \\\\\\n' +
        '    echo "✓ mcp__' + serverName + '__* permission toegevoegd"; \\\\\\n' +
        '  else \\\\\\n' +
        '    echo "✓ mcp__' + serverName + '__* permission bestaat al"; \\\\\\n' +
        '  fi; \\\\\\n' +
        'else \\\\\\n' +
        "  cat > \\"$SETTINGS\\" << 'EOF'\\n" +
        '{\\n  "permissions": {\\n    "allow": ["mcp__' + serverName + '__*"]\\n  }\\n}\\n' +
        "EOF\\n" +
        '  echo "✓ .claude/settings.json aangemaakt met permissions"; \\\\\\n' +
        'fi && \\\\\\n' +
        'echo "" && echo "🎉 Setup compleet! Herstart Claude Code om te activeren."';
    }

    function setPlatform(p) {
      currentPlatform = p;
      document.querySelectorAll('.platform-btn').forEach(function(btn) {
        btn.classList.remove('active');
      });
      event.target.classList.add('active');
      document.getElementById('customPath').style.display = p === 'custom' ? 'block' : 'none';
      // Step 3 + jq hint: adapt per platform
      if (p === 'windows') {
        document.getElementById('step3Title').textContent = 'Klaar!';
        document.getElementById('step3Desc').textContent = 'Het script start Claude Desktop automatisch opnieuw op. Wacht 10-15 seconden en je kunt vragen:';
        document.getElementById('jqHint').style.display = 'none';
      } else {
        document.getElementById('step3Title').textContent = 'Herstart Claude';
        document.getElementById('step3Desc').textContent = 'Herstart Claude Desktop of Claude Code. Daarna kun je vragen:';
        document.getElementById('jqHint').style.display = 'block';
      }
      updateCommand();
    }

    function updateCommand() {
      var platform = platforms[currentPlatform];
      document.getElementById('installCmd').textContent = platform.cmd();
      document.getElementById('platformNote').textContent = platform.note;
    }

    function copyCommand(btn) {
      navigator.clipboard.writeText(document.getElementById('installCmd').textContent);
      btn.textContent = '✓ Gekopieerd';
      btn.classList.add('copied');
      setTimeout(function() { btn.textContent = '📋 Kopieer'; btn.classList.remove('copied'); }, 2000);
    }

    // Default to Linux
    document.querySelector('.platform-btn:nth-child(3)').classList.add('active');
    updateCommand();
  </script>
</body>
</html>`);
      } catch (err: any) {
        console.error("Setup callback error:", err.message || err);
        const setupUrl = `${baseUrl}/setup`;
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Fout</title></head>
          <body style="font-family:sans-serif;padding:40px;text-align:center;">
          <h1 style="color:#c00;">Setup Fout</h1>
          <p>${err.message || "Onbekende fout"}</p>
          <p style="margin-top:20px;"><a href="${setupUrl}" style="background:#1976d2;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;">Opnieuw proberen</a></p>
          <p style="margin-top:10px;font-size:12px;color:#888;">Je wordt opnieuw door de login geleid.</p>
          </body></html>`);
      }
      return;
    }

    // Bash client download (no auth)
    if (parsedUrl.pathname === "/client.sh") {
      try {
        const fs = await import("fs/promises");
        const path = await import("path");
        const scriptPath = path.join(process.cwd(), "mcp-client.sh");
        const script = await fs.readFile(scriptPath, "utf-8");
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": "attachment; filename=mcp-client.sh"
        });
        res.end(script);
      } catch (err) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bash client script not found" }));
      }
      return;
    }

    // Health endpoint (no auth)
    if (parsedUrl.pathname === "/health") {
      const healthData = {
        status: "healthy",
        version: "1.0.0",
        client_version: CLIENT_VERSION,
        auth: {
          api_keys: API_KEYS.length > 0,
          oauth: OAUTH_ENABLED
        },
        timestamp: new Date().toISOString()
      };

      // Return JSON if requested
      const wantsJson = parsedUrl.query.format === "json" ||
                        req.headers.accept?.includes("application/json");
      if (wantsJson) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(healthData));
        return;
      }

      const baseUrl = getBaseUrl(req);

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Health Check - MCP Server</title>
  <style>
    :root { --primary: #1976d2; --success: #2e7d32; --warning: #f57c00; --bg: #f5f7fa; --card: #ffffff; --text: #333; --code-bg: #263238; --code: #4fc3f7; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 20px; background: var(--bg); color: var(--text); line-height: 1.6; }
    .container { max-width: 800px; margin: 0 auto; }
    .breadcrumb { margin-bottom: 20px; }
    .breadcrumb a { color: var(--primary); text-decoration: none; }
    .breadcrumb a:hover { text-decoration: underline; }
    h1 { color: var(--primary); margin-bottom: 10px; }
    .subtitle { color: #666; margin-bottom: 30px; }
    .card { background: var(--card); border-radius: 12px; padding: 25px; margin-bottom: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .card h2 { margin-top: 0; color: var(--primary); border-bottom: 2px solid #e0e0e0; padding-bottom: 10px; }
    .status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; }
    .status-item { background: #f8f9fa; padding: 20px; border-radius: 8px; text-align: center; }
    .status-item .label { font-size: 12px; color: #666; text-transform: uppercase; margin-bottom: 8px; }
    .status-item .value { font-size: 24px; font-weight: 600; }
    .status-item .value.healthy { color: var(--success); }
    .badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
    .badge.enabled { background: #e8f5e9; color: var(--success); }
    .badge.disabled { background: #fafafa; color: #999; }
    .auth-table { width: 100%; margin-top: 15px; }
    .auth-table td { padding: 8px 0; }
    .auth-table td:first-child { color: #666; }
    .auth-table td:last-child { text-align: right; }
    .code-block { background: var(--code-bg); color: var(--code); padding: 15px 20px; border-radius: 8px; font-family: monospace; font-size: 13px; overflow-x: auto; margin: 15px 0; position: relative; }
    .copy-btn { position: absolute; top: 8px; right: 12px; background: #37474f; border: none; color: #90a4ae; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
    .copy-btn:hover { background: #455a64; color: #fff; }
    .timestamp { color: #999; font-size: 12px; margin-top: 20px; text-align: center; }
    a { color: var(--primary); }
  </style>
</head>
<body>
  <div class="container">
    <div class="breadcrumb">
      <a href="${baseUrl}/">← Terug naar landing page</a>
    </div>

    <h1>💚 Health Check</h1>
    <p class="subtitle">Huidige status van de MCP Server</p>

    <div class="card">
      <h2>Status</h2>
      <div class="status-grid">
        <div class="status-item">
          <div class="label">Server Status</div>
          <div class="value healthy">● Healthy</div>
        </div>
        <div class="status-item">
          <div class="label">Server Versie</div>
          <div class="value">${healthData.version}</div>
        </div>
        <div class="status-item">
          <div class="label">Client Versie</div>
          <div class="value">${healthData.client_version}</div>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Authenticatie</h2>
      <table class="auth-table">
        <tr>
          <td>API Keys</td>
          <td><span class="badge ${healthData.auth.api_keys ? 'enabled' : 'disabled'}">${healthData.auth.api_keys ? '● Enabled' : '○ Disabled'}</span></td>
        </tr>
        <tr>
          <td>OAuth2 (Authentik)</td>
          <td><span class="badge ${healthData.auth.oauth ? 'enabled' : 'disabled'}">${healthData.auth.oauth ? '● Enabled' : '○ Disabled'}</span></td>
        </tr>
      </table>
    </div>

    <div class="card">
      <h2>JSON Response</h2>
      <p>Voor monitoring tools: <a href="${baseUrl}/health?format=json">/health?format=json</a></p>
      <div class="code-block">
        <button class="copy-btn" onclick="copyJson()">Copy</button>
        <pre id="json-health">${JSON.stringify(healthData, null, 2)}</pre>
      </div>
    </div>

    <div class="timestamp">Laatste check: ${healthData.timestamp}</div>
  </div>

  <script>
    function copyJson() {
      const json = document.getElementById('json-health').innerText;
      navigator.clipboard.writeText(json);
      const btn = event.target;
      btn.innerText = '✓ Copied';
      setTimeout(() => btn.innerText = 'Copy', 2000);
    }
  </script>
</body>
</html>`);
      return;
    }

    // Version endpoint (no auth) - for client update checks
    if (parsedUrl.pathname === "/version") {
      const versionData = {
        server_version: "1.0.0",
        client_version: CLIENT_VERSION,
        node_version: process.version,
        platform: process.platform,
        uptime_seconds: Math.floor(process.uptime())
      };

      // Return JSON if requested
      const wantsJson = parsedUrl.query.format === "json" ||
                        req.headers.accept?.includes("application/json");
      if (wantsJson) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(versionData));
        return;
      }

      const baseUrl = getBaseUrl(req);

      const formatUptime = (seconds: number) => {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        if (days > 0) return days + "d " + hours + "h " + mins + "m";
        if (hours > 0) return hours + "h " + mins + "m";
        return mins + "m";
      };

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Versie Info - MCP Server</title>
  <style>
    :root { --primary: #1976d2; --success: #2e7d32; --bg: #f5f7fa; --card: #ffffff; --text: #333; --code-bg: #263238; --code: #4fc3f7; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 20px; background: var(--bg); color: var(--text); line-height: 1.6; }
    .container { max-width: 800px; margin: 0 auto; }
    .breadcrumb { margin-bottom: 20px; }
    .breadcrumb a { color: var(--primary); text-decoration: none; }
    .breadcrumb a:hover { text-decoration: underline; }
    h1 { color: var(--primary); margin-bottom: 10px; }
    .subtitle { color: #666; margin-bottom: 30px; }
    .card { background: var(--card); border-radius: 12px; padding: 25px; margin-bottom: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .card h2 { margin-top: 0; color: var(--primary); border-bottom: 2px solid #e0e0e0; padding-bottom: 10px; }
    .version-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 20px; }
    .version-item { background: #f8f9fa; padding: 20px; border-radius: 8px; text-align: center; }
    .version-item .label { font-size: 12px; color: #666; text-transform: uppercase; margin-bottom: 8px; }
    .version-item .value { font-size: 28px; font-weight: 700; color: var(--primary); }
    .version-item .value.secondary { font-size: 20px; color: #666; }
    .info-table { width: 100%; }
    .info-table td { padding: 10px 0; border-bottom: 1px solid #eee; }
    .info-table tr:last-child td { border-bottom: none; }
    .info-table td:first-child { color: #666; width: 140px; }
    .info-table td:last-child { font-family: monospace; }
    .code-block { background: var(--code-bg); color: var(--code); padding: 15px 20px; border-radius: 8px; font-family: monospace; font-size: 13px; overflow-x: auto; margin: 15px 0; position: relative; }
    .copy-btn { position: absolute; top: 8px; right: 12px; background: #37474f; border: none; color: #90a4ae; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
    .copy-btn:hover { background: #455a64; color: #fff; }
    a { color: var(--primary); }
  </style>
</head>
<body>
  <div class="container">
    <div class="breadcrumb">
      <a href="${baseUrl}/">← Terug naar landing page</a>
    </div>

    <h1>📦 Versie Informatie</h1>
    <p class="subtitle">Server en client versie details</p>

    <div class="card">
      <h2>Versies</h2>
      <div class="version-grid">
        <div class="version-item">
          <div class="label">Server</div>
          <div class="value">${versionData.server_version}</div>
        </div>
        <div class="version-item">
          <div class="label">Client</div>
          <div class="value">${versionData.client_version}</div>
        </div>
        <div class="version-item">
          <div class="label">Uptime</div>
          <div class="value secondary">${formatUptime(versionData.uptime_seconds)}</div>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Runtime</h2>
      <table class="info-table">
        <tr>
          <td>Node.js</td>
          <td>${versionData.node_version}</td>
        </tr>
        <tr>
          <td>Platform</td>
          <td>${versionData.platform}</td>
        </tr>
        <tr>
          <td>Uptime</td>
          <td>${versionData.uptime_seconds} seconden</td>
        </tr>
      </table>
    </div>

    <div class="card">
      <h2>JSON Response</h2>
      <p>Voor update checks: <a href="${baseUrl}/version?format=json">/version?format=json</a></p>
      <div class="code-block">
        <button class="copy-btn" onclick="copyJson()">Copy</button>
        <pre id="json-version">${JSON.stringify(versionData, null, 2)}</pre>
      </div>
    </div>
  </div>

  <script>
    function copyJson() {
      const json = document.getElementById('json-version').innerText;
      navigator.clipboard.writeText(json);
      const btn = event.target;
      btn.innerText = '✓ Copied';
      setTimeout(() => btn.innerText = 'Copy', 2000);
    }
  </script>
</body>
</html>`);
      return;
    }

    // API Key endpoint - GET shows docs, POST generates key (requires OAuth token)
    if (parsedUrl.pathname === "/api-key") {
      const baseUrl = getBaseUrl(req);

      // POST: Generate API key (requires valid OAuth token)
      if (req.method === "POST") {
        const authHeader = req.headers.authorization;
        if (!authHeader) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Authorization header required. Login first with OAuth." }));
          return;
        }

        const token = authHeader.replace(/^Bearer\s+/i, "");
        const oauthResult = await validateOAuthToken(token);

        if (!oauthResult.valid || !oauthResult.userInfo) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid or expired OAuth token. Please login again." }));
          return;
        }

        // Generate API key
        const apiKey = generateApiKey({
          sub: oauthResult.userInfo.sub,
          email: oauthResult.userInfo.email,
          name: oauthResult.userInfo.name
        });

        const expiryDate = new Date(Date.now() + API_KEY_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          api_key: apiKey,
          user: {
            email: oauthResult.userInfo.email,
            name: oauthResult.userInfo.name
          },
          expires_at: expiryDate.toISOString(),
          expires_in_days: API_KEY_EXPIRY_DAYS,
          usage: {
            header: "Authorization: Bearer <api_key>",
            example: `curl -X POST "${baseUrl}/mcp" -H "Authorization: Bearer ${apiKey.substring(0, 20)}..." -H "Content-Type: application/json"`
          }
        }, null, 2));
        return;
      }

      // GET: Documentation page
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>API Key - MCP Server</title>
  <style>
    :root { --primary: #1976d2; --success: #2e7d32; --warning: #f57c00; --bg: #f5f7fa; --card: #ffffff; --text: #333; --code-bg: #263238; --code: #4fc3f7; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 20px; background: var(--bg); color: var(--text); line-height: 1.6; }
    .container { max-width: 800px; margin: 0 auto; }
    .breadcrumb { margin-bottom: 20px; }
    .breadcrumb a { color: var(--primary); text-decoration: none; }
    .breadcrumb a:hover { text-decoration: underline; }
    h1 { color: var(--primary); margin-bottom: 10px; }
    .subtitle { color: #666; margin-bottom: 30px; }
    .card { background: var(--card); border-radius: 12px; padding: 25px; margin-bottom: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .card h2 { margin-top: 0; color: var(--primary); border-bottom: 2px solid #e0e0e0; padding-bottom: 10px; }
    .step { display: flex; gap: 15px; margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid #eee; }
    .step:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
    .step-num { background: var(--primary); color: white; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 600; flex-shrink: 0; }
    .step-content { flex: 1; }
    .step-content h4 { margin: 0 0 8px 0; }
    .step-content p { margin: 0; color: #666; }
    .code-block { background: var(--code-bg); color: var(--code); padding: 15px 20px; border-radius: 8px; font-family: monospace; font-size: 13px; overflow-x: auto; margin: 10px 0; }
    .info-box { background: #e8f5e9; padding: 15px; border-radius: 8px; border-left: 4px solid var(--success); margin-top: 20px; }
    .info-box h4 { margin: 0 0 8px 0; color: var(--success); }
    .warning-box { background: #fff3e0; padding: 15px; border-radius: 8px; border-left: 4px solid var(--warning); margin-top: 20px; }
    .warning-box h4 { margin: 0 0 8px 0; color: var(--warning); }
    .compare-table { width: 100%; border-collapse: collapse; margin-top: 15px; }
    .compare-table th, .compare-table td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; }
    .compare-table th { background: #f8f9fa; color: #666; font-size: 12px; text-transform: uppercase; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .badge.temp { background: #fff3e0; color: var(--warning); }
    .badge.perm { background: #e8f5e9; color: var(--success); }
    a { color: var(--primary); }
  </style>
</head>
<body>
  <div class="container">
    <div class="breadcrumb">
      <a href="${baseUrl}/">← Terug naar landing page</a>
    </div>

    <h1>🔑 API Key Genereren</h1>
    <p class="subtitle">Genereer een permanente API key voor langdurig gebruik</p>

    <div class="card">
      <h2>OAuth Token vs API Key</h2>
      <table class="compare-table">
        <tr>
          <th>Eigenschap</th>
          <th>OAuth Token <span class="badge temp">Tijdelijk</span></th>
          <th>API Key <span class="badge perm">Permanent</span></th>
        </tr>
        <tr>
          <td>Geldigheid</td>
          <td>~30 minuten</td>
          <td>${API_KEY_EXPIRY_DAYS} dagen (1 jaar)</td>
        </tr>
        <tr>
          <td>Verkrijgen</td>
          <td><code>./mcp-client.sh login</code></td>
          <td><code>./mcp-client.sh api-key</code></td>
        </tr>
        <tr>
          <td>Gebruik</td>
          <td>Interactieve sessies</td>
          <td>Claude Desktop, scripts, automation</td>
        </tr>
      </table>
    </div>

    <div class="card">
      <h2>Hoe te genereren</h2>

      <div class="step">
        <div class="step-num">1</div>
        <div class="step-content">
          <h4>Download de client</h4>
          <p>Als je dit nog niet hebt gedaan:</p>
          <div class="code-block">curl -sL ${baseUrl}/client.sh -o mcp-client.sh && chmod +x mcp-client.sh</div>
        </div>
      </div>

      <div class="step">
        <div class="step-num">2</div>
        <div class="step-content">
          <h4>Login via OAuth</h4>
          <p>Authenticeer met je Authentik account:</p>
          <div class="code-block">./mcp-client.sh login</div>
        </div>
      </div>

      <div class="step">
        <div class="step-num">3</div>
        <div class="step-content">
          <h4>Genereer API Key</h4>
          <p>Maak een permanente API key aan:</p>
          <div class="code-block">./mcp-client.sh api-key</div>
          <p style="margin-top:10px;">De key wordt automatisch opgeslagen in <code>~/.mcp-client-apikey</code></p>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Direct via API</h2>
      <p>Als je al een OAuth token hebt, kun je direct een API key genereren:</p>
      <div class="code-block">curl -X POST "${baseUrl}/api-key" \\
  -H "Authorization: Bearer YOUR_OAUTH_TOKEN"</div>

      <div class="info-box">
        <h4>✅ Response bevat</h4>
        <ul style="margin: 0; padding-left: 20px;">
          <li><code>api_key</code> - Je permanente API key</li>
          <li><code>expires_at</code> - Vervaldatum</li>
          <li><code>user</code> - Je email en naam</li>
        </ul>
      </div>
    </div>

    <div class="card">
      <h2>Gebruik in Claude Desktop / Claude Code</h2>
      <p>Voeg toe aan <code>.mcp.json</code> (project) of <code>claude_desktop_config.json</code>:</p>
      <div class="code-block">{
  "mcpServers": {
    "mcp-server": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "${baseUrl}/mcp",
        "--header",
        "Authorization:Bearer YOUR_API_KEY"
      ]
    }
  }
}</div>
      <p style="margin-top: 10px; font-size: 0.9em; color: #666;">
        ℹ️ We gebruiken <code>--header</code> i.p.v. <code>MCP_HEADERS</code> env var vanwege
        <a href="https://github.com/anthropics/claude-code/issues/6204" target="_blank">Claude Code issue 6204</a>.
      </p>
    </div>

    <div class="warning-box">
      <h4>⚠️ Belangrijk</h4>
      <ul style="margin: 0; padding-left: 20px;">
        <li>Behandel je API key als een wachtwoord - deel deze niet</li>
        <li>De key is gebonden aan jouw account voor audit logging</li>
        <li>Bij verlies: genereer een nieuwe key (oude blijft geldig tot expiry)</li>
      </ul>
    </div>
  </div>
</body>
</html>`);
      return;
    }

    // OAuth info endpoint (no auth) - for clients to discover OAuth config
    if (parsedUrl.pathname === "/oauth/config") {
      if (!OAUTH_ENABLED) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "OAuth not enabled" }));
        return;
      }
      // Use public token URL (same host as authorize URL)
      const publicTokenUrl = OAUTH_AUTHORIZE_URL.replace("/authorize/", "/token/");
      const config = {
        enabled: true,
        authorize_url: OAUTH_AUTHORIZE_URL,
        token_url: publicTokenUrl,
        client_id: OAUTH_CLIENT_ID,
        redirect_uri: OAUTH_REDIRECT_URI,
        scopes: "openid profile email"
      };

      // Return JSON if requested via query param or Accept header
      const wantsJson = parsedUrl.query.format === "json" ||
                        req.headers.accept?.includes("application/json");
      if (wantsJson) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(config));
        return;
      }

      // HTML page with styled config display
      const baseUrl = getBaseUrl(req);

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OAuth2 Configuratie - MCP Server</title>
  <style>
    :root { --primary: #1976d2; --success: #2e7d32; --bg: #f5f7fa; --card: #ffffff; --text: #333; --code-bg: #263238; --code: #4fc3f7; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 20px; background: var(--bg); color: var(--text); line-height: 1.6; }
    .container { max-width: 800px; margin: 0 auto; }
    .breadcrumb { margin-bottom: 20px; }
    .breadcrumb a { color: var(--primary); text-decoration: none; }
    .breadcrumb a:hover { text-decoration: underline; }
    h1 { color: var(--primary); margin-bottom: 10px; }
    .subtitle { color: #666; margin-bottom: 30px; }
    .card { background: var(--card); border-radius: 12px; padding: 25px; margin-bottom: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .card h2 { margin-top: 0; color: var(--primary); border-bottom: 2px solid #e0e0e0; padding-bottom: 10px; }
    .config-table { width: 100%; border-collapse: collapse; }
    .config-table tr { border-bottom: 1px solid #eee; }
    .config-table tr:last-child { border-bottom: none; }
    .config-table td { padding: 12px 0; vertical-align: top; }
    .config-table td:first-child { font-weight: 600; color: var(--primary); width: 140px; }
    .config-table td:last-child { font-family: monospace; word-break: break-all; }
    .config-table .desc { font-weight: normal; font-size: 12px; color: #666; display: block; margin-top: 4px; }
    .code-block { background: var(--code-bg); color: var(--code); padding: 15px 20px; border-radius: 8px; font-family: 'Fira Code', 'Consolas', monospace; font-size: 13px; overflow-x: auto; margin: 15px 0; position: relative; }
    .copy-btn { position: absolute; top: 8px; right: 12px; background: #37474f; border: none; color: #90a4ae; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
    .copy-btn:hover { background: #455a64; color: #fff; }
    .badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
    .badge.enabled { background: #e8f5e9; color: var(--success); }
    .info-box { background: #e3f2fd; padding: 15px; border-radius: 8px; margin-top: 20px; }
    .info-box h4 { margin: 0 0 10px 0; color: var(--primary); }
    a { color: var(--primary); }
  </style>
</head>
<body>
  <div class="container">
    <div class="breadcrumb">
      <a href="${baseUrl}/">← Terug naar landing page</a>
    </div>

    <h1>🔐 OAuth2 Configuratie</h1>
    <p class="subtitle">Instellingen voor OAuth2/OpenID Connect authenticatie</p>

    <div class="card">
      <h2>Configuratie</h2>
      <table class="config-table">
        <tr>
          <td>Status<span class="desc">OAuth2 authenticatie</span></td>
          <td><span class="badge enabled">● Enabled</span></td>
        </tr>
        <tr>
          <td>Client ID<span class="desc">Applicatie identifier</span></td>
          <td>${config.client_id}</td>
        </tr>
        <tr>
          <td>Scopes<span class="desc">Gevraagde permissies</span></td>
          <td>${config.scopes}</td>
        </tr>
        <tr>
          <td>Authorize URL<span class="desc">Start OAuth flow (browser)</span></td>
          <td><a href="${config.authorize_url}" target="_blank">${config.authorize_url}</a></td>
        </tr>
        <tr>
          <td>Token URL<span class="desc">Token exchange (server-side)</span></td>
          <td>${config.token_url}</td>
        </tr>
        <tr>
          <td>Redirect URI<span class="desc">Callback na authenticatie</span></td>
          <td>${config.redirect_uri}</td>
        </tr>
      </table>
    </div>

    <div class="card">
      <h2>JSON Response</h2>
      <p>Voor programmatisch gebruik: <a href="${baseUrl}/oauth/config?format=json">/oauth/config?format=json</a></p>
      <div class="code-block">
        <button class="copy-btn" onclick="copyJson()">Copy</button>
        <pre id="json-config">${JSON.stringify(config, null, 2)}</pre>
      </div>
    </div>

    <div class="info-box">
      <h4>💡 Hoe te gebruiken</h4>
      <p>De MCP client gebruikt deze configuratie automatisch. Voor handmatige OAuth flow:</p>
      <ol style="margin: 10px 0 0 0; padding-left: 20px;">
        <li>Redirect gebruiker naar <code>authorize_url</code> met client_id en redirect_uri</li>
        <li>Ontvang authorization code op <code>redirect_uri</code></li>
        <li>Exchange code voor tokens via <code>token_url</code></li>
        <li>Gebruik access token in Authorization header: <code>Bearer &lt;token&gt;</code></li>
      </ol>
    </div>
  </div>

  <script>
    function copyJson() {
      const json = document.getElementById('json-config').innerText;
      navigator.clipboard.writeText(json);
      const btn = event.target;
      btn.innerText = '✓ Copied';
      setTimeout(() => btn.innerText = 'Copy', 2000);
    }
  </script>
</body>
</html>`);
      return;
    }

    // OAuth callback endpoint - exchanges code for tokens
    if (parsedUrl.pathname === "/oauth/callback") {
      const code = parsedUrl.query.code as string;
      const state = parsedUrl.query.state as string;
      const error = parsedUrl.query.error as string;
      const format = parsedUrl.query.format as string;

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Login Mislukt</title></head>
          <body style="font-family:sans-serif;padding:40px;text-align:center;">
          <h1 style="color:#c00;">Login Mislukt</h1>
          <p>${parsedUrl.query.error_description || error}</p>
          </body></html>`);
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Fout</title></head>
          <body style="font-family:sans-serif;padding:40px;text-align:center;">
          <h1>Geen authorization code</h1>
          </body></html>`);
        return;
      }

      try {
        const tokens = await exchangeCodeForTokens(code, OAUTH_REDIRECT_URI);

        // If format=json requested (for programmatic access), return JSON
        if (format === "json") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            success: true,
            access_token: tokens.access_token,
            token_type: tokens.token_type || "Bearer",
            expires_in: tokens.expires_in,
            refresh_token: tokens.refresh_token
          }));
          return;
        }

        // Default: show HTML page with token for copy/paste
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>MCP - Login Succesvol</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 40px; max-width: 700px; margin: 0 auto; background: #f5f5f5; }
    .card { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    h1 { color: #2e7d32; margin-top: 0; }
    .token-box { background: #263238; color: #4fc3f7; padding: 15px; border-radius: 8px; font-family: monospace; font-size: 12px; word-break: break-all; margin: 20px 0; max-height: 100px; overflow-y: auto; }
    .instructions { background: #e3f2fd; padding: 15px; border-radius: 8px; margin-top: 20px; }
    .instructions code { background: #bbdefb; padding: 2px 6px; border-radius: 4px; }
    button { background: #1976d2; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-size: 14px; }
    button:hover { background: #1565c0; }
    .copied { background: #2e7d32 !important; }
  </style>
</head>
<body>
  <div class="card">
    <h1>✅ Login Succesvol!</h1>
    <p>Je bent ingelogd. Kopieer onderstaande token en plak deze in PowerShell:</p>

    <div class="token-box" id="token">${tokens.access_token}</div>

    <button onclick="copyToken()">📋 Kopieer Token</button>

    <div class="instructions">
      <strong>In PowerShell:</strong><br>
      Plak de token wanneer gevraagd, of sla op met:<br><br>
      <code>$token = "PLAK_HIER"</code><br>
      <code>$token | Set-Content ~/.mcp-client-token.txt</code>
    </div>
  </div>

  <script>
    function copyToken() {
      const token = document.getElementById('token').innerText;
      navigator.clipboard.writeText(token);
      const btn = event.target;
      btn.classList.add('copied');
      btn.innerText = '✓ Gekopieerd!';
      setTimeout(() => { btn.classList.remove('copied'); btn.innerText = '📋 Kopieer Token'; }, 2000);
    }
  </script>
</body>
</html>`);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Fout</title></head>
          <body style="font-family:sans-serif;padding:40px;text-align:center;">
          <h1 style="color:#c00;">Token Exchange Mislukt</h1>
          <p>${err instanceof Error ? err.message : "Onbekende fout"}</p>
          </body></html>`);
      }
      return;
    }

    // MCP Documentation page (GET /mcp shows docs, POST /mcp is the API)
    if (parsedUrl.pathname === "/mcp" && req.method === "GET") {
      const baseUrl = getBaseUrl(req);

      const tools = [
        { name: "package_list", desc: "Lijst alle packages met status", args: "category?, status?" },
        { name: "package_info", desc: "Details van een package", args: "name" },
        { name: "package_search", desc: "Zoek packages op naam/beschrijving", args: "query" },
        { name: "service_status", desc: "Status van een service", args: "name" },
        { name: "service_health", desc: "Health check van een service", args: "name" },
        { name: "service_logs", desc: "Recente logs van een service", args: "name, lines?" },
        { name: "ecosystem_health", desc: "Overzicht van alle services", args: "-" },
        { name: "redmine_epics", desc: "Lijst alle epics", args: "status?" },
        { name: "redmine_issues", desc: "Zoek issues", args: "query?, project?, tracker?, status?" },
        { name: "redmine_issue", desc: "Details van een issue", args: "id" },
        { name: "redmine_create_ticket", desc: "Maak nieuw ticket/epic", args: "subject, tracker?, epic_id?, description?" },
        { name: "redmine_update_ticket", desc: "Update ticket (auto-reopen)", args: "id, subject?, description?, notes?, status?, priority?, assigned_to?, epic_id?" },
        { name: "redmine_close_ticket", desc: "Sluit ticket (idempotent)", args: "id, notes?" },
        { name: "redmine_reopen_ticket", desc: "Heropen ticket (idempotent)", args: "id, notes?" },
        { name: "redmine_add_note", desc: "Voeg notitie toe (auto-reopen)", args: "id, note" },
        { name: "redmine_attach_file", desc: "Upload bestand en koppel aan ticket", args: "id, file_path, filename?, description?, content_type?, max_size_bytes?, author_login?" },
        { name: "developer_hook_setup", desc: "Claude Code hook template voor ticket validation", args: "-" },
      ];

      const toolRows = tools.map(t =>
        `<tr><td><code>${t.name}</code></td><td>${t.desc}</td><td><code>${t.args}</code></td></tr>`
      ).join("\n");

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MCP API - MCP Server</title>
  <style>
    :root { --primary: #1976d2; --success: #2e7d32; --warning: #f57c00; --bg: #f5f7fa; --card: #ffffff; --text: #333; --code-bg: #263238; --code: #4fc3f7; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 20px; background: var(--bg); color: var(--text); line-height: 1.6; }
    .container { max-width: 900px; margin: 0 auto; }
    .breadcrumb { margin-bottom: 20px; }
    .breadcrumb a { color: var(--primary); text-decoration: none; }
    .breadcrumb a:hover { text-decoration: underline; }
    h1 { color: var(--primary); margin-bottom: 10px; }
    .subtitle { color: #666; margin-bottom: 30px; }
    .card { background: var(--card); border-radius: 12px; padding: 25px; margin-bottom: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .card h2 { margin-top: 0; color: var(--primary); border-bottom: 2px solid #e0e0e0; padding-bottom: 10px; }
    .method-badge { display: inline-block; background: var(--warning); color: white; padding: 4px 12px; border-radius: 4px; font-weight: 600; font-size: 12px; margin-right: 10px; }
    .endpoint-url { font-family: monospace; font-size: 16px; color: var(--primary); }
    .tools-table { width: 100%; border-collapse: collapse; margin-top: 15px; }
    .tools-table th { text-align: left; padding: 12px 8px; border-bottom: 2px solid #e0e0e0; color: #666; font-size: 12px; text-transform: uppercase; }
    .tools-table td { padding: 10px 8px; border-bottom: 1px solid #eee; }
    .tools-table tr:hover { background: #f8f9fa; }
    .tools-table code { background: #e8f5e9; color: var(--success); padding: 2px 6px; border-radius: 4px; font-size: 13px; }
    .code-block { background: var(--code-bg); color: var(--code); padding: 15px 20px; border-radius: 8px; font-family: 'Fira Code', monospace; font-size: 13px; overflow-x: auto; margin: 15px 0; position: relative; white-space: pre; }
    .code-block .comment { color: #78909c; }
    .code-block .string { color: #c3e88d; }
    .code-block .key { color: #89ddff; }
    .copy-btn { position: absolute; top: 8px; right: 12px; background: #37474f; border: none; color: #90a4ae; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
    .copy-btn:hover { background: #455a64; color: #fff; }
    .auth-info { background: #fff3e0; padding: 15px; border-radius: 8px; border-left: 4px solid var(--warning); }
    .auth-info h4 { margin: 0 0 10px 0; color: var(--warning); }
    .step { display: flex; gap: 15px; margin-bottom: 15px; }
    .step-num { background: var(--primary); color: white; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 600; flex-shrink: 0; }
    .step-content { flex: 1; }
    .step-content h4 { margin: 0 0 5px 0; }
    .step-content p { margin: 0; color: #666; }
    a { color: var(--primary); }
    .tag { display: inline-block; background: #e3f2fd; color: var(--primary); padding: 2px 8px; border-radius: 4px; font-size: 11px; margin-left: 8px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="breadcrumb">
      <a href="${baseUrl}/">← Terug naar landing page</a>
    </div>

    <h1>🔌 MCP API Documentatie</h1>
    <p class="subtitle">Model Context Protocol endpoint voor AI agent integratie</p>

    <div class="card">
      <h2>Endpoint</h2>
      <p>
        <span class="method-badge">POST</span>
        <span class="endpoint-url">${baseUrl}/mcp</span>
      </p>
      <p style="margin-top:15px; color:#666;">
        Dit endpoint implementeert het <a href="https://modelcontextprotocol.io" target="_blank">Model Context Protocol</a> (MCP) -
        een open standaard voor AI agent communicatie met externe tools en data.
      </p>
    </div>

    <div class="card">
      <h2>Authenticatie</h2>
      <div class="auth-info">
        <h4>🔐 API Key Vereist</h4>
        <p>Alle requests naar <code>/mcp</code> vereisen een permanente API key via de Authorization header.</p>
      </div>

      <div style="margin-top: 20px;">
        <div class="step">
          <div class="step-num">1</div>
          <div class="step-content">
            <h4>Download de client</h4>
            <p><a href="${baseUrl}/client.sh">Bash</a> of <a href="${baseUrl}/client.ps1">PowerShell</a></p>
          </div>
        </div>
        <div class="step">
          <div class="step-num">2</div>
          <div class="step-content">
            <h4>Login via OAuth</h4>
            <p><code>./mcp-client.sh login</code> - opent browser voor Authentik SSO</p>
          </div>
        </div>
        <div class="step">
          <div class="step-num">3</div>
          <div class="step-content">
            <h4>Genereer permanente API key</h4>
            <p><code>./mcp-client.sh api-key</code> - genereert JWT-based key (geldig 1 jaar)</p>
          </div>
        </div>
        <div class="step">
          <div class="step-num">4</div>
          <div class="step-content">
            <h4>Configureer Claude Desktop</h4>
            <p>API key wordt opgeslagen in <code>~/.mcp-client-apikey</code> en getoond met config voorbeeld</p>
          </div>
        </div>
      </div>

      <p style="margin-top: 15px; color: #666;">
        <strong>Of via browser:</strong> <a href="${baseUrl}/api-key">/api-key</a> endpoint (na OAuth login)
      </p>
    </div>

    <div class="card">
      <h2>Beschikbare Tools <span class="tag">${tools.length} tools</span></h2>
      <table class="tools-table">
        <thead>
          <tr><th>Tool</th><th>Beschrijving</th><th>Parameters</th></tr>
        </thead>
        <tbody>
          ${toolRows}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>Request Voorbeeld</h2>
      <p>MCP gebruikt JSON-RPC 2.0 formaat:</p>
      <div class="code-block" id="example-request">
<span class="comment"># Voorbeeld: Lijst alle running packages</span>
curl -X POST "${baseUrl}/mcp" \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    <span class="key">"jsonrpc"</span>: <span class="string">"2.0"</span>,
    <span class="key">"method"</span>: <span class="string">"tools/call"</span>,
    <span class="key">"params"</span>: {
      <span class="key">"name"</span>: <span class="string">"package_list"</span>,
      <span class="key">"arguments"</span>: { <span class="key">"status"</span>: <span class="string">"running"</span> }
    },
    <span class="key">"id"</span>: 1
  }'</div>
    </div>

    <div class="card">
      <h2>Claude Desktop Integratie</h2>
      <p>Voeg toe aan <code>claude_desktop_config.json</code>:</p>
      <div class="code-block" id="claude-config">{
  <span class="key">"mcpServers"</span>: {
    <span class="key">"mcp-server"</span>: {
      <span class="key">"command"</span>: <span class="string">"npx"</span>,
      <span class="key">"args"</span>: [<span class="string">"-y"</span>, <span class="string">"@anthropic-ai/mcp-remote"</span>, <span class="string">"${baseUrl}/mcp"</span>],
      <span class="key">"env"</span>: { <span class="key">"MCP_API_KEY"</span>: <span class="string">"YOUR_API_KEY"</span> }
    }
  }
}</div>
      <p style="margin-top:15px; color:#666;">
        Vervang <code>YOUR_API_KEY</code> met de key uit <code>~/.mcp-client-apikey</code>
        (gegenereerd via <code>./mcp-client.sh api-key</code>).
      </p>
      <p style="color:#666;">
        Na configuratie kan Claude direct tools aanroepen zoals
        <em>"Wat is de status van de n8n service?"</em> of
        <em>"Maak een nieuw ticket voor bug X"</em>.
      </p>
    </div>
  </div>
</body>
</html>`);
      return;
    }

    // Nothing else is served here. The MCP endpoint itself is /mcp, behind its own
    // check of who is calling; no other path reaches the tools.
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  };

  // ---------------------------------------------------------------------------
  // Express front: OAuth 2.1 authorization server (SDK router) + the /mcp
  // endpoint, with the legacy dispatcher as the fallback for every other route.
  const app = express();
  app.set("trust proxy", 1);

  // CORS + preflight in front of everything. A preflight (OPTIONS) carries no
  // Authorization, so it must never reach the auth gate; and a browser client can
  // only follow the WWW-Authenticate pointer if it is allowed to read it.
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "authorization, content-type, mcp-protocol-version, mcp-session-id",
    );
    res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id");
    res.setHeader("Access-Control-Max-Age", "600");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // The authorization server: /authorize, /token, /register, /revoke and the
  // metadata documents, all from the SDK, unauthenticated, at the root — a
  // connector must reach them before it holds any token. Issuer is the fixed
  // PUBLIC_URL, never a request header.
  app.use(
    mcpAuthRouter({
      provider: OAUTH_PROVIDER,
      issuerUrl: PUBLIC_URL,
      baseUrl: PUBLIC_URL,
      resourceServerUrl: RESOURCE_URL,
      resourceName: "MCP Server",
      scopesSupported: OAUTH_SCOPES,
    }),
  );

  // Three discovery paths the SDK does not mount but real connectors probe:
  // the bare protected-resource path (claude.ai asks for it), openid-configuration
  // (probed, answering costs one route), and the AS metadata under /mcp.
  const AUTH_METADATA = createOAuthMetadata({
    provider: OAUTH_PROVIDER,
    issuerUrl: PUBLIC_URL,
    baseUrl: PUBLIC_URL,
    scopesSupported: OAUTH_SCOPES,
  });
  const RESOURCE_DOC = {
    resource: RESOURCE_URL.href,
    authorization_servers: [AUTH_METADATA.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: OAUTH_SCOPES,
    resource_name: "MCP Server",
  };
  const serveMeta = (doc: unknown) => (_req: any, res: any) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(doc);
  };
  app.get("/.well-known/oauth-protected-resource", serveMeta(RESOURCE_DOC));
  app.get("/.well-known/openid-configuration", serveMeta(AUTH_METADATA));
  app.get("/mcp/.well-known/oauth-authorization-server", serveMeta(AUTH_METADATA));

  // The other half of /authorize: the sign-in page posts here. Every field came
  // from a form (editable), so client + redirect are re-checked; the key
  // decides who this is, and that identity travels with the code.
  app.post(SIGN_IN_PATH, express.urlencoded({ extended: false }), (req, res) => {
    const body = (req.body || {}) as Record<string, string>;
    Promise.resolve(OAUTH_PROVIDER.clientsStore.getClient(body["client_id"] || ""))
      .then((cl) => {
        const redirectUri = body["redirect_uri"] || "";
        if (!cl || !cl.redirect_uris.includes(redirectUri)) {
          res.status(400).send("Deze aanvraag hoort niet bij een bekende verbinding.");
          return;
        }
        const codeChallenge = body["code_challenge"] || "";
        const hidden: Record<string, string> = {
          client_id: cl.client_id,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
        };
        if (body["state"]) hidden["state"] = body["state"];
        if (body["scope"]) hidden["scope"] = body["scope"];
        if (body["resource"]) hidden["resource"] = body["resource"];

        const who = resolvePersonalToken(body["token"] || "");
        if (!who) {
          res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
          res.send(signInPage(cl, hidden, "Die sleutel kennen we niet. Probeer het opnieuw."));
          return;
        }
        const scopes = (body["scope"] || "").split(" ").filter(Boolean);
        const resource = body["resource"] ? new URL(body["resource"]) : undefined;
        const code = grantCode(who, {
          clientId: cl.client_id,
          redirectUri,
          codeChallenge,
          scopes,
          ...(resource ? { resource } : {}),
        });
        const back = new URL(redirectUri);
        back.searchParams.set("code", code);
        if (body["state"]) back.searchParams.set("state", body["state"]);
        res.redirect(back.href);
      })
      .catch(() => {
        if (!res.headersSent) res.status(500).send("sign-in error");
      });
  });

  // Authentik login callback (chained flow). Authentik redirects the browser
  // here after the human authenticates; we exchange the upstream code, learn who
  // they are, mint OUR authorization code, and bounce back to the connector.
  app.get(AK_CALLBACK_PATH, async (req: any, res: any) => {
    if (req.query.error) {
      console.error("[authentik] authorize error:", req.query.error, req.query.error_description);
      res.status(400).send("Authentik-login is afgebroken of geweigerd. Sluit dit venster en probeer opnieuw.");
      return;
    }
    const pending = takePending(String(req.query.state || ""));
    if (!pending) {
      res.status(400).send("Deze login-aanvraag is verlopen of onbekend. Probeer opnieuw te verbinden.");
      return;
    }
    try {
      const form = new URLSearchParams({
        grant_type: "authorization_code",
        code: String(req.query.code || ""),
        redirect_uri: AK_CALLBACK,
        client_id: AK_CLIENT_ID,
        client_secret: AK_CLIENT_SECRET,
        code_verifier: pending.akVerifier,
      });
      const tr = await fetch(AK_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      if (!tr.ok) {
        console.error("[authentik] token exchange failed", tr.status, (await tr.text()).slice(0, 300));
        res.status(502).send("Kon de Authentik-login niet voltooien (token-uitwisseling).");
        return;
      }
      const tj: any = await tr.json();
      let author = "authentik-user";
      if (AK_USERINFO_URL && tj.access_token) {
        try {
          const ur = await fetch(AK_USERINFO_URL, {
            headers: { authorization: `Bearer ${tj.access_token}` },
          });
          if (ur.ok) {
            const ui: any = await ur.json();
            author = ui.email || ui.preferred_username || ui.name || ui.sub || author;
          }
        } catch (e: any) {
          console.error("[authentik] userinfo failed:", e?.message || e);
        }
      }
      const ourCode = grantCode(author, {
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        scopes: pending.scope ? pending.scope.split(" ").filter(Boolean) : [],
        ...(pending.resource ? { resource: new URL(pending.resource) } : {}),
      } as any);
      const back = new URL(pending.redirectUri);
      back.searchParams.set("code", ourCode);
      if (pending.state) back.searchParams.set("state", pending.state);
      res.redirect(back.href);
    } catch (e: any) {
      console.error("[authentik] callback error:", e?.stack || e?.message || e);
      if (!res.headersSent) res.status(502).send("Authentik-login fout.");
    }
  });

  // Resolve any caller: static key, self-issued HS256 key, or OAuth access token.
  const callerOf = async (req: any): Promise<string | null> => {
    const header = (req.headers?.authorization as string) || "";
    const token = header.replace(/^Bearer\s+/i, "");
    if (!token) return null;
    const personal = resolvePersonalToken(token);
    if (personal) return personal;
    try {
      const info = await OAUTH_PROVIDER.verifyAccessToken(token);
      const a = (info as any)?.extra?.author;
      return typeof a === "string" ? a : "oauth-user";
    } catch {
      return null;
    }
  };

  // The MCP endpoint. Auth gate first (401 → resource_metadata pointer), then the
  // header fix-ups mcp-remote/python need, then a fresh stateless transport.
  app.all("/mcp", async (req: any, res: any) => {
    const who = await callerOf(req);
    if (!who) {
      res.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${PUBLIC_URL.origin}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`,
      );
      res
        .status(401)
        .json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
      return;
    }
    req.headers.accept = "application/json, text/event-stream";
    delete req.headers["accept-encoding"];
    const rawHeaders = req.rawHeaders as string[];
    for (let i = rawHeaders.length - 2; i >= 0; i -= 2) {
      const h = rawHeaders[i].toLowerCase();
      if (h === "accept") rawHeaders[i + 1] = "application/json, text/event-stream";
      else if (h === "accept-encoding") rawHeaders.splice(i, 2);
    }
    let parsedBody: unknown = undefined;
    if (req.method === "POST") {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const s = Buffer.concat(chunks).toString("utf-8");
        if (s) parsedBody = JSON.parse(s);
      } catch {
        res.status(400).json({ error: "Invalid JSON body" });
        return;
      }
    }
    try {
      const requestServer = await createMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await requestServer.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
      await transport.close();
      await requestServer.close();
    } catch (e: any) {
      console.error("MCP transport error:", e?.stack || e?.message || e);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal transport error", detail: e?.message });
      }
    }
  });

  // Everything else falls through to the original dispatcher.
  app.use((req: any, res: any) => {
    void legacyDispatch(req, res);
  });

  const httpServer = http.createServer(app);

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 MCP Server running at http://0.0.0.0:${PORT}`);
    console.log(`📋 Health check: http://0.0.0.0:${PORT}/health`);
    console.log(`🔑 API Key auth: ${API_KEYS.length > 0 ? "enabled" : "disabled"}`);
    console.log(`🔐 OAuth2 auth: ${OAUTH_ENABLED ? "enabled" : "disabled"}`);
    if (OAUTH_ENABLED) {
      console.log(`   Client ID: ${OAUTH_CLIENT_ID}`);
      console.log(`   Callback: ${OAUTH_REDIRECT_URI}`);
    }
  });
}

// Stop at once when asked to: this process is the container's first one, and without
// a handler of its own it would ignore the request until it is killed.
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

startServer().catch(console.error);
