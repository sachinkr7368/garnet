import { beforeEach, describe, expect, it } from "vitest";
import { checkTrust, globalOnly, globToRegExp, isTrusted, loadSettings, setting, trustProject, updateSetting } from "../settings";
import { fake } from "./fakeIpc";

const ROOT = "/work/blog";

beforeEach(async () => {
  fake.reset();
  await loadSettings(null);
});

describe("settings merge", () => {
  it("falls back from project to global to the schema default", async () => {
    fake.config.set("settings.json", JSON.stringify({ "editor.fontSize": 15, "editor.minimap": true }));
    fake.files.set(`${ROOT}/.garnet/settings.json`, JSON.stringify({ "editor.fontSize": 18 }));
    await loadSettings(ROOT);
    expect(setting("editor.fontSize")).toBe(18);
    expect(setting("editor.minimap")).toBe(true);
    expect(setting("editor.wordWrap")).toBe("off");
  });

  it("keeps the previous values when a settings file is not valid JSON", async () => {
    fake.config.set("settings.json", JSON.stringify({ "editor.fontSize": 15 }));
    await loadSettings(ROOT);
    fake.config.set("settings.json", "{ nope");
    await loadSettings(ROOT);
    expect(setting("editor.fontSize")).toBe(15);
  });

  it("writes to the chosen scope and resets with undefined", async () => {
    await loadSettings(ROOT);
    await updateSetting("editor.fontSize", 20, "project");
    expect(JSON.parse(fake.files.get(`${ROOT}/.garnet/settings.json`)!)).toEqual({ "editor.fontSize": 20 });
    expect(setting("editor.fontSize")).toBe(20);
    await updateSetting("editor.fontSize", undefined, "project");
    expect(setting("editor.fontSize")).toBe(13);
  });
});

describe("global-only settings", () => {
  it("matches the keys that choose programs or their environment", () => {
    for (const k of ["ruby.lspCommand", "ruby.versionManager", "git.path", "terminal.shell", "terminal.env", "debug.rdbgPath", "testing.rspecRunner", "rails.serverPort"])
      expect(globalOnly(k), k).toBe(true);
    for (const k of ["editor.fontSize", "appearance.theme", "keymap.bindings", "terminal.fontSize"]) expect(globalOnly(k), k).toBe(false);
  });

  it("ignores them in .garnet/settings.json", async () => {
    fake.config.set("settings.json", JSON.stringify({ "git.path": "/usr/bin/git" }));
    fake.files.set(`${ROOT}/.garnet/settings.json`, JSON.stringify({ "ruby.lspCommand": "touch /tmp/pwned", "git.path": "./evil", "terminal.env": { A: "1" }, "editor.fontSize": 11 }));
    await loadSettings(ROOT);
    expect(setting("ruby.lspCommand")).toBe("");
    expect(setting("git.path")).toBe("/usr/bin/git");
    expect(setting("terminal.env")).toEqual({});
    expect(setting("editor.fontSize")).toBe(11);
  });

  it("forces writes of global-only keys into the global file", async () => {
    await loadSettings(ROOT);
    await updateSetting("ruby.lspCommand", "ruby-lsp --debug", "project");
    expect(fake.files.has(`${ROOT}/.garnet/settings.json`)).toBe(false);
    expect(JSON.parse(fake.config.get("settings.json")!)).toEqual({ "ruby.lspCommand": "ruby-lsp --debug" });
  });
});

describe("trust", () => {
  it("is untrusted until trusted, keyed by canonical path, and tells git", async () => {
    await loadSettings(ROOT);
    expect(await checkTrust(ROOT)).toBe(false);
    expect(isTrusted()).toBe(false);
    expect(fake.trustedFlag).toBe(false);
    await trustProject(`${ROOT}/`, true);
    expect(JSON.parse(fake.config.get("trusted.json")!)).toEqual([ROOT]);
    expect(await checkTrust(ROOT)).toBe(true);
    expect(fake.trustedFlag).toBe(true);
    expect(await checkTrust("/work/other")).toBe(false);
    expect(fake.trustedFlag).toBe(false);
  });

  it("never stores trust in the project", async () => {
    await loadSettings(ROOT);
    await trustProject(ROOT, true);
    expect([...fake.files.keys()].filter((k) => k.startsWith(ROOT))).toEqual([]);
  });
});

describe("globToRegExp", () => {
  it.each([
    ["*.rb", "user.rb", true],
    ["*.rb", "app/user.rb", false],
    ["**/*.rb", "app/models/user.rb", true],
    ["Procfile*", "Procfile.dev", true],
    ["file?.txt", "file1.txt", true],
    ["*.{yml,yaml}", "a.yaml", true],
    ["*.{yml,yaml}", "a.json", false],
    [".env*", ".env.local", true],
    ["a+b.rb", "a+b.rb", true],
  ])("%s ~ %s → %s", (glob, path, ok) => expect(globToRegExp(glob).test(path)).toBe(ok));
});
