/**
 * OAuth 2.1 authorization server for the MCP endpoint.
 *
 * A hosted assistant (Claude, ChatGPT) cannot paste an API key into a header:
 * its connector screen takes only a URL and then runs the authorization-code
 * flow itself — discovering the metadata, registering a client on the fly
 * (RFC 7591), and proving possession of the code with PKCE. So the MCP server
 * has to BE an authorization server as well as a resource server. This file is
 * that half.
 *
 * Design ported from ext/DigitaleKraamzorg (content-studio), which is proven
 * against both claude.ai and chatgpt.com. The only substitutions here:
 *   - storage is bun:sqlite (embedded, one file) instead of MariaDB/Kysely, so
 *     the MCP server keeps needing no external database;
 *   - "who is at the keyboard" is decided by server.ts, which already owns the
 *     API keys (static MCP_API_KEYS + self-issued HS256 keys). The sign-in
 *     page posts the key back and server.ts resolves it to an identity string
 *     that then travels code -> access token -> tool call.
 *
 * WHAT THE SDK DOES: `mcpAuthRouter` mounts /authorize, /token, /register,
 * /revoke and the metadata documents, validates redirect URIs, and does the
 * PKCE S256 check itself. What is left here is the provider: where clients,
 * codes and tokens live. Codes and tokens are stored as a SHA-256 of
 * themselves, never the value.
 */

import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "crypto";
import { mkdirSync } from "fs";
import { dirname } from "path";

import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Response } from "express";

/* ---------------------------------------------------------------- basics --- */

/** The one scope this server has. Always granted, always echoed back. */
export const SCOPE = "mcp";

/** A code is a handoff, not a credential. Tokens last an hour; refresh forever. */
const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_S = 60 * 60;

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const secret = (): string => randomBytes(32).toString("base64url");

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/* -------------------------------------------------------------- database --- */

let db: Database | null = null;

/** Open (and migrate) the token store. Idempotent; call once at startup. */
export function initOAuthDb(path?: string): Database {
  if (db) return db;
  const file =
    path ||
    process.env.MCP_OAUTH_DB ||
    "./data/oauth.sqlite";
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch {
    /* dir may already exist */
  }
  db = new Database(file, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(`CREATE TABLE IF NOT EXISTS oauth_client (
    id TEXT PRIMARY KEY,
    name TEXT,
    secret TEXT,
    redirect_uris TEXT NOT NULL,
    registration TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS oauth_code (
    code TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    author TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    resource TEXT,
    scopes TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS oauth_token (
    token TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    client_id TEXT NOT NULL,
    author TEXT NOT NULL,
    scopes TEXT NOT NULL,
    resource TEXT,
    expires_at INTEGER
  )`);
  // A connector's authorization request, parked while the human logs in at the
  // upstream IdP (Authentik). Keyed by an id we hand to the IdP as `state`.
  db.run(`CREATE TABLE IF NOT EXISTS oauth_pending (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    state TEXT,
    scope TEXT,
    resource TEXT,
    ak_verifier TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  return db;
}

/* ------------------------------------------------------ pending (chained) --- */

export interface PendingAuth {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scope?: string;
  resource?: string;
  akVerifier: string;
}

/** Park a connector's authorization while the human logs in upstream. */
export function savePending(p: PendingAuth): string {
  const id = secret();
  conn().run(
    "INSERT INTO oauth_pending (id, client_id, redirect_uri, code_challenge, state, scope, resource, ak_verifier, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      p.clientId,
      p.redirectUri,
      p.codeChallenge,
      p.state ?? null,
      p.scope ?? null,
      p.resource ?? null,
      p.akVerifier,
      Date.now() + CODE_TTL_MS,
    ],
  );
  return id;
}

/** Read a parked authorization back exactly once (deleted on read). */
export function takePending(id: string): PendingAuth | null {
  const c = conn();
  const row = c
    .query(
      "SELECT client_id, redirect_uri, code_challenge, state, scope, resource, ak_verifier, expires_at FROM oauth_pending WHERE id = ?",
    )
    .get(id) as
    | {
        client_id: string;
        redirect_uri: string;
        code_challenge: string;
        state: string | null;
        scope: string | null;
        resource: string | null;
        ak_verifier: string;
        expires_at: number;
      }
    | null;
  if (!row) return null;
  c.run("DELETE FROM oauth_pending WHERE id = ?", [id]);
  if (row.expires_at < Date.now()) return null;
  return {
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    state: row.state ?? undefined,
    scope: row.scope ?? undefined,
    resource: row.resource ?? undefined,
    akVerifier: row.ak_verifier,
  };
}

function conn(): Database {
  return db ?? initOAuthDb();
}

/* ---------------------------------------------------------------- clients --- */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Is this somewhere a code may be sent? Not a host allowlist (see registerClient
 * — ChatGPT mints a per-connector callback so no exact list is ever complete).
 * What it refuses are the two ways a redirect lies about its destination: a
 * fragment (RFC 6749 §3.1.2) and user information, which is how
 * `https://claude.ai@example.com/` reads as claude.ai to a glancing eye.
 */
export function usableRedirect(raw: string): boolean {
  let uri: URL;
  try {
    uri = new URL(raw);
  } catch {
    return false;
  }
  if (uri.hash || uri.username || uri.password) return false;
  if (uri.protocol === "https:") return true;
  return uri.protocol === "http:" && LOOPBACK.has(uri.hostname);
}

function clientsStore(): OAuthRegisteredClientsStore {
  return {
    getClient(clientId: string): OAuthClientInformationFull | undefined {
      const row = conn()
        .query("SELECT registration FROM oauth_client WHERE id = ?")
        .get(clientId) as { registration: string } | null;
      if (!row) return undefined;
      return parseJson<OAuthClientInformationFull>(
        row.registration,
        {} as OAuthClientInformationFull,
      );
    },

    /**
     * Open registration: a connector cannot be entered here in advance, so
     * refusing unknown clients would refuse every one of them. Registering
     * proves nothing about a person — the sign-in page is where the decision is
     * made. The shape checks below only stop a redirect that lies about where
     * the code is going.
     */
    registerClient(client: OAuthClientInformationFull): OAuthClientInformationFull {
      for (const uri of client.redirect_uris) {
        if (!usableRedirect(uri)) {
          throw new InvalidClientMetadataError(
            `"${uri}" cannot be a redirect: use https, or http on a loopback address, ` +
              "with no fragment and no user information in it.",
          );
        }
      }
      conn().run(
        "INSERT OR REPLACE INTO oauth_client (id, name, secret, redirect_uris, registration, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [
          client.client_id,
          client.client_name ?? "",
          client.client_secret ? hash(client.client_secret) : null,
          JSON.stringify(client.redirect_uris),
          JSON.stringify(client),
          Date.now(),
        ],
      );
      return client;
    },
  };
}

/* ------------------------------------------------------------- sign-in --- */

/** Where the sign-in form posts back to. Mounted in server.ts. */
export const SIGN_IN_PATH = "/oauth/sign-in";

const escape = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

/**
 * The one screen a person sees in this flow. Plain, and explicit about what is
 * being connected: it names the client the way the client named itself, which
 * is unverified — hence the line saying so. The password is the person's
 * API key (the same secret curl and .mcp.json put in a Bearer header).
 */
export function signInPage(
  client: OAuthClientInformationFull,
  hidden: Record<string, string>,
  error?: string,
): string {
  const fields = Object.entries(hidden)
    .map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`)
    .join("\n      ");
  const name = client.client_name ?? client.client_id;
  return `<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MCP — verbinden</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center;
           font: 16px/1.55 system-ui, sans-serif; background: #f5f7fa; color: #263238; }
    @media (prefers-color-scheme: dark) { body { background: #161b1e; color: #e7edf0; } }
    main { width: min(30rem, 92vw); padding: 2rem; border-radius: 16px;
           background: color-mix(in srgb, Canvas 88%, transparent); box-shadow: 0 12px 40px rgb(0 0 0 / .12); }
    h1 { font-size: 1.3rem; margin: 0 0 .4rem; }
    p { margin: .4rem 0 1rem; }
    .who { font-weight: 600; }
    .note { font-size: .86rem; opacity: .75; }
    label { display: block; font-size: .9rem; margin-bottom: .35rem; }
    input[type=password] { width: 100%; box-sizing: border-box; padding: .7rem .8rem; font: inherit;
           border: 1px solid rgb(128 128 128 / .45); border-radius: 10px; background: Canvas; color: inherit; }
    button { margin-top: 1rem; width: 100%; padding: .75rem 1rem; font: inherit; font-weight: 600;
           border: 0; border-radius: 10px; background: #1976d2; color: #fff; cursor: pointer; }
    .error { margin: 0 0 1rem; padding: .7rem .8rem; border-radius: 10px;
           background: #fdecec; color: #7a2020; font-size: .9rem; }
    @media (prefers-color-scheme: dark) { .error { background: #46201d; color: #f6c9c4; } }
  </style>
</head>
<body>
  <main>
    <h1>Verbinden met de MCP-server</h1>
    <p><span class="who">${escape(name)}</span> wil namens jou toegang tot de tools van deze
       MCP-server.</p>
    ${error ? `<p class="error">${escape(error)}</p>` : ""}
    <form method="post" action="${SIGN_IN_PATH}">
      ${fields}
      <label for="token">Je API-sleutel</label>
      <input id="token" name="token" type="password" autocomplete="current-password" autofocus required>
      <button type="submit">Verbinden</button>
    </form>
    <p class="note">De naam hierboven komt van de aanvrager zelf en is niet door ons
       gecontroleerd. Deze verbinding krijgt dezelfde rechten als je API-sleutel.</p>
  </main>
</body>
</html>`;
}

/* -------------------------------------------------------------- provider --- */

function issue(
  clientId: string,
  asked: string[],
  author: string,
  resource: URL | undefined,
): OAuthTokens {
  // Never an empty `scope` in the reply: a client that indexes the field reads
  // an empty string as "nothing was granted" and stops.
  const scopes = asked.length ? asked : [SCOPE];
  const access = secret();
  const refresh = secret();
  const scopesJson = JSON.stringify(scopes);
  const res = resource?.href ?? null;
  const c = conn();
  c.run(
    "INSERT INTO oauth_token (token, kind, client_id, author, scopes, resource, expires_at) VALUES (?, 'access', ?, ?, ?, ?, ?)",
    [hash(access), clientId, author, scopesJson, res, Date.now() + ACCESS_TTL_S * 1000],
  );
  // No expiry on the refresh token on purpose; /revoke is what ends it.
  c.run(
    "INSERT INTO oauth_token (token, kind, client_id, author, scopes, resource, expires_at) VALUES (?, 'refresh', ?, ?, ?, ?, NULL)",
    [hash(refresh), clientId, author, scopesJson, res],
  );
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_S,
    refresh_token: refresh,
    scope: scopes.join(" "),
  };
}

/**
 * Turn a signed-in person plus a pending authorization into a code. Called by
 * the POST handler in server.ts once the API key checked out. Lives here so the
 * write and the read of an `oauth_code` row sit in one file.
 */
export function grantCode(
  author: string,
  params: AuthorizationParams & { clientId: string },
): string {
  const code = secret();
  conn().run(
    "INSERT INTO oauth_code (code, client_id, author, redirect_uri, code_challenge, resource, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      hash(code),
      params.clientId,
      author,
      params.redirectUri,
      params.codeChallenge,
      params.resource?.href ?? null,
      JSON.stringify(params.scopes ?? []),
      Date.now() + CODE_TTL_MS,
    ],
  );
  return code;
}

export interface OAuthProviderOptions {
  /**
   * Override the /authorize step. When set (e.g. to redirect the human to an
   * upstream IdP like Authentik), it replaces the built-in API-key sign-in page.
   */
  authorize?: (
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ) => void | Promise<void>;
}

export function oauthProvider(opts: OAuthProviderOptions = {}): OAuthServerProvider {
  const store = clientsStore();
  return {
    get clientsStore() {
      return store;
    },

    /**
     * Either delegate to the injected authorize handler (Authentik login), or
     * show the built-in API-key sign-in page. The SDK has already checked the
     * client and redirect URI; anything carried through the page is re-checked
     * on the way back (a hidden field is editable).
     */
    authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
      if (opts.authorize) return Promise.resolve(opts.authorize(client, params, res));
      const hidden: Record<string, string> = {
        client_id: client.client_id,
        redirect_uri: params.redirectUri,
        code_challenge: params.codeChallenge,
      };
      if (params.state) hidden["state"] = params.state;
      if (params.scopes?.length) hidden["scope"] = params.scopes.join(" ");
      if (params.resource) hidden["resource"] = params.resource.href;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(signInPage(client, hidden));
      return Promise.resolve();
    },

    challengeForAuthorizationCode(
      client: OAuthClientInformationFull,
      authorizationCode: string,
    ): Promise<string> {
      const row = conn()
        .query("SELECT code_challenge, expires_at FROM oauth_code WHERE code = ? AND client_id = ?")
        .get(hash(authorizationCode), client.client_id) as
        | { code_challenge: string; expires_at: number }
        | null;
      if (!row) throw new InvalidGrantError("Unknown or already used authorization code.");
      if (row.expires_at < Date.now()) throw new InvalidGrantError("That code has expired.");
      return Promise.resolve(row.code_challenge);
    },

    exchangeAuthorizationCode(
      client: OAuthClientInformationFull,
      authorizationCode: string,
      _codeVerifier?: string,
      redirectUri?: string,
      resource?: URL,
    ): Promise<OAuthTokens> {
      const c = conn();
      const codeHash = hash(authorizationCode);
      const row = c
        .query(
          "SELECT redirect_uri, scopes, author, expires_at FROM oauth_code WHERE code = ? AND client_id = ?",
        )
        .get(codeHash, client.client_id) as
        | { redirect_uri: string; scopes: string; author: string; expires_at: number }
        | null;
      if (!row) throw new InvalidGrantError("Unknown or already used authorization code.");
      // Deleted before minting, not after: a code is good for exactly one
      // exchange, and a failure below must not leave it usable a second time.
      c.run("DELETE FROM oauth_code WHERE code = ?", [codeHash]);
      if (row.expires_at < Date.now()) throw new InvalidGrantError("That code has expired.");
      if (redirectUri && redirectUri !== row.redirect_uri) {
        throw new InvalidGrantError("The redirect URI is not the one the code was issued for.");
      }
      return Promise.resolve(
        issue(client.client_id, parseJson<string[]>(row.scopes, []), row.author, resource),
      );
    },

    exchangeRefreshToken(
      client: OAuthClientInformationFull,
      refreshToken: string,
      scopes?: string[],
      resource?: URL,
    ): Promise<OAuthTokens> {
      const row = conn()
        .query(
          "SELECT scopes, author FROM oauth_token WHERE token = ? AND kind = 'refresh' AND client_id = ?",
        )
        .get(hash(refreshToken), client.client_id) as
        | { scopes: string; author: string }
        | null;
      if (!row) throw new InvalidGrantError("Unknown refresh token.");
      return Promise.resolve(
        issue(client.client_id, scopes ?? parseJson<string[]>(row.scopes, []), row.author, resource),
      );
    },

    verifyAccessToken(token: string): Promise<AuthInfo> {
      const row = conn()
        .query(
          "SELECT client_id, author, scopes, expires_at FROM oauth_token WHERE token = ? AND kind = 'access'",
        )
        .get(hash(token)) as
        | { client_id: string; author: string; scopes: string; expires_at: number }
        | null;
      if (!row) throw new InvalidTokenError("Unknown access token.");
      if (row.expires_at < Date.now()) throw new InvalidTokenError("That access token has expired.");
      return Promise.resolve({
        token,
        clientId: row.client_id,
        scopes: parseJson<string[]>(row.scopes, []),
        expiresAt: Math.floor(row.expires_at / 1000),
        // The whole point of the flow: who signed in, carried code -> token.
        extra: { author: row.author },
      });
    },

    revokeToken(
      client: OAuthClientInformationFull,
      request: OAuthTokenRevocationRequest,
    ): Promise<void> {
      conn().run("DELETE FROM oauth_token WHERE token = ? AND client_id = ?", [
        hash(request.token),
        client.client_id,
      ]);
      return Promise.resolve();
    },
  };
}
