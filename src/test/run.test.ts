import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../editor", async () => await import("./fakeEditor"));
vi.mock("../debug", () => ({ debugSession: vi.fn(), sessionFor: () => null, stopSession: vi.fn() }));

import { buildCommand, configList, loadRunConfigs, newConfig, parseDotenv, safeEnv, validateConfig } from "../run";
import { loadSettings, trustProject } from "../settings";
import { state } from "../state";
import type { ProjectInfo } from "../ipc";
import { fake } from "./fakeIpc";

const ROOT = "/work/blog";
const project = (over: Partial<ProjectInfo> = {}): ProjectInfo => ({ root: ROOT, name: "blog", git: true, rails: true, rspec: false, minitest: true, binRspec: false, debugBundled: false, ...over });

beforeEach(async () => {
  fake.reset();
  state.project = project();
  await loadSettings(ROOT);
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
    expect(buildCommand(newConfig("rspec", "s", "spec/a_spec.rb"), { port: 1234 })).toBe("rdbg --open --port=1234 --host=127.0.0.1 --command -- bundle exec rspec spec/a_spec.rb");
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
