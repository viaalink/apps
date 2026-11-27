/**
 * Which tools this server lists.
 *
 * A tool is listed only when what it works with is there: the address and key
 * of the app it talks to, a project folder with recipes, or read access to
 * Docker. Without any of those the server offers its two introspection tools
 * and nothing else, so a client never sees a tool that can only fail.
 *
 * @module
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** What a tool needs before it is listed. */
export type ToolGroup = "always" | "project" | "services" | "redmine" | "n8n" | "zammad";

/** What this server was given at its start. */
export interface Capabilities {
  /** A project folder with a Justfile is mounted: recipes can run. */
  project: boolean;
  /** Read access to Docker (containers: list, inspect, logs). */
  docker: boolean;
  redmine: boolean;
  n8n: boolean;
  zammad: boolean;
}

/** Where the project folder is mounted inside the container. */
export const PROJECT_MOUNT = "/app/project";

/** The folder recipes run in: MCP_PROJECT_DIR, else the mount point. */
export function projectDir(env: Record<string, string | undefined> = process.env): string {
  return env["MCP_PROJECT_DIR"] || PROJECT_MOUNT;
}

/** Read what the environment (and the mounted project folder) allows. */
export function capabilitiesFrom(
  env: Record<string, string | undefined> = process.env,
  hasFile: (path: string) => boolean = existsSync,
): Capabilities {
  const dir = projectDir(env);
  return {
    project: ["Justfile", "justfile"].some((name) => hasFile(join(dir, name))),
    docker: Boolean(env["MCP_DOCKER_HOST"]),
    redmine: Boolean(env["REDMINE_URL"] && env["REDMINE_API_KEY"]),
    n8n: Boolean(env["N8N_URL"] && env["N8N_API_KEY"]),
    zammad: Boolean(env["ZAMMAD_API_URL"] && env["ZAMMAD_API_TOKEN"]),
  };
}

/** The group a tool belongs to, by its name. */
export function groupOf(tool: string): ToolGroup {
  if (tool.startsWith("redmine_")) return "redmine";
  if (tool.startsWith("n8n_")) return "n8n";
  if (tool.startsWith("zammad_")) return "zammad";
  if (tool.startsWith("service_") || tool === "ecosystem_health") return "services";
  // Recipes of the project: its packages, its commands, its mail recipes, its commit hook.
  if (/^(package_|command_|email_|developer_)/.test(tool)) return "project";
  return "always";
}

/** Whether a tool is listed with these capabilities. */
export function isListed(tool: string, caps: Capabilities): boolean {
  const group = groupOf(tool);
  if (group === "always") return true;
  // Service tools read Docker; with a project they run its recipes, which read Docker too.
  if (group === "services") return caps.docker;
  return caps[group];
}
