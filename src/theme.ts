import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ITheme } from "@xterm/xterm";
import type { editor } from "monaco-editor";

export type Appearance = "system" | "light" | "dark";
export type Theme = "light" | "dark";

export const resolveTheme = (pref: string, systemDark: boolean): Theme =>
  pref === "light" ? "light" : pref === "dark" ? "dark" : systemDark ? "dark" : "light";

/// The opposite of what is showing now; "Toggle theme" pins it explicitly.
export const toggledAppearance = (current: Theme): Appearance => (current === "dark" ? "light" : "dark");

/// macOS appearance, from the web view's prefers-color-scheme and the Tauri window theme.
let systemDark = matchMedia("(prefers-color-scheme: dark)").matches;
export const systemPrefersDark = () => systemDark;

/// Calls `onChange` when the OS appearance changes while `following()` (the setting is "system").
export function watchSystemTheme(following: () => boolean, onChange: () => void) {
  const set = (dark: boolean) => {
    if (dark === systemDark) return;
    systemDark = dark;
    if (following()) onChange();
  };
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => following() && set(e.matches));
  try {
    const win = getCurrentWindow();
    win.theme().then((t) => t && following() && set(t === "dark")).catch(() => {});
    win.onThemeChanged(({ payload }) => following() && set(payload === "dark")).catch(() => {});
  } catch {
    // no Tauri window (tests, plain browser): prefers-color-scheme alone
  }
}

/// Native title bar and vibrancy follow the setting; null hands control back to macOS.
export function applyWindowTheme(pref: string) {
  try {
    getCurrentWindow()
      .setTheme(pref === "light" || pref === "dark" ? pref : null)
      .then(() => (pref === "system" ? getCurrentWindow().theme() : null))
      .then((t) => t && (systemDark = t === "dark"))
      .catch(() => {});
  } catch {
    // no Tauri window
  }
}

/// Palettes. Every text color is checked for WCAG contrast in src/test/theme.test.ts.

export const EDITOR_BG: Record<Theme, string> = { dark: "#18181d", light: "#ffffff" };

/// Syntax colors, used for Monarch tokens and ruby-lsp semantic tokens alike.
export const SYNTAX: Record<Theme, Record<string, string>> = {
  dark: {
    comment: "#868a93",
    keyword: "#e0876a",
    string: "#8fbf7a",
    number: "#6fb3d2",
    constant: "#c792ea",
    regexp: "#d6a84a",
    type: "#e5c07b",
    function: "#82aaff",
    parameter: "#d9a6a6",
    property: "#9cc4c4",
    variable: "#d6d6dc",
    namespace: "#e5c07b",
    tag: "#e0876a",
    attribute: "#d6a84a",
    erb: "#ef6b85",
  },
  light: {
    comment: "#6a6f78",
    keyword: "#a8323e",
    string: "#2c6e2f",
    number: "#1a5fa8",
    constant: "#7a3fb0",
    regexp: "#8a5a00",
    type: "#7d4e00",
    function: "#1f5fb8",
    parameter: "#8b3a62",
    property: "#22667a",
    variable: "#24242a",
    namespace: "#7d4e00",
    tag: "#a8323e",
    attribute: "#8a5a00",
    erb: "#b8263d",
  },
};

const RULES: [string, keyof (typeof SYNTAX)["dark"], string?][] = [
  ["comment", "comment", "italic"],
  ["keyword", "keyword"],
  ["string", "string"],
  ["string.escape", "regexp"],
  ["regexp", "regexp"],
  ["number", "number"],
  ["constant", "constant"],
  ["variable.predefined", "constant"],
  ["type", "type"],
  ["type.identifier", "type"],
  ["constructor.identifier", "type"],
  ["identifier", "variable"],
  ["tag", "tag"],
  ["attribute.name", "attribute"],
  ["attribute.value", "string"],
  ["metatag.erb", "erb", "bold"],
  ["metatag.haml", "erb", "bold"],
  ["metatag.slim", "erb", "bold"],
  // ruby-lsp semantic token types
  ["namespace", "namespace"],
  ["class", "type"],
  ["enum", "type"],
  ["interface", "type"],
  ["method", "function"],
  ["function", "function"],
  ["parameter", "parameter"],
  ["property", "property"],
  ["variable", "variable"],
  ["variable.defaultLibrary", "constant"],
  ["enumMember", "constant"],
];

const DIFF: Record<Theme, Record<string, string>> = {
  dark: {
    "diffEditor.insertedTextBackground": "#5aa46933",
    "diffEditor.removedTextBackground": "#c5606a40",
    "diffEditor.insertedLineBackground": "#5aa4691a",
    "diffEditor.removedLineBackground": "#c5606a1f",
    "diffEditorGutter.insertedLineBackground": "#5aa46933",
    "diffEditorGutter.removedLineBackground": "#c5606a33",
    "diffEditor.diagonalFill": "#2c2c34",
  },
  light: {
    "diffEditor.insertedTextBackground": "#3c8a4b33",
    "diffEditor.removedTextBackground": "#b8414c2e",
    "diffEditor.insertedLineBackground": "#3c8a4b14",
    "diffEditor.removedLineBackground": "#b8414c14",
    "diffEditorGutter.insertedLineBackground": "#3c8a4b2e",
    "diffEditorGutter.removedLineBackground": "#b8414c2e",
    "diffEditor.diagonalFill": "#dcdce2",
  },
};

export function monacoTheme(t: Theme): editor.IStandaloneThemeData {
  const c = SYNTAX[t];
  const strip = (hex: string) => hex.slice(1);
  return {
    base: t === "dark" ? "vs-dark" : "vs",
    inherit: true,
    rules: RULES.map(([token, color, fontStyle]) => ({ token, foreground: strip(c[color]), ...(fontStyle ? { fontStyle } : {}) })),
    colors: {
      "editor.background": EDITOR_BG[t],
      "editor.foreground": c.variable,
      "editorGutter.background": EDITOR_BG[t],
      ...(t === "dark"
        ? {
            "editor.lineHighlightBackground": "#22222a",
            "editorLineNumber.foreground": "#5d6069",
            "editorLineNumber.activeForeground": "#a0a3ab",
            "editor.selectionBackground": "#3a3d4a",
            "editorIndentGuide.background1": "#26262d",
          }
        : {
            "editor.lineHighlightBackground": "#f5f5f8",
            "editorLineNumber.foreground": "#8c8f97",
            "editorLineNumber.activeForeground": "#3a3a42",
            "editor.selectionBackground": "#cfd6ea",
            "editorIndentGuide.background1": "#ececf0",
          }),
      ...DIFF[t],
    },
  };
}

export const TERMINAL: Record<Theme, ITheme> = {
  dark: {
    background: "#141418",
    foreground: "#d4d4d8",
    cursor: "#e0476a",
    selectionBackground: "#3a3d4a",
    black: "#6b6d78",
    red: "#e0656f",
    green: "#8fbf7a",
    yellow: "#d6b35a",
    blue: "#6fa3e0",
    magenta: "#c792ea",
    cyan: "#6fc0c9",
    white: "#c8c8ce",
    brightBlack: "#8a8c95",
    brightRed: "#f08088",
    brightGreen: "#a6d491",
    brightYellow: "#e8c770",
    brightBlue: "#8cb8f0",
    brightMagenta: "#d8aef2",
    brightCyan: "#8ad4dc",
    brightWhite: "#f0f0f4",
  },
  light: {
    background: "#fbfbfc",
    foreground: "#26262b",
    cursor: "#b8263d",
    selectionBackground: "#cfd3e0",
    black: "#26262b",
    red: "#b3262f",
    green: "#2c6e2f",
    yellow: "#7a5a00",
    blue: "#1f5fb8",
    magenta: "#8a3fa0",
    cyan: "#0f6b78",
    white: "#5c5d66",
    brightBlack: "#5c5d66",
    brightRed: "#a01f28",
    brightGreen: "#245c27",
    brightYellow: "#6a4e00",
    brightBlue: "#1a4f9a",
    brightMagenta: "#73348a",
    brightCyan: "#0b5a66",
    brightWhite: "#3a3a42",
  },
};

/// WCAG 2 contrast ratio of two #rrggbb colors.
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
