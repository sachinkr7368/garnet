import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "./ipc";
import { toast } from "./ui";

export type SettingType = "boolean" | "number" | "string" | "enum" | "map" | "list";

export interface SettingDef {
  key: string;
  page: string;
  label: string;
  type: SettingType;
  default: unknown;
  description?: string;
  options?: string[];
  min?: number;
  max?: number;
}

const LANGS = ["ruby", "erb", "yaml", "javascript", "typescript", "css", "scss", "json", "markdown", "html"];

/// Every setting Garnet understands. The settings window is generated from this list.
export const SCHEMA: SettingDef[] = [
  { key: "appearance.theme", page: "Appearance", label: "Theme", type: "enum", options: ["dark", "light", "system"], default: "dark" },
  { key: "appearance.uiFontSize", page: "Appearance", label: "UI font size", type: "number", min: 10, max: 20, default: 13 },
  { key: "appearance.zoom", page: "Appearance", label: "Zoom (%)", type: "number", min: 70, max: 200, default: 100, description: "Scales the whole window." },
  { key: "appearance.sidebarPosition", page: "Appearance", label: "Tool window bar position", type: "enum", options: ["left", "right"], default: "left" },
  { key: "appearance.restoreBottomPanel", page: "Appearance", label: "Restore the bottom panel on project open", type: "boolean", default: true },

  { key: "keymap.preset", page: "Keymap", label: "Keymap preset", type: "enum", options: ["rubymine", "vscode"], default: "rubymine", description: "RubyMine-compatible (macOS) or VS Code-style shortcuts." },
  { key: "keymap.bindings", page: "Keymap", label: "Custom bindings", type: "map", default: {}, description: "keystroke → command id; edited from the Keymap page." },
  { key: "keymap.removed", page: "Keymap", label: "Removed bindings", type: "list", default: [] },

  { key: "editor.cursorStyle", page: "Editor/General", label: "Caret style", type: "enum", options: ["line", "block", "underline", "line-thin"], default: "line" },
  { key: "editor.cursorBlinking", page: "Editor/General", label: "Caret blinking", type: "enum", options: ["smooth", "blink", "phase", "expand", "solid"], default: "smooth" },
  { key: "editor.smoothScrolling", page: "Editor/General", label: "Smooth scrolling", type: "boolean", default: true },
  { key: "editor.scrollBeyondLastLine", page: "Editor/General", label: "Allow scrolling past the end of the file", type: "boolean", default: false },
  { key: "editor.stickyScroll", page: "Editor/General", label: "Sticky class/method headers while scrolling", type: "boolean", default: true },
  { key: "editor.wordWrap", page: "Editor/General", label: "Soft wrap", type: "enum", options: ["off", "on", "bounded"], default: "off" },
  { key: "editor.minimap", page: "Editor/General", label: "Show minimap", type: "boolean", default: false },
  { key: "editor.renderWhitespace", page: "Editor/General", label: "Show whitespace", type: "enum", options: ["none", "selection", "boundary", "trailing", "all"], default: "selection" },
  { key: "editor.trimTrailingWhitespace", page: "Editor/General", label: "Strip trailing whitespace on save", type: "boolean", default: true },
  { key: "editor.insertFinalNewline", page: "Editor/General", label: "Ensure a final newline on save", type: "boolean", default: true },
  { key: "editor.formatOnSave", page: "Editor/General", label: "Reformat Ruby files on save (RuboCop via ruby-lsp)", type: "boolean", default: false },
  { key: "editor.autoSave", page: "Editor/General", label: "Auto-save", type: "enum", options: ["off", "afterDelay", "onFocusChange"], default: "onFocusChange", description: "onFocusChange saves when you switch tabs or the window loses focus." },
  { key: "editor.autoSaveDelay", page: "Editor/General", label: "Auto-save delay (ms)", type: "number", min: 200, max: 60000, default: 1000 },

  { key: "editor.fontFamily", page: "Editor/Font", label: "Font family", type: "string", default: "'JetBrains Mono', 'SF Mono', Menlo, Monaco, monospace" },
  { key: "editor.fontSize", page: "Editor/Font", label: "Font size", type: "number", min: 8, max: 32, default: 13 },
  { key: "editor.lineHeight", page: "Editor/Font", label: "Line height (px, 0 = automatic)", type: "number", min: 0, max: 48, default: 20 },
  { key: "editor.fontLigatures", page: "Editor/Font", label: "Enable font ligatures", type: "boolean", default: false },

  { key: "editor.colorScheme", page: "Editor/Color Scheme", label: "Editor color scheme", type: "enum", options: ["auto", "garnet-dark", "garnet-light", "vs-dark", "vs", "hc-black", "hc-light"], default: "auto", description: "auto follows the Appearance theme." },

  ...LANGS.flatMap((lang): SettingDef[] => [
    { key: `codeStyle.${lang}.tabSize`, page: `Editor/Code Style/${lang}`, label: "Indent size", type: "number", min: 1, max: 8, default: ["javascript", "typescript", "json", "css", "scss", "html", "markdown"].includes(lang) ? 2 : 2 },
    { key: `codeStyle.${lang}.insertSpaces`, page: `Editor/Code Style/${lang}`, label: "Use spaces (not tabs)", type: "boolean", default: true },
  ]),
  { key: "codeStyle.respectEditorConfig", page: "Editor/Code Style", label: "Respect .editorconfig", type: "boolean", default: true },
  { key: "codeStyle.respectRubocop", page: "Editor/Code Style", label: "Use Layout/IndentationWidth from .rubocop.yml for Ruby", type: "boolean", default: true },

  { key: "inspections.rubocop", page: "Editor/Inspections", label: "RuboCop diagnostics (via ruby-lsp)", type: "boolean", default: true, description: "Takes effect when Ruby LSP restarts." },
  { key: "inspections.minSeverity", page: "Editor/Inspections", label: "Minimum severity to show", type: "enum", options: ["hint", "info", "warning", "error"], default: "hint" },

  { key: "files.associations", page: "File Types", label: "File associations", type: "map", default: { "Procfile*": "shell", "*.jbuilder": "ruby", ".env*": "ini" }, description: "glob → language id, e.g. \"*.thor\": \"ruby\"." },
  { key: "files.exclude", page: "File Types", label: "Hide in project tree (globs)", type: "list", default: [".DS_Store"] },

  { key: "git.path", page: "Version Control/Git", label: "Path to git", type: "string", default: "git" },
  { key: "git.autoFetchMinutes", page: "Version Control/Git", label: "Auto-fetch every N minutes (0 = off)", type: "number", min: 0, max: 240, default: 0 },
  { key: "git.checkProblemsBeforeCommit", page: "Version Control/Git", label: "Warn before committing files with errors", type: "boolean", default: true },

  { key: "ruby.versionManager", page: "Languages/Ruby", label: "Default Ruby version manager for new run configurations", type: "enum", options: ["auto", "rbenv", "asdf", "chruby", "rvm", "mise", "none"], default: "auto" },
  { key: "ruby.useBundler", page: "Languages/Ruby", label: "Use bundler for new run configurations", type: "boolean", default: true },
  { key: "ruby.lspCommand", page: "Languages/Ruby", label: "ruby-lsp command (empty = auto)", type: "string", default: "", description: "Auto uses bundle exec ruby-lsp when the bundle includes it, else the global ruby-lsp. Restart Ruby LSP to apply." },
  { key: "ruby.lspEnabled", page: "Languages/Ruby", label: "Start Ruby LSP when a project opens", type: "boolean", default: true },

  { key: "rails.environment", page: "Rails", label: "RAILS_ENV for Rails server/console/tasks", type: "string", default: "development" },
  { key: "rails.serverPort", page: "Rails", label: "Default Rails server port", type: "number", min: 1, max: 65535, default: 3000 },
  { key: "rails.serverBinding", page: "Rails", label: "Rails server binding", type: "string", default: "127.0.0.1" },

  { key: "testing.rspecRunner", page: "Testing", label: "RSpec runner", type: "enum", options: ["auto", "bundle exec rspec", "bin/rspec", "rspec"], default: "auto" },
  { key: "testing.rspecArgs", page: "Testing", label: "Extra RSpec arguments", type: "string", default: "" },
  { key: "testing.minitestArgs", page: "Testing", label: "Extra Minitest arguments", type: "string", default: "" },

  { key: "debug.rdbgPath", page: "Run and Debug", label: "rdbg executable (empty = from bundle or PATH)", type: "string", default: "" },
  { key: "debug.breakOnExceptions", page: "Run and Debug", label: "Break on exceptions by default", type: "enum", options: ["none", "RuntimeError", "any"], default: "none" },
  { key: "debug.connectTimeout", page: "Run and Debug", label: "Seconds to wait for the debuggee to start", type: "number", min: 5, max: 900, default: 180 },
  { key: "run.consoleScrollback", page: "Run and Debug", label: "Console buffer size (lines)", type: "number", min: 1000, max: 200000, default: 20000 },
  { key: "run.saveBeforeRun", page: "Run and Debug", label: "Save all files before running", type: "boolean", default: true },

  { key: "terminal.shell", page: "Terminal", label: "Shell path (empty = $SHELL)", type: "string", default: "" },
  { key: "terminal.fontFamily", page: "Terminal", label: "Font family (empty = editor font)", type: "string", default: "" },
  { key: "terminal.fontSize", page: "Terminal", label: "Font size", type: "number", min: 8, max: 32, default: 13 },
  { key: "terminal.cursorBlink", page: "Terminal", label: "Blinking cursor", type: "boolean", default: true },
  { key: "terminal.env", page: "Terminal", label: "Environment variables", type: "map", default: {}, description: "Added to every terminal and run console." },
];

const DEFAULTS: Record<string, unknown> = Object.fromEntries(SCHEMA.map((d) => [d.key, d.default]));

/// Keys that decide which programs run or with what environment. A cloned repo must not be able to set them,
/// so they are read from the global settings only.
const GLOBAL_ONLY = /^(ruby\.(lspCommand|lspEnabled|versionManager|useBundler)|git\.path|terminal\.(shell|env)|debug\.rdbgPath|testing\.|rails\.)/;
export const globalOnly = (key: string) => GLOBAL_ONLY.test(key);

let globalValues: Record<string, unknown> = {};
let projectValues: Record<string, unknown> = {};
let projectRoot: string | null = null;
const listeners: (() => void)[] = [];

export function setting<T = any>(key: string): T {
  if (key in projectValues) return projectValues[key] as T;
  if (key in globalValues) return globalValues[key] as T;
  return DEFAULTS[key] as T;
}

export const scopeValue = (scope: "global" | "project", key: string) => (scope === "global" ? globalValues : projectValues)[key];

export function onSettingsChange(fn: () => void) {
  listeners.push(fn);
}

function applyChrome() {
  const theme = setting<string>("appearance.theme");
  const dark = theme === "system" ? matchMedia("(prefers-color-scheme: dark)").matches : theme !== "light";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.style.setProperty("--ui-font-size", `${setting("appearance.uiFontSize")}px`);
  document.body.style.zoom = `${setting<number>("appearance.zoom") / 100}`;
  document.body.classList.toggle("sidebar-right", setting("appearance.sidebarPosition") === "right");
}

export const isDarkTheme = () => document.documentElement.dataset.theme !== "light";
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (setting("appearance.theme") === "system") notify();
});

function notify() {
  applyChrome();
  listeners.forEach((fn) => {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  });
}

async function readJson(read: () => Promise<string | null>, label: string): Promise<Record<string, unknown> | null> {
  const raw = await read().catch(() => null);
  if (raw === null || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : {};
  } catch (e) {
    toast(`${label} is not valid JSON (${e}); keeping the previous settings.`, "error");
    return null;
  }
}

export const projectSettingsPath = () => (projectRoot ? `${projectRoot}/.garnet/settings.json` : null);
export const settingsPath = () => api.configPath("settings.json");

export async function loadSettings(root: string | null = projectRoot): Promise<void> {
  projectRoot = root;
  const global = await readJson(() => api.configRead("settings.json"), "settings.json");
  if (global) globalValues = global;
  const project = root ? await readJson(() => api.readFile(`${root}/.garnet/settings.json`), ".garnet/settings.json") : {};
  if (project) {
    const ignored = Object.keys(project).filter(globalOnly);
    for (const k of ignored) delete project[k];
    if (ignored.length) toast(`.garnet/settings.json: ignored ${ignored.join(", ")} (global-only settings that control which programs run).`, "error");
    projectValues = project;
  }
  notify();
}

/// Writes one key to the chosen scope; `undefined` resets it to the inherited value.
export async function updateSetting(key: string, value: unknown, scope: "global" | "project" = "global") {
  if (globalOnly(key)) scope = "global";
  const target = scope === "project" ? projectValues : globalValues;
  if (value === undefined) delete target[key];
  else target[key] = value;
  const text = JSON.stringify(target, null, 2) + "\n";
  if (scope === "project") {
    if (!projectRoot) return toast("Open a project to use project settings.", "error");
    await api.createPath(`${projectRoot}/.garnet`, true).catch(() => {});
    await api.writeFile(`${projectRoot}/.garnet/settings.json`, text);
  } else await api.configWrite("settings.json", text);
  notify();
}

async function readConfig<T>(name: string, fallback: T): Promise<T> {
  try {
    const raw = await api.configRead(name);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export const recentProjects = () => readConfig<string[]>("recent.json", []);

export async function addRecentProject(root: string) {
  const list = (await recentProjects()).filter((p) => p !== root);
  list.unshift(root);
  await api.configWrite("recent.json", JSON.stringify(list.slice(0, 15), null, 2));
}

export interface Session {
  tabs: string[];
  active?: string;
  expanded?: string[];
  bottom?: string | null;
}

export async function loadSession(root: string): Promise<Session | undefined> {
  return (await readConfig<Record<string, Session>>("sessions.json", {}))[root];
}

export async function saveSession(root: string, session: Session) {
  const all = await readConfig<Record<string, Session>>("sessions.json", {});
  all[root] = session;
  await api.configWrite("sessions.json", JSON.stringify(all, null, 2));
}

/// Minimal glob → RegExp for file names and relative paths (*, **, ?, {a,b}).
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      re += `(?:${glob.slice(i + 1, end).split(",").map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`;
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/// Project trust, kept in the global config keyed by canonical path (never in the repo).
let trusted = false;
export const isTrusted = () => trusted;

export async function checkTrust(root: string): Promise<boolean> {
  const canonical = await api.canonicalPath(root).catch(() => root);
  trusted = (await readConfig<string[]>("trusted.json", [])).includes(canonical);
  return trusted;
}

export async function trustProject(root: string, silent = false) {
  const canonical = await api.canonicalPath(root);
  const list = (await readConfig<string[]>("trusted.json", [])).filter((p) => p !== canonical);
  list.push(canonical);
  await api.configWrite("trusted.json", JSON.stringify(list, null, 2));
  trusted = true;
  if (!silent) window.dispatchEvent(new Event("garnet:trusted"));
}

/// Asks once per untrusted root; returns whether the project is trusted afterwards.
export async function askTrust(): Promise<boolean> {
  if (trusted || !projectRoot) return trusted;
  const ok = await ask(
    `Trust and open "${projectRoot.split("/").pop()}"?\n\nA trusted project can run code: ruby-lsp loads its Gemfile, and run configurations, .env files and Rake tasks come from the repository. In safe mode Garnet only browses and edits files; ruby-lsp, run configurations and terminals stay off until you trust it.`,
    { title: "Trust Project", kind: "warning", okLabel: "Trust Project", cancelLabel: "Safe Mode" },
  );
  if (ok) await trustProject(projectRoot);
  return ok;
}
