#!/usr/bin/env bun
/**
 * Package: authentik
 * Purpose: give another app its SAML sign-in through Authentik, without a
 *          person: make (or bring up to date) the SAML provider and the
 *          application for it in Authentik, and hand the caller what the app
 *          needs: the sign-in address and Authentik's signing certificate.
 *          Works through Authentik's own shell in its container, so it needs
 *          no API token. Safe to repeat: an existing provider keeps its
 *          settings; the address the answer is sent to is changed only when it
 *          is not at the app's own address, and attribute mappings and a signing certificate are
 *          added when it has none.
 * Usage:   bun packages/authentik/scripts/saml-client.ts <app> --acs-path=/path
 *              --audience-path=/path [--name="Shown name"] [--url=https://app.example.com]
 *              [--mappings=<file.json>]
 *          --mappings: a JSON list of { name, saml_name, expression }: attributes the app
 *          needs that Authentik does not send by itself (a first name, say). A mapping
 *          that exists under that name is used as it is; one the provider lacks is added.
 *          The app's address comes from .env: <APP>_URL (its published
 *          address, written by `via net apply`), else http://localhost:<APP>_PORT.
 * Called by: the setup step of an app that signs in through Authentik with SAML.
 * Output:  a last line `VIA_SAML <json>` with slug, made, changed and the
 *          certificate (PEM). Nothing in it is a secret.
 * Exit:    0 when the provider exists, 1 otherwise.
 *
 * @module
 */
import { readFileSync } from "node:fs";
import { envGet, ts } from "./_setup-env.ts";

const args = process.argv.slice(2);
const app = args.find((a) => !a.startsWith("--")) ?? "";
const option = (name: string): string => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? "";
const acsPath = option("acs-path");
const audiencePath = option("audience-path");
if (!/^[a-z0-9][a-z0-9-]*$/.test(app) || !acsPath.startsWith("/") || !audiencePath.startsWith("/")) {
  console.error("Usage: bun saml-client.ts <app> --acs-path=/path --audience-path=/path [--name=...] [--url=...]");
  process.exit(1);
}
const KEY = app.toUpperCase().replace(/-/g, "_");
interface Mapping {
  name: string;
  saml_name: string;
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

const published = (option("url") || envGet(`${KEY}_URL`)).replace(/\/+$/, "");
const port = envGet(`${KEY}_PORT`);
const own = /^https?:\/\//.test(published) ? published : port ? `http://localhost:${port}` : "";
if (!own) fail(`no address for ${app}: neither ${KEY}_URL nor ${KEY}_PORT is in .env`);

const python = `
import json
from authentik.core.models import Application
from authentik.crypto.models import CertificateKeyPair
from authentik.flows.models import Flow
from authentik.providers.saml.models import SAMLPropertyMapping, SAMLProvider
slug = ${JSON.stringify(app)}
name = ${JSON.stringify(option("name") || app)}
acs = ${JSON.stringify(`${own}${acsPath}`)}
audience = ${JSON.stringify(`${own}${audiencePath}`)}
made = False
changed = []
# The provider the application already has is the one to keep, whatever it is called.
application = Application.objects.filter(slug=slug).first()
provider = SAMLProvider.objects.filter(pk=application.provider_id).first() if application and application.provider_id else None
if provider is None:
    provider = SAMLProvider.objects.filter(name=slug).first()
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
    provider = SAMLProvider(name=slug, authorization_flow=flow_for("default-provider-authorization-implicit-consent", "authorization"), acs_url=acs, audience=audience, sp_binding="post")
    if hasattr(provider, "invalidation_flow"):
        provider.invalidation_flow = flow_for("default-provider-invalidation-flow", "invalidation")
    provider.save()
    made = True
# A provider made before Authentik had its flows is completed here.
if provider.authorization_flow_id is None:
    provider.authorization_flow = flow_for("default-provider-authorization-implicit-consent", "authorization")
    changed.append("authorization_flow")
if hasattr(provider, "invalidation_flow") and provider.invalidation_flow_id is None:
    provider.invalidation_flow = flow_for("default-provider-invalidation-flow", "invalidation")
    changed.append("invalidation_flow")
# An address that is already at the app's own address stays as it is.
if not (provider.acs_url or "").startswith(${JSON.stringify(own)} + "/"):
    provider.acs_url = acs
    changed.append("acs_url")
if provider.signing_kp_id is None:
    # Authentik's own certificate for signing, not the internal one it manages and may replace.
    usable = CertificateKeyPair.objects.exclude(key_data="")
    provider.signing_kp = usable.filter(managed__isnull=True).order_by("name").first() or usable.order_by("name").first()
    changed.append("signing_kp")
if made:
    # The app is told who signed in by e-mail address.
    email = SAMLPropertyMapping.objects.filter(managed="goauthentik.io/providers/saml/email").first()
    if email is not None:
        provider.name_id_mapping = email
provider.save()
if provider.property_mappings.count() == 0:
    provider.property_mappings.set(SAMLPropertyMapping.objects.filter(managed__startswith="goauthentik.io/providers/saml"))
    changed.append("property_mappings")
# Attributes this app needs on top of Authentik's own.
for wanted_mapping in json.loads(${JSON.stringify(JSON.stringify(mappings))}):
    mapping, _ = SAMLPropertyMapping.objects.get_or_create(name=wanted_mapping["name"], defaults={"saml_name": wanted_mapping["saml_name"], "expression": wanted_mapping["expression"]})
    if not provider.property_mappings.filter(pk=mapping.pk).exists():
        provider.property_mappings.add(mapping)
        changed.append("mapping " + wanted_mapping["saml_name"])
if application is None:
    application = Application.objects.create(name=name, slug=slug, provider=provider)
elif application.provider_id != provider.pk:
    application.provider = provider
    application.save()
certificate = provider.signing_kp.certificate_data if provider.signing_kp_id else ""
print("VIA_JSON " + json.dumps({"slug": application.slug, "made": made, "changed": changed, "certificate": certificate}))
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
if (!line)
  fail(
    `Authentik's shell gave no answer (exit ${run.exitCode}): ${run.stderr.toString().trim().split("\n").pop() ?? ""}`,
  );
const result = JSON.parse(line.slice("VIA_JSON ".length)) as {
  slug: string;
  made: boolean;
  changed: string[];
  certificate: string;
};
if (!result.certificate) fail("Authentik has no certificate to sign with; SAML sign-in needs one.");

ts(result.made ? `✓ SAML sign-in for ${app} made in Authentik.` : `✓ SAML sign-in for ${app} already in Authentik.`);
if (!result.made && result.changed.length) ts(`  ✓ Brought up to date: ${result.changed.join(", ")}`);
console.log(`VIA_SAML ${JSON.stringify(result)}`);
