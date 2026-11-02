// Pure helpers for running configurations inside a docker compose service.

export interface DockerTarget {
  /// Compose service name.
  service: string;
  /// `run` starts a fresh container (`docker compose run --rm`), `exec` uses the running one.
  mode: "run" | "exec";
  /// Compose file relative to the project root; empty = compose's own lookup (compose.yaml, docker-compose.yml, ...).
  composeFile: string;
  /// Project root inside the container, e.g. /app.
  containerRoot: string;
  /// rdbg port for `exec` (must be published by the service on 127.0.0.1); `run` publishes a free port on 127.0.0.1 itself.
  debugPort: number;
  /// Publish the service's own ports from the compose file (`run --service-ports`); off unless the user ticks it.
  servicePorts: boolean;
  /// rdbg UNIX socket relative to the project root on a shared volume (e.g. tmp/rdbg.sock); preferred over TCP when set.
  socketPath: string;
}

export const defaultDocker = (): DockerTarget => ({ service: "", mode: "run", composeFile: "", containerRoot: "/app", debugPort: 12345, servicePorts: false, socketPath: "" });

const SERVICE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/// Accepts a run.json `docker` entry only when every field has the expected type and shape.
export function validateDocker(raw: unknown): DockerTarget | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  const base = defaultDocker();
  const service = d.service;
  const mode = d.mode ?? base.mode;
  const composeFile = d.composeFile ?? base.composeFile;
  const containerRoot = d.containerRoot ?? base.containerRoot;
  const debugPort = d.debugPort ?? base.debugPort;
  const servicePorts = d.servicePorts ?? base.servicePorts;
  const socketPath = d.socketPath ?? base.socketPath;
  if (typeof service !== "string" || !SERVICE.test(service)) return null;
  if (mode !== "run" && mode !== "exec") return null;
  if (typeof composeFile !== "string" || /[\n\0]/.test(composeFile) || composeFile.startsWith("/") || composeFile.split("/").includes("..")) return null;
  if (typeof containerRoot !== "string" || !/^\/[^\n\0]*$/.test(containerRoot)) return null;
  if (typeof debugPort !== "number" || !Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65535) return null;
  if (typeof servicePorts !== "boolean") return null;
  if (typeof socketPath !== "string" || !relativeInside(socketPath)) return null;
  return { service, mode, composeFile, containerRoot: containerRoot.replace(/(.)\/+$/, "$1"), debugPort, servicePorts, socketPath: socketPath.trim() };
}

const relativeInside = (p: string) => !/[\n\0]/.test(p) && !p.startsWith("/") && !p.split("/").includes("..");

/// Maps a host path under `root` to the container (and back with `reverse`). Returns null outside the mapped root.
export function mapPath(path: string, root: string, containerRoot: string, reverse = false): string | null {
  const [from, to] = reverse ? [containerRoot, root] : [root, containerRoot];
  if (path === from) return to;
  const prefix = from.endsWith("/") ? from : `${from}/`;
  return path.startsWith(prefix) ? `${to.replace(/\/$/, "")}/${path.slice(prefix.length)}` : null;
}

/// rdbg's `localfsMap` attach argument: `<remote>:<local>`.
export const localfsMap = (t: DockerTarget, root: string) => `${t.containerRoot}:${root}`;

export interface ComposeOptions {
  /// Variable names passed through from the docker CLI's environment (`-e NAME`), so values never appear on the command line.
  envNames: string[];
  /// Working directory relative to the project root ("" = root).
  cwd: string;
  /// Port to publish on 127.0.0.1 only (host = container) for rdbg (`run` mode only).
  publish?: number;
}

export function composeCommand(t: DockerTarget, inner: string, opts: ComposeOptions, quote: (s: string) => string): string {
  const parts = ["docker", "compose"];
  if (t.composeFile.trim()) parts.push("-f", quote(t.composeFile.trim()));
  if (t.mode === "run") {
    parts.push("run", "--rm");
    if (t.servicePorts) parts.push("--service-ports");
    if (opts.publish) parts.push("-p", `127.0.0.1:${opts.publish}:${opts.publish}`);
  } else parts.push("exec");
  for (const name of opts.envNames) parts.push("-e", name);
  const cwd = opts.cwd.replace(/^\.\/?/, "").replace(/\/$/, "");
  parts.push("-w", quote(cwd ? `${t.containerRoot.replace(/\/$/, "")}/${cwd}` : t.containerRoot));
  // The whole command runs in the container's shell: unquoted, `a && b` would run b on the host.
  parts.push(t.service, "sh", "-c", quote(inner));
  return parts.join(" ");
}

/// Port rdbg listens on inside the container and that Garnet attaches to on 127.0.0.1.
export const debugPortFor = (t: DockerTarget, freePort: number) => (t.mode === "run" ? freePort : t.debugPort);

/// rdbg listen arguments inside the container: the shared-volume socket when configured, else TCP.
/// TCP binds 0.0.0.0 inside the container only; the host side is published on 127.0.0.1 (run) or verified to be (exec).
export const rdbgListen = (t: DockerTarget, port: number, quote: (s: string) => string) =>
  t.socketPath ? `--sock-path=${quote(`${t.containerRoot.replace(/\/$/, "")}/${t.socketPath}`)}` : `--port=${port} --host=0.0.0.0`;

/// Host-side rdbg socket for a socket-path target.
export const hostSocket = (t: DockerTarget, root: string) => `${root}/${t.socketPath}`;

/// Checks `docker compose port <service> <port>` output for `exec` debugging. rdbg has no authentication,
/// so the port must be published on loopback only. Returns the host port to attach to, or why debugging is refused.
export function checkPublishedPort(output: string, containerPort: number): { port: number } | { error: string } {
  const mapping = `127.0.0.1:${containerPort}:${containerPort}`;
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length || lines.some((l) => !/:\d+$/.test(l)))
    return { error: `port ${containerPort} is not published by the service${lines.length ? ` (${lines.join(" ").slice(0, 160)})` : ""}. Add  ports: ["${mapping}"]  to it in the compose file and recreate the container.` };
  for (const line of lines) {
    const host = line.slice(0, line.lastIndexOf(":")).replace(/^\[|\]$/g, "");
    if (!/^(127\.\d+\.\d+\.\d+|::1|localhost)$/.test(host))
      return { error: `port ${containerPort} is published on ${host || "all interfaces"}, so anyone who can reach this machine could run code through the debugger. Publish it on loopback only:  ports: ["${mapping}"]` };
  }
  return { port: Number(lines[0].slice(lines[0].lastIndexOf(":") + 1)) };
}
