import { setting } from "./settings";
import { quickPick } from "./ui";

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

let capturing: ((key: string) => void) | null = null;
export function captureNextKey(fn: (key: string) => void) {
  capturing = fn;
}

export function installKeyHandler() {
  window.addEventListener(
    "keydown",
    (e) => {
      if (capturing) {
        if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        const fn = capturing;
        capturing = null;
        fn(e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey ? "" : eventKey(e));
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
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !/^f\d+$/.test(keyName(e.code)) && key !== "shift+f6" && key !== "shift+escape";
      if (plain) return;
      const inTerminal = (e.target as HTMLElement)?.closest?.(".xterm");
      if (inTerminal && e.ctrlKey && !e.metaKey) return;
      const id = keymap().get(key);
      if (!id) return;
      const t = e.target as HTMLElement;
      if (registry.get(id)?.editor && t?.matches?.("input, textarea, select") && !t.closest(".monaco-editor")) return;
      e.preventDefault();
      e.stopPropagation();
      runCommand(id);
    },
    true,
  );
}

export function showPalette() {
  quickPick({
    placeholder: "Type a command",
    items: allCommands().map((c) => ({ label: c.title, detail: keyLabel(c), data: c.id })),
    onAccept: (item) => item && runCommand(item.data as string),
  });
}
