import { beforeEach, describe, expect, it } from "vitest";
import { checkTrust, editableSettingsPath, globalOnly, globToRegExp, isTrusted, loadSettings, loadSession, modifyConfig, saveSession, setting, trustProject, updateSetting } from "../settings";
import { api, fake } from "./fakeIpc";

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

describe("config files Garnet writes", () => {
  const problemToasts = () => [...document.querySelectorAll(".toast.error")].filter((t) => t.textContent!.includes("settings.json"));

  it("never overwrites a settings.json that does not parse, and keeps a persistent notice with an Open action", async () => {
    document.getElementById("overlay-root")!.replaceChildren();
    const broken = '{"editor.fontSize":16,"terminal.env":{"A":"1"},}';
    fake.config.set("settings.json", broken);
    await loadSettings(ROOT);
    await updateSetting("appearance.theme", "dark");
    expect(fake.config.get("settings.json")).toBe(broken);
    expect(setting("appearance.theme")).toBe("system");
    expect(problemToasts()).toHaveLength(1);
    const open = [...problemToasts()[0].querySelectorAll("button")].find((b) => b.textContent === "Open settings.json")!;
    const opened: string[] = [];
    window.addEventListener("garnet:open-file", (e) => opened.push((e as CustomEvent<string>).detail), { once: true });
    open.click();
    expect(opened).toEqual(["/config/settings.json"]);
  });

  it("treats an existing empty settings.json as broken, not as {}", async () => {
    document.getElementById("overlay-root")!.replaceChildren();
    fake.config.set("settings.json", JSON.stringify({ "editor.fontSize": 15 }));
    await loadSettings(ROOT);
    fake.config.set("settings.json", "");
    await loadSettings(ROOT);
    expect(setting("editor.fontSize")).toBe(15);
    expect(problemToasts()[0]?.textContent).toContain("empty");
    await updateSetting("appearance.theme", "dark");
    expect(fake.config.get("settings.json")).toBe("");
  });

  it("saves again once a broken settings.json was fixed outside Garnet, without a reload", async () => {
    fake.config.set("settings.json", "{ nope");
    await loadSettings(ROOT);
    await updateSetting("appearance.theme", "dark");
    expect(fake.config.get("settings.json")).toBe("{ nope");
    fake.config.set("settings.json", JSON.stringify({ "editor.fontSize": 17 }));
    await updateSetting("appearance.theme", "dark");
    expect(JSON.parse(fake.config.get("settings.json")!)).toEqual({ "editor.fontSize": 17, "appearance.theme": "dark" });
    expect(setting("editor.fontSize")).toBe(17);
  });

  it("merges a key into what is on disk now, so another window's change survives", async () => {
    await loadSettings(ROOT);
    let first = true;
    (api as any).configRead = async (name: string) => {
      const v = fake.config.get(name) ?? null;
      if (first && name === "sessions.json") {
        first = false;
        fake.config.set(name, JSON.stringify({ "/other": { tabs: ["x.rb"] } }));
      }
      return v;
    };
    try {
      await saveSession(ROOT, { tabs: ["a.rb"] });
    } finally {
      (api as any).configRead = async (name: string) => fake.config.get(name) ?? null;
    }
    expect(await loadSession("/other")).toEqual({ tabs: ["x.rb"] });
    expect(await loadSession(ROOT)).toEqual({ tabs: ["a.rb"] });
  });

  it("refuses to replace a corrupt state file instead of wiping every project's entry", async () => {
    fake.config.set("run-configs.json", "{ truncated");
    expect(await modifyConfig("run-configs.json", {}, (all) => ({ ...all, [ROOT]: {} }))).toBe(false);
    expect(fake.config.get("run-configs.json")).toBe("{ truncated");
  });

  it("creates settings.json before opening it on a fresh install", async () => {
    expect(fake.config.has("settings.json")).toBe(false);
    expect(await editableSettingsPath()).toBe("/config/settings.json");
    expect(fake.config.get("settings.json")).toBe("{}\n");
    fake.config.set("settings.json", '{"a":1}');
    await editableSettingsPath();
    expect(fake.config.get("settings.json")).toBe('{"a":1}');
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

  it("Trust Project tells the backend before announcing it, and a saved trust is restored on the next launch", async () => {
    await loadSettings(ROOT);
    expect(await checkTrust(ROOT)).toBe(false);
    let flagWhenAnnounced: boolean | null = null;
    const onTrusted = () => (flagWhenAnnounced = fake.trustedFlag);
    window.addEventListener("garnet:trusted", onTrusted);
    await trustProject(ROOT);
    window.removeEventListener("garnet:trusted", onTrusted);
    expect(flagWhenAnnounced).toBe(true);
    fake.trustedFlag = false;
    expect(await checkTrust(ROOT)).toBe(true);
    expect(fake.trustedFlag).toBe(true);
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
