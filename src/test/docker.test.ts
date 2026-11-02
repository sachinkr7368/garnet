import { describe, expect, it } from "vitest";
import { checkPublishedPort, composeCommand, debugPortFor, defaultDocker, hostSocket, localfsMap, mapPath, rdbgListen, validateDocker } from "../docker";
import { shellQuote } from "../state";

describe("path mapping", () => {
  it("maps project paths into the container and back", () => {
    expect(mapPath("/Users/me/blog/app/models/post.rb", "/Users/me/blog", "/app")).toBe("/app/app/models/post.rb");
    expect(mapPath("/Users/me/blog", "/Users/me/blog", "/app")).toBe("/app");
    expect(mapPath("/app/config/routes.rb", "/Users/me/blog", "/app", true)).toBe("/Users/me/blog/config/routes.rb");
  });

  it("refuses paths outside the mapped root, including prefix look-alikes", () => {
    expect(mapPath("/Users/me/blog2/x.rb", "/Users/me/blog", "/app")).toBeNull();
    expect(mapPath("/etc/passwd", "/Users/me/blog", "/app")).toBeNull();
  });

  it("builds rdbg's localfsMap as remote:local", () => {
    expect(localfsMap({ ...defaultDocker(), containerRoot: "/srv/app" }, "/Users/me/blog")).toBe("/srv/app:/Users/me/blog");
  });
});

describe("validateDocker", () => {
  it("normalizes a trailing slash and fills defaults", () => {
    expect(validateDocker({ service: "web", containerRoot: "/app/" })).toEqual({ ...defaultDocker(), service: "web", containerRoot: "/app" });
  });
  it("rejects non-integer ports and absolute compose files", () => {
    expect(validateDocker({ service: "web", debugPort: 1.5 })).toBeNull();
    expect(validateDocker({ service: "web", composeFile: "/etc/compose.yml" })).toBeNull();
  });
});

describe("composeCommand", () => {
  it("quotes the compose file and working directory", () => {
    const t = { ...defaultDocker(), service: "web", composeFile: "docker/my compose.yml", containerRoot: "/my app" };
    expect(composeCommand(t, "ruby x.rb", { envNames: ["A"], cwd: "./sub/" }, shellQuote)).toBe("docker compose -f 'docker/my compose.yml' run --rm -e A -w '/my app/sub' web ruby x.rb");
  });

  it("picks the debug port: a free published one for run, the configured one for exec", () => {
    expect(debugPortFor({ ...defaultDocker(), mode: "run" }, 5555)).toBe(5555);
    expect(debugPortFor({ ...defaultDocker(), mode: "exec", debugPort: 1234 }, 5555)).toBe(1234);
  });
});

describe("exec debugging port check", () => {
  it("accepts a loopback-only mapping and returns the host port", () => {
    expect(checkPublishedPort("127.0.0.1:12345\n", 12345)).toEqual({ port: 12345 });
    expect(checkPublishedPort("127.0.0.1:40001", 12345)).toEqual({ port: 40001 });
    expect(checkPublishedPort("[::1]:12345", 12345)).toEqual({ port: 12345 });
  });

  it.each(["0.0.0.0:12345", "[::]:12345", ":::12345", "192.168.1.5:12345", "127.0.0.1:12345\n0.0.0.0:12345"])("refuses %j and shows the loopback mapping", (out) => {
    const r = checkPublishedPort(out, 12345);
    expect("error" in r && r.error).toContain('ports: ["127.0.0.1:12345:12345"]');
    expect("error" in r && r.error).toContain("published on");
  });

  it("refuses an unpublished port or a compose error", () => {
    for (const out of ["", "no port 12345/tcp for container web-1", "service \"web\" is not running"]) {
      const r = checkPublishedPort(out, 12345);
      expect("error" in r && r.error).toContain("is not published");
    }
  });
});

describe("rdbg listen address", () => {
  it("uses TCP on the container side by default and the shared socket when configured", () => {
    expect(rdbgListen(defaultDocker(), 4000)).toBe("--port=4000 --host=0.0.0.0");
    const t = { ...defaultDocker(), socketPath: "tmp/rdbg.sock" };
    expect(rdbgListen(t, 4000)).toBe("--sock-path=/app/tmp/rdbg.sock");
    expect(hostSocket(t, "/Users/me/blog")).toBe("/Users/me/blog/tmp/rdbg.sock");
  });

  it("rejects socket paths outside the project", () => {
    expect(validateDocker({ service: "web", socketPath: "/tmp/x.sock" })).toBeNull();
    expect(validateDocker({ service: "web", socketPath: "../x.sock" })).toBeNull();
    expect(validateDocker({ service: "web", servicePorts: "yes" })).toBeNull();
  });
});
