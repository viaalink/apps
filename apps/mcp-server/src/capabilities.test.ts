/**
 * Which tools are listed for what the server was given.
 *
 * Run: cd packages/mcp-server && bun test src/capabilities.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { capabilitiesFrom, groupOf, isListed } from "./capabilities.ts";

const none = () => false;
const toolNames = [
  ...readFileSync(join(import.meta.dir, "server.ts"), "utf8").matchAll(/server\.tool\(\s*"([a-z0-9_]+)"/g),
].map((m) => m[1] as string);

describe("tool groups", () => {
  test("the server's tools are found", () => {
    expect(toolNames.length).toBeGreaterThan(50);
  });

  test("with nothing given, only the introspection tools are listed", () => {
    const caps = capabilitiesFrom({}, none);
    expect(toolNames.filter((name) => isListed(name, caps)).sort()).toEqual(["mcp_info", "mcp_tools"]);
  });

  test("an app needs its address and its key", () => {
    expect(capabilitiesFrom({ REDMINE_URL: "http://redmine:3000" }, none).redmine).toBe(false);
    expect(capabilitiesFrom({ REDMINE_API_KEY: "k" }, none).redmine).toBe(false);
    expect(capabilitiesFrom({ REDMINE_URL: "http://redmine:3000", REDMINE_API_KEY: "k" }, none).redmine).toBe(true);
    expect(capabilitiesFrom({ N8N_URL: "http://n8n:5678", N8N_API_KEY: "k" }, none).n8n).toBe(true);
    expect(capabilitiesFrom({ ZAMMAD_API_URL: "http://zammad:3000", ZAMMAD_API_TOKEN: "t" }, none).zammad).toBe(true);
  });

  test("recipe tools need a project folder with a Justfile", () => {
    const caps = capabilitiesFrom({ MCP_PROJECT_DIR: "/app/project" }, (path) => path === "/app/project/Justfile");
    expect(caps.project).toBe(true);
    for (const name of ["package_list", "command_list", "email_send", "developer_hook_setup"])
      expect(isListed(name, caps)).toBe(true);
    // Its service recipes ask Docker, which was not given.
    expect(isListed("service_status", caps)).toBe(false);
    expect(capabilitiesFrom({ MCP_PROJECT_DIR: "/app/project" }, none).project).toBe(false);
  });

  test("service tools need read access to Docker", () => {
    const caps = capabilitiesFrom({ MCP_DOCKER_HOST: "tcp://proxy:2375" }, none);
    for (const name of ["service_status", "service_health", "service_logs", "ecosystem_health"])
      expect(isListed(name, caps)).toBe(true);
    expect(isListed("package_list", caps)).toBe(false);
  });

  test("every tool belongs to a group on purpose", () => {
    const always = toolNames.filter((name) => groupOf(name) === "always").sort();
    expect(always).toEqual(["mcp_info", "mcp_tools"]);
  });
});
