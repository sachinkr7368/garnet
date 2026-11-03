import { beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
Element.prototype.scrollIntoView ??= () => {};
(globalThis as any).Worker ??= class {
  onmessage = null;
  postMessage() {}
  terminate() {}
  addEventListener() {}
};

import { allCommands, eventKey, keymap } from "../commands";
import { MONACO_CONFLICTS } from "../editor";
import { welcomeHints } from "../keymapref";
import { updateSetting } from "../settings";
import { state } from "../state";
import { bottom } from "../ui";

// The real app: main.ts registers every command (and db.ts its own) and installs the key handler.
beforeAll(async () => {
  await import("../main");
});

/// Live defaults from the command registry (no user bindings are loaded in tests).
const defaults = () => new Map(allCommands().map((c) => [c.id, (c.key ?? "").split(" ").filter(Boolean)]));

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
  // View | Appearance | Zoom IDE, https://www.jetbrains.com/help/ruby/ide-zoom-level.html (macOS keymap)
  ["Zoom In IDE", "zoomIn", "ctrl+alt+="],
  ["Zoom Out IDE", "zoomOut", "ctrl+alt+-"],
  ["Reset IDE Zoom", "zoomReset", "ctrl+alt+0"],
  ["Expand", "expandRegion", "cmd+numpadadd"],
  ["Collapse", "collapseRegion", "cmd+numpadsubtract"],
  ["Expand Recursively", "expandRecursively", "cmd+alt+numpadadd"],
  ["Collapse Recursively", "collapseRecursively", "cmd+alt+numpadsubtract"],
  ["Expand All", "expandAll", "cmd+shift+numpadadd"],
  ["Collapse All", "collapseAll", "cmd+shift+numpadsubtract"],
  // The macOS reference card lists the main-keyboard keys too:
  // https://resources.jetbrains.com/storage/products/rubymine/docs/RubyMine_ReferenceCard_mac.pdf
  ["Expand code block", "expandRegion", "cmd+="],
  ["Collapse code block", "collapseRegion", "cmd+-"],
  ["Expand all", "expandAll", "cmd+shift+="],
  ["Collapse all", "collapseAll", "cmd+shift+-"],
  ["Last Edit Location", "lastEditLocation", "cmd+shift+backspace"],
  ["Run To Cursor", "runToCursor", "alt+f9"],
  ["Introduce Variable", "extractVariable", "cmd+alt+v"],
  ["Extract Method", "extractMethod", "cmd+alt+m"],
  ["Toggle Case", "toggleCase", "cmd+shift+u"],
  ["Deselect Last Occurrence", "unselectOccurrence", "ctrl+shift+g"],
  ["Copy Paths", "copyPath", "cmd+shift+c"],
  ["Copy Reference", "copyReference", "cmd+alt+shift+c"],
  ["Introduce Constant (extract-constant.html)", "extractConstant", "cmd+alt+c"],
  ["Insert Live Template (using-live-templates.html)", "insertLiveTemplate", "cmd+j"],
];

describe("RubyMine macOS default keymap", () => {
  it.each(RUBYMINE_MACOS)("%s → %s is bound to %s", (_action, id, key) => {
    expect(keymap().get(key)).toBe(id);
  });

  it("binds no keystroke to two commands", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const [id, keys] of defaults()) for (const k of keys) seen.has(k) ? dupes.push(`${k}: ${seen.get(k)} / ${id}`) : seen.set(k, id);
    expect(dupes).toEqual([]);
  });

  it("drops the old non-RubyMine bindings and anything the docs don't list", () => {
    const km = keymap();
    expect(km.has("ctrl+shift+b")).toBe(false);
    expect(km.has("cmd+alt+s")).toBe(false);
    expect(km.get("cmd+s")).toBe("saveAll");
    expect(km.has("cmd+shift+l")).toBe(false);
  });

  it("leaves the keys macOS owns to the menu bar and the system", () => {
    const km = keymap();
    const taken = ["cmd+h", "cmd+alt+h", "cmd+m", "cmd+q", "cmd+ctrl+f", "cmd+ctrl+space", "cmd+`", "cmd+tab", "cmd+space", "cmd+c", "cmd+v", "cmd+x", "cmd+z", "cmd+shift+z", "cmd+a", "alt+backspace"].filter((k) => km.has(k));
    expect(taken).toEqual([]);
  });

  it("standard macOS zoom keys are opt-in and take ⌘= ⌘- ⌘0 from folding and Commit", async () => {
    expect(keymap().get("cmd+0")).toBe("commitView");
    await updateSetting("keymap.macZoomKeys", true);
    const km = keymap();
    expect([km.get("cmd+="), km.get("cmd+shift+="), km.get("cmd+-"), km.get("cmd+0")]).toEqual(["zoomIn", "zoomIn", "zoomOut", "zoomReset"]);
    expect(km.get("ctrl+alt+=")).toBe("zoomIn");
    expect(km.get("cmd+numpadadd")).toBe("expandRegion");
    await updateSetting("keymap.macZoomKeys", undefined);
  });

  it("menu bar shows app shortcuts and find, but not other editor actions", async () => {
    const { menuAccelerators } = await import("../main");
    const accels = menuAccelerators();
    expect(accels.zoomIn).toBe("ctrl+alt+=");
    expect(accels.saveAll).toBe("cmd+s");
    expect(accels.closeTab).toBe("cmd+w");
    expect(accels.find).toBe("cmd+f");
    expect(accels.deleteLine).toBeNull();
    expect(accels.expandRegion).toBeNull();
    expect("quit" in accels).toBe(false);
  });

  it("a menu shortcut for an editor action is ignored while a text field outside the editor has focus", async () => {
    const { menuBlockedByFocus } = await import("../main");
    const input = document.createElement("input");
    const term = document.createElement("div");
    term.className = "xterm";
    const termInput = document.createElement("textarea");
    term.append(termInput);
    const monacoEl = document.createElement("div");
    monacoEl.className = "monaco-editor";
    const monacoInput = document.createElement("textarea");
    monacoEl.append(monacoInput);
    expect(menuBlockedByFocus("find", input)).toBe(true);
    expect(menuBlockedByFocus("findNext", termInput)).toBe(true);
    expect(menuBlockedByFocus("find", monacoInput)).toBe(false);
    expect(menuBlockedByFocus("find", document.body)).toBe(false);
    expect(menuBlockedByFocus("saveAll", input)).toBe(false);
    const tree = document.createElement("div");
    tree.id = "tree";
    tree.tabIndex = 0;
    expect(menuBlockedByFocus("find", tree)).toBe(true);
  });

  it("only unbinds Monaco defaults on keys Garnet owns", () => {
    const km = keymap();
    expect(Object.keys(MONACO_CONFLICTS)).toContain("alt+f12");
    expect(Object.keys(MONACO_CONFLICTS).filter((k) => !km.has(k))).toEqual([]);
  });
});

describe("terminal shortcut (⌥F12)", () => {
  it("names ⌥F12 from the physical key, as WKWebView reports it", () => {
    expect(eventKey(new KeyboardEvent("keydown", { code: "F12", key: "F12", altKey: true }))).toBe("alt+f12");
    expect(keymap().get("alt+f12")).toBe("terminalView");
  });

  it.each([
    ["the Monaco editor", "monaco-editor", "textarea"],
    ["the terminal", "xterm", "textarea"],
    ["a plain input", "x", "input"],
  ])("activates the Terminal tool window from %s and keeps Monaco/xterm from seeing the key", async (_where, cls, field) => {
    const activate = vi.spyOn(bottom, "activate").mockImplementation(() => {});
    state.project = { root: "/p", name: "p" } as typeof state.project;
    const host = document.createElement("div");
    host.className = cls;
    const target = document.createElement(field);
    host.append(target);
    document.body.append(host);
    const inner = vi.fn();
    target.addEventListener("keydown", inner);
    const e = new KeyboardEvent("keydown", { code: "F12", key: "F12", altKey: true, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    await new Promise((r) => setTimeout(r, 0));
    expect(activate).toHaveBeenCalledWith("terminal");
    expect(e.defaultPrevented).toBe(true);
    expect(inner).not.toHaveBeenCalled();
    host.remove();
    activate.mockRestore();
    state.project = null;
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
    expect(hints["Find Action"]).toBe("⌘⇧A");
  });
});
