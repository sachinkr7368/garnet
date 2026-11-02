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
import { SEMANTIC_RULES } from "./semantic";
import { styleFor } from "./codestyle";
import { globToRegExp, isDarkTheme, loadSettings, onSettingsChange, projectSettingsPath, setting, settingsPath } from "./settings";
import { basename, rel } from "./state";
import { h, icon, statusSlot, toast } from "./ui";

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
  monaco.editor.defineTheme("garnet-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "7a7e85", fontStyle: "italic" },
      { token: "keyword", foreground: "e0876a" },
      { token: "string", foreground: "8fbf7a" },
      { token: "number", foreground: "6fb3d2" },
      { token: "constant", foreground: "c792ea" },
      { token: "metatag.erb", foreground: "e0476a", fontStyle: "bold" },
      { token: "metatag.haml", foreground: "e0476a", fontStyle: "bold" },
      { token: "metatag.slim", foreground: "e0476a", fontStyle: "bold" },
      { token: "tag", foreground: "e0876a" },
      { token: "attribute.name", foreground: "9cc3e6" },
      ...SEMANTIC_RULES.dark,
    ],
    colors: {
      "editor.background": "#18181d",
      "editorGutter.background": "#18181d",
      "editor.lineHighlightBackground": "#22222a",
      "editorLineNumber.foreground": "#4b4d55",
      "editorLineNumber.activeForeground": "#a0a3ab",
      "editor.selectionBackground": "#3a3d4a",
      "editorIndentGuide.background1": "#26262d",
    },
  });
  monaco.editor.defineTheme("garnet-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "8c8c8c", fontStyle: "italic" },
      { token: "keyword", foreground: "a8323e" },
      { token: "metatag.erb", foreground: "b8263d", fontStyle: "bold" },
      { token: "metatag.haml", foreground: "b8263d", fontStyle: "bold" },
      { token: "metatag.slim", foreground: "b8263d", fontStyle: "bold" },
      { token: "tag", foreground: "a8323e" },
      { token: "attribute.name", foreground: "1f5f99" },
      ...SEMANTIC_RULES.light,
    ],
    colors: { "editor.lineHighlightBackground": "#f5f5f8" },
  });
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
  kind: "file" | "diff";
  title: string;
  model: monaco.editor.ITextModel;
  original?: monaco.editor.ITextModel;
  savedVersion: number;
  viewState: monaco.editor.ICodeEditorViewState | monaco.editor.IDiffEditorViewState | null;
  el: HTMLElement;
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

let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
function getDiffEditor() {
  diffEditor ??= monaco.editor.createDiffEditor(diffEl, {
    ...editorOptions(),
    automaticLayout: true,
    originalEditable: false,
    renderSideBySide: true,
  });
  return diffEditor;
}

onSettingsChange(() => {
  const opts = editorOptions();
  editor.updateOptions(opts);
  diffEditor?.updateOptions(opts);
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

const cursorSlot = statusSlot("cursor", "right");
const langSlot = statusSlot("language", "right");
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
  let tab = tabs.find((t) => t.kind === "diff" && t.path === path);
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
  diffEl.hidden = tab?.kind !== "diff";
  if (tab?.kind === "file") {
    editor.setModel(tab.model);
    if (tab.viewState) editor.restoreViewState(tab.viewState as monaco.editor.ICodeEditorViewState);
    editor.focus();
    langSlot.textContent = tab.model.getLanguageId();
    const pos = editor.getPosition();
    cursorSlot.textContent = pos ? `${pos.lineNumber}:${pos.column}` : "";
  } else if (tab?.kind === "diff") {
    const d = getDiffEditor();
    d.setModel({ original: tab.original!, modified: tab.model });
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
  if (modelUsers(tab.model) === 0) {
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
          title: rel(t.path),
          onmousedown: (e: MouseEvent) => {
            if (e.button === 1) {
              e.preventDefault();
              closeTab(t);
            } else if (e.button === 0) activate(t);
          },
        },
        icon(t.kind === "diff" ? "diff" : "file", `lang-${t.model.getLanguageId()}`),
        h("span", { class: "tab-title" }, t.title),
        (names.get(t.title) ?? 0) > 1 && parent ? h("span", { class: "tab-desc" }, parent) : null,
        h(
          "button",
          {
            class: "tab-close",
            title: "Close (⌘W)",
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
