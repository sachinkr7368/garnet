import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../editor", async () => await import("./fakeEditor"));
vi.mock("../debug", () => ({ debugSession: vi.fn(), sessionFor: () => null, stopSession: vi.fn() }));

import { buildCommand, configList, loadRunConfigs, newConfig, parseDotenv, safeEnv, saveRunConfigs, validateConfig, type RunConfig } from "../run";
import { mergeConfigs, splitConfigs } from "../runstore";
import { checkTrust, loadSettings, trustProject } from "../settings";
import { state } from "../state";
import type { ProjectInfo } from "../ipc";
import { fake } from "./fakeIpc";

const ROOT = "/work/blog";
const project = (over: Partial<ProjectInfo> = {}): ProjectInfo => ({ root: ROOT, name: "blog", git: true, rails: true, rspec: false, minitest: true, binRspec: false, debugBundled: false, ...over });

beforeEach(async () => {
  fake.reset();
  state.project = project();
  await loadSettings(ROOT);
  await checkTrust(ROOT);
});

describe("run.json validation", () => {
  it("accepts a well-formed entry and fills defaults", () => {
    const c = validateConfig({ name: "Server", type: "rails-server", args: "-p 4000" })!;
    expect(c).toMatchObject({ name: "Server", type: "rails-server", args: "-p 4000", cwd: "", envFile: "", env: {}, bundler: true, rubyManager: "auto" });
  });

  it.each([
    [null],
    ["str"],
    [{ type: "rspec" }],
    [{ name: "  ", type: "rspec" }],
    [{ name: "x", type: "shell" }],
    [{ name: "x", type: "rspec", args: 1 }],
    [{ name: "x", type: "rspec", rubyManager: "nvm" }],
    [{ name: "x", type: "rspec", bundler: "yes" }],
    [{ name: "x", type: "rspec", env: ["A=1"] }],
    [{ name: "x", type: "rspec", env: { A: 1 } }],
  ])("rejects %j", (raw) => expect(validateConfig(raw)).toBeNull());

  it("drops interpreter-hijacking env vars", () => {
    const c = validateConfig({ name: "x", type: "ruby", env: { PATH: "/evil", RUBYOPT: "-r/evil", DYLD_INSERT_LIBRARIES: "x", LD_PRELOAD: "x", BASH_ENV: "x", ENV: "x", FOO: "bar" } })!;
    expect(c.env).toEqual({ FOO: "bar" });
  });
});

describe("env", () => {
  it("blocks PATH, RUBYOPT, BASH_ENV, ENV, DYLD_* and LD_*", () => {
    expect(safeEnv({ PATH: "a", PATHS: "b", RUBYOPT: "c", DYLD_LIBRARY_PATH: "d", LD_LIBRARY_PATH: "e", RAILS_ENV: "test" }, "t")).toEqual({ PATHS: "b", RAILS_ENV: "test" });
  });

  it("parses .env files", () => {
    const env = parseDotenv(`# comment\nexport A=1\nB = "two words"\nC='x # not a comment'\nD=value # comment\nE=line\\nbreak\nnot a line\n9X=bad\n`);
    expect(env).toEqual({ A: "1", B: "two words", C: "x # not a comment", D: "value", E: "line\nbreak" });
  });
});

describe("buildCommand", () => {
  it("adds Rails port and binding unless given", () => {
    expect(buildCommand(newConfig("rails-server", "s"))).toBe("bin/rails server -b 127.0.0.1 -p 3000");
    expect(buildCommand({ ...newConfig("rails-server", "s"), args: "--port 4000 -b 0.0.0.0" })).toBe("bin/rails server --port 4000 -b 0.0.0.0");
  });

  it("prefixes the version manager and bundler", () => {
    state.project = project({ rails: false });
    expect(buildCommand({ ...newConfig("ruby", "r", "script.rb"), rubyManager: "mise" })).toBe("mise exec -- bundle exec ruby script.rb");
    expect(buildCommand({ ...newConfig("rake", "r", "db:migrate"), rubyManager: "rbenv", bundler: false })).toBe("rbenv exec rake db:migrate");
  });

  it("wraps in rdbg for debugging", () => {
    expect(buildCommand(newConfig("rspec", "s", "spec/a_spec.rb"), { debug: { port: 1234 } })).toBe("rdbg --open --port=1234 --host=127.0.0.1 --command -- bundle exec rspec spec/a_spec.rb");
  });

  it("keeps custom commands verbatim", () => {
    expect(buildCommand(newConfig("custom", "c", "echo  'a  b'"))).toBe("echo  'a  b'");
  });
});

describe("trust gating", () => {
  it("never reads or writes .garnet/run.json for an untrusted project", async () => {
    fake.files.set(`${ROOT}/.garnet/run.json`, JSON.stringify({ configurations: [{ name: "Evil", type: "custom", args: "rm -rf ~" }] }));
    await loadRunConfigs();
    expect(configList().map((c) => c.name)).toEqual(["Rails server", "Rails console", "All tests"]);
    expect(fake.calls).not.toContain("api.writeFile");
  });

  it("reads a trusted project's run.json and skips invalid entries", async () => {
    await trustProject(ROOT, true);
    fake.files.set(`${ROOT}/.garnet/run.json`, JSON.stringify({ selected: "Web", configurations: [{ name: "Web", type: "rails-server" }, { name: 3 }] }));
    await loadRunConfigs();
    expect(configList().map((c) => c.name)).toEqual(["Web"]);
  });
});

describe("run configuration storage", () => {
  const stateEntry = () => JSON.parse(fake.config.get("run-configs.json")!)[ROOT];
  const projectWrites = () => fake.calls.filter((c) => c === "api.writeFile" || c === "api.createPath");

  it("keeps auto-created configurations in Garnet's config dir, not the repository", async () => {
    await trustProject(ROOT, true);
    await loadRunConfigs();
    expect(stateEntry().configurations.map((c: { name: string }) => c.name)).toEqual(["Rails server", "Rails console", "All tests"]);
    expect(fake.files.has(`${ROOT}/.garnet/run.json`)).toBe(false);
    expect(projectWrites()).toEqual([]);
    fake.calls.length = 0;
    await loadRunConfigs();
    expect(configList()).toHaveLength(3);
    expect(projectWrites()).toEqual([]);
  });

  it("writes only configurations marked 'Store as project file' to .garnet/run.json", async () => {
    await trustProject(ROOT, true);
    await loadRunConfigs();
    const [server, ...rest] = configList();
    await saveRunConfigs([{ ...server, shared: true }, ...rest]);
    const file = JSON.parse(fake.files.get(`${ROOT}/.garnet/run.json`)!);
    expect(file.configurations.map((c: { name: string }) => c.name)).toEqual(["Rails server"]);
    expect(file.configurations[0].shared).toBeUndefined();
    expect(stateEntry().configurations.map((c: { name: string }) => c.name)).toEqual(["Rails console", "All tests"]);
    await loadRunConfigs();
    expect(configList().map((c) => [c.name, c.shared])).toEqual([["Rails server", true], ["Rails console", false], ["All tests", false]]);
    await saveRunConfigs(configList().map((c) => ({ ...c, shared: false })));
    expect(fake.files.has(`${ROOT}/.garnet/run.json`)).toBe(false);
    expect(stateEntry().configurations).toHaveLength(3);
  });

  it("keeps reading an existing .garnet/run.json, but only once trusted", async () => {
    fake.files.set(`${ROOT}/.garnet/run.json`, JSON.stringify({ configurations: [{ name: "Team server", type: "rails-server" }] }));
    await loadRunConfigs();
    expect(configList().some((c) => c.name === "Team server")).toBe(false);
    await trustProject(ROOT, true);
    await loadRunConfigs();
    expect(configList().map((c) => c.name)).toContain("Team server");
    expect(configList().find((c) => c.name === "Team server")!.shared).toBe(true);
  });

  it("merges shared configurations ahead of local ones, shared winning on a name clash", () => {
    const merged = mergeConfigs([{ name: "a" }, { name: "b" }], [{ name: "b" }, { name: "c" }]);
    expect(merged).toEqual([{ name: "b", shared: true }, { name: "c", shared: true }, { name: "a", shared: false }]);
    expect(splitConfigs(merged)).toEqual({ local: [{ name: "a" }], shared: [{ name: "b" }, { name: "c" }] });
  });
});

describe("docker compose targets", () => {
  const docker = { service: "web", mode: "run" as const, composeFile: "docker-compose.yml", containerRoot: "/app", debugPort: 12345, servicePorts: false, socketPath: "" };

  it("validates the docker entry of run.json", () => {
    expect(validateConfig({ name: "x", type: "rspec", docker })?.docker).toEqual(docker);
    expect(validateConfig({ name: "x", type: "rspec", docker: { service: "web" } })?.docker).toMatchObject({ service: "web", mode: "run", containerRoot: "/app" });
    for (const bad of [{ service: "web; rm -rf ~" }, { service: "web", mode: "up" }, { service: "web", containerRoot: "app" }, { service: "web", composeFile: "../x.yml" }, { service: "web", debugPort: 70000 }, "web"])
      expect(validateConfig({ name: "x", type: "rspec", docker: bad })).toBeNull();
  });

  it("still drops blocked env vars for docker configs", () => {
    expect(validateConfig({ name: "x", type: "ruby", docker, env: { RUBYOPT: "-r/evil", A: "1" } })?.env).toEqual({ A: "1" });
  });

  it("runs inside the service with env names only and the mapped working directory", () => {
    const cfg: RunConfig = { ...newConfig("rspec", "s", "spec/a_spec.rb"), cwd: "engines/core", env: { SECRET: "hunter2" }, rubyManager: "mise", docker };
    const cmd = buildCommand(cfg);
    expect(cmd).toBe("docker compose -f docker-compose.yml run --rm -e SECRET -w /app/engines/core web bundle exec rspec spec/a_spec.rb");
    expect(cmd).not.toContain("hunter2");
  });

  it("debugs via rdbg with the port published on loopback only and keeps the configured Rails binding", () => {
    expect(buildCommand({ ...newConfig("rails-server", "s"), docker }, { debug: { port: 4567 } })).toBe(
      "docker compose -f docker-compose.yml run --rm -p 127.0.0.1:4567:4567 -w /app web rdbg --open --port=4567 --host=0.0.0.0 --command -- bin/rails server -b 127.0.0.1 -p 3000",
    );
  });

  it("publishes service ports only when ticked", () => {
    expect(buildCommand({ ...newConfig("rails-server", "s", "-b 0.0.0.0"), docker: { ...docker, servicePorts: true } })).toBe("docker compose -f docker-compose.yml run --rm --service-ports -w /app web bin/rails server -p 3000 -b 0.0.0.0");
  });

  it("prefers a shared-volume socket over TCP and publishes nothing", () => {
    expect(buildCommand({ ...newConfig("ruby", "r", "x.rb"), bundler: false, docker: { ...docker, socketPath: "tmp/rdbg.sock" } }, { debug: { port: 4567 } })).toBe(
      "docker compose -f docker-compose.yml run --rm -w /app web rdbg --open --sock-path=/app/tmp/rdbg.sock --command -- ruby x.rb",
    );
  });

  it("uses exec without publishing ports", () => {
    expect(buildCommand({ ...newConfig("ruby", "r", "x.rb"), bundler: false, docker: { ...docker, mode: "exec", composeFile: "" } }, { debug: { port: 12345 } })).toBe(
      "docker compose exec -w /app web rdbg --open --port=12345 --host=0.0.0.0 --command -- ruby x.rb",
    );
  });
});
