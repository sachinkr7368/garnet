import { setting } from "./settings";
import { quickPick, setShortcutResolver } from "./ui";

export interface Command {
  id: string;
  title: string;
  key?: string;
  editor?: boolean;
  run: () => unknown;
}

const registry = new Map<string, Command>();
let lastShift = 0;

/// Overrides applied on top of the RubyMine-compatible defaults for the VS Code-style preset.
const VSCODE_PRESET: Record<string, string> = {
  "cmd+p": "goToFile",
  "cmd+shift+p": "commandPalette",
  "cmd+t": "goToSymbol",
  "cmd+shift+o": "fileStructure",
  f12: "goToDefinition",
  "shift+f12": "findUsages",
  f2: "rename",
  "alt+shift+f": "format",
  "cmd+.": "codeActions",
  "ctrl+`": "terminalView",
  "cmd+b": "projectView",
  "cmd+j": "hidePanels",
  "ctrl+g": "goToLine",
  f5: "debugSelected",
  "ctrl+f5": "runSelected",
  "shift+f5": "stopDebug",
  f9: "toggleBreakpoint",
  f10: "stepOver",
  f11: "stepInto",
  "shift+f11": "stepOut",
  "ctrl+shift+g": "commitView",
};

/// Runs a Monaco editor action. Actions with a quick input (Go to Line) need the editor focused, which it is not
/// when the command comes from the tree, a tool window or Find Action.
export function runEditorAction(ed: { focus(): void; getAction(id: string): { run(): Promise<void> } | null } | null, id: string) {
  if (!ed) return;
  ed.focus();
  return ed.getAction(id)?.run();
}

export function command(c: Command) {
  registry.set(c.id, c);
}

export function commands(...cs: Command[]) {
  cs.forEach(command);
}

export const allCommands = () => [...registry.values()].sort((a, b) => a.title.localeCompare(b.title));

export function runCommand(id: string) {
  const c = registry.get(id);
  if (!c) return;
  Promise.resolve()
    .then(() => c.run())
    .catch((e) => console.error(id, e));
}

function keyName(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F\d+$/.test(code)) return code.toLowerCase();
  if (code.startsWith("Arrow")) return code.slice(5).toLowerCase();
  const named: Record<string, string> = {
    Enter: "enter", Escape: "escape", Backquote: "`", Comma: ",", Period: ".", Slash: "/",
    BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=", Backspace: "backspace",
    Delete: "delete", Tab: "tab", Space: "space", Semicolon: ";", Quote: "'", Backslash: "\\",
  };
  return named[code] ?? code.toLowerCase();
}

export function eventKey(e: KeyboardEvent): string {
  return [e.metaKey && "cmd", e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift", keyName(e.code)]
    .filter(Boolean)
    .join("+");
}

/// Effective keystroke → command map: preset defaults, minus removed keys, plus user bindings.
export function keymap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of registry.values()) for (const k of c.key?.split(" ") ?? []) map.set(k, c.id);
  if (setting("keymap.preset") === "vscode") {
    for (const [k, id] of Object.entries(VSCODE_PRESET)) {
      for (const [key, existing] of map) if (existing === id && !key.startsWith("cmd+shift+p")) map.delete(key);
      map.set(k, id);
    }
  }
  for (const k of setting<string[]>("keymap.removed") ?? []) map.delete(k);
  for (const [k, id] of Object.entries(setting<Record<string, string>>("keymap.bindings") ?? {})) map.set(k, id);
  return map;
}

export function keysFor(id: string): string[] {
  return [...keymap()].filter(([, cmd]) => cmd === id).map(([k]) => k);
}

const SYMBOLS: Record<string, string> = { cmd: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧", up: "↑", down: "↓", left: "←", right: "→", enter: "↩", escape: "⎋", backspace: "⌫" };
export const formatKey = (key: string) =>
  key
    .split("+")
    .map((p) => SYMBOLS[p] ?? p.toUpperCase())
    .join("");

export const keyLabel = (c: Command) => {
  const k = keysFor(c.id)[0];
  return k ? formatKey(k) : "";
};

setShortcutResolver((id) => {
  const k = keysFor(id)[0];
  return k ? formatKey(k) : "";
});

/// Keystrokes the key handler can dispatch: a ⌘/⌃/⌥ combination or an F-key. Plain letters, ⇧+letter and Enter
/// stay with the focused editor or field, so they cannot be shortcuts.
export function bindable(key: string): boolean {
  const parts = key.split("+");
  return parts.some((p) => p === "cmd" || p === "ctrl" || p === "alt") || /^f\d+$/.test(parts[parts.length - 1]) || key === "shift+f6" || key === "shift+escape";
}

let capturing: { fn: (key: string) => void; invalid?: (key: string) => void } | null = null;
/// Next keystroke for the Keymap page: "" for a bare Escape (cancel); a key that can never fire goes to `invalid`
/// and capture continues.
export function captureNextKey(fn: (key: string) => void, invalid?: (key: string) => void) {
  capturing = { fn, invalid };
}

/// Editor commands act only when focus is in an editor or nowhere in particular (the tab strip, the editor area).
/// With focus in the Project tree, a tool window or a field, the key goes there instead (⌘⌫ deletes the selected
/// file in the tree, not a line of the open file).
export function editorHasFocus(t: HTMLElement | null): boolean {
  if (!t || t === document.body || t === document.documentElement) return true;
  if (t.closest?.(".monaco-editor")) return true;
  if (t.matches?.("input, textarea, select, [contenteditable]")) return false;
  return !!t.closest?.("#editor-area, #tabs");
}

export function installKeyHandler() {
  window.addEventListener(
    "keydown",
    (e) => {
      if (capturing) {
        if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        const key = e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey ? "" : eventKey(e);
        if (key && !bindable(key)) return capturing.invalid?.(key);
        const { fn } = capturing;
        capturing = null;
        fn(key);
        return;
      }
      if (e.key === "Shift" && !e.repeat) {
        const now = Date.now();
        if (now - lastShift < 350) {
          lastShift = 0;
          runCommand("searchEverywhere");
        } else lastShift = now;
        return;
      }
      lastShift = 0;
      const key = eventKey(e);
      if (!bindable(key)) return;
      const inTerminal = (e.target as HTMLElement)?.closest?.(".xterm");
      if (inTerminal && e.ctrlKey && !e.metaKey) return;
      // A dialog is open: shortcuts would act on the editor behind it.
      if (document.querySelector("#overlay-root > [data-modal]")) return;
      const id = keymap().get(key);
      if (!id) return;
      if (registry.get(id)?.editor && !editorHasFocus(e.target as HTMLElement)) return;
      e.preventDefault();
      e.stopPropagation();
      runCommand(id);
    },
    true,
  );
}

const CATEGORY_ICONS: Record<string, string> = {
  File: "file", Window: "window", Preferences: "settings-gear", Help: "question", Navigate: "arrow-right", Find: "search", Code: "code",
  Refactor: "lightbulb", Edit: "edit", View: "layout", VCS: "source-control", Diff: "diff", Run: "play", Debug: "debug-alt", Test: "beaker",
  Rails: "ruby", "Ruby LSP": "ruby", Database: "database", GitHub: "github", Terminal: "terminal",
};

/// Icon for a command in Find Action / Search Everywhere, from its "Category: Action" title.
export const commandIcon = (c: Command) => CATEGORY_ICONS[c.title.split(":")[0]] ?? "zap";

export function showPalette() {
  quickPick({
    placeholder: "Type a command",
    items: allCommands().map((c) => ({ label: c.title, detail: keyLabel(c), icon: commandIcon(c), data: c.id })),
    onAccept: (item) => item && runCommand(item.data as string),
  });
}
