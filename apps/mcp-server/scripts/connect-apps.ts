#!/usr/bin/env bun
/**
 * Package: mcp-server
 * Purpose: connect the MCP server to the apps of this project, without a
 *          person. The server lists the tools of an app only when it has that
 *          app's address and key. For each app it knows (Redmine, n8n, Zammad)
 *          that is installed in the project and has made its key, this writes
 *          the address the server reaches it at (its container on the network
 *          the apps share) to .env; the key itself stays where the app put it.
 *          It prints what is connected and what is not, and why.
 *          An address a person wrote for an app that runs somewhere else is
 *          left alone. Safe to repeat.
 * Usage:   bun packages/mcp-server/scripts/connect-apps.ts
 * Called by: app.yaml (prepare step)
 * Exit:    0 always: an app that is not there is not an error.
 *
 * @module
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { envGet, fromEnvFile, setEnv, ts } from "./_setup-env.ts";

interface App {
  id: string;
  name: string;
  /** The container that answers the app's API, and the port it listens on there. */
  container: string;
  port: number;
  /** The key the app's own setup writes to .env. */
  key: string;
  /** Where this server keeps the app's address. */
  address: string;
  tools: string;
}

const APPS: App[] = [
  {
    id: "redmine",
    name: "Redmine",
    container: "redmine",
    port: 3000,
    key: "REDMINE_API_KEY",
    address: "MCP_SERVER_REDMINE_URL",
    tools: "redmine_*",
  },
  {
    id: "n8n",
    name: "n8n",
    container: "n8n",
    port: 5678,
    key: "N8N_API_KEY",
    address: "MCP_SERVER_N8N_URL",
    tools: "n8n_*",
  },
  {
    id: "zammad",
    name: "Zammad",
    container: "zammad-rails",
    port: 3000,
    key: "ZAMMAD_API_TOKEN",
    address: "MCP_SERVER_ZAMMAD_URL",
    tools: "zammad_*",
  },
];

const packages = dirname(process.env["VIA_APP_DIR"] ?? dirname(import.meta.dir));
const prefix = envGet("CONTAINER_PREFIX");

for (const app of APPS) {
  const installed = existsSync(join(packages, app.id, "app.yaml"));
  const current = fromEnvFile(app.address);
  if (!installed) {
    ts(
      current
        ? `✓ ${app.name}: ${current} (set by hand; ${app.name} is not an app of this project)`
        : `- ${app.name} is not in this project; its tools (${app.tools}) are not listed.`,
    );
    continue;
  }
  if (!envGet(app.key)) {
    ts(
      `- ${app.name} is in this project but has no ${app.key} in .env yet (its own setup makes it); its tools are listed from the next start after that.`,
    );
    continue;
  }
  const wanted = `http://${prefix}${app.container}:${app.port}`;
  if (current !== wanted) await setEnv(app.address, wanted);
  ts(`✓ ${app.name} connected at ${wanted}; its tools (${app.tools}) are listed.`);
}

const project = envGet("MCP_SERVER_PROJECT_DIR");
ts(
  project
    ? `✓ Project folder ${project} is mounted read-only; its recipes are listed as tools (package_*, command_*, email_*).`
    : "- No project folder (MCP_SERVER_PROJECT_DIR is empty); tools that run the project's recipes are not listed.",
);
const socket = envGet("MCP_SERVER_DOCKER_SOCKET");
ts(
  socket
    ? `✓ Docker is read through a proxy on ${socket} (containers: list, inspect, logs; nothing else); service_* and ecosystem_health are listed.`
    : "- No access to Docker (MCP_SERVER_DOCKER_SOCKET is empty); service_* and ecosystem_health are not listed.",
);
