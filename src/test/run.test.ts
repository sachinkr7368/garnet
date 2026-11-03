import { ask } from "@tauri-apps/plugin-dialog";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../editor", async () => await import("./fakeEditor"));
vi.mock("../debug", () => ({ debugSession: vi.fn(), sessionFor: () => null, stopSession: vi.fn() }));

import { buildCommand, configList, editConfigurations, loadRunConfigs, newConfig, parseDotenv, rakeTask, safeEnv, saveRunConfigs, validateConfig, type RunConfig } from "../run";
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
    [{ name: "x", type: "rspec", env: { "A;touch /tmp/pwn": "1" } }],
    [{ name: "x", type: "rspec", env: { "1A": "1" } }],
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
    expect(buildCommand(newConfig("rspec", "s", "spec/a_spec.rb"), { debug: { port: 1234 } })).toBe("rdbg --open --port=1234 --host=127.0.0.1 --command -- rspec spec/a_spec.rb");
  });

  it("picks the RSpec runner like RubyMine: binstub, else the bundle's rspec when locked, else a global rspec", async () => {
    const spec = () => buildCommand(newConfig("rspec", "s", "spec"));
    expect(spec()).toBe("rspec spec");
    fake.files.set(`${ROOT}/Gemfile.lock`, "GEM\n  specs:\n    rspec-core (3.13.0)\n");
    await loadRunConfigs();
    expect(spec()).toBe("bundle exec rspec spec");
    state.project = project({ binRspec: true });
    expect(spec()).toBe("bin/rspec spec");
    state.project = project();
  });

  it("keeps the rake/rails -T error output so a failure says why", async () => {
    await trustProject(ROOT, true);
    const commands: string[] = [];
    fake.capture = (c) => (commands.push(c), "rails db:migrate  # Migrate the database\n");
    await rakeTask();
    expect(commands.find((c) => c.includes("-T"))).toBe("bin/rails -T 2>&1");
    document.getElementById("overlay-root")!.replaceChildren();
  });

  it("reads .ruby-version from the project root for chruby and rvm, whatever the working directory", () => {
    expect(buildCommand({ ...newConfig("ruby", "r", "x.rb"), cwd: "engines/core", bundler: false, rubyManager: "chruby" })).toBe(`chruby-exec "$(cat ${ROOT}/.ruby-version)" -- ruby x.rb`);
    expect(buildCommand({ ...newConfig("ruby", "r", "x.rb"), cwd: "engines/core", bundler: false, rubyManager: "rvm" })).toBe(`rvm in ${ROOT} do ruby x.rb`);
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

  it("stores no defaults while untrusted, so trusting shows the project's run.json without shadow copies", async () => {
    fake.files.set(`${ROOT}/.garnet/run.json`, JSON.stringify({ configurations: [{ name: "Rails server", type: "rails-server" }] }));
    await loadRunConfigs();
    expect(fake.config.has("run-configs.json")).toBe(false);
    await trustProject(ROOT, true);
    await loadRunConfigs();
    expect(configList().map((c) => [c.name, c.shared])).toEqual([["Rails server", true]]);
    expect(fake.config.has("run-configs.json")).toBe(false);
  });

  it("keeps Safe Mode selections and edits in memory and runs no shell probe", async () => {
    const captured: string[] = [];
    fake.capture = (c) => (captured.push(c), "");
    await loadRunConfigs();
    const select = document.querySelector<HTMLSelectElement>("#run-widget .run-select")!;
    select.value = "Rails console";
    select.dispatchEvent(new Event("change"));
    await saveRunConfigs([...configList(), newConfig("rspec", "Mine", "spec")]);
    await new Promise((r) => setTimeout(r, 0));
    expect(configList().map((c) => c.name)).toContain("Mine");
    expect(fake.config.has("run-configs.json")).toBe(false);
    expect(fake.calls).not.toContain("api.writeFile");
    expect(captured).toEqual([]);
  });

  it("asks for Trust before editing configurations and opens no editor in Safe Mode", async () => {
    await loadRunConfigs();
    vi.mocked(ask).mockClear();
    await editConfigurations();
    expect(ask).toHaveBeenCalledOnce();
    expect(document.querySelector(".rc-list")).toBeNull();
    vi.mocked(ask).mockResolvedValueOnce(true);
    await editConfigurations();
    expect(document.querySelector(".rc-list")).not.toBeNull();
    document.querySelector(".rc-list")!.closest("[data-modal]")?.remove();
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
    expect(JSON.parse(fake.files.get(`${ROOT}/.garnet/run.json`)!).configurations).toEqual([]);
    expect(stateEntry().configurations).toHaveLength(3);
  });

  it("keeps the selection out of an existing .garnet/run.json and never rewrites or deletes it on select", async () => {
    const raw = JSON.stringify({ selected: "Team server", configurations: [{ name: "Team server", type: "rails-server" }, { name: "Team specs", type: "rspec", env: { PATH: "/x" } }] });
    fake.files.set(`${ROOT}/.garnet/run.json`, raw);
    await trustProject(ROOT, true);
    await loadRunConfigs();
    fake.calls.length = 0;
    const select = document.querySelector<HTMLSelectElement>("#run-widget .run-select")!;
    select.value = "Team specs";
    select.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.files.get(`${ROOT}/.garnet/run.json`)).toBe(raw);
    expect(projectWrites()).toEqual([]);
    expect(fake.calls).not.toContain("api.deletePath");
    expect(stateEntry().selected).toBe("Team specs");
    await saveRunConfigs(configList().map((c) => ({ ...c, args: c.shared ? c.args : "x" })));
    expect(fake.files.get(`${ROOT}/.garnet/run.json`)).toBe(raw);
  });

  it("rewrites only the edited shared entry, keeping unknown keys and entries it could not read", async () => {
    const raw = { version: 2, configurations: [{ name: "Team server", type: "rails-server", note: "keep me" }, { name: "Legacy", type: "capistrano" }, { name: "Team specs", type: "rspec" }] };
    fake.files.set(`${ROOT}/.garnet/run.json`, JSON.stringify(raw));
    await trustProject(ROOT, true);
    await loadRunConfigs();
    await saveRunConfigs(configList().map((c) => (c.name === "Team server" ? { ...c, args: "-p 4000" } : c)));
    const file = JSON.parse(fake.files.get(`${ROOT}/.garnet/run.json`)!);
    expect(file.version).toBe(2);
    expect(file.selected).toBeUndefined();
    expect(file.configurations.map((c: { name: string }) => c.name)).toEqual(["Team server", "Team specs", "Legacy"]);
    expect(file.configurations[0]).toMatchObject({ note: "keep me", args: "-p 4000" });
    expect(file.configurations[1]).toEqual({ name: "Team specs", type: "rspec" });
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

  it("runs inside the service with env names only and the mapped working directory", async () => {
    fake.files.set(`${ROOT}/Gemfile.lock`, "GEM\n  specs:\n    rspec-core (3.13.0)\n");
    await loadRunConfigs();
    const cfg: RunConfig = { ...newConfig("rspec", "s", "spec/a_spec.rb"), cwd: "engines/core", env: { SECRET: "hunter2" }, rubyManager: "mise", docker };
    const cmd = buildCommand(cfg);
    expect(cmd).toBe("docker compose -f docker-compose.yml run --rm -e SECRET -w /app/engines/core web sh -c 'bundle exec rspec spec/a_spec.rb'");
    expect(cmd).not.toContain("hunter2");
  });

  it("debugs via rdbg with the port published on loopback only and keeps the configured Rails binding", () => {
    expect(buildCommand({ ...newConfig("rails-server", "s"), docker }, { debug: { port: 4567 } })).toBe(
      "docker compose -f docker-compose.yml run --rm -p 127.0.0.1:4567:4567 -w /app web sh -c 'rdbg --open --port=4567 --host=0.0.0.0 --command -- bin/rails server -b 127.0.0.1 -p 3000'",
    );
  });

  it("publishes service ports only when ticked", () => {
    expect(buildCommand({ ...newConfig("rails-server", "s", "-b 0.0.0.0"), docker: { ...docker, servicePorts: true } })).toBe("docker compose -f docker-compose.yml run --rm --service-ports -w /app web sh -c 'bin/rails server -p 3000 -b 0.0.0.0'");
  });

  it("prefers a shared-volume socket over TCP and publishes nothing", () => {
    expect(buildCommand({ ...newConfig("ruby", "r", "x.rb"), bundler: false, docker: { ...docker, socketPath: "tmp/rdbg.sock" } }, { debug: { port: 4567 } })).toBe(
      "docker compose -f docker-compose.yml run --rm -w /app web sh -c 'rdbg --open --sock-path=/app/tmp/rdbg.sock --command -- ruby x.rb'",
    );
  });

  it("runs a compound custom command entirely inside the container", () => {
    expect(buildCommand({ ...newConfig("custom", "c", "bin/setup && rails db:seed"), docker })).toBe("docker compose -f docker-compose.yml run --rm -w /app web sh -c 'bin/setup && rails db:seed'");
  });

  it("uses exec without publishing ports", () => {
    expect(buildCommand({ ...newConfig("ruby", "r", "x.rb"), bundler: false, docker: { ...docker, mode: "exec", composeFile: "" } }, { debug: { port: 12345 } })).toBe(
      "docker compose exec -w /app web sh -c 'rdbg --open --port=12345 --host=0.0.0.0 --command -- ruby x.rb'",
    );
  });
});
