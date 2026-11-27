/**
 * Read-only view of the project's containers, for a project without recipes of
 * its own. Talks to the Docker API over HTTP (the socket proxy next to this
 * server, which lets through container list, inspect and logs and nothing
 * else).
 *
 * @module
 */

/** One container as the service tools report it. */
export interface ContainerInfo {
  name: string;
  state: string;
  status: string;
  health: string;
  image: string;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** MCP_DOCKER_HOST (tcp://host:port) as an http base address. */
export function dockerBase(host: string): string {
  return host.replace(/^tcp:\/\//, "http://").replace(/\/+$/, "");
}

/** "Up 2 hours (healthy)" -> "healthy"; a container without a health check has none. */
function healthOf(status: string): string {
  return /\((healthy|unhealthy|health: starting)\)/.exec(status)?.[1]?.replace("health: ", "") ?? "";
}

/** Which containers are this project's: on the network its apps share, and named with its container prefix. */
export interface ProjectScope {
  prefix: string;
  network: string;
}

/** Every container of this project. */
export async function listContainers(base: string, scope: ProjectScope, fetcher: Fetch = fetch): Promise<ContainerInfo[]> {
  const response = await fetcher(`${base}/containers/json?all=true`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Docker answered HTTP ${response.status}`);
  const rows = (await response.json()) as {
    Names?: string[];
    State?: string;
    Status?: string;
    Image?: string;
    NetworkSettings?: { Networks?: Record<string, unknown> };
  }[];
  return rows
    .filter((row) => !scope.network || scope.network in (row.NetworkSettings?.Networks ?? {}))
    .map((row) => ({
      name: (row.Names?.[0] ?? "").replace(/^\//, ""),
      state: row.State ?? "unknown",
      status: row.Status ?? "",
      health: healthOf(row.Status ?? ""),
      image: row.Image ?? "",
    }))
    .filter((c) => c.name && (!scope.prefix || c.name.startsWith(scope.prefix)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The containers of one app: `<prefix><app>` and `<prefix><app>-<role>`; the first is the main one. */
export function containersOf(all: ContainerInfo[], prefix: string, service: string): ContainerInfo[] {
  const main = `${prefix}${service}`;
  return all
    .filter((c) => c.name === main || c.name.startsWith(`${main}-`))
    .sort((a, b) => Number(b.name === main) - Number(a.name === main));
}

/** Docker's log stream without its 8-byte frame headers (a container with a terminal has none). */
export function plainLogs(raw: Uint8Array): string {
  const framed = raw.length >= 8 && raw[0] !== undefined && raw[0] <= 2 && raw[1] === 0 && raw[2] === 0 && raw[3] === 0;
  if (!framed) return new TextDecoder().decode(raw);
  const parts: Uint8Array[] = [];
  let at = 0;
  while (at + 8 <= raw.length) {
    const size = new DataView(raw.buffer, raw.byteOffset + at + 4, 4).getUint32(0);
    parts.push(raw.subarray(at + 8, at + 8 + size));
    at += 8 + size;
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}

/** The last lines a container wrote. */
export async function containerLogs(base: string, name: string, lines: number, fetcher: Fetch = fetch): Promise<string[]> {
  const tail = Math.max(1, Math.min(Math.floor(lines) || 50, 2000));
  const response = await fetcher(
    `${base}/containers/${encodeURIComponent(name)}/logs?stdout=true&stderr=true&tail=${tail}`,
    { signal: AbortSignal.timeout(30000) },
  );
  if (!response.ok) throw new Error(`Docker answered HTTP ${response.status} for the logs of ${name}`);
  return plainLogs(new Uint8Array(await response.arrayBuffer())).split("\n");
}
