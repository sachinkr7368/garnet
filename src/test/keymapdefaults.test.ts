import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { commands, eventKey, installKeyHandler, keymap } from "../commands";
import { welcomeHints } from "../keymapref";
import { bottom } from "../ui";

/// Defaults declared in the sources (`key:` on commands, `E(id, title, key, …)` editor actions).
function sourceDefaults(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of ["main.ts", "db.ts"]) {
    const src = readFileSync(`${process.cwd()}/src/${file}`, "utf8");
    for (const m of src.matchAll(/\{ id: "([^"]+)",[^\n]*?\bkey: "([^"]+)"/g)) out.set(m[1], m[2].split(" "));
    for (const m of src.matchAll(/\bE\("([^"]+)", "[^"]*", "([^"]+)"/g)) out.set(m[1], m[2].split(" "));
    for (const m of src.matchAll(/id: "([^"]+)",\n\s+title: "[^"]*",\n\s+key: "([^"]+)"/g)) out.set(m[1], m[2].split(" "));
  }
  return out;
}

/// RubyMine's predefined macOS keymap, from https://www.jetbrains.com/help/ruby/reference-keymap-mac-default.html
/// (JetBrains action → keystroke), for every action Garnet implements.
const RUBYMINE_MACOS: [string, string, string][] = [
  ["Find Action", "commandPalette", "cmd+shift+a"],
  ["Show Project window", "projectView", "cmd+1"],
  ["Show Find window", "findView", "cmd+3"],
  ["Show Run window", "runView", "cmd+4"],
  ["Show Debug window", "debugView", "cmd+5"],
  ["Show Problems window", "problemsView", "cmd+6"],
  ["Show Structure window", "structureView", "cmd+7"],
  ["Show Version Control window", "gitLogView", "cmd+9"],
  ["Show Commit window", "commitView", "cmd+0"],
  ["Commit", "commitView", "cmd+k"],
  ["Show Terminal window", "terminalView", "alt+f12"],
  ["Hide Active Tool Window", "hidePanels", "shift+escape"],
  ["Hide All Tool Windows", "hideAll", "cmd+shift+f12"],
  ["Jump to Last Tool Window", "lastToolWindow", "f12"],
  ["Show Intention Actions", "codeActions", "alt+enter"],
  ["Recent Files", "recentFiles", "cmd+e"],
  ["Find Usages", "findUsages", "alt+f7"],
  ["Show Usages", "peekReferences", "cmd+alt+f7"],
  ["Highlight Usages in File", "highlightUsages", "cmd+shift+f7"],
  ["Select In", "revealInTree", "alt+f1"],
  ["Settings", "settings", "cmd+,"],
  ["Debug…", "chooseDebug", "ctrl+alt+d"],
  ["Run…", "chooseRun", "ctrl+alt+r"],
  ["Run context configuration", "runSelected", "ctrl+r"],
  ["Debug context configuration", "debugSelected", "ctrl+d"],
  ["View Breakpoints", "viewBreakpoints", "cmd+shift+f8"],
  ["Attach to Process", "attach", "alt+shift+f5"],
  ["VCS Operations Popup", "vcsPopup", "ctrl+v"],
  ["Refactor This", "refactorThis", "ctrl+t"],
  ["Reformat Code", "format", "cmd+alt+l"],
  ["Save All", "saveAll", "cmd+s"],
  ["Delete Line", "deleteLine", "cmd+backspace"],
  ["Join Lines", "joinLines", "ctrl+shift+j"],
  ["Duplicate Line or Selection", "duplicateLine", "cmd+d"],
  ["Start New Line Before Current", "newLineBefore", "cmd+alt+enter"],
  ["Increase Font Size in All Editors", "increaseFont", "ctrl+shift+."],
  ["Decrease Font Size in All Editors", "decreaseFont", "ctrl+shift+,"],
  ["Move Caret to Matching Brace", "matchingBrace", "ctrl+m"],
  ["Extend Selection", "expandSelection", "alt+up"],
  ["Shrink Selection", "shrinkSelection", "alt+down"],
  ["Add Caret to Each Line in Selection", "caretsOnLines", "alt+shift+g"],
  ["Add Selection for Next Occurrence", "nextOccurrence", "ctrl+g"],
  ["Select All Occurrences", "selectAllOccurrences", "cmd+ctrl+g"],
  ["Parameter Info", "parameterInfo", "cmd+p"],
  ["Quick Documentation", "quickDoc", "f1"],
  ["Move Statement Up", "moveLineUp", "cmd+shift+up"],
  ["Move Statement Down", "moveLineDown", "cmd+shift+down"],
  ["Move Line Up", "moveLineUp", "alt+shift+up"],
  ["Move Line Down", "moveLineDown", "alt+shift+down"],
  ["Comment with Line Comment", "toggleComment", "cmd+/"],
  ["Comment with Block Comment", "blockComment", "cmd+alt+/"],
  ["Go to Line/Column", "goToLine", "cmd+l"],
  ["Switcher", "switcher", "ctrl+tab"],
  ["Back", "back", "cmd+["],
  ["Forward", "forward", "cmd+]"],
  ["Select Next Tab", "nextTab", "cmd+shift+]"],
  ["Select Previous Tab", "prevTab", "cmd+shift+["],
  ["Find", "find", "cmd+f"],
  ["Find Next", "findNext", "cmd+g"],
  ["Find Previous", "findPrevious", "cmd+shift+g"],
  ["Replace", "replace", "cmd+r"],
  ["Find in Files", "findInFiles", "cmd+shift+f"],
  ["Replace in Files", "replaceInFiles", "cmd+shift+r"],
  ["Go to File", "goToFile", "cmd+shift+o"],
  ["File Structure", "fileStructure", "cmd+f12"],
  ["Go to Symbol", "goToSymbol", "cmd+alt+o"],
  ["Go to Declaration or Usages", "goToDefinition", "cmd+b"],
  ["Go to Type Declaration", "goToTypeDefinition", "cmd+shift+b"],
  ["Go to Implementation(s)", "goToImplementation", "cmd+alt+b"],
  ["Next Highlighted Error", "nextError", "f2"],
  ["Previous Highlighted Error", "prevError", "shift+f2"],
  ["Stop", "stopDebug", "cmd+f2"],
  ["Resume Program", "resume", "cmd+alt+r"],
  ["Step Over", "stepOver", "f8"],
  ["Step Into / Next Difference", "stepInto", "f7"],
  ["Previous Difference", "diffPrev", "shift+f7"],
  ["Step Out", "stepOut", "shift+f8"],
  ["Evaluate Expression", "evaluate", "alt+f8"],
  ["Toggle Line Breakpoint", "toggleBreakpoint", "cmd+f8"],
  ["Rename", "rename", "shift+f6"],
  ["Update Project", "pull", "cmd+t"],
  ["Rollback", "rollbackLines", "cmd+alt+z"],
  ["Push", "push", "cmd+shift+k"],
  ["Next Change", "nextChange", "ctrl+alt+shift+down"],
  ["Previous Change", "prevChange", "ctrl+alt+shift+up"],
  ["New Query Console (DataGrip/RubyMine database)", "dbConsole", "cmd+shift+l"],
];

describe("RubyMine macOS default keymap", () => {
  const defaults = sourceDefaults();

  it.each(RUBYMINE_MACOS)("%s → %s is bound to %s", (_action, id, key) => {
    expect(defaults.get(id) ?? []).toContain(key);
  });

  it("binds no keystroke to two commands", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const [id, keys] of defaults) for (const k of keys) seen.has(k) ? dupes.push(`${k}: ${seen.get(k)} / ${id}`) : seen.set(k, id);
    expect(dupes).toEqual([]);
  });

  it("drops the old non-RubyMine bindings", () => {
    expect(defaults.get("goToTypeDefinition")).not.toContain("ctrl+shift+b");
    expect(defaults.get("save") ?? []).not.toContain("cmd+s");
    expect(defaults.get("saveAll")).not.toContain("cmd+alt+s");
  });

  it("only unbinds Monaco defaults on keys Garnet owns", () => {
    const src = readFileSync(`${process.cwd()}/src/editor.ts`, "utf8");
    const block = src.slice(src.indexOf("MONACO_CONFLICTS"), src.indexOf("};", src.indexOf("MONACO_CONFLICTS")));
    const owned = new Set([...defaults.values()].flat());
    const keys = [...block.matchAll(/^\s+"?([a-z0-9+,.[\]]+)"?: "/gm)].map((m) => m[1]);
    expect(keys).toContain("alt+f12");
    expect(keys.filter((k) => !owned.has(k))).toEqual([]);
  });
});

describe("terminal shortcut (⌥F12)", () => {
  const ran = vi.fn();
  beforeAll(() => {
    commands({ id: "terminalView", title: "View: Terminal", key: "alt+f12", run: ran }, { id: "goToFile", title: "Go to File", key: "cmd+shift+o", run: () => {} });
    installKeyHandler();
  });

  it("names ⌥F12 from the physical key, as WKWebView reports it", () => {
    expect(eventKey(new KeyboardEvent("keydown", { code: "F12", key: "F12", altKey: true }))).toBe("alt+f12");
    expect(keymap().get("alt+f12")).toBe("terminalView");
  });

  it.each([
    ["the Monaco editor", ".monaco-editor", "textarea"],
    ["the terminal", ".xterm", "textarea"],
    ["a plain input", "div", "input"],
  ])("opens the terminal from %s and keeps Monaco/xterm from seeing the key", async (_where, wrapper, field) => {
    ran.mockClear();
    const host = document.createElement("div");
    host.className = wrapper.replace(".", "");
    const target = document.createElement(field);
    host.append(target);
    document.body.append(host);
    const inner = vi.fn();
    target.addEventListener("keydown", inner);
    const e = new KeyboardEvent("keydown", { code: "F12", key: "F12", altKey: true, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    await Promise.resolve();
    await Promise.resolve();
    expect(ran).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    expect(inner).not.toHaveBeenCalled();
    host.remove();
  });

  it("activates like RubyMine: shows and focuses, hides only when already focused", () => {
    const el = document.createElement("div");
    const input = document.createElement("input");
    el.append(input);
    bottom.add({ id: "t-term", title: "Terminal", icon: "terminal", el });
    bottom.hide();
    bottom.activate("t-term");
    expect(bottom.active).toBe("t-term");
    expect(document.activeElement).toBe(input);
    (document.activeElement as HTMLElement).blur();
    bottom.activate("t-term");
    expect(bottom.active).toBe("t-term");
    expect(document.activeElement).toBe(input);
    bottom.activate("t-term");
    expect(bottom.active).toBeNull();
  });

  it("labels the empty-editor hints from the live keymap", () => {
    const hints = Object.fromEntries(welcomeHints());
    expect(hints.Terminal).toBe("⌥F12");
    expect(hints["Go to File"]).toBe("⌘⇧O");
  });
});
