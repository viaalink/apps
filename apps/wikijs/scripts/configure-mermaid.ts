#!/usr/bin/env bun
/**
 * Wiki.js: inject Mermaid 11 via Admin > General > Site Code (head).
 *
 * #3898, Epic #3896. Wiki.js 2.x bundles Mermaid 8.8.2 which chokes on
 * `subgraph`, `[(...)]`, and styling. A full Wiki.js 3 migration is out
 * of scope; instead we override the bundled renderer at runtime by
 * injecting an ES-module Mermaid 11 script into the page <head>.
 *
 * Strategy:
 *   1. Build the injection block (Mermaid 11 pinned via CDN URL).
 *   2. Read the current `theming` setting (JSON blob).
 *   3. If `injectHead` already contains an `MMD11-MARKER` block, exit 0
 *      (idempotent). Otherwise replace/append the marker block.
 *   4. Write back via the GraphQL `theming.setConfig` mutation using
 *      WIKIJS_API_KEY. If GraphQL fails, fall back to a direct
 *      settings-table UPDATE + container restart (same pattern as
 *      connect-sign-in.ts).
 *
 * Required env: WIKIJS_PORT, WIKIJS_API_KEY (or .asd/workspace/wikijs/api-key.txt).
 * For DB fallback: CONTAINER_PREFIX.
 *
 * The injected HTML stubs the bundled `window.mermaid` before the bundle
 * defines it (preventing v8 from running), loads Mermaid 11 ESM, then
 * re-renders all `.mermaid` elements on initial load and on SPA route
 * mutations. See packages/wikijs/docs/mermaid-upgrade.md.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { envGet, ts } from "./_setup-env.ts";

const pmaPath = process.env["PMA_PATH"] ?? process.cwd();
const port = process.env["WIKIJS_PORT"] ?? envGet("WIKIJS_PORT");
if (!port) {
  console.error("[WIKIJS] ERROR: WIKIJS_PORT not set in .env");
  process.exit(1);
}
const base = `http://localhost:${port}`;
const keyfile = join(pmaPath, ".asd/workspace/wikijs/api-key.txt");

function loadApiKey(): string {
  const fromEnv = process.env["WIKIJS_API_KEY"] ?? envGet("WIKIJS_API_KEY");
  if (fromEnv) return fromEnv;
  if (existsSync(keyfile)) return readFileSync(keyfile, "utf8").trim();
  return "";
}

const apiKey = loadApiKey();
if (!apiKey) {
  console.error("[WIKIJS] ERROR: no API key. Run: just wikijs-configure");
  process.exit(1);
}

// --- Build the Mermaid 11 injection block ------------------------------
// Pin a specific Mermaid 11 minor through the URL. Bumping = edit this line.
const MERMAID_VERSION = "11.4.1";
// Bump when wrapper logic changes but MERMAID_VERSION stays. Idempotency
// re-applies when either differs. #3900 playwright probe showed wrapper v1
// captured the wrong source (rendered SVG) because Wiki.js's bundled
// Mermaid 8 mutates `.mermaid` innerHTML before our module-import script
// reads it. v2 adds a synchronous early-capture script that snapshots
// dataset.source on each block as soon as it parses.
const WRAPPER_VERSION = "4";
const MARKER_OPEN = "<!-- MMD11-MARKER:START -->";
const MARKER_CLOSE = "<!-- MMD11-MARKER:END -->";

const INJECT = `${MARKER_OPEN}
<!-- mmd11-wrapper:${WRAPPER_VERSION} -->
<style>
  /* Wiki.js's content typography ({ p { margin: 1em 0; line-height: 1.7 }})
     leaks into the <p> tags Mermaid 11 wraps labels in
     (<span class="nodeLabel"><p>label</p></span>), pushing the rendered
     label height above the foreignObject's allotted box. The label gets
     clipped on screen. Reset just enough to keep mermaid's own sizing
     consistent with the source SVG dimensions. */
  .mermaid foreignObject p,
  .mermaid foreignObject ul,
  .mermaid foreignObject ol,
  .mermaid foreignObject pre,
  .mermaid foreignObject blockquote {
    margin: 0 !important;
    padding: 0 !important;
    line-height: inherit !important;
    font-size: inherit !important;
    color: inherit !important;
    display: inline !important;
  }
  .mermaid foreignObject {
    overflow: visible !important;
  }
</style>
<script>
  // Early capture: snapshot mermaid sources to dataset.source BEFORE the
  // bundled Mermaid 8 replaces innerHTML with rendered SVG.
  (function(){
    function snap(){
      document.querySelectorAll('pre.mermaid:not([data-source]), .mermaid:not([data-source])')
        .forEach(function(el){ el.dataset.source = (el.textContent || '').trim(); });
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', snap);
    } else { snap(); }
    new MutationObserver(snap).observe(document.documentElement, { childList: true, subtree: true });
  })();
  // Stub the bundled Mermaid 8 so it does not run before MMD11 takes over.
  window.mermaid = { initialize:()=>{}, init:()=>{}, contentLoaded:()=>{}, parse:()=>true, render:()=>Promise.resolve({svg:""}) };
</script>
<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.esm.min.mjs";
  window.mermaid = mermaid;
  mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "loose" });

  // Wrapper v3: Wiki.js's bundled Mermaid 8 renders asynchronously and may
  // overwrite our v11 SVG AFTER renderAll() has finished. The per-block
  // guard observer below catches that and re-renders.
  const V11_MARKER_ATTR = "data-mmd11-rendered";

  async function renderBlock(el) {
    const source = (el.dataset.source ?? el.textContent ?? "").trim();
    if (!source) { el.dataset.mmd11 = "skip"; return; }
    el.dataset.source = source;
    el.removeAttribute("data-processed");
    el.dataset.mmd11 = "rendering";
    try {
      const id = "mmd-" + Math.random().toString(36).slice(2, 10);
      const { svg } = await mermaid.render(id, source);
      // Temporarily disconnect guard while we ourselves write.
      const guard = el.__mmd11Guard;
      if (guard) guard.disconnect();
      el.innerHTML = svg;
      const newSvg = el.querySelector("svg");
      if (newSvg) newSvg.setAttribute(V11_MARKER_ATTR, "1");
      el.dataset.mmd11 = "ok";
      if (guard) guard.observe(el, { childList: true, subtree: false });
    } catch (err) {
      const guard = el.__mmd11Guard;
      if (guard) guard.disconnect();
      el.innerHTML = "<pre style='color:#b00;white-space:pre-wrap'>Mermaid error: " + (err && err.message ? err.message : String(err)) + "\\n\\n" + source.replace(/[<>]/g, c => c === "<" ? "&lt;" : "&gt;") + "</pre>";
      el.dataset.mmd11 = "error";
      if (guard) guard.observe(el, { childList: true, subtree: false });
    }
  }

  function attachGuard(el) {
    if (el.__mmd11Guard) return;
    el.__mmd11Guard = new MutationObserver(() => {
      const svg = el.querySelector("svg");
      // If our marker is gone, v8 (or anyone) reverted us. Re-render.
      if (!svg || !svg.hasAttribute(V11_MARKER_ATTR)) {
        renderBlock(el);
      }
    });
    el.__mmd11Guard.observe(el, { childList: true, subtree: false });
  }

  async function renderAll() {
    const blocks = document.querySelectorAll("pre.mermaid, .mermaid");
    for (const el of blocks) {
      attachGuard(el);
      if (el.dataset.mmd11 === "ok" && el.querySelector("svg[" + V11_MARKER_ATTR + "]")) continue;
      await renderBlock(el);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => renderAll());
  } else { renderAll(); }

  // SPA navigation + late-injected blocks
  const obs = new MutationObserver(() => {
    if (document.querySelector("pre.mermaid, .mermaid")) {
      renderAll();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
</script>
${MARKER_CLOSE}`;

// --- GraphQL helpers ---------------------------------------------------
interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<GqlResponse<T>> {
  const r = await fetch(`${base}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, variables }),
  });
  return (await r.json()) as GqlResponse<T>;
}

interface ThemingConfig {
  theming: {
    config: {
      theme: string;
      iconset: string;
      darkMode: boolean;
      tocPosition: string;
      injectCSS: string;
      injectHead: string;
      injectBody: string;
    };
  };
}

interface SetConfigResult {
  theming: {
    setConfig: {
      responseResult: { succeeded: boolean; message: string };
    };
  };
}

// --- Idempotency check + write -----------------------------------------
ts("Reading current theming config...");
const cur = await gql<ThemingConfig>(`{ theming { config { theme iconset darkMode tocPosition injectCSS injectHead injectBody } } }`);
const cfg = cur.data?.theming?.config;
if (!cfg) {
  console.error(`[WIKIJS] ERROR: could not read theming config: ${JSON.stringify(cur)}`);
  process.exit(1);
}

const existing = cfg.injectHead ?? "";

// Idempotency: parse the marker block out of the existing injectHead.
const markerRe = new RegExp(`${MARKER_OPEN}[\\s\\S]*?${MARKER_CLOSE}`, "m");
const hadMarker = markerRe.test(existing);
const existingVersionMatch = existing.match(/mermaid@(\d+\.\d+\.\d+)/);
const existingVersion = existingVersionMatch?.[1];
const existingWrapperMatch = existing.match(/mmd11-wrapper:(\d+)/);
const existingWrapper = existingWrapperMatch?.[1];

if (hadMarker && existingVersion === MERMAID_VERSION && existingWrapper === WRAPPER_VERSION) {
  ts(`  ✓ MMD11 block already present at v${MERMAID_VERSION} wrapper=${WRAPPER_VERSION} — nothing to do.`);
  process.exit(0);
}

const newInjectHead = hadMarker
  ? existing.replace(markerRe, INJECT)
  : (existing ? `${existing}\n${INJECT}` : INJECT);

ts(hadMarker
  ? `  Replacing existing MMD${existingVersion ?? "?"} block with v${MERMAID_VERSION}...`
  : `  Appending MMD11 block (v${MERMAID_VERSION})...`);

const res = await gql<SetConfigResult>(
  `mutation Theme($theme: String!, $iconset: String!, $darkMode: Boolean!, $tocPosition: String, $injectCSS: String!, $injectHead: String!, $injectBody: String!) {
    theming { setConfig(theme: $theme, iconset: $iconset, darkMode: $darkMode, tocPosition: $tocPosition, injectCSS: $injectCSS, injectHead: $injectHead, injectBody: $injectBody) {
      responseResult { succeeded message }
    } }
  }`,
  {
    theme: cfg.theme,
    iconset: cfg.iconset,
    darkMode: cfg.darkMode,
    tocPosition: cfg.tocPosition ?? "left",
    injectCSS: cfg.injectCSS ?? "",
    injectHead: newInjectHead,
    injectBody: cfg.injectBody ?? "",
  },
);

if (res.data?.theming?.setConfig?.responseResult?.succeeded) {
  ts("  ✓ Mermaid 11 injection applied via GraphQL.");
  process.exit(0);
}

// --- DB fallback -------------------------------------------------------
const gqlErr = res.data?.theming?.setConfig?.responseResult?.message ?? res.errors?.[0]?.message ?? JSON.stringify(res);
ts(`  GraphQL setConfig failed: ${gqlErr}`);
ts("  Falling back to direct DB write + container restart...");

const containerPrefix = process.env["CONTAINER_PREFIX"] ?? envGet("CONTAINER_PREFIX");
if (!containerPrefix) {
  console.error("[WIKIJS] ERROR: CONTAINER_PREFIX not set — cannot use DB fallback");
  process.exit(1);
}
const pgContainer = `${containerPrefix}wikijs-postgres`;
const appContainer = `${containerPrefix}wikijs`;

const newCfgJson = JSON.stringify({
  theme: cfg.theme,
  iconset: cfg.iconset,
  darkMode: cfg.darkMode,
  tocPosition: cfg.tocPosition ?? "left",
  injectCSS: cfg.injectCSS ?? "",
  injectHead: newInjectHead,
  injectBody: cfg.injectBody ?? "",
});

// Use stdin to avoid argv quoting hell with the large injected HTML blob.
const sql = `UPDATE settings SET value = $tag$${newCfgJson}$tag$::jsonb, "updatedAt" = NOW() WHERE key = 'theming';`;
const proc = Bun.spawnSync(
  ["docker", "exec", "-i", pgContainer, "psql", "-U", "wikijs", "-d", "wikijs"],
  { stdin: Buffer.from(sql), stdout: "pipe", stderr: "pipe" },
);
if (proc.exitCode !== 0) {
  console.error(`[WIKIJS] ERROR: DB fallback failed: ${proc.stderr.toString()}`);
  process.exit(1);
}
ts("  ✓ theming row updated in DB.");

ts("  Restarting wikijs container for config reload...");
const restart = Bun.spawnSync(["docker", "restart", appContainer], { stdout: "pipe", stderr: "pipe" });
if (restart.exitCode !== 0) {
  console.error(`[WIKIJS] WARN: restart failed: ${restart.stderr.toString()}`);
  // Not fatal — the next manual restart picks up the change.
}
ts("  ✓ Mermaid 11 injection applied via DB fallback.");
