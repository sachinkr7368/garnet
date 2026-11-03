import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { allCommands, bindable, captureNextKey, commands, eventKey, formatKey, installKeyHandler, keymap, keysFor, runEditorAction } from "../commands";
import { importJetBrainsKeymap, jetbrainsKeystroke } from "../keymapref";
import { loadSettings, updateSetting } from "../settings";
import { fake } from "./fakeIpc";

const noop = () => {};

beforeAll(() => {
  commands(
    { id: "goToFile", title: "Go to File", key: "cmd+shift+o", run: noop },
    { id: "recentFiles", title: "Recent Files", key: "cmd+e", run: noop },
    { id: "commandPalette", title: "Find Action", key: "cmd+shift+a", run: noop },
    { id: "goToDefinition", title: "Go to Declaration", key: "cmd+b f12", run: noop },
    { id: "projectView", title: "Project", key: "cmd+1", run: noop },
    { id: "stepOver", title: "Step Over", key: "f8", run: noop },
  );
});

beforeEach(async () => {
  fake.reset();
  await loadSettings(null);
});

describe("keymap", () => {
  it("maps every default keystroke, including several keys per command", () => {
    const km = keymap();
    expect(km.get("cmd+shift+o")).toBe("goToFile");
    expect(km.get("cmd+b")).toBe("goToDefinition");
    expect(km.get("f12")).toBe("goToDefinition");
    expect(keysFor("goToDefinition").sort()).toEqual(["cmd+b", "f12"]);
  });

  it("has no conflicting defaults", () => {
    const km = keymap();
    const shadowed = allCommands().flatMap((c) => (c.key ?? "").split(" ").filter(Boolean).filter((k) => km.get(k) !== c.id));
    expect(shadowed).toEqual([]);
  });

  it("applies the VS Code preset, dropping the RubyMine key of each remapped command", async () => {
    await updateSetting("keymap.preset", "vscode");
    const km = keymap();
    expect(km.get("cmd+p")).toBe("goToFile");
    expect(km.has("cmd+shift+o")).toBe(true);
    expect(km.get("cmd+shift+o")).toBe("fileStructure");
    expect(km.get("cmd+b")).toBe("projectView");
    expect(km.get("f12")).toBe("goToDefinition");
  });

  it("applies removed keys, then custom bindings", async () => {
    await updateSetting("keymap.removed", ["cmd+e"]);
    await updateSetting("keymap.bindings", { "cmd+alt+e": "recentFiles", "cmd+shift+o": "recentFiles" });
    const km = keymap();
    expect(km.has("cmd+e")).toBe(false);
    expect(km.get("cmd+alt+e")).toBe("recentFiles");
    expect(km.get("cmd+shift+o")).toBe("recentFiles");
  });

  it("names keystrokes from keyboard events by physical key", () => {
    const ev = (code: string, mods: Partial<KeyboardEvent> = {}) => eventKey({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods } as KeyboardEvent);
    expect(ev("KeyO", { metaKey: true, shiftKey: true })).toBe("cmd+shift+o");
    expect(ev("Digit1", { metaKey: true })).toBe("cmd+1");
    expect(ev("F8", { altKey: true })).toBe("alt+f8");
    expect(ev("BracketLeft", { metaKey: true })).toBe("cmd+[");
    expect(ev("ArrowUp", { ctrlKey: true, altKey: true })).toBe("ctrl+alt+up");
  });

  it("formats keystrokes with macOS symbols", () => {
    expect(formatKey("cmd+shift+o")).toBe("⌘⇧O");
    expect(formatKey("ctrl+alt+up")).toBe("⌃⌥↑");
  });
});

describe("JetBrains keymap import", () => {
  it.each([
    ["meta shift O", "cmd+shift+o"],
    ["control alt UP", "ctrl+alt+up"],
    ["shift alt meta F10", "cmd+alt+shift+f10"],
    ["meta OPEN_BRACKET", "cmd+["],
    ["ctrl BACK_SPACE", "ctrl+backspace"],
    ["meta 1", "cmd+1"],
  ])("parses %s", (stroke, key) => expect(jetbrainsKeystroke(stroke)).toBe(key));

  it("rejects unknown modifiers and keys", () => {
    expect(jetbrainsKeystroke("hyper O")).toBeNull();
    expect(jetbrainsKeystroke("meta NUMPAD5")).toBeNull();
  });

  it("replaces the keys of mapped actions and skips unknown ones and chords", async () => {
    await importJetBrainsKeymap(`<keymap version="1" name="Mine" parent="Mac OS X 10.5+">
      <action id="RecentFiles"><keyboard-shortcut first-keystroke="meta alt E"/></action>
      <action id="GotoFile"><keyboard-shortcut first-keystroke="meta K" second-keystroke="meta F"/></action>
      <action id="SomePluginAction"><keyboard-shortcut first-keystroke="meta alt P"/></action>
    </keymap>`);
    const km = keymap();
    expect(km.get("cmd+alt+e")).toBe("recentFiles");
    expect(km.has("cmd+e")).toBe(false);
    expect(km.has("cmd+shift+o")).toBe(false);
    expect(km.has("cmd+alt+p")).toBe(false);
  });

  it("refuses files that are not keymaps", async () => {
    await expect(importJetBrainsKeymap("<settings/>")).rejects.toThrow(/not a JetBrains keymap/);
    await expect(importJetBrainsKeymap("<keymap")).rejects.toThrow();
  });
});

describe("shortcut capture", () => {
  it("rejects keys the handler can never dispatch and keeps listening", () => {
    for (const k of ["q", "shift+q", "enter", "shift+enter"]) expect(bindable(k), k).toBe(false);
    for (const k of ["cmd+ctrl+j", "alt+f7", "f5", "shift+f6", "ctrl+shift+g"]) expect(bindable(k), k).toBe(true);
    installKeyHandler();
    const got: string[] = [];
    const bad: string[] = [];
    captureNextKey((k) => got.push(k), (k) => bad.push(k));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "q", code: "KeyQ" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", code: "KeyJ", metaKey: true, ctrlKey: true }));
    expect(bad).toEqual(["q", "enter"]);
    expect(got).toEqual(["cmd+ctrl+j"]);
  });
});

describe("editor actions from outside the editor", () => {
  it("focuses the editor before running the action", async () => {
    const log: string[] = [];
    const ed = { focus: () => log.push("focus"), getAction: (id: string) => ({ run: async () => void log.push(id) }) };
    await runEditorAction(ed, "editor.action.gotoLine");
    expect(log).toEqual(["focus", "editor.action.gotoLine"]);
    expect(runEditorAction(null, "x")).toBeUndefined();
  });
});
