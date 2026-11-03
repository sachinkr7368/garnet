import { autoEndText } from "./autoend";
import { symbolPath, type SymbolNode } from "./breadcrumbs";
import { commands, runEditorAction } from "./commands";
import { runToCursor, toggleMuteBreakpoints } from "./debug";
import {
  activeTab, allTabs, closeTabs, editor, encodingMenu, goToEdit, lineSeparatorMenu, monaco, openTextDiff, reopenClosedTab, tabsToClose, targetEditor,
  isDirty, togglePin, toggleSoftWrap,
} from "./editor";
import { api } from "./ipc";
import { snippetsFor } from "./languages/snippets";
import { cachedSymbols, extractRefactor, lspActiveForTab, onTypeEdits } from "./lsp";
import { setting, updateSetting } from "./settings";
import { abs, rel, state } from "./state";
import { bottom, fileIconName, inputBox, quickPick, toast } from "./ui";
import { terminals } from "./terminal";
import { openInTerminal, selectedTreePath, treeEl } from "./tree";

/// Automatic `end` on Enter: ruby-lsp's onTypeFormatting when it runs, else Garnet's own rule. The edit keeps the
/// caret on the new line (ruby-lsp only places it for VS Code, through a snippet).
// ponytail: onDidType is Monaco's internal typed-text event (formatOnType uses it); not in the public typings.
(editor as unknown as { onDidType(fn: (text: string) => void): monaco.IDisposable }).onDidType((text) => void autoEnd(text));

async function autoEnd(text: string) {
  const model = editor.getModel();
  const pos = editor.getPosition();
  if (text !== "\n" || !model || !pos || model.getLanguageId() !== "ruby" || !setting("editor.autoInsertEnd") || editor.getOption(monaco.editor.EditorOption.readOnly)) return;
  const version = model.getVersionId();
  let edits = await onTypeEdits(model, pos, "\n");
  if (edits?.some((e) => e.text?.trimStart().startsWith("#"))) edits = [];
  if (edits === null) {
    const end = autoEndText(model.getLinesContent(), pos.lineNumber);
    const col = model.getLineMaxColumn(pos.lineNumber);
    edits = end ? [{ range: new monaco.Range(pos.lineNumber, col, pos.lineNumber, col), text: end }] : [];
  }
  if (!edits.length || model.getVersionId() !== version || editor.getModel() !== model) return;
  editor.executeEdits("autoEnd", mergeInserts(edits), editor.getSelections() ?? undefined);
  // The block body is indented one level past the opener, as RubyMine does.
  const opts = model.getOptions();
  const want = (model.getLineContent(pos.lineNumber - 1).match(/^\s*/)?.[0] ?? "") + (opts.insertSpaces ? " ".repeat(opts.indentSize) : "\t");
  const line = model.getLineContent(pos.lineNumber);
  if (!line.trim() && line.length < want.length)
    editor.executeEdits("autoEnd", [{ range: new monaco.Range(pos.lineNumber, 1, pos.lineNumber, line.length + 1), text: want }], [new monaco.Selection(pos.lineNumber, want.length + 1, pos.lineNumber, want.length + 1)]);
}

/// Inserts at the same position, joined in order (Monaco does not promise their order).
export function mergeInserts(edits: monaco.editor.IIdentifiedSingleEditOperation[]) {
  const out: monaco.editor.IIdentifiedSingleEditOperation[] = [];
  for (const e of edits) {
    const last = out[out.length - 1];
    if (last && monaco.Range.isEmpty(e.range) && monaco.Range.equalsRange(last.range, e.range)) last.text = (last.text ?? "") + (e.text ?? "");
    else out.push({ ...e });
  }
  return out;
}

/// Copy Reference (⌥⇧⌘C): Foo::Bar#baz, Foo.klass_method, Foo::CONST from the symbols around the caret.
export function rubyReference(path: Pick<SymbolNode, "name" | "kind">[]): string {
  const K = monaco.languages.SymbolKind;
  let ref = "";
  for (const s of path) {
    if (s.kind === K.Class || s.kind === K.Module || s.kind === K.Namespace) ref += (ref ? "::" : "") + s.name;
    else if (s.kind === K.Method || s.kind === K.Function || s.kind === K.Constructor) return ref + (s.name.startsWith("self.") ? `.${s.name.slice(5)}` : `#${s.name}`);
    else if (s.kind === K.Constant) return ref + (ref ? "::" : "") + s.name;
  }
  return ref;
}

async function copyReference() {
  const t = activeTab();
  const pos = editor.getPosition();
  if (!t || t.kind !== "file" || !pos) return;
  const ref = lspActiveForTab() ? rubyReference(symbolPath(await cachedSymbols(t.model), pos.lineNumber, pos.column)) : "";
  const text = ref || `${rel(t.path)}:${pos.lineNumber}`;
  await navigator.clipboard.writeText(text);
  toast(`Copied ${text}`);
}

function copyPath() {
  const path = treeEl.contains(document.activeElement) ? selectedTreePath() : activeTab()?.path;
  if (path) void navigator.clipboard.writeText(path).then(() => toast(`Copied ${path}`));
}

/// Where Extract Constant puts `NAME = value`: under the innermost class/module line enclosing `line`, else at the
/// top of the file after its leading comments. Returns the 1-based line to insert before and the indent.
export function constantSite(lines: string[], line: number): { line: number; indent: string } {
  const own = (lines[line - 1] ?? "").match(/^\s*/)![0].length;
  for (let i = line - 2; i >= 0; i--) {
    const m = lines[i].match(/^(\s*)(class|module)\b/);
    if (m && m[1].length < own) return { line: i + 2, indent: `${m[1]}  ` };
  }
  let top = 0;
  while (top < lines.length && /^\s*#/.test(lines[top])) top++;
  return { line: top + 1, indent: "" };
}

async function extractConstant() {
  const model = editor.getModel();
  const sel = editor.getSelection();
  if (!model || !sel || activeTab()?.kind !== "file" || model.getLanguageId() !== "ruby") return;
  const value = model.getValueInRange(sel).trim();
  if (!value) return toast("Select the value to extract first (⌥↑ extends the selection).");
  const name = await inputBox("Extract Constant: name", "CONSTANT");
  if (!name) return;
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return toast(`${name} is not a constant name (use UPPER_SNAKE_CASE).`, "error");
  const site = constantSite(model.getLinesContent(), sel.startLineNumber);
  editor.focus();
  editor.pushUndoStop();
  editor.executeEdits("extractConstant", [
    { range: sel, text: name },
    { range: new monaco.Range(site.line, 1, site.line, 1), text: `${site.indent}${name} = ${value}\n${site.line === 1 ? "\n" : ""}` },
  ]);
  editor.pushUndoStop();
}

function toggleCase() {
  const ed = targetEditor();
  const model = ed?.getModel();
  const sel = ed?.getSelection();
  if (!ed || !model || !sel) return;
  const range = sel.isEmpty() ? model.getWordAtPosition(sel.getStartPosition()) : null;
  const text = sel.isEmpty() ? (range?.word ?? "") : model.getValueInRange(sel);
  return runEditorAction(ed, text !== text.toUpperCase() ? "editor.action.transformToUppercase" : "editor.action.transformToLowercase");
}

/// Insert Live Template (⌘J): the templates for this file, inserted as a snippet at the caret.
function insertLiveTemplate() {
  const ed = targetEditor();
  const model = ed?.getModel();
  if (!ed || !model) return;
  const list = snippetsFor(model.getLanguageId(), model.uri.fsPath);
  if (!list.length) return toast("No live templates for this file type.");
  quickPick({
    placeholder: "Insert live template",
    items: list.map((s) => ({ label: s.prefix, description: s.description, icon: "symbol-snippet", data: s.body })),
    onAccept: (item) => {
      if (!item) return;
      ed.focus();
      (ed.getContribution("snippetController2") as unknown as { insert(t: string): void } | null)?.insert(item.data as string);
    },
  });
}

async function compareWithClipboard() {
  const t = activeTab();
  if (!t || t.kind !== "file") return;
  const clip = await navigator.clipboard.readText().catch(() => null);
  if (clip === null) return toast("Garnet can't read the clipboard.", "error");
  const sel = editor.getSelection();
  const mine = sel && !sel.isEmpty() ? t.model.getValueInRange(sel) : t.model.getValue();
  openTextDiff(`clipboard:${t.path}:${Date.now()}`, t.path, mine, clip, `${t.title} vs Clipboard`, `${rel(t.path)}${sel && !sel.isEmpty() ? " (selection)" : ""} ↔ Clipboard`);
}

function compareWith() {
  const t = activeTab();
  if (!t || t.kind !== "file" || !state.project) return;
  quickPick({
    placeholder: `Compare ${t.title} with…`,
    items: async (q) => (await api.findFiles(q, 80)).map((p) => ({ label: p.split("/").pop()!, description: p, icon: fileIconName(p), data: p })),
    onAccept: async (item) => {
      if (!item) return;
      const other = abs(item.data as string);
      const text = await api.readFile(other).catch((e) => (toast(`Cannot read ${item.data}: ${e}`, "error"), null));
      if (text !== null) openTextDiff(`compare:${t.path}:${other}`, t.path, t.model.getValue(), text, `${t.title} vs ${item.label}`, `${rel(t.path)} ↔ ${rel(other)}`);
    },
  });
}

const closeGroup = (action: Parameters<typeof tabsToClose>[2]) => () => {
  const t = activeTab() ?? allTabs()[0];
  if (t) void closeTabs(tabsToClose(allTabs(), t, action, isDirty));
};

const E = (id: string, title: string, key: string | undefined, run: () => unknown) => ({ id, title, key, editor: true, run });

commands(
  { id: "reopenClosedTab", title: "Window: Reopen Closed Tab", run: reopenClosedTab },
  { id: "pinTab", title: "Window: Pin / Unpin Active Tab", run: () => { const t = activeTab(); if (t) togglePin(t); } },
  { id: "closeOtherTabs", title: "Window: Close Other Tabs", run: closeGroup("others") },
  { id: "closeAllTabs", title: "Window: Close All Tabs", run: closeGroup("all") },
  { id: "closeUnmodifiedTabs", title: "Window: Close Unmodified Tabs", run: closeGroup("unmodified") },
  { id: "closeTabsToRight", title: "Window: Close Tabs to the Right", run: closeGroup("right") },
  { id: "lastEditLocation", title: "Navigate: Last Edit Location", key: "cmd+shift+backspace", run: () => goToEdit(-1) },
  { id: "nextEditLocation", title: "Navigate: Next Edit Location", run: () => goToEdit(1) },
  { id: "runToCursor", title: "Debug: Run to Cursor", key: "alt+f9", run: runToCursor },
  { id: "muteBreakpoints", title: "Debug: Mute Breakpoints", run: toggleMuteBreakpoints },
  { id: "terminalFind", title: "Terminal: Find…", run: () => (bottom.show("terminal"), terminals.openFind()) },
  { id: "openInTerminal", title: "Terminal: Open in Terminal", run: () => (state.project ? openInTerminal(selectedTreePath() ?? undefined) : toast("Open a folder first.")) },
  E("extractVariable", "Refactor: Extract Variable", "cmd+alt+v", () => extractRefactor("Variable")),
  E("extractMethod", "Refactor: Extract Method", "cmd+alt+m", () => extractRefactor("Method")),
  E("extractConstant", "Refactor: Extract Constant…", "cmd+alt+c", extractConstant),
  E("toggleCase", "Edit: Toggle Case", "cmd+shift+u", toggleCase),
  E("insertLiveTemplate", "Code: Insert Live Template…", "cmd+j", insertLiveTemplate),
  E("unselectOccurrence", "Edit: Unselect Occurrence", "ctrl+shift+g", () => runEditorAction(targetEditor(), "cursorUndo")),
  E("copyReference", "Edit: Copy Reference", "cmd+alt+shift+c", copyReference),
  { id: "copyPath", title: "Edit: Copy Path", key: "cmd+shift+c", run: copyPath },
  { id: "compareClipboard", title: "Diff: Compare with Clipboard", run: compareWithClipboard },
  { id: "compareWith", title: "Diff: Compare File With…", run: compareWith },
  { id: "toggleSoftWrap", title: "View: Soft-Wrap Active Editor", run: toggleSoftWrap },
  { id: "toggleWhitespace", title: "View: Show Whitespaces", run: () => updateSetting("editor.renderWhitespace", setting("editor.renderWhitespace") === "all" ? "selection" : "all") },
  { id: "lineSeparator", title: "File: Line Separator…", run: lineSeparatorMenu },
  { id: "fileEncoding", title: "File: File Encoding…", run: encodingMenu },
);
