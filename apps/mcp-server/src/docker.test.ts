/**
 * The read-only view of the project's containers.
 *
 * Run: cd packages/mcp-server && bun test src/docker.test.ts
 */
import { describe, expect, test } from "bun:test";
import { containerLogs, containersOf, dockerBase, listContainers, plainLogs } from "./docker.ts";

const onApps = { NetworkSettings: { Networks: { apps: {} } } };
const rows = [
  { Names: ["/p-redmine-postgres"], State: "running", Status: "Up 2 hours (healthy)", Image: "postgres:15", ...onApps },
  { Names: ["/p-redmine"], State: "running", Status: "Up 2 hours (unhealthy)", Image: "redmine:6", ...onApps },
  { Names: ["/p-redminer"], State: "exited", Status: "Exited (1) 3 minutes ago", Image: "x:1", ...onApps },
  { Names: ["/other-app"], State: "running", Status: "Up 1 minute", Image: "y:1", ...onApps },
  { Names: ["/p-elsewhere"], State: "running", Status: "Up 1 minute", Image: "z:1" },
];
const scope = { prefix: "p-", network: "apps" };
const answering = (body: unknown, status = 200) => async (): Promise<Response> =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("containers of the project", () => {
  test("a tcp address becomes an http one", () => {
    expect(dockerBase("tcp://proxy:2375/")).toBe("http://proxy:2375");
  });

  test("only containers on the project's network, with its prefix, are listed", async () => {
    const all = await listContainers("http://proxy:2375", scope, answering(rows));
    expect(all.map((c) => c.name)).toEqual(["p-redmine", "p-redmine-postgres", "p-redminer"]);
    expect(all.find((c) => c.name === "p-redmine")?.health).toBe("unhealthy");
    expect(all.find((c) => c.name === "p-redminer")?.health).toBe("");
  });

  test("an app's containers are its own and its roles, the main one first", async () => {
    const all = await listContainers("http://proxy:2375", scope, answering(rows));
    expect(containersOf(all, "p-", "redmine").map((c) => c.name)).toEqual(["p-redmine", "p-redmine-postgres"]);
    expect(containersOf(all, "p-", "nothing")).toEqual([]);
  });

  test("a refusal from Docker is an error, not an empty list", async () => {
    expect(listContainers("http://proxy:2375", scope, answering("forbidden", 403))).rejects.toThrow("403");
  });

  test("without a prefix the network alone says which containers are the project's", async () => {
    const all = await listContainers("http://proxy:2375", { prefix: "", network: "apps" }, answering(rows));
    expect(all.map((c) => c.name)).not.toContain("p-elsewhere");
    expect(all.map((c) => c.name)).toContain("other-app");
  });

  test("log frames are unwrapped", async () => {
    const frame = (stream: number, text: string): Buffer => {
      const header = Buffer.alloc(8);
      header[0] = stream;
      header.writeUInt32BE(Buffer.byteLength(text), 4);
      return Buffer.concat([header, Buffer.from(text)]);
    };
    const raw = Buffer.concat([frame(1, "one\n"), frame(2, "two\n")]);
    expect(plainLogs(new Uint8Array(raw))).toBe("one\ntwo\n");
    expect(plainLogs(new TextEncoder().encode("plain line\n"))).toBe("plain line\n");
    const lines = await containerLogs("http://proxy:2375", "p-redmine", 5, async () => new Response(raw));
    expect(lines).toEqual(["one", "two", ""]);
  });
});
