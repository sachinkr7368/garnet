import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import { conf as htmlConf, language as htmlLanguage } from "monaco-editor/languages/definitions/html/html";
import { message } from "@tauri-apps/plugin-dialog";
import { api } from "./ipc";
import { hamlConf, hamlLanguage } from "./languages/haml";
import { slimConf, slimLanguage } from "./languages/slim";
import { snippetsFor } from "./languages/snippets";
import { styleFor } from "./codestyle";
import { monacoTheme } from "./theme";
import { globToRegExp, isDarkTheme, loadSettings, onSettingsChange, projectSettingsPath, setting, settingsPath, updateSetting } from "./settings";
import { basename, rel } from "./state";
import { fileIcon, h, icon, iconButton, statusSlot, tip, toast } from "./ui";

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
  monaco.languages.register({ id: "erb", extensions: [".erb"], aliases: ["ERB", "erb"] });
  const lang = structuredClone(htmlLanguage) as any;
  const open = [/<%(?:=|-|#)?/, { token: "metatag.erb", next: "@erb", nextEmbedded: "ruby" }];
  const close = [/-?%>/, "metatag.erb"];
  for (const key of Object.keys(lang.tokenizer)) lang.tokenizer[key].unshift(open, close);
  lang.tokenizer.erb = [[/-?%>/, { token: "@rematch", next: "@pop", nextEmbedded: "@pop" }]];
  lang.tokenPostfix = ".erb";
  monaco.languages.setMonarchTokensProvider("erb", lang);
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
    wordWrap: setting("editor.wordWrap"),
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

export function retitleViewTab(key: string, title: string) {
  const tab = tabs.find((t) => t.kind === "view" && t.key === key);
  if (tab && tab.title !== title) {
    tab.title = title;
    renderTabs();
  }
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

export async function ensureModel(path: string): Promise<monaco.editor.ITextModel | null> {
  const uri = uriFor(path);
  const existing = monaco.editor.getModel(uri);
  if (existing) return existing;
  let text: string;
  try {
    text = await api.readFile(path);
  } catch (e) {
    toast(`Cannot open ${rel(path)}: ${e}`, "error");
    return null;
  }
  return (
    monaco.editor.getModel(uri) ??
    monaco.editor.createModel(text, languageFor(path), uri)
  );
}

function addTab(tab: Tab) {
  const firstUser = modelUsers(tab.model) === 0;
  tabs.push(tab);
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
export const recentLocations = () => [...back].reverse();

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
    langSlot.textContent = "";
    cursorSlot.textContent = "";
    tab.view!.onActivate?.();
  } else if (tab?.kind === "file") {
    editor.setModel(tab.model);
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
  renderTabs();
  tab?.el.scrollIntoView({ block: "nearest", inline: "nearest" });
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
  if (tab.kind === "file" && tab === active && setting("editor.formatOnSave") && tab.model.getLanguageId() === "ruby") {
    await editor.getAction("editor.action.formatDocument")?.run().catch(() => {});
  }
  cleanupOnSave(tab);
  try {
    await api.writeFile(tab.path, tab.model.getValue());
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
export const closeActive = () => active && closeTab(active);
export const activeTab = () => active;
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
    let text: string;
    try {
      text = await api.readFile(path);
    } catch {
      continue;
    }
    if (text === model.getValue()) continue;
    const owners = tabs.filter((t) => t.model === model);
    const replace = () => {
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
          class: `tab${t === active ? " active" : ""}${dirty ? " dirty" : ""}`,
          title: t.view ? (t.view.tooltip ?? t.title) : rel(t.path),
          onmousedown: (e: MouseEvent) => {
            if (e.button === 1) {
              e.preventDefault();
              closeTab(t);
            } else if (e.button === 0) activate(t);
          },
        },
        t.view ? icon(t.view.icon, "view-tab-icon") : t.kind === "diff" ? icon("diff", `lang-${t.model.getLanguageId()}`) : fileIcon(t.path, `lang-${t.model.getLanguageId()}`),
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
  );
}
