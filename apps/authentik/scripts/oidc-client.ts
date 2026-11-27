#!/usr/bin/env bun
/**
 * Package: authentik
 * Purpose: give another app its sign-in through Authentik, without a person:
 *          make (or bring up to date) the OpenID provider and the application
 *          for it in Authentik, and put the client id and secret in .env as
 *          <APP>_OAUTH_CLIENT_ID / <APP>_OAUTH_CLIENT_SECRET.
 *          Works through Authentik's own shell in its container, so it needs
 *          no API token. Safe to repeat: an existing provider keeps its id and
 *          secret; only its redirect addresses are brought up to date.
 * Usage:   bun packages/authentik/scripts/oidc-client.ts <app> --redirect-path=/path
 *              [--redirect-path=/other] [--name="Shown name"] [--url=https://app.example.com]
 *              [--sub-mode=user_id] [--mappings=<file.json>]
 *          The app's addresses come from .env: <APP>_URL (its published
 *          address, written by `via net apply`) and <APP>_PORT (local).
 * Called by: the setup step of an app that signs in through Authentik.
 * Exit:    0 when the provider exists and .env holds its id and secret, 1 otherwise.
 *
 * @module
 */
import { readFileSync } from "node:fs";
import { envGet, setEnv, ts } from "./_setup-env.ts";

const args = process.argv.slice(2);
const app = args.find((a) => !a.startsWith("--")) ?? "";
const option = (name: string): string => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? "";
const redirectPaths = args
  .filter((a) => a.startsWith("--redirect-path="))
  .map((a) => a.slice("--redirect-path=".length));
if (!/^[a-z0-9][a-z0-9-]*$/.test(app) || !redirectPaths.length || redirectPaths.some((p) => !p.startsWith("/"))) {
  console.error(
    "Usage: bun oidc-client.ts <app> --redirect-path=/path [--redirect-path=/other] [--name=...] [--url=...]",
  );
  process.exit(1);
}
const KEY = app.toUpperCase().replace(/-/g, "_");

// What an app needs from Authentik beyond a plain client, used when its provider is made:
// --sub-mode=user_id (which value identifies the user) and --mappings=<file>, a JSON list of
// { name, scope_name, description, expression } that say what Authentik tells the app about a user.
const subMode = option("sub-mode");
interface Mapping {
  name: string;
  scope_name: string;
  description?: string;
  expression: string;
}
let mappings: Mapping[] = [];
if (option("mappings")) {
  try {
    mappings = JSON.parse(readFileSync(option("mappings"), "utf8")) as Mapping[];
  } catch (error) {
    console.error(`[authentik] ERROR: cannot read ${option("mappings")}: ${(error as Error).message}`);
    process.exit(1);
  }
}
const container = `${envGet("CONTAINER_PREFIX")}authentik`;

function fail(message: string): never {
  console.error(`[authentik] ERROR: ${message}`);
  process.exit(1);
}

// Where the app's sign-in comes back: its published address, or its local port when it has none.
const redirects: string[] = [];
const publicUrl = (option("url") || envGet(`${KEY}_URL`)).replace(/\/+$/, "");
const port = envGet(`${KEY}_PORT`);
const published = /^https?:\/\//.test(publicUrl);
for (const redirectPath of redirectPaths) {
  // A published app is signed in to at its published address only; its local port is for an app without one.
  if (published) redirects.push(`${publicUrl}${redirectPath}`);
  else if (port) redirects.push(`http://localhost:${port}${redirectPath}`, `http://127.0.0.1:${port}${redirectPath}`);
}
if (!redirects.length) fail(`no address for ${app}: neither ${KEY}_URL nor ${KEY}_PORT is in .env`);

const python = `
import json
from authentik.core.models import Application
from authentik.crypto.models import CertificateKeyPair
from authentik.flows.models import Flow
from authentik.providers.oauth2.models import OAuth2Provider, RedirectURI, RedirectURIMatchingMode, ScopeMapping
def standard_mapping(scope):
    # Authentik's own mapping for a scope: the managed one, or the same one after an
    # administrator took it out of Authentik's management to change it.
    return (ScopeMapping.objects.filter(managed="goauthentik.io/providers/oauth2/scope-" + scope).first()
        or ScopeMapping.objects.filter(scope_name=scope, name__startswith="authentik default OAuth Mapping").first())


slug = ${JSON.stringify(app)}
name = ${JSON.stringify(option("name") || app)}
wanted = ${JSON.stringify(redirects)}
made = False
# The client the app already uses (its id is in .env) is the one to keep, whatever it is called.
known = ${JSON.stringify(envGet(`${KEY}_OAUTH_CLIENT_ID`))}
provider = OAuth2Provider.objects.filter(client_id=known).first() if known else None
if provider is None:
    provider = OAuth2Provider.objects.filter(name=slug).first()
if provider is None:
    existing = Application.objects.filter(slug=slug).first()
    provider = OAuth2Provider.objects.filter(pk=existing.provider_id).first() if existing and existing.provider_id else None
import time
def flow_for(slug, designation):
    # Authentik makes its own flows a little after its first start; a provider without one answers every sign-in with an error.
    for _ in range(90):
        found = Flow.objects.filter(slug=slug).first() or Flow.objects.filter(designation=designation).first()
        if found is not None:
            return found
        time.sleep(2)
    raise SystemExit("Authentik has no " + designation + " flow after three minutes")
if provider is None:
    provider = OAuth2Provider.objects.create(name=slug, authorization_flow=flow_for("default-provider-authorization-implicit-consent", "authorization"), invalidation_flow=flow_for("default-provider-invalidation-flow", "invalidation"))
    made = True
    # What this app needs beyond a plain client. Only for a provider made here: an existing one keeps its own.
    sub_mode = ${JSON.stringify(subMode)}
    if sub_mode:
        provider.sub_mode = sub_mode
    own = []
    for wanted_mapping in json.loads(${JSON.stringify(JSON.stringify(mappings))}):
        mapping, _ = ScopeMapping.objects.get_or_create(name=wanted_mapping["name"], defaults={"scope_name": wanted_mapping["scope_name"], "description": wanted_mapping.get("description", ""), "expression": wanted_mapping["expression"]})
        own.append(mapping)
    if own:
        taken = {mapping.scope_name for mapping in own}
        standard = [m for m in (standard_mapping(scope) for scope in ("openid", "email", "profile")) if m is not None and m.scope_name not in taken]
        provider.save()
        provider.property_mappings.set(own + standard)
# A provider made before Authentik had its flows is completed here.
if provider.authorization_flow_id is None:
    provider.authorization_flow = flow_for("default-provider-authorization-implicit-consent", "authorization")
if provider.invalidation_flow_id is None:
    provider.invalidation_flow = flow_for("default-provider-invalidation-flow", "invalidation")
if provider.signing_key_id is None:
    # Authentik's own certificate for signing, not the internal one it manages and may replace.
    usable = CertificateKeyPair.objects.exclude(key_data="")
    provider.signing_key = usable.filter(managed__isnull=True).order_by("name").first() or usable.order_by("name").first()
# Addresses already there stay (also patterns somebody added); missing ones are added.
uris = list(provider.redirect_uris)
have = [u.url for u in uris]
added = [w for w in wanted if w not in have]
provider.redirect_uris = uris + [RedirectURI(RedirectURIMatchingMode.STRICT, w) for w in added]
provider.save()
# Who signs in is told by openid, email and profile: a scope no mapping of the client covers
# yet gets Authentik's own. Authentik makes those three a little after its first start, so a
# client made right then is completed here, also on a later run.
import time
for _ in range(90):
    if all(standard_mapping(scope) is not None for scope in ("openid", "email", "profile")):
        break
    time.sleep(2)
covered = set(ScopeMapping.objects.filter(pk__in=provider.property_mappings.values_list("pk", flat=True)).values_list("scope_name", flat=True))
still = []
for scope in ("openid", "email", "profile"):
    if scope in covered:
        continue
    mapping = standard_mapping(scope)
    if mapping is None:
        still.append(scope)
    else:
        provider.property_mappings.add(mapping)
if still:
    print("VIA_ERROR Authentik has no mapping yet for: " + ", ".join(still))
# A provider serves one application: the one it has already stays, whatever its slug.
application = Application.objects.filter(provider=provider).first() or Application.objects.filter(slug=slug).first()
if application is None:
    application = Application.objects.create(name=name, slug=slug, provider=provider)
elif application.provider_id != provider.pk:
    application.provider = provider
    application.save()
print("VIA_JSON " + json.dumps({"made": made, "added": added, "client_id": provider.client_id, "client_secret": provider.client_secret, "signing_key": provider.signing_key_id is not None}))
`;

const run = Bun.spawnSync(["docker", "exec", "-i", container, "ak", "shell"], {
  stdin: Buffer.from(`${python}\n`),
  stdout: "pipe",
  stderr: "pipe",
});
const line = run.stdout
  .toString()
  .split("\n")
  .filter((l) => l.startsWith("VIA_JSON "))
  .pop();
const refused = run.stdout
  .toString()
  .split("\n")
  .filter((l) => l.startsWith("VIA_ERROR "))
  .pop();
if (refused) fail(refused.slice("VIA_ERROR ".length));
if (!line)
  fail(
    `Authentik's shell gave no answer (exit ${run.exitCode}): ${run.stderr.toString().trim().split("\n").pop() ?? ""}`,
  );
const result = JSON.parse(line.slice("VIA_JSON ".length)) as {
  made: boolean;
  added: string[];
  client_id: string;
  client_secret: string;
  signing_key: boolean;
};
if (!result.client_id || !result.client_secret) fail("Authentik gave no client id or secret");

ts(result.made ? `✓ Sign-in for ${app} made in Authentik.` : `✓ Sign-in for ${app} already in Authentik.`);
for (const uri of result.added) ts(`  ✓ Redirect address added: ${uri}`);
if (!result.signing_key) ts("  ⚠ Authentik has no certificate to sign with; tokens are signed with the client secret.");
let wrote = false;
if (envGet(`${KEY}_OAUTH_CLIENT_ID`) !== result.client_id)
  wrote = (await setEnv(`${KEY}_OAUTH_CLIENT_ID`, result.client_id)) || wrote;
if (envGet(`${KEY}_OAUTH_CLIENT_SECRET`) !== result.client_secret)
  wrote = (await setEnv(`${KEY}_OAUTH_CLIENT_SECRET`, result.client_secret)) || wrote;
ts(
  wrote
    ? `  ✓ ${KEY}_OAUTH_CLIENT_ID and ${KEY}_OAUTH_CLIENT_SECRET saved in .env.`
    : "  ✓ .env already holds its client id and secret.",
);
// Where a browser on this machine finds Authentik when it has no published address. An app's
// compose file can fall back to it: AUTHENTIK_URL when set, else AUTHENTIK_LOCAL_URL.
const authentikPort = envGet("AUTHENTIK_PORT");
if (authentikPort && envGet("AUTHENTIK_LOCAL_URL") !== `http://localhost:${authentikPort}`) {
  wrote = (await setEnv("AUTHENTIK_LOCAL_URL", `http://localhost:${authentikPort}`)) || wrote;
  ts(`  ✓ AUTHENTIK_LOCAL_URL set to http://localhost:${authentikPort}`);
}
// Tells the caller whether the app must be started again to pick the values up.
console.log(`VIA_CHANGED ${wrote ? "yes" : "no"}`);
