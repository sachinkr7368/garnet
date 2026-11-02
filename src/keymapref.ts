import { allCommands, formatKey, keysFor } from "./commands";
import { updateSetting, setting } from "./settings";
import { fuzzyScore, h, icon, toast } from "./ui";

/// Help › Keymap Reference: every action with its current shortcuts.
export function showKeymapReference() {
  const filter = h("input", { class: "search-input", placeholder: "Filter actions", spellcheck: false });
  const table = h("div", { class: "st-keys" });
  const render = () =>
    table.replaceChildren(
      ...allCommands()
        .filter((c) => !filter.value || fuzzyScore(filter.value, c.title) !== null)
        .map((c) =>
          h(
            "div",
            { class: "st-key-row" },
            h("span", { class: "st-key-title" }, c.title),
            h("span", { class: "st-chips" }, ...keysFor(c.id).map((k) => h("span", { class: "chip" }, formatKey(k), " "))),
          ),
        ),
    );
  filter.oninput = render;
  render();
  const close = () => backdrop.remove();
  const backdrop = h(
    "div",
    { class: "qp-backdrop", onmousedown: (e: MouseEvent) => e.target === backdrop && close() },
    h(
      "div",
      { class: "st-dialog" },
      h("div", { class: "rc-title" }, icon("keyboard"), " Keymap Reference", h("span", { class: "spacer" }), h("span", { class: "dim" }, "double ⇧ = Search Everywhere")),
      h("div", { class: "st-page" }, filter, table),
      h("div", { class: "rc-actions" }, h("button", { class: "btn primary", onclick: close }, "Close")),
    ),
  );
  backdrop.addEventListener("keydown", (e) => e.key === "Escape" && close());
  document.getElementById("overlay-root")!.append(backdrop);
  filter.focus();
}

/// JetBrains action ids → Garnet command ids, for importing an exported keymap XML.
const JETBRAINS_ACTIONS: Record<string, string> = {
  GotoFile: "goToFile", GotoClass: "goToClass", GotoSymbol: "goToSymbol", RecentFiles: "recentFiles",
  RecentLocations: "recentLocations", GotoDeclaration: "goToDefinition", QuickImplementations: "peekDefinition",
  FindUsages: "findUsages", ShowUsages: "peekReferences", RenameElement: "rename", ReformatCode: "format",
  CommentByLineComment: "toggleComment", CommentByBlockComment: "blockComment", EditorDuplicate: "duplicateLine",
  EditorDeleteLine: "deleteLine", EditorSelectWord: "expandSelection", EditorUnSelectWord: "shrinkSelection",
  SelectNextOccurrence: "nextOccurrence", MoveLineUp: "moveLineUp", MoveLineDown: "moveLineDown",
  MoveStatementUp: "moveLineUp", MoveStatementDown: "moveLineDown", ShowIntentionActions: "codeActions",
  Run: "runSelected", Debug: "debugSelected", RunClass: "runTestAtCursor", DebugClass: "debugTestAtCursor",
  ChooseRunConfiguration: "chooseRun", ChooseDebugConfiguration: "chooseDebug", Rerun: "rerun",
  StepOver: "stepOver", StepInto: "stepInto", StepOut: "stepOut", Resume: "resume", Stop: "stopDebug",
  ToggleLineBreakpoint: "toggleBreakpoint", ViewBreakpoints: "viewBreakpoints", EvaluateExpression: "evaluate",
  CheckinProject: "commitView", "Vcs.Push": "push", "Vcs.UpdateProject": "pull", "Vcs.QuickListPopupAction": "vcsPopup",
  "Git.Branches": "branches", ActivateProjectToolWindow: "projectView", ActivateTerminalToolWindow: "terminalView",
  ActivateRunToolWindow: "runView", ActivateDebugToolWindow: "debugView", ActivateProblemsViewToolWindow: "problemsView",
  ActivateStructureToolWindow: "structureView", ActivateFindToolWindow: "findView", ActivateCommitToolWindow: "commitView",
  GotoAction: "commandPalette", ShowSettings: "settings", GotoTest: "goToTest", GotoRelated: "related",
  FileStructurePopup: "fileStructure", Back: "back", Forward: "forward", FindInPath: "findInFiles", ReplaceInPath: "replaceInFiles",
  GotoImplementation: "goToImplementation", GotoTypeDeclaration: "goToTypeDefinition", ToggleInlayHintsGloballyAction: "toggleInlayHints", Find: "find",
  Replace: "replace", FindNext: "findNext", FindPrevious: "findPrevious", CloseContent: "closeTab", NextTab: "nextTab",
  PreviousTab: "prevTab", Switcher: "switcher", HideAllWindows: "hideAll", GotoLine: "goToLine", SaveAll: "saveAll",
  SearchEverywhere: "searchEverywhere", "Annotate": "gitBlame", "Compare.SameVersion": "gitDiff",
  ActivateVersionControlToolWindow: "gitLogView", "Vcs.ShowTabbedFileHistory": "fileHistory", "Vcs.RollbackChangedLines": "rollbackLines",
  VcsShowNextChangeMarker: "nextChange", VcsShowPrevChangeMarker: "prevChange", "Git.Stash": "stash", "Git.Unstash": "unstash",
  "Git.ResolveConflicts": "resolveConflicts", NextDiff: "diffNext", PreviousDiff: "diffPrev",
};

const KEY_NAMES: Record<string, string> = {
  BACK_SPACE: "backspace", DELETE: "delete", ENTER: "enter", ESCAPE: "escape", TAB: "tab", SPACE: "space",
  SLASH: "/", BACK_SLASH: "\\", OPEN_BRACKET: "[", CLOSE_BRACKET: "]", COMMA: ",", PERIOD: ".", SEMICOLON: ";",
  BACK_QUOTE: "`", EQUALS: "=", MINUS: "-", QUOTE: "'", UP: "up", DOWN: "down", LEFT: "left", RIGHT: "right",
};

export function jetbrainsKeystroke(stroke: string): string | null {
  const parts = stroke.trim().split(/\s+/);
  const key = parts.pop()!;
  const mods = new Set(parts.map((p) => ({ meta: "cmd", control: "ctrl", ctrl: "ctrl", alt: "alt", shift: "shift" })[p.toLowerCase()] ?? "?"));
  if (mods.has("?")) return null;
  const name = KEY_NAMES[key] ?? (/^(F\d+|[A-Z0-9])$/.test(key) ? key.toLowerCase() : null);
  if (!name) return null;
  return [...["cmd", "ctrl", "alt", "shift"].filter((m) => mods.has(m)), name].join("+");
}

/// Applies a JetBrains keymap XML export on top of the RubyMine-compatible defaults.
export async function importJetBrainsKeymap(xml: string) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror") || !doc.querySelector("keymap")) throw new Error("not a JetBrains keymap XML file");
  const bindings: Record<string, string> = { ...setting<Record<string, string>>("keymap.bindings") };
  const removed = new Set(setting<string[]>("keymap.removed"));
  let applied = 0;
  let skipped = 0;
  for (const action of doc.querySelectorAll("keymap > action")) {
    const id = JETBRAINS_ACTIONS[action.getAttribute("id") ?? ""];
    if (!id) {
      skipped++;
      continue;
    }
    for (const k of keysFor(id)) removed.add(k);
    for (const [k, v] of Object.entries(bindings)) if (v === id) delete bindings[k];
    for (const ks of action.querySelectorAll("keyboard-shortcut")) {
      if (ks.getAttribute("second-keystroke")) continue;
      const key = jetbrainsKeystroke(ks.getAttribute("first-keystroke") ?? "");
      if (!key) continue;
      bindings[key] = id;
      removed.delete(key);
      applied++;
    }
  }
  await updateSetting("keymap.bindings", bindings);
  await updateSetting("keymap.removed", [...removed]);
  toast(`Imported ${applied} shortcuts${skipped ? `; ${skipped} actions have no Garnet equivalent and were skipped` : ""}.`);
}
