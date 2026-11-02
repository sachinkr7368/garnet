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
  /// rdbg port for `exec` (must be published by the service); `run` publishes a free port itself.
  debugPort: number;
}

export const defaultDocker = (): DockerTarget => ({ service: "", mode: "run", composeFile: "", containerRoot: "/app", debugPort: 12345 });

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
  if (typeof service !== "string" || !SERVICE.test(service)) return null;
  if (mode !== "run" && mode !== "exec") return null;
  if (typeof composeFile !== "string" || /[\n\0]/.test(composeFile) || composeFile.startsWith("/") || composeFile.split("/").includes("..")) return null;
  if (typeof containerRoot !== "string" || !/^\/[^\n\0]*$/.test(containerRoot)) return null;
  if (typeof debugPort !== "number" || !Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65535) return null;
  return { service, mode, composeFile, containerRoot: containerRoot.replace(/(.)\/+$/, "$1"), debugPort };
}

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
  /// Host = container port to publish for rdbg (`run` mode only).
  publish?: number;
  /// Publish the service's own ports (`run --service-ports`), e.g. for a Rails server.
  servicePorts?: boolean;
}

export function composeCommand(t: DockerTarget, inner: string, opts: ComposeOptions, quote: (s: string) => string): string {
  const parts = ["docker", "compose"];
  if (t.composeFile.trim()) parts.push("-f", quote(t.composeFile.trim()));
  if (t.mode === "run") {
    parts.push("run", "--rm");
    if (opts.servicePorts) parts.push("--service-ports");
    if (opts.publish) parts.push("-p", `127.0.0.1:${opts.publish}:${opts.publish}`);
  } else parts.push("exec");
  for (const name of opts.envNames) parts.push("-e", name);
  const cwd = opts.cwd.replace(/^\.\/?/, "").replace(/\/$/, "");
  parts.push("-w", quote(cwd ? `${t.containerRoot.replace(/\/$/, "")}/${cwd}` : t.containerRoot));
  parts.push(t.service, inner);
  return parts.join(" ");
}

/// Port rdbg listens on inside the container and that Garnet attaches to on 127.0.0.1.
export const debugPortFor = (t: DockerTarget, freePort: number) => (t.mode === "run" ? freePort : t.debugPort);
