import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import { conf as htmlConf, language as htmlLanguage } from "monaco-editor/languages/definitions/html/html";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { api, type TextFile } from "./ipc";
import { hamlConf, hamlLanguage } from "./languages/haml";
import { erbLanguage, rubyLanguage } from "./languages/ruby";
import { slimConf, slimLanguage } from "./languages/slim";
import { snippetsFor } from "./languages/snippets";
import { styleFor } from "./codestyle";
import { monacoTheme } from "./theme";
import { globToRegExp, isDarkTheme, loadSettings, onSettingsChange, projectSettingsPath, setting, settingsPath, updateSetting } from "./settings";
import { basename, rel } from "./state";
import { contextMenu, fileIcon, h, icon, iconButton, overflowStrip, quickPick, statusSlot, tip, toast } from "./ui";

export { monaco };

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

function registerErb() {
  monaco.languages.setMonarchTokensProvider("ruby", rubyLanguage);
  monaco.languages.register({ id: "erb", extensions: [".erb"], aliases: ["ERB", "erb"] });
  monaco.languages.setMonarchTokensProvider("erb", erbLanguage(htmlLanguage));
  monaco.languages.setLanguageConfiguration("erb", htmlConf);
}

function registerTemplates() {
  monaco.languages.register({ id: "haml", extensions: [".haml"], aliases: ["HAML", "haml"] });
  monaco.languages.setMonarchTokensProvider("haml", hamlLanguage);
  monaco.languages.setLanguageConfiguration("haml", hamlConf);
  monaco.languages.register({ id: "slim", extensions: [".slim"], aliases: ["Slim", "slim"] });
  monaco.languages.setMonarchTokensProvider("slim", slimLanguage);
  monaco.languages.setLanguageConfiguration("slim", slimConf);
}

function registerSnippets() {
  for (const lang of ["ruby", "erb"]) {
    monaco.languages.registerCompletionItemProvider(lang, {
      provideCompletionItems(model, position) {
        if (!setting("editor.liveTemplates")) return { suggestions: [] };
        const word = model.getWordUntilPosition(position);
        const bang = model.getValueInRange(new monaco.Range(position.lineNumber, word.endColumn, position.lineNumber, word.endColumn + 1)) === "!" ? 1 : 0;
        const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn + bang);
        return {
          suggestions: snippetsFor(lang, model.uri.fsPath).map((s) => ({
            label: { label: s.prefix, description: s.description },
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: s.body,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: { value: "```" + lang + "\n" + s.body.replace(/\$\{\d+:([^}]*)\}|\$\d/g, "$1") + "\n```" },
            range,
            sortText: `~${s.prefix}`,
          })),
        };
      },
    });
  }
}

function defineThemes() {
  monaco.editor.defineTheme("garnet-dark", monacoTheme("dark"));
  monaco.editor.defineTheme("garnet-light", monacoTheme("light"));
}

registerErb();
registerTemplates();
registerSnippets();
defineThemes();

const RUBY_FILES = new Set([
  "Gemfile", "Rakefile", "Guardfile", "Capfile", "Brewfile", "Podfile", "Fastfile", "Vagrantfile", "Dangerfile", "Steepfile",
]);

export function languageFor(path: string): string {
  const name = basename(path);
  for (const [glob, lang] of Object.entries(setting<Record<string, string>>("files.associations") ?? {})) {
    if (globToRegExp(glob).test(glob.includes("/") ? rel(path) : name)) return lang;
  }
  if (RUBY_FILES.has(name) || /\.(rb|rake|gemspec|ru|jbuilder|builder|thor|rbs|arb)$/.test(name)) return "ruby";
  if (name.endsWith(".erb")) return "erb";
  if (/\.ya?ml$/.test(name)) return "yaml";
  if (/\.(m|c)?js$|\.jsx$/.test(name)) return "javascript";
  if (/\.tsx?$/.test(name)) return "typescript";
  if (name === "Dockerfile" || name.startsWith("Dockerfile.")) return "dockerfile";
  if (name === ".env" || name.startsWith(".env.")) return "ini";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  const hit = monaco.languages.getLanguages().find((l) => l.extensions?.includes(ext) || l.filenames?.includes(name));
  return hit?.id ?? "plaintext";
}

export const uriFor = (path: string) => monaco.Uri.file(path);

export interface Target {
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface Tab {
  path: string;
  kind: "file" | "diff" | "view";
  title: string;
  model: monaco.editor.ITextModel;
  original?: monaco.editor.ITextModel;
  savedVersion: number;
  viewState: monaco.editor.ICodeEditorViewState | monaco.editor.IDiffEditorViewState | null;
  el: HTMLElement;
  /// Read-only diff between two revisions; `key` identifies it (path + revisions).
  readonly?: boolean;
  key?: string;
  label?: string;
  pinned?: boolean;
  /// Per-tab soft wrap (View | Active Editor | Soft-Wrap); undefined follows the setting.
  softWrap?: boolean;
  usedAt?: number;
  /// Non-text editor tab (database console, table data): its element is shown in the editor area.
  view?: { el: HTMLElement; icon: string; tooltip?: string; onClose?: () => void; onActivate?: () => void };
}

class Emitter<T> {
  private fns: ((v: T) => void)[] = [];
  on(fn: (v: T) => void) {
    this.fns.push(fn);
  }
  fire(v: T) {
    for (const fn of this.fns) {
      try {
        fn(v);
      } catch (e) {
        console.error(e);
      }
    }
  }
}

export const events = {
  modelOpened: new Emitter<monaco.editor.ITextModel>(),
  modelClosed: new Emitter<monaco.editor.ITextModel>(),
  saved: new Emitter<Tab>(),
  activated: new Emitter<Tab | null>(),
  tabsChanged: new Emitter<void>(),
};

const tabsEl = document.getElementById("tabs")!;
const tabOf = (el: HTMLElement) => tabs.find((x) => x.el === el);
const tabOverflow = overflowStrip(tabsEl, {
  title: "Show Hidden Tabs",
  label: (el) => el.querySelector(".tab-title")?.textContent ?? "",
  detail: (el) => el.querySelector(".tab-desc")?.textContent ?? undefined,
  pick: (el) => {
    const t = tabOf(el);
    if (t) activate(t);
  },
  close: (el) => {
    const t = tabOf(el);
    if (t) closeTab(t);
  },
});
const editorEl = document.getElementById("editor")!;
const diffEl = document.getElementById("diff-editor")!;
const welcomeEl = document.getElementById("welcome")!;
diffEl.hidden = true;
editorEl.hidden = true;

const tabs: Tab[] = [];
let active: Tab | null = null;

function editorTheme() {
  const scheme = setting<string>("editor.colorScheme");
  return scheme === "auto" ? (isDarkTheme() ? "garnet-dark" : "garnet-light") : scheme;
}

function editorOptions(): monaco.editor.IEditorOptions & monaco.editor.IGlobalEditorOptions {
  return {
    fontFamily: setting("editor.fontFamily"),
    fontSize: setting("editor.fontSize"),
    lineHeight: setting("editor.lineHeight"),
    fontLigatures: setting("editor.fontLigatures"),
    wordWrap: active?.softWrap === undefined ? setting("editor.wordWrap") : active.softWrap ? "on" : "off",
    minimap: { enabled: setting("editor.minimap") },
    cursorStyle: setting("editor.cursorStyle"),
    cursorBlinking: setting("editor.cursorBlinking"),
    smoothScrolling: setting("editor.smoothScrolling"),
    scrollBeyondLastLine: setting("editor.scrollBeyondLastLine"),
    stickyScroll: { enabled: setting("editor.stickyScroll") },
    renderWhitespace: setting("editor.renderWhitespace"),
    "semanticHighlighting.enabled": !!setting("editor.semanticHighlighting"),
    inlayHints: { enabled: setting("editor.inlayHints") ? "on" : "off" },
    theme: editorTheme(),
  };
}

function applyCodeStyle(tab: Tab) {
  const style = styleFor(tab.path, tab.model.getLanguageId());
  tab.model.updateOptions({ tabSize: style.tabSize, indentSize: style.tabSize, insertSpaces: style.insertSpaces });
}

export const editor = monaco.editor.create(editorEl, {
  ...editorOptions(),
  automaticLayout: true,
  glyphMargin: true,
  lineNumbersMinChars: 3,
  bracketPairColorization: { enabled: true },
  fixedOverflowWidgets: true,
  padding: { top: 6 },
  cursorSmoothCaretAnimation: "on",
  model: null,
});

/// Monaco's own defaults on keys Garnet's RubyMine keymap owns. Garnet's capture-phase handler wins anyway;
/// unbinding them keeps Monaco from acting if focus is somewhere the handler lets through.
export const MONACO_CONFLICTS: Record<string, string> = {
  "alt+f12": "editor.action.peekDefinition",
  f1: "editor.action.quickCommand",
  f2: "editor.action.rename",
  f7: "editor.action.accessibleDiffViewer.next",
  "shift+f7": "editor.action.accessibleDiffViewer.prev",
  f8: "editor.action.marker.nextInFiles",
  "shift+f8": "editor.action.marker.prevInFiles",
  f12: "editor.action.revealDefinition",
  "cmd+f12": "editor.action.goToImplementation",
  "cmd+shift+o": "editor.action.quickOutline",
  "cmd+d": "editor.action.addSelectionToNextFindMatch",
  "cmd+l": "expandLineSelection",
  "cmd+e": "actions.findWithSelection",
  "cmd+shift+k": "editor.action.deleteLines",
  "ctrl+g": "editor.action.gotoLine",
  "alt+up": "editor.action.moveLinesUpAction",
  "alt+down": "editor.action.moveLinesDownAction",
  "alt+shift+up": "editor.action.copyLinesUpAction",
  "alt+shift+down": "editor.action.copyLinesDownAction",
};

/// Garnet keystroke ("cmd+shift+o") → Monaco keybinding number, or null for keys Monaco can't express.
export function monacoKeybinding(key: string): number | null {
  const parts = key.split("+");
  const name = parts.pop()!;
  const mods: Record<string, number> = { cmd: monaco.KeyMod.CtrlCmd, ctrl: monaco.KeyMod.WinCtrl, alt: monaco.KeyMod.Alt, shift: monaco.KeyMod.Shift };
  const named: Record<string, string> = { up: "UpArrow", down: "DownArrow", left: "LeftArrow", right: "RightArrow", enter: "Enter", escape: "Escape", backspace: "Backspace", tab: "Tab", space: "Space", "[": "BracketLeft", "]": "BracketRight", "/": "Slash", ",": "Comma", ".": "Period" };
  const codeName = /^f\d+$/.test(name) ? name.toUpperCase() : /^[a-z]$/.test(name) ? `Key${name.toUpperCase()}` : /^\d$/.test(name) ? `Digit${name}` : named[name];
  const code = codeName ? (monaco.KeyCode as unknown as Record<string, number>)[codeName] : undefined;
  if (code === undefined || parts.some((m) => !(m in mods))) return null;
  return parts.reduce((acc, m) => acc | mods[m], code);
}

monaco.editor.addKeybindingRules(
  Object.entries(MONACO_CONFLICTS).flatMap(([key, command]) => {
    const keybinding = monacoKeybinding(key);
    return keybinding === null ? [] : [{ keybinding, command: `-${command}` }];
  }),
);

let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
const diffOptions = () => ({
  renderSideBySide: setting<boolean>("diff.sideBySide"),
  hideUnchangedRegions: { enabled: setting<boolean>("diff.collapseUnchanged") },
});
/// Editor and diff settings for other diff views (the pull request Files tab), so they look like diff tabs.
export const diffEditorOptions = () => ({ ...editorOptions(), ...diffOptions() });
function getDiffEditor() {
  diffEditor ??= monaco.editor.createDiffEditor(diffEl, {
    ...editorOptions(),
    ...diffOptions(),
    automaticLayout: true,
    originalEditable: false,
  });
  return diffEditor;
}

const diffLabel = h("span", { class: "diff-label" });
const diffBar = h(
  "div",
  { class: "diff-bar view-toolbar" },
  diffLabel,
  h("span", { class: "spacer" }),
  iconButton("arrow-up", "Previous Difference", () => goToDiff("previous"), "diffPrev"),
  iconButton("arrow-down", "Next Difference", () => goToDiff("next"), "stepInto"),
  iconButton("split-horizontal", "Side-by-side / Unified", () => updateSetting("diff.sideBySide", !setting("diff.sideBySide"))),
  iconButton("fold", "Collapse Unchanged Regions", () => updateSetting("diff.collapseUnchanged", !setting("diff.collapseUnchanged"))),
);
diffBar.hidden = true;
diffEl.before(diffBar);

export const diffActive = () => active?.kind === "diff";

const editorArea = document.getElementById("editor-area")!;
let placeholder: monaco.editor.ITextModel | null = null;

/// Opens (or focuses) an editor tab that hosts `el` instead of a text model, keyed by `key`.
export function openViewTab(key: string, title: string, view: NonNullable<Tab["view"]>): Tab {
  let tab = tabs.find((t) => t.kind === "view" && t.key === key);
  if (!tab) {
    // ponytail: one shared empty model keeps Tab.model non-null; view tabs are never dirty or saved.
    placeholder ??= monaco.editor.createModel("", "plaintext", monaco.Uri.from({ scheme: "garnet-view", path: "/placeholder" }));
    view.el.classList.add("editor-view");
    view.el.hidden = true;
    editorArea.append(view.el);
    tab = { path: `garnet-view:${key}`, kind: "view", title, model: placeholder, savedVersion: placeholder.getAlternativeVersionId(), viewState: null, el: h("div"), key, view };
    tabs.push(tab);
    events.tabsChanged.fire();
  }
  activate(tab);
  return tab;
}

export function retitleViewTab(key: string, title: string, tooltip?: string) {
  const tab = tabs.find((t) => t.kind === "view" && t.key === key);
  if (!tab || (tab.title === title && (tooltip === undefined || tab.view!.tooltip === tooltip))) return;
  tab.title = title;
  if (tooltip !== undefined) tab.view!.tooltip = tooltip;
  renderTabs();
}

export const findViewTab = (key: string) => tabs.find((t) => t.kind === "view" && t.key === key);
export function goToDiff(target: "next" | "previous") {
  if (!diffEditor || !diffActive()) return;
  diffEditor.goToDiff(target);
  diffEditor.getModifiedEditor().focus();
}

onSettingsChange(() => {
  const opts = editorOptions();
  editor.updateOptions(opts);
  diffEditor?.updateOptions({ ...opts, ...diffOptions() });
  monaco.editor.setTheme(opts.theme!);
  for (const t of tabs) applyCodeStyle(t);
});

monaco.editor.registerEditorOpener({
  openCodeEditor(_source, resource, selection) {
    if (resource.scheme !== "file") return false;
    let target: Target | undefined;
    if (selection && "startLineNumber" in selection)
      target = { line: selection.startLineNumber, column: selection.startColumn, endLine: selection.endLineNumber, endColumn: selection.endColumn };
    else if (selection) target = { line: selection.lineNumber, column: selection.column };
    openFile(resource.fsPath, target);
    return true;
  },
});

const cursorSlot = statusSlot("cursor", "right", undefined, "Line:column", "goToLine");
const langSlot = statusSlot("language", "right", undefined, "File type");
editor.onDidChangeCursorPosition((e) => {
  cursorSlot.textContent = `${e.position.lineNumber}:${e.position.column}`;
});

function modelUsers(model: monaco.editor.ITextModel) {
  return tabs.filter((t) => t.model === model).length;
}

export function isDirty(tab: Tab) {
  return tab.model.getAlternativeVersionId() !== tab.savedVersion;
}

/// How a file buffer is saved back: the encoding it was read in (or converted to) and its BOM. `large`: only the
/// first 10 MB were loaded; `lossy`: some bytes are not valid in `encoding`. Either makes the buffer read-only, since
/// saving would cut the file or write U+FFFD over those bytes. `forced`: picked with Reopen with Encoding.
export interface FileMeta {
  encoding: string;
  bom: boolean;
  large: boolean;
  lossy?: boolean;
  forced?: boolean;
}
const fileMeta = new WeakMap<monaco.editor.ITextModel, FileMeta>();
export const metaOf = (model: monaco.editor.ITextModel): FileMeta => fileMeta.get(model) ?? { encoding: "UTF-8", bom: false, large: false };
/// Why a buffer can't be saved, or null.
export const lockedReason = (m: FileMeta) => (m.large ? "it is larger than 10 MB" : m.lossy ? `it is not valid ${m.encoding}; reopen it with the right encoding` : null);
const metaFrom = (file: TextFile, forced?: boolean): FileMeta => ({ encoding: file.encoding, bom: file.bom, large: file.truncated, lossy: file.lossy, forced });
/// The encoding of an open file's buffer, for reading other versions of it (git) the same way.
export const encodingOf = (path: string) => {
  const model = monaco.editor.getModel(uriFor(path));
  return model ? fileMeta.get(model)?.encoding : undefined;
};

export async function ensureModel(path: string): Promise<monaco.editor.ITextModel | null> {
  const uri = uriFor(path);
  const existing = monaco.editor.getModel(uri);
  if (existing) return existing;
  let file;
  try {
    file = await api.openText(path);
  } catch (e) {
    toast(String(e) === "binary file" ? `${rel(path)} is a binary file and can't be opened as text.` : `Cannot open ${rel(path)}: ${e}`, "error");
    return null;
  }
  const again = monaco.editor.getModel(uri);
  if (again) return again;
  const model = monaco.editor.createModel(file.text, file.truncated ? "plaintext" : languageFor(path), uri);
  fileMeta.set(model, metaFrom(file));
  if (file.lossy) toast(`${basename(path)} is not valid ${file.encoding}: opened read-only.`, "error");
  if (file.truncated) toast(`${basename(path)} is ${Math.round(file.size / 1048576)} MB: showing the first 10 MB, read-only, as plain text.`);
  return model;
}

function addTab(tab: Tab) {
  const firstUser = modelUsers(tab.model) === 0;
  tabs.push(tab);
  enforceTabLimit(tab);
  applyCodeStyle(tab);
  if (firstUser) {
    const model = tab.model;
    let wasDirty = false;
    model.onDidChangeContent(() => {
      const dirty = tabs.some((t) => t.model === model && isDirty(t));
      if (dirty !== wasDirty) renderTabs();
      wasDirty = dirty;
      if (dirty && setting("editor.autoSave") === "afterDelay") scheduleAutoSave();
    });
    events.modelOpened.fire(tab.model);
  }
  renderTabs();
  events.tabsChanged.fire();
}

/// RubyMine's tab limit: past it, the least recently used clean, unpinned tab closes.
function enforceTabLimit(keep: Tab) {
  const limit = setting<number>("editor.tabLimit") ?? 0;
  const open = tabs.filter((t) => t.kind !== "view");
  if (limit <= 0 || open.length <= limit) return;
  const victim = open.filter((t) => t !== keep && t !== active && !t.pinned && !isDirty(t)).sort((a, b) => (a.usedAt ?? 0) - (b.usedAt ?? 0))[0];
  if (!victim) return;
  if (victim.kind === "file") closedTabs.push(victim.path);
  void closeTab(victim, true);
}

export async function openFile(path: string, target?: Target) {
  let tab = tabs.find((t) => t.kind === "file" && t.path === path);
  if (!tab) {
    const model = await ensureModel(path);
    if (!model) return;
    tab = tabs.find((t) => t.kind === "file" && t.path === path);
    if (!tab) {
      const sibling = tabs.find((t) => t.model === model);
      tab = {
        path,
        kind: "file",
        title: basename(path),
        model,
        savedVersion: sibling?.savedVersion ?? model.getAlternativeVersionId(),
        viewState: null,
        el: h("div"),
      };
      addTab(tab);
    }
  }
  activate(tab);
  if (target) reveal(target);
}

export async function openDiffTab(path: string, originalText: string, title: string) {
  const model = await ensureModel(path);
  if (!model) return;
  let tab = tabs.find((t) => t.kind === "diff" && !t.readonly && t.path === path);
  const original = monaco.editor.createModel(originalText, model.getLanguageId(), monaco.Uri.from({ scheme: "garnet-original", path, query: String(Date.now()) }));
  if (tab) {
    tab.original?.dispose();
    tab.original = original;
    tab.title = title;
  } else {
    const sibling = tabs.find((t) => t.model === model);
    tab = {
      path,
      kind: "diff",
      title,
      model,
      original,
      savedVersion: sibling?.savedVersion ?? model.getAlternativeVersionId(),
      viewState: null,
      el: h("div"),
    };
    addTab(tab);
  }
  active = null;
  activate(tab);
}

/// Read-only diff of two texts (commit, stash, branch comparison). `path` sets the language and tab tooltip.
export function openTextDiff(key: string, path: string, left: string, right: string, title: string, label = "") {
  let tab = tabs.find((t) => t.key === key);
  if (!tab) {
    const lang = languageFor(path);
    const uri = (side: string) => monaco.Uri.from({ scheme: "garnet-rev", path, query: `${side}-${key}-${Date.now()}` });
    tab = {
      path,
      kind: "diff",
      title,
      model: monaco.editor.createModel(right, lang, uri("new")),
      original: monaco.editor.createModel(left, lang, uri("old")),
      savedVersion: 0,
      viewState: null,
      el: h("div"),
      readonly: true,
      key,
      label,
    };
    tab.savedVersion = tab.model.getAlternativeVersionId();
    addTab(tab);
  }
  activate(tab);
}

/// Navigation history (⌘[ / ⌘]), recent files (⌘E) and recent locations (⌘⇧E)

interface Place {
  path: string;
  line: number;
  column: number;
}
const back: Place[] = [];
const forward: Place[] = [];
const recentFiles: string[] = [];
let navigating = false;

function here(): Place | null {
  const pos = editor.getPosition();
  return active?.kind === "file" && pos ? { path: active.path, line: pos.lineNumber, column: pos.column } : null;
}

function remember() {
  const p = here();
  if (!p || navigating) return;
  const last = back[back.length - 1];
  if (last && last.path === p.path && Math.abs(last.line - p.line) < 10) back[back.length - 1] = p;
  else back.push(p);
  if (back.length > 200) back.shift();
  forward.length = 0;
}

async function goTo(p: Place) {
  navigating = true;
  try {
    await openFile(p.path, { line: p.line, column: p.column });
  } finally {
    navigating = false;
  }
}

export async function navigateBack() {
  const cur = here();
  const p = back.pop();
  if (!p) return;
  if (cur) forward.push(cur);
  if (cur && p.path === cur.path && p.line === cur.line) return navigateBack();
  await goTo(p);
}

export async function navigateForward() {
  const p = forward.pop();
  if (!p) return;
  const cur = here();
  if (cur) back.push(cur);
  await goTo(p);
}

export const recentFileList = () => [...recentFiles];
export const restoreRecentFiles = (paths: string[]) => recentFiles.splice(0, recentFiles.length, ...paths.slice(0, 50));
export const forgetRecentFile = (path: string) => recentFiles.includes(path) && recentFiles.splice(recentFiles.indexOf(path), 1);
export const recentLocations = () => [...back].reverse();

/// Last Edit Location (⌘⇧⌫) and Next Edit Location walk the places where file buffers were edited.
const edits: Place[] = [];
let editAt = 0;
editor.onDidChangeModelContent((e) => {
  const model = editor.getModel();
  if (navigating || !model || active?.kind !== "file" || active.model !== model || !e.changes.length) return;
  const c = e.changes[0];
  const p = { path: active.path, line: c.range.startLineNumber, column: c.range.startColumn };
  const last = edits[edits.length - 1];
  if (last && last.path === p.path && Math.abs(last.line - p.line) <= 1) edits[edits.length - 1] = p;
  else edits.push(p);
  if (edits.length > 100) edits.shift();
  editAt = edits.length;
});

export async function goToEdit(delta: -1 | 1) {
  let i = editAt + delta;
  const cur = here();
  if (delta < 0 && editAt === edits.length && cur && edits[i]?.path === cur.path && edits[i]?.line === cur.line) i--;
  const p = edits[i];
  if (!p) return;
  editAt = i;
  await goTo(p);
}

editor.onDidChangeCursorPosition((e) => {
  if (e.reason === monaco.editor.CursorChangeReason.Explicit && e.source === "mouse") remember();
});

export function reveal(target: Target) {
  remember();
  const range = new monaco.Range(
    target.line,
    target.column ?? 1,
    target.endLine ?? target.line,
    target.endColumn ?? target.column ?? 1,
  );
  editor.setSelection(range);
  editor.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Smooth);
  editor.focus();
}

function saveViewState(tab: Tab) {
  if (tab.kind === "view") return;
  tab.viewState = tab.kind === "file" ? editor.saveViewState() : (diffEditor?.saveViewState() ?? null);
}

export function activate(tab: Tab | null) {
  if (tab && tab !== active) remember();
  if (tab?.kind === "file") {
    const i = recentFiles.indexOf(tab.path);
    if (i >= 0) recentFiles.splice(i, 1);
    recentFiles.unshift(tab.path);
    if (recentFiles.length > 50) recentFiles.pop();
  }
  if (active && active !== tab && tabs.includes(active)) {
    saveViewState(active);
    if (setting("editor.autoSave") === "onFocusChange" && isDirty(active)) save(active);
  }
  active = tab;
  welcomeEl.hidden = !!tab;
  editorEl.hidden = tab?.kind !== "file";
  diffEl.hidden = diffBar.hidden = tab?.kind !== "diff";
  for (const t of tabs) if (t.view) t.view.el.hidden = t !== tab;
  if (tab?.kind === "view") {
    // Detach the hidden main editor so editor commands and Save All can't touch the last file behind the view.
    editor.setModel(null);
    langSlot.textContent = "";
    cursorSlot.textContent = "";
    tab.view!.onActivate?.();
  } else if (tab?.kind === "file") {
    editor.setModel(tab.model);
    editor.updateOptions({ readOnly: !!lockedReason(metaOf(tab.model)), wordWrap: editorOptions().wordWrap });
    if (tab.viewState) editor.restoreViewState(tab.viewState as monaco.editor.ICodeEditorViewState);
    editor.focus();
    langSlot.textContent = tab.model.getLanguageId();
    const pos = editor.getPosition();
    cursorSlot.textContent = pos ? `${pos.lineNumber}:${pos.column}` : "";
  } else if (tab?.kind === "diff") {
    const d = getDiffEditor();
    d.updateOptions({ readOnly: !!tab.readonly });
    d.setModel({ original: tab.original!, modified: tab.model });
    diffLabel.textContent = tab.label || `${rel(tab.path)}: HEAD ↔ working copy`;
    if (tab.viewState) d.restoreViewState(tab.viewState as monaco.editor.IDiffEditorViewState);
    d.getModifiedEditor().focus();
  } else {
    editor.setModel(null);
    langSlot.textContent = "";
    cursorSlot.textContent = "";
  }
  if (tab) tab.usedAt = Date.now();
  renderFileSlots();
  renderTabs();
  events.activated.fire(tab);
}

export async function closeTab(tab: Tab, force = false): Promise<boolean> {
  if (!force && isDirty(tab) && modelUsers(tab.model) === 1) {
    const answer = await message(`Save changes to ${tab.title}?`, {
      kind: "warning",
      buttons: { yes: "Save", no: "Don't Save", cancel: "Cancel" },
    });
    if (answer === "Save" || answer === "Yes") {
      if (!(await save(tab))) return false;
    } else if (answer !== "Don't Save" && answer !== "No") return false;
  }
  const i = tabs.indexOf(tab);
  if (i < 0) return true;
  tabs.splice(i, 1);
  if (tab.kind === "file" && !force) {
    closedTabs.push(tab.path);
    if (closedTabs.length > 30) closedTabs.shift();
  }
  tab.original?.dispose();
  if (tab.view) {
    tab.view.el.remove();
    tab.view.onClose?.();
  } else if (modelUsers(tab.model) === 0) {
    events.modelClosed.fire(tab.model);
    tab.model.dispose();
  }
  if (active === tab) {
    active = null;
    activate(tabs[Math.min(i, tabs.length - 1)] ?? null);
  } else renderTabs();
  events.tabsChanged.fire();
  return true;
}

export async function closeAll(): Promise<boolean> {
  for (const t of [...tabs]) if (!(await closeTab(t))) return false;
  return true;
}

const closedTabs: string[] = [];
export async function reopenClosedTab() {
  const path = closedTabs.pop();
  if (path) await openFile(path);
}

/// Tab context menu groups: which tabs each close action closes (pinned tabs stay, except for Close All).
export function tabsToClose(list: readonly Tab[], target: Tab, action: "others" | "all" | "unmodified" | "right" | "unpinned", dirty: (t: Tab) => boolean): Tab[] {
  const at = list.indexOf(target);
  return list.filter((t, i) => {
    if (action === "all") return true;
    if (t.pinned) return false;
    if (action === "others") return t !== target;
    if (action === "right") return i > at;
    if (action === "unmodified") return !dirty(t);
    return true;
  });
}

export async function closeTabs(list: Tab[]) {
  for (const t of list) if (!(await closeTab(t))) return;
}

export function togglePin(tab: Tab) {
  tab.pinned = !tab.pinned;
  renderTabs();
}

function tabMenu(e: MouseEvent, t: Tab) {
  const close = (action: Parameters<typeof tabsToClose>[2]) => () => void closeTabs(tabsToClose(tabs, t, action, isDirty));
  const file = t.kind !== "view";
  contextMenu(e, [
    { label: "Close", command: "closeTab", run: () => void closeTab(t) },
    { label: "Close Other Tabs", run: close("others") },
    { label: "Close All Tabs", run: close("all") },
    { label: "Close Unmodified Tabs", run: close("unmodified") },
    { label: "Close Tabs to the Right", run: close("right"), disabled: tabs.indexOf(t) === tabs.length - 1 },
    { label: "Close All but Pinned", run: close("unpinned") },
    { label: "Reopen Closed Tab", command: "reopenClosedTab", run: () => void reopenClosedTab(), disabled: !closedTabs.length },
    null,
    { label: t.pinned ? "Unpin Tab" : "Pin Tab", icon: "pin", command: "pinTab", run: () => togglePin(t) },
    null,
    { label: "Copy Path", command: "copyPath", run: () => void navigator.clipboard.writeText(t.path), disabled: !file },
    { label: "Copy Relative Path", run: () => void navigator.clipboard.writeText(rel(t.path)), disabled: !file },
    { label: "Reveal in Finder", run: () => void api.revealInFinder(t.path), disabled: t.kind !== "file" },
  ]);
}

/// View | Active Editor | Soft-Wrap: this tab only.
export function toggleSoftWrap() {
  if (active?.kind !== "file") return;
  active.softWrap = editor.getOption(monaco.editor.EditorOption.wordWrap) === "off";
  editor.updateOptions({ wordWrap: active.softWrap ? "on" : "off" });
}

/// Encoding and line separator status bar widgets (RubyMine's status bar)

export const ENCODINGS = ["UTF-8", "UTF-16LE", "UTF-16BE", "windows-1252", "ISO-8859-2", "ISO-8859-15", "windows-1251", "KOI8-R", "Shift_JIS", "EUC-JP", "GBK", "Big5", "EUC-KR"];
const eolSlot = statusSlot("eol", "right", () => lineSeparatorMenu(), "Line separator");
const encodingSlot = statusSlot("encoding", "right", () => encodingMenu(), "File encoding");

function renderFileSlots() {
  const model = active?.kind === "file" ? active.model : null;
  const meta = model && metaOf(model);
  eolSlot.textContent = model ? (model.getEOL() === "\r\n" ? "CRLF" : "LF") : "";
  encodingSlot.textContent = meta ? `${meta.encoding}${meta.bom ? " BOM" : ""}${lockedReason(meta) ? " (read-only)" : ""}` : "";
  encodingSlot.title = meta && lockedReason(meta) ? `Read-only: ${lockedReason(meta)}` : "File encoding";
}

export function setLineSeparator(eol: "LF" | "CRLF") {
  if (active?.kind !== "file" || lockedReason(metaOf(active.model))) return;
  active.model.pushEOL(eol === "LF" ? monaco.editor.EndOfLineSequence.LF : monaco.editor.EndOfLineSequence.CRLF);
  renderFileSlots();
}

export function lineSeparatorMenu() {
  if (active?.kind !== "file") return;
  quickPick({
    placeholder: "Line separator",
    items: [
      { label: "LF", description: "Unix and macOS (\\n)", data: "LF" },
      { label: "CRLF", description: "Windows (\\r\\n)", data: "CRLF" },
    ],
    onAccept: (item) => item && setLineSeparator(item.data as "LF" | "CRLF"),
  });
}

/// Rereads the file from disk decoded as `encoding` (unsaved changes are dropped after asking).
export async function reopenWithEncoding(tab: Tab, encoding: string) {
  if (isDirty(tab) && !(await ask(`Reopening ${tab.title} as ${encoding} discards unsaved changes.`, { title: "Reopen with Encoding", kind: "warning", okLabel: "Reopen", cancelLabel: "Cancel" }))) return;
  try {
    const file = await api.openText(tab.path, encoding);
    tab.model.setValue(file.text);
    fileMeta.set(tab.model, metaFrom(file, true));
    if (tab === active) editor.updateOptions({ readOnly: !!lockedReason(metaOf(tab.model)) });
    if (file.lossy) toast(`${tab.title} is not valid ${encoding}: opened read-only so saving can't damage it.`, "error");
    const version = tab.model.getAlternativeVersionId();
    for (const t of tabs) if (t.model === tab.model) t.savedVersion = version;
  } catch (e) {
    toast(`Cannot reopen ${tab.title} as ${encoding}: ${e}`, "error");
  }
  renderTabs();
  renderFileSlots();
}

const NO_BOM = "UTF-8 (no BOM)";
/// BOM after converting: always for UTF-16, kept for UTF-8 unless "UTF-8 (no BOM)" was picked, never otherwise.
export const convertedBom = (before: { encoding: string; bom: boolean }, picked: string) =>
  picked.startsWith("UTF-16") || (picked === "UTF-8" && before.encoding === "UTF-8" && before.bom);

/// Saves the buffer in another encoding; if it can't represent the text, nothing changes.
export async function convertEncoding(tab: Tab, picked: string) {
  const before = metaOf(tab.model);
  const encoding = picked === NO_BOM ? "UTF-8" : picked;
  fileMeta.set(tab.model, { ...before, encoding, bom: convertedBom(before, picked) });
  if (!(await save(tab))) fileMeta.set(tab.model, before);
  renderFileSlots();
}

export function encodingMenu() {
  const tab = active?.kind === "file" ? active : null;
  if (!tab) return;
  const pick = (title: string, run: (enc: string) => unknown, extra: string[] = []) =>
    quickPick({ placeholder: title, items: [...ENCODINGS, ...extra].map((e) => ({ label: e, description: e === metaOf(tab.model).encoding ? "current" : "", data: e })), onAccept: (item) => item && void run(item.data as string) });
  quickPick({
    placeholder: `${tab.title}: ${metaOf(tab.model).encoding}`,
    items: [
      { label: "Reopen with Encoding…", description: "decode the file on disk differently", data: "reopen" },
      { label: "Convert to Encoding…", description: "save the text in another encoding", data: "convert", icon: lockedReason(metaOf(tab.model)) ? "lock" : undefined },
    ],
    onAccept: (item) => {
      if (item?.data === "reopen") pick("Reopen with encoding", (enc) => reopenWithEncoding(tab, enc));
      else if (item?.data === "convert" && !lockedReason(metaOf(tab.model))) pick("Convert to encoding", (enc) => convertEncoding(tab, enc), [NO_BOM]);
    },
  });
}
editor.onDidChangeModelContent(() => active?.kind === "file" && renderFileSlots());

function cleanupOnSave(tab: Tab) {
  const model = tab.model;
  const style = styleFor(tab.path, model.getLanguageId());
  const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
  if (style.trimTrailingWhitespace) {
    const cursorLine = tab === active ? editor.getPosition()?.lineNumber : -1;
    for (let i = 1; i <= model.getLineCount(); i++) {
      if (i === cursorLine) continue;
      const line = model.getLineContent(i);
      const trimmed = line.trimEnd().length;
      if (trimmed < line.length) edits.push({ range: new monaco.Range(i, trimmed + 1, i, line.length + 1), text: "" });
    }
  }
  const last = model.getLineCount();
  if (style.insertFinalNewline && model.getLineContent(last) !== "") edits.push({ range: new monaco.Range(last, model.getLineMaxColumn(last), last, model.getLineMaxColumn(last)), text: model.getEOL() });
  if (edits.length) model.pushEditOperations(tab === active ? editor.getSelections() : [], edits, () => (tab === active ? editor.getSelections() : null));
}

export async function save(tab: Tab): Promise<boolean> {
  if (tab.kind === "view") return true;
  const meta = metaOf(tab.model);
  if (lockedReason(meta)) {
    toast(`${tab.title} is read-only: ${lockedReason(meta)}.`, "error");
    return false;
  }
  if (tab.kind === "file" && tab === active && setting("editor.formatOnSave") && tab.model.getLanguageId() === "ruby") {
    await editor.getAction("editor.action.formatDocument")?.run().catch(() => {});
  }
  cleanupOnSave(tab);
  try {
    await api.writeFile(tab.path, tab.model.getValue(), meta.encoding, meta.bom);
  } catch (e) {
    toast(`Save failed: ${e}`, "error");
    return false;
  }
  const version = tab.model.getAlternativeVersionId();
  for (const t of tabs) if (t.model === tab.model) t.savedVersion = version;
  renderTabs();
  events.saved.fire(tab);
  if (tab.path === (await settingsPath()) || tab.path === projectSettingsPath()) await loadSettings();
  return true;
}

let autoSaveTimer = 0;
function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = window.setTimeout(() => saveAll(), setting<number>("editor.autoSaveDelay"));
}
window.addEventListener("blur", () => {
  if (setting("editor.autoSave") !== "off") saveAll();
});

export const saveActive = () => active && save(active);
export const saveAll = () => Promise.all(tabs.filter(isDirty).map(save));
/// Titles of file buffers with unsaved changes, once per buffer (an editable diff shares its file's model).
/// Unsaved file buffers with their text (hot exit backups).
export const dirtyBuffers = () => [...new Map(tabs.filter((t) => t.kind === "file" && isDirty(t)).map((t) => [t.model, { path: t.path, text: t.model.getValue(), encoding: metaOf(t.model).encoding, bom: metaOf(t.model).bom }])).values()];

/// Puts backed-up text into a file's buffer as an undoable, unsaved edit; false when there is nothing to restore.
export async function restoreBuffer(b: { path: string; text: string; encoding?: string; bom?: boolean }): Promise<boolean> {
  await openFile(b.path);
  const tab = tabs.find((t) => t.kind === "file" && t.path === b.path);
  if (!tab || tab.model.getValue() === b.text) return false;
  if (b.encoding && !lockedReason(metaOf(tab.model))) fileMeta.set(tab.model, { ...metaOf(tab.model), encoding: b.encoding, bom: !!b.bom });
  tab.model.pushEditOperations([], [{ range: tab.model.getFullModelRange(), text: b.text }], () => null);
  return true;
}

export const unsavedTitles = () => [...new Map(tabs.filter((t) => t.kind !== "view" && isDirty(t)).map((t) => [t.model, t.title])).values()];
export const closeActive = () => active && closeTab(active);
/// The active file or diff tab; view tabs (database console, table data, DDL) have no file path, see activeViewTab().
export const activeTab = () => (active?.kind === "view" ? null : active);
export const activeViewTab = () => (active?.kind === "view" ? active : null);

/// The Monaco editor that should receive editor commands: the one with keyboard focus (a SQL console, a diff side,
/// the main editor), else the main editor when a file tab is showing; null when nothing editable is showing.
export function targetEditor(): monaco.editor.ICodeEditor | null {
  const editors = monaco.editor.getEditors();
  const focused = editors.find((e) => e.hasTextFocus()) ?? editors.find((e) => e.getContainerDomNode().contains(document.activeElement));
  if (focused) return focused;
  if (active?.kind === "file") return editor;
  const el = active?.view?.el;
  return (el && editors.find((e) => el.contains(e.getContainerDomNode()))) || null;
}

/// Puts focus back in what the active tab shows: the main editor, the diff, or a view tab's own editor/element.
export function focusActiveTab() {
  if (!active) return;
  if (active.kind === "file") return editor.focus();
  if (active.kind === "diff") return diffEditor?.getModifiedEditor().focus();
  const el = active.view!.el;
  const inner = monaco.editor.getEditors().find((e) => el.contains(e.getContainerDomNode()));
  if (inner) return inner.focus();
  el.querySelector<HTMLElement>("input, textarea, [tabindex]")?.focus();
}
export const allTabs = () => [...tabs];

export function cycleTab(delta: number) {
  if (!tabs.length) return;
  const i = active ? tabs.indexOf(active) : 0;
  activate(tabs[(i + delta + tabs.length) % tabs.length]);
}

/// Reload buffers whose files changed on disk; dirty buffers ask first.
export async function handleFsChanged(paths: string[]) {
  for (const path of paths) {
    const model = monaco.editor.getModel(uriFor(path));
    if (!model) continue;
    let file: TextFile;
    const meta = metaOf(model);
    try {
      file = await api.openText(path, meta.forced ? meta.encoding : undefined);
      if (file.truncated) continue;
    } catch {
      continue;
    }
    const text = file.text;
    if (text === model.getValue()) continue;
    const owners = tabs.filter((t) => t.model === model);
    const replace = () => {
      fileMeta.set(model, metaFrom(file, meta.forced));
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
      const version = model.getAlternativeVersionId();
      for (const t of owners) t.savedVersion = version;
      renderTabs();
    };
    if (owners.some(isDirty)) {
      toast(`${basename(path)} changed on disk.`, "info", [
        { label: "Reload", run: replace },
        { label: "Keep mine", run: () => {} },
      ]);
    } else replace();
  }
}

/// Paths renamed or deleted from the file tree
export function handlePathMoved(from: string, to: string | null) {
  for (const t of tabs.filter((t) => t.path === from || t.path.startsWith(from + "/"))) {
    if (to === null) {
      closeTab(t, true);
      continue;
    }
    const next = to + t.path.slice(from.length);
    const text = t.model.getValue();
    const wasActive = active === t;
    closeTab(t, true).then(async () => {
      await openFile(next);
      const nt = tabs.find((x) => x.path === next);
      if (nt && nt.model.getValue() !== text) nt.model.setValue(text);
      if (!wasActive && nt) activate(nt);
    });
  }
}

function renderTabs() {
  const names = new Map<string, number>();
  for (const t of tabs) names.set(t.title, (names.get(t.title) ?? 0) + 1);
  tabsEl.replaceChildren(
    ...tabs.map((t) => {
      const dirty = isDirty(t);
      const parent = rel(t.path).split("/").slice(-2, -1)[0];
      t.el = h(
        "div",
        {
          class: `tab${t === active ? " active" : ""}${dirty ? " dirty" : ""}${t.pinned ? " pinned" : ""}`,
          title: t.view ? (t.view.tooltip ?? t.title) : rel(t.path),
          oncontextmenu: (e: MouseEvent) => tabMenu(e, t),
          onmousedown: (e: MouseEvent) => {
            if (e.button === 1) {
              e.preventDefault();
              closeTab(t);
            } else if (e.button === 0) activate(t);
          },
        },
        t.view ? icon(t.view.icon, "view-tab-icon") : t.kind === "diff" ? icon("diff", `lang-${t.model.getLanguageId()}`) : fileIcon(t.path, `lang-${t.model.getLanguageId()}`),
        t.pinned ? h("span", { class: "codicon codicon-pinned tab-pin", title: "Pinned", "aria-label": "Pinned" }) : null,
        h("span", { class: "tab-title" }, t.title),
        (names.get(t.title) ?? 0) > 1 && parent ? h("span", { class: "tab-desc" }, parent) : null,
        h(
          "button",
          {
            class: "tab-close",
            title: tip("Close", "closeTab"),
            onmousedown: (e: MouseEvent) => e.stopPropagation(),
            onclick: (e: MouseEvent) => (e.stopPropagation(), closeTab(t)),
          },
          icon(dirty ? "circle-filled" : "close"),
        ),
      );
      return t.el;
    }),
    tabOverflow.more,
  );
  tabOverflow.fit();
}
