import { allTabs, editor, ensureModel, events, handlePathMoved, monaco, openFile, uriFor, activeTab } from "./editor";
import { api, Channel, invoke, type RpcEvent } from "./ipc";
import { runInPanel } from "./run";
import { symbolPath } from "./breadcrumbs";
import { applyTokenEdits } from "./semantic";
import { askTrust, onSettingsChange, setting } from "./settings";
import { showLocations, type Loc } from "./search";
import { debounce, rel, root, state } from "./state";
import { bottom, h, icon, quickPick, statusSlot, toast, type PickItem } from "./ui";

type Json = any;
type Pos = { line: number; character: number };
type LspRange = { start: Pos; end: Pos };
type TextEdit = { range: LspRange; newText: string };

const LANGS = ["ruby", "erb"];
let capabilities: Json = {};
let ready = false;
let stopping = false;
let nextId = 1;
const pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
const tracked = new Map<string, { model: monaco.editor.ITextModel; sub: monaco.IDisposable }>();
const lspDiagnostics = new Map<string, Json[]>();

/// Status bar + log

const statusEl = statusSlot("lsp", "right", () => lspMenu());
const logEl = h("pre", { class: "log" });
export const lspLogView = h("div", { class: "log-view" }, logEl);

function setStatus(text: string, kind = "") {
  statusEl.replaceChildren(icon("ruby"), ` ${text}`);
  statusEl.className = `status-item right clickable lsp ${kind}`;
}

function log(line: string) {
  logEl.append(line + "\n");
  while (logEl.childNodes.length > 3000) logEl.firstChild?.remove();
}

function lspMenu() {
  quickPick({
    placeholder: "Ruby LSP",
    items: [
      { label: "Restart Ruby LSP", data: () => startLsp() },
      { label: "Stop Ruby LSP", data: () => stopLsp() },
      { label: "Show Ruby LSP Log", data: () => bottom.show("log") },
    ],
    onAccept: (item) => item && (item.data as () => void)(),
  });
}

/// Transport

function send(msg: Json) {
  invoke("lsp_send", { body: JSON.stringify({ jsonrpc: "2.0", ...msg }) }).catch((e) => log(`send failed: ${e}`));
}

export function request<T = Json>(method: string, params: Json, token?: monaco.CancellationToken): Promise<T> {
  if (!ready && method !== "initialize") return Promise.reject(new Error("Ruby LSP is not ready"));
  const id = nextId++;
  send({ id, method, params });
  token?.onCancellationRequested(() => send({ method: "$/cancelRequest", params: { id } }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function notify(method: string, params: Json) {
  send({ method, params });
}

async function onServerRequest(msg: Json) {
  let result: Json = null;
  switch (msg.method) {
    case "workspace/configuration":
      result = (msg.params?.items ?? []).map(() => null);
      break;
    case "workspace/applyEdit":
      await applyWorkspaceEdit(msg.params.edit);
      result = { applied: true };
      break;
    case "workspace/diagnostic/refresh":
      for (const { model } of tracked.values()) pullDiagnostics(model);
      break;
    case "window/showMessageRequest":
      toast(msg.params.message);
      break;
    case "window/showDocument":
      openFile(monaco.Uri.parse(msg.params.uri).fsPath);
      result = { success: true };
      break;
  }
  send({ id: msg.id, result });
}

const progress = new Map<string | number, string>();

function onNotification(msg: Json) {
  const p = msg.params;
  switch (msg.method) {
    case "window/logMessage":
      log(p.message);
      break;
    case "window/showMessage":
      log(p.message);
      if (p.type <= 2) toast(`Ruby LSP: ${p.message}`, p.type === 1 ? "error" : "info");
      break;
    case "$/progress": {
      const v = p.value;
      if (v.kind === "end") progress.delete(p.token);
      else progress.set(p.token, `${v.title ?? progress.get(p.token)?.split(" ")[0] ?? ""}${v.percentage !== undefined ? ` ${v.percentage}%` : ""}`.trim());
      const busy = [...progress.values()][0];
      if (ready) setStatus(busy ? `Ruby LSP: ${busy}` : "Ruby LSP", busy ? "busy" : "ok");
      break;
    }
    case "textDocument/publishDiagnostics": {
      const model = monaco.editor.getModel(monaco.Uri.parse(p.uri));
      if (model) setDiagnostics(model, p.diagnostics);
      break;
    }
  }
}

function onEvent(ev: RpcEvent) {
  if (ev.type === "stderr") return log(ev.line);
  if (ev.type === "exit") {
    ready = false;
    for (const p of pending.values()) p.reject(new Error("Ruby LSP exited"));
    pending.clear();
    setStatus("Ruby LSP stopped", "off");
    log(`ruby-lsp exited (${ev.code ?? "signal"})`);
    if (!stopping) toast("Ruby LSP stopped unexpectedly.", "error", [{ label: "Restart", run: () => startLsp() }, { label: "Show Log", run: () => bottom.show("log") }]);
    return;
  }
  const msg = JSON.parse(ev.body);
  if (msg.id !== undefined && msg.method === undefined) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p?.reject(new Error(msg.error.message));
    else p?.resolve(msg.result);
  } else if (msg.id !== undefined) onServerRequest(msg);
  else onNotification(msg);
}

/// Lifecycle

export async function startLsp() {
  if (!state.project || !(await askTrust())) return;
  await stopLsp();
  stopping = false;
  setStatus("Ruby LSP: starting", "busy");
  const channel = new Channel<RpcEvent>();
  channel.onmessage = onEvent;
  try {
    const cmd = await invoke<string>("lsp_start", { root: root(), command: setting<string>("ruby.lspCommand") || null, onEvent: channel });
    log(`$ ${cmd}`);
  } catch (e) {
    if (String(e).includes("ruby-lsp-missing")) {
      setStatus("Ruby LSP: not installed", "off");
      toast("ruby-lsp is not installed. Install it to get completion, navigation and diagnostics.", "info", [
        { label: "gem install ruby-lsp", run: installLsp },
      ]);
    } else {
      setStatus("Ruby LSP: failed", "off");
      log(String(e));
      toast(`Ruby LSP failed to start: ${e}`, "error");
    }
    return;
  }
  ready = true;
  try {
    const init = await request("initialize", initializeParams());
    capabilities = init.capabilities ?? {};
    notify("initialized", {});
    setStatus("Ruby LSP", "ok");
    registerFeatureProviders();
    for (const { model } of tracked.values()) didOpen(model);
    refreshOutline();
    refreshBreadcrumbs();
  } catch (e) {
    ready = false;
    setStatus("Ruby LSP: failed", "off");
    log(`initialize failed: ${e}`);
  }
}

export async function stopLsp() {
  if (!ready) return invoke("lsp_stop");
  stopping = true;
  await Promise.race([request("shutdown", null).catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
  notify("exit", null);
  ready = false;
  await invoke("lsp_stop");
}

function installLsp() {
  runInPanel("gem install ruby-lsp", "gem install ruby-lsp", {
    onExit: (code) => (code === 0 ? startLsp() : toast("gem install ruby-lsp failed; see the Run panel.", "error")),
  });
}

function initializeParams() {
  const uri = uriFor(root()).toString();
  return {
    processId: null,
    clientInfo: { name: "Garnet", version: "0.1.0" },
    rootUri: uri,
    workspaceFolders: [{ uri, name: state.project!.name }],
    capabilities: {
      general: { positionEncodings: ["utf-16"] },
      window: { workDoneProgress: true, showDocument: { support: true } },
      workspace: {
        applyEdit: true,
        workspaceEdit: { documentChanges: true, resourceOperations: ["rename"] },
        configuration: true,
        workspaceFolders: true,
        symbol: {},
        diagnostics: { refreshSupport: true },
      },
      textDocument: {
        synchronization: { didSave: true },
        completion: {
          completionItem: {
            snippetSupport: true,
            documentationFormat: ["markdown", "plaintext"],
            resolveSupport: { properties: ["documentation", "detail"] },
            labelDetailsSupport: true,
          },
          contextSupport: true,
        },
        hover: { contentFormat: ["markdown", "plaintext"] },
        definition: { linkSupport: true },
        implementation: { linkSupport: true },
        typeDefinition: { linkSupport: true },
        typeHierarchy: {},
        semanticTokens: {
          requests: { full: { delta: true }, range: false },
          tokenTypes: ["namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property", "enumMember", "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator", "decorator"],
          tokenModifiers: ["declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification", "documentation", "defaultLibrary"],
          formats: ["relative"],
          multilineTokenSupport: false,
          overlappingTokenSupport: false,
        },
        inlayHint: {},
        references: {},
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        formatting: {},
        rename: { prepareSupport: true },
        codeAction: {
          codeActionLiteralSupport: { codeActionKind: { valueSet: ["quickfix", "refactor", "refactor.extract", "refactor.rewrite", "source"] } },
          resolveSupport: { properties: ["edit"] },
          dataSupport: true,
          isPreferredSupport: true,
        },
        diagnostic: {},
        publishDiagnostics: { relatedInformation: false },
      },
    },
    initializationOptions: {
      enabledFeatures: { codeLens: false },
      featuresConfiguration: { inlayHint: { enableAll: true } },
      formatter: "auto",
      linters: setting("inspections.rubocop") ? ["rubocop"] : [],
    },
  };
}

/// Document sync

export const lspPos = (p: monaco.IPosition): Pos => ({ line: p.lineNumber - 1, character: p.column - 1 });
export const lspRange = (r: monaco.IRange): LspRange => ({
  start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
  end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
});
export const toRange = (r: LspRange) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
const docId = (m: monaco.editor.ITextModel) => ({ uri: m.uri.toString() });
const docPos = (m: monaco.editor.ITextModel, p: monaco.IPosition) => ({ textDocument: docId(m), position: lspPos(p) });

events.modelOpened.on((model) => {
  if (!LANGS.includes(model.getLanguageId()) || model.uri.scheme !== "file") return;
  tracked.set(model.uri.toString(), { model, sub: { dispose() {} } });
  if (ready) didOpen(model);
});

events.modelClosed.on((model) => {
  const key = model.uri.toString();
  const t = tracked.get(key);
  if (!t) return;
  t.sub.dispose();
  tracked.delete(key);
  lspDiagnostics.delete(key);
  if (ready) notify("textDocument/didClose", { textDocument: docId(model) });
});

events.saved.on((tab) => {
  const t = tracked.get(tab.model.uri.toString());
  if (t && ready) {
    notify("textDocument/didSave", { textDocument: docId(tab.model) });
    pullDiagnostics(tab.model);
  }
});

function didOpen(model: monaco.editor.ITextModel) {
  const key = model.uri.toString();
  const t = tracked.get(key);
  if (!t) return;
  t.sub.dispose();
  notify("textDocument/didOpen", {
    textDocument: { uri: key, languageId: model.getLanguageId(), version: model.getVersionId(), text: model.getValue() },
  });
  const later = debounce(() => pullDiagnostics(model), 400);
  t.sub = model.onDidChangeContent((e) => {
    if (!ready) return;
    notify("textDocument/didChange", {
      textDocument: { uri: key, version: model.getVersionId() },
      contentChanges: e.isFlush
        ? [{ text: model.getValue() }]
        : e.changes.map((c) => ({ range: lspRange(c.range), rangeLength: c.rangeLength, text: c.text })),
    });
    later();
  });
  pullDiagnostics(model);
}

/// Diagnostics

const severity = [monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning, monaco.MarkerSeverity.Info, monaco.MarkerSeverity.Hint];

const SEVERITY_RANK: Record<string, number> = { error: 1, warning: 2, info: 3, hint: 4 };

function setDiagnostics(model: monaco.editor.ITextModel, all: Json[]) {
  lspDiagnostics.set(model.uri.toString(), all);
  const max = SEVERITY_RANK[setting<string>("inspections.minSeverity")] ?? 4;
  const items = all.filter((d) => (d.severity ?? 1) <= max);
  monaco.editor.setModelMarkers(
    model,
    "ruby-lsp",
    items.map((d) => ({
      ...toRange(d.range).toJSON(),
      severity: severity[d.severity ?? 1],
      message: d.message,
      source: d.source,
      code: typeof d.code === "object" ? String(d.code?.value) : d.code !== undefined ? String(d.code) : undefined,
      tags: d.tags?.map((t: number) => (t === 1 ? monaco.MarkerTag.Unnecessary : monaco.MarkerTag.Deprecated)),
    })),
  );
}

async function pullDiagnostics(model: monaco.editor.ITextModel) {
  if (!ready || !capabilities.diagnosticProvider) return;
  const version = model.getVersionId();
  const res = await request("textDocument/diagnostic", { textDocument: docId(model) }).catch(() => null);
  if (!res || model.isDisposed() || model.getVersionId() !== version) return;
  if (res.kind === "full") setDiagnostics(model, res.items ?? []);
}

/// Workspace edits

export function applyTextEdits(text: string, edits: TextEdit[]): string {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  const offset = (p: Pos) => Math.min(text.length, (starts[p.line] ?? text.length) + p.character);
  const sorted = edits.map((e) => ({ s: offset(e.range.start), e: offset(e.range.end), t: e.newText })).sort((a, b) => b.s - a.s);
  for (const { s, e, t } of sorted) text = text.slice(0, s) + t + text.slice(e);
  return text;
}

/// Applies a WorkspaceEdit: open buffers are edited in place (or returned for Monaco to apply),
/// files that are not open are rewritten on disk.
export async function applyWorkspaceEdit(edit: Json, collect = false): Promise<monaco.languages.IWorkspaceTextEdit[]> {
  const perUri = new Map<string, TextEdit[]>();
  const renames: [string, string][] = [];
  const push = (uri: string, edits: TextEdit[]) => perUri.set(uri, [...(perUri.get(uri) ?? []), ...edits]);
  for (const ch of edit?.documentChanges ?? []) {
    if (ch.kind === "rename") renames.push([ch.oldUri, ch.newUri]);
    else if (!ch.kind) push(ch.textDocument.uri, ch.edits);
  }
  for (const [uri, edits] of Object.entries(edit?.changes ?? {})) push(uri, edits as TextEdit[]);

  const openModels = new Set(allTabs().map((t) => t.model));
  const forMonaco: monaco.languages.IWorkspaceTextEdit[] = [];
  for (const [uri, edits] of perUri) {
    const parsed = monaco.Uri.parse(uri);
    const model = monaco.editor.getModel(parsed);
    if (model && openModels.has(model)) {
      if (collect) for (const e of edits) forMonaco.push({ resource: model.uri, textEdit: { range: toRange(e.range), text: e.newText }, versionId: undefined });
      else model.pushEditOperations([], edits.map((e) => ({ range: toRange(e.range), text: e.newText })), () => null);
    } else {
      const text = await api.readFile(parsed.fsPath);
      await api.writeFile(parsed.fsPath, applyTextEdits(text, edits));
    }
  }
  for (const [from, to] of renames) {
    const [a, b] = [monaco.Uri.parse(from).fsPath, monaco.Uri.parse(to).fsPath];
    await api.renamePath(a, b);
    handlePathMoved(a, b);
  }
  return forMonaco;
}

const CMD_APPLY_ACTION = "garnet.applyCodeAction";
monaco.editor.registerCommand(CMD_APPLY_ACTION, async (_accessor, action: Json) => {
  let a = action;
  if (!a.edit && !a.command && capabilities.codeActionProvider?.resolveProvider) a = await request("codeAction/resolve", a);
  if (a.edit) await applyWorkspaceEdit(a.edit);
  const cmd = typeof a.command === "string" ? a : a.command;
  if (cmd?.command) await request("workspace/executeCommand", { command: cmd.command, arguments: cmd.arguments }).catch((e) => toast(String(e), "error"));
});

/// Monaco providers

const completionKinds = [
  "", "Text", "Method", "Function", "Constructor", "Field", "Variable", "Class", "Interface", "Module", "Property", "Unit",
  "Value", "Enum", "Keyword", "Snippet", "Color", "File", "Reference", "Folder", "EnumMember", "Constant", "Struct",
  "Event", "Operator", "TypeParameter",
] as const;

function markdown(doc: Json): monaco.IMarkdownString | undefined {
  if (!doc) return undefined;
  if (typeof doc === "string") return { value: doc };
  if (doc.kind === "plaintext") return { value: doc.value.replace(/[\\`*_{}[\]()#+\-.!]/g, "\\$&") };
  if (doc.language) return { value: "```" + doc.language + "\n" + doc.value + "\n```" };
  return { value: doc.value ?? "" };
}

async function locations(result: Json): Promise<monaco.languages.Location[]> {
  const list = !result ? [] : Array.isArray(result) ? result : [result];
  const locs = list.map((l: Json) => ("targetUri" in l ? { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange } : l));
  const uris = [...new Set<string>(locs.map((l: Json) => l.uri))].slice(0, 60);
  await Promise.all(uris.map((u) => ensureModel(monaco.Uri.parse(u).fsPath)));
  return locs.map((l: Json) => ({ uri: monaco.Uri.parse(l.uri), range: toRange(l.range) }));
}

const live = (m: monaco.editor.ITextModel) => ready && tracked.has(m.uri.toString());

for (const lang of LANGS) {
  monaco.languages.registerCompletionItemProvider(lang, {
    triggerCharacters: [".", ":", "@", '"', "'", "/", "<"],
    async provideCompletionItems(model, position, context, token) {
      if (!live(model)) return { suggestions: [] };
      const res = await request(
        "textDocument/completion",
        { ...docPos(model, position), context: { triggerKind: context.triggerKind + 1, triggerCharacter: context.triggerCharacter } },
        token,
      ).catch(() => null);
      const items: Json[] = Array.isArray(res) ? res : (res?.items ?? []);
      const word = model.getWordUntilPosition(position);
      const fallback = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      return {
        incomplete: !!res?.isIncomplete,
        suggestions: items.map((it) => {
          const te = it.textEdit;
          const range = !te ? fallback : "range" in te ? toRange(te.range) : { insert: toRange(te.insert), replace: toRange(te.replace) };
          return {
            label: it.labelDetails ? { label: it.label, detail: it.labelDetails.detail, description: it.labelDetails.description } : it.label,
            kind: monaco.languages.CompletionItemKind[completionKinds[it.kind ?? 1] as keyof typeof monaco.languages.CompletionItemKind] ?? monaco.languages.CompletionItemKind.Text,
            detail: it.detail,
            documentation: markdown(it.documentation),
            insertText: te?.newText ?? it.insertText ?? it.label,
            insertTextRules: it.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
            range,
            sortText: it.sortText,
            filterText: it.filterText,
            preselect: it.preselect,
            additionalTextEdits: it.additionalTextEdits?.map((e: TextEdit) => ({ range: toRange(e.range), text: e.newText })),
            lsp: it,
          } as monaco.languages.CompletionItem;
        }),
      };
    },
    async resolveCompletionItem(item, token) {
      if (!ready || !capabilities.completionProvider?.resolveProvider) return item;
      const r = await request("completionItem/resolve", (item as Json).lsp, token).catch(() => null);
      if (r) {
        item.documentation = markdown(r.documentation) ?? item.documentation;
        item.detail = r.detail ?? item.detail;
      }
      return item;
    },
  });

  monaco.languages.registerHoverProvider(lang, {
    async provideHover(model, position, token) {
      if (!live(model)) return null;
      const r = await request("textDocument/hover", docPos(model, position), token).catch(() => null);
      if (!r?.contents) return null;
      const contents = (Array.isArray(r.contents) ? r.contents : [r.contents]).map(markdown).filter(Boolean) as monaco.IMarkdownString[];
      return { contents, range: r.range ? toRange(r.range) : undefined };
    },
  });

  monaco.languages.registerDefinitionProvider(lang, {
    async provideDefinition(model, position, token) {
      if (!live(model)) return null;
      return locations(await request("textDocument/definition", docPos(model, position), token).catch(() => null));
    },
  });

  monaco.languages.registerReferenceProvider(lang, {
    async provideReferences(model, position, context, token) {
      if (!live(model)) return null;
      return locations(
        await request("textDocument/references", { ...docPos(model, position), context: { includeDeclaration: context.includeDeclaration } }, token).catch(() => null),
      );
    },
  });

  monaco.languages.registerDocumentSymbolProvider(lang, {
    async provideDocumentSymbols(model, token) {
      return live(model) ? documentSymbols(model, token) : [];
    },
  });

  monaco.languages.registerDocumentFormattingEditProvider(lang, {
    async provideDocumentFormattingEdits(model, options, token) {
      if (!live(model)) return [];
      const edits: TextEdit[] | null = await request(
        "textDocument/formatting",
        { textDocument: docId(model), options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } },
        token,
      ).catch((e) => (toast(`Format failed: ${e.message}`, "error"), null));
      return (edits ?? []).map((e) => ({ range: toRange(e.range), text: e.newText }));
    },
  });

  monaco.languages.registerRenameProvider(lang, {
    async provideRenameEdits(model, position, newName, token) {
      const edit = await request("textDocument/rename", { ...docPos(model, position), newName }, token).catch((e) => ({ error: e.message }));
      if (!edit || edit.error) return { edits: [], rejectReason: edit?.error ?? "Nothing to rename" };
      return { edits: await applyWorkspaceEdit(edit, true) };
    },
    async resolveRenameLocation(model, position, token) {
      const word = model.getWordAtPosition(position);
      const wordRange = word && new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      if (!live(model) || !capabilities.renameProvider?.prepareProvider) return wordRange ? { range: wordRange, text: word!.word } : null;
      const r = await request("textDocument/prepareRename", docPos(model, position), token).catch(() => null);
      if (!r) return { range: wordRange ?? new monaco.Range(1, 1, 1, 1), text: "", rejectReason: "This element can't be renamed." };
      if (r.range) return { range: toRange(r.range), text: r.placeholder };
      if (r.start) return { range: toRange(r), text: model.getValueInRange(toRange(r)) };
      return wordRange ? { range: wordRange, text: word!.word } : null;
    },
  });

  monaco.languages.registerCodeActionProvider(
    lang,
    {
      async provideCodeActions(model, range, context, token) {
        if (!live(model)) return { actions: [], dispose() {} };
        const diagnostics = (lspDiagnostics.get(model.uri.toString()) ?? []).filter((d) => toRange(d.range).intersectRanges(range));
        const r: Json[] | null = await request(
          "textDocument/codeAction",
          { textDocument: docId(model), range: lspRange(range), context: { diagnostics, only: context.only ? [context.only] : undefined, triggerKind: context.trigger } },
          token,
        ).catch(() => null);
        const actions = (r ?? []).map((a) => ({
          title: a.title,
          kind: a.kind,
          isPreferred: a.isPreferred,
          command: { id: CMD_APPLY_ACTION, title: a.title, arguments: [a] },
        }));
        return { actions, dispose() {} };
      },
    },
    { providedCodeActionKinds: ["quickfix", "refactor", "refactor.extract", "refactor.rewrite", "source"] },
  );
}

/// Symbols

export async function documentSymbols(model: monaco.editor.ITextModel, token?: monaco.CancellationToken): Promise<monaco.languages.DocumentSymbol[]> {
  const res: Json[] | null = await request("textDocument/documentSymbol", { textDocument: docId(model) }, token).catch(() => null);
  const convert = (s: Json): monaco.languages.DocumentSymbol => {
    const range = toRange(s.range ?? s.location.range);
    return {
      name: s.name,
      detail: s.detail ?? "",
      kind: (s.kind - 1) as monaco.languages.SymbolKind,
      tags: [],
      range,
      selectionRange: s.selectionRange ? toRange(s.selectionRange) : range,
      children: (s.children ?? []).map(convert),
    };
  };
  return (res ?? []).map(convert);
}

const symbolCache = new WeakMap<monaco.editor.ITextModel, { version: number; symbols: Promise<monaco.languages.DocumentSymbol[]> }>();

/// Document symbols for the model's current version, shared by the Structure panel and breadcrumbs.
export function cachedSymbols(model: monaco.editor.ITextModel): Promise<monaco.languages.DocumentSymbol[]> {
  const version = model.getVersionId();
  const hit = symbolCache.get(model);
  if (hit?.version === version) return hit.symbols;
  const symbols = documentSymbols(model).then((list) => {
    if (!list.length && symbolCache.get(model)?.version === version) symbolCache.delete(model);
    return list;
  });
  symbolCache.set(model, { version, symbols });
  return symbols;
}

const symbolIcons: Record<number, string> = {
  4: "symbol-class", 1: "symbol-namespace", 5: "symbol-method", 11: "symbol-function", 8: "symbol-constant",
  13: "symbol-constant", 6: "symbol-property", 7: "symbol-field", 12: "symbol-variable", 9: "symbol-constructor",
};
const symbolIcon = (kind: number) => symbolIcons[kind] ?? "symbol-misc";

function flatten(symbols: monaco.languages.DocumentSymbol[], container = ""): { s: monaco.languages.DocumentSymbol; container: string }[] {
  return symbols.flatMap((s) => [{ s, container }, ...flatten(s.children ?? [], container ? `${container}::${s.name}` : s.name)]);
}

export async function fileStructurePopup() {
  const model = editor.getModel();
  if (!model || !live(model)) return toast("File structure needs Ruby LSP on a Ruby file.");
  const items = flatten(await documentSymbols(model)).map(({ s, container }) => ({
    label: s.name,
    description: container,
    icon: symbolIcon(s.kind),
    data: s,
  }));
  quickPick({
    placeholder: "File structure",
    items,
    onAccept: (item) => {
      const s = item?.data as monaco.languages.DocumentSymbol | undefined;
      if (s) openFile(model.uri.fsPath, { line: s.selectionRange.startLineNumber, column: s.selectionRange.startColumn });
    },
  });
}

export function workspaceSymbolsPopup(kinds?: number[]) {
  if (!ready) return toast("Ruby LSP is not running.");
  quickPick({
    placeholder: kinds ? "Go to class or module" : "Go to symbol in project (classes, modules, methods)",
    items: async (query): Promise<PickItem[]> => {
      if (!query.trim()) return [];
      const res: Json[] | null = await request("workspace/symbol", { query }).catch(() => null);
      return (res ?? []).filter((s) => !kinds || kinds.includes(s.kind)).slice(0, 200).map((s) => ({
        label: s.name,
        description: s.containerName ?? "",
        detail: rel(monaco.Uri.parse(s.location.uri).fsPath),
        icon: symbolIcon(s.kind - 1),
        data: s.location,
      }));
    },
    onAccept: (item) => {
      const loc = item?.data as Json;
      if (loc) openFile(monaco.Uri.parse(loc.uri).fsPath, { line: loc.range.start.line + 1, column: loc.range.start.character + 1 });
    },
  });
}

export async function findUsages() {
  const model = editor.getModel();
  const pos = editor.getPosition();
  if (!model || !pos || !live(model)) return toast("Find Usages needs Ruby LSP on a Ruby file.");
  const locs = await locations(await request("textDocument/references", { ...docPos(model, pos), context: { includeDeclaration: false } }).catch(() => null));
  const word = model.getWordAtPosition(pos)?.word ?? "symbol";
  const rows: Loc[] = locs.map((l) => {
    const m = monaco.editor.getModel(l.uri);
    const r = l.range;
    return { path: l.uri.fsPath, line: r.startLineNumber, column: r.startColumn, endLine: r.endLineNumber, endColumn: r.endColumn, text: m?.getLineContent(r.startLineNumber) ?? "" };
  });
  showLocations(`Usages of ${word}`, rows);
}

/// Structure tool window

const outlineBody = h("div", { class: "outline" });
export const outlineView = h("div", { class: "outline-view" }, outlineBody);
let outlineSeq = 0;

export const refreshOutline = debounce(async () => {
  const seq = ++outlineSeq;
  const model = editor.getModel();
  if (!model || !live(model)) {
    outlineBody.replaceChildren(h("div", { class: "empty" }, model ? "Structure is available for Ruby files." : "No file open."));
    return;
  }
  const symbols = await cachedSymbols(model);
  if (seq !== outlineSeq) return;
  const render = (list: monaco.languages.DocumentSymbol[], depth: number): HTMLElement[] =>
    list.flatMap((s) => [
      h(
        "div",
        {
          class: "outline-row",
          style: `padding-left:${depth * 14 + 8}px`,
          onclick: () => openFile(model.uri.fsPath, { line: s.selectionRange.startLineNumber, column: s.selectionRange.startColumn }),
        },
        icon(symbolIcon(s.kind)),
        h("span", {}, s.name),
        s.detail ? h("span", { class: "dim" }, s.detail) : null,
      ),
      ...render(s.children ?? [], depth + 1),
    ]);
  outlineBody.replaceChildren(...render(symbols, 0));
}, 300);

events.activated.on(() => refreshOutline());
editor.onDidChangeModelContent(() => refreshOutline());

/// Breadcrumbs

const crumbsEl = h("div", { class: "breadcrumbs" });
document.getElementById("editor-area")!.before(crumbsEl);
let crumbsSeq = 0;

export const refreshBreadcrumbs = debounce(async () => {
  const seq = ++crumbsSeq;
  const tab = activeTab();
  const model = editor.getModel();
  const pos = editor.getPosition();
  if (!setting("editor.breadcrumbs") || tab?.kind !== "file" || !model || !pos) {
    crumbsEl.hidden = true;
    return;
  }
  const symbols = live(model) ? await cachedSymbols(model) : [];
  if (seq !== crumbsSeq || model.isDisposed()) return;
  const path = symbolPath(symbols, pos.lineNumber, pos.column);
  crumbsEl.hidden = false;
  crumbsEl.replaceChildren(
    h("span", { class: "crumb file", title: rel(model.uri.fsPath) }, icon("file"), h("span", {}, rel(model.uri.fsPath).split("/").pop()!)),
    ...path.flatMap((s) => [
      icon("chevron-right", "crumb-sep"),
      h(
        "span",
        {
          class: "crumb",
          title: s.detail || s.name,
          onclick: () => openFile(model.uri.fsPath, { line: s.selectionRange.startLineNumber, column: s.selectionRange.startColumn }),
        },
        icon(symbolIcon(s.kind)),
        h("span", {}, s.name),
      ),
    ]),
  );
}, 80);

events.activated.on(() => refreshBreadcrumbs());
editor.onDidChangeCursorPosition(() => refreshBreadcrumbs());
editor.onDidChangeModelContent(debounce(() => refreshBreadcrumbs(), 300));
onSettingsChange(() => refreshBreadcrumbs());

/// Go to Implementation / Type Declaration

async function jumpOrPick(title: string, locs: monaco.languages.Location[]) {
  if (!locs.length) return toast(`No ${title.toLowerCase()} found.`);
  const go = (l: monaco.languages.Location) =>
    openFile(l.uri.fsPath, { line: l.range.startLineNumber, column: l.range.startColumn, endLine: l.range.endLineNumber, endColumn: l.range.endColumn });
  if (locs.length === 1) return go(locs[0]);
  quickPick({
    placeholder: `Choose ${title}`,
    items: locs.map((l) => {
      const text = monaco.editor.getModel(l.uri)?.getLineContent(l.range.startLineNumber).trim() ?? "";
      return { label: text || rel(l.uri.fsPath), description: `${rel(l.uri.fsPath)}:${l.range.startLineNumber}`, icon: "symbol-class", data: l };
    }),
    onAccept: (item) => item && go(item.data as monaco.languages.Location),
  });
}

/// Uses textDocument/implementation when the server has it; ruby-lsp doesn't, so classes and modules fall back
/// to the type hierarchy (subclasses and including modules).
export async function goToImplementation() {
  const model = editor.getModel();
  const pos = editor.getPosition();
  if (!model || !pos || !live(model)) return toast("Go to Implementation needs Ruby LSP on a Ruby file.");
  if (capabilities.implementationProvider) {
    return jumpOrPick("Implementations", await locations(await request("textDocument/implementation", docPos(model, pos)).catch(() => null)));
  }
  if (!capabilities.typeHierarchyProvider) return toast("The language server does not provide implementations.");
  const items: Json[] = (await request("textDocument/prepareTypeHierarchy", docPos(model, pos)).catch(() => null)) ?? [];
  if (!items.length) return toast("Place the caret on a class or module to find its implementations.");
  const subs: Json[] = (await Promise.all(items.map((item) => request("typeHierarchy/subtypes", { item }).catch(() => null)))).flat().filter(Boolean);
  jumpOrPick("Implementations", await locations(subs.map((s) => ({ uri: s.uri, range: s.selectionRange ?? s.range }))));
}

export async function goToTypeDefinition() {
  const model = editor.getModel();
  const pos = editor.getPosition();
  if (!model || !pos || !live(model)) return toast("Go to Type Declaration needs Ruby LSP on a Ruby file.");
  if (!capabilities.typeDefinitionProvider)
    return toast("The language server does not provide type declarations. ruby-lsp has none; a typed server such as Sorbet (set ruby.lspCommand) does.");
  jumpOrPick("Type Declarations", await locations(await request("textDocument/typeDefinition", docPos(model, pos)).catch(() => null)));
}

/// Semantic highlighting and inlay hints

let featureSubs: monaco.IDisposable[] = [];
function changeEvent() {
  const fns = new Set<() => void>();
  return {
    event: (fn: () => void) => (fns.add(fn), { dispose: () => void fns.delete(fn) }),
    fire: () => fns.forEach((fn) => fn()),
  };
}
const semanticChanged = changeEvent();
const inlayChanged = changeEvent();
const tokenCache = new Map<string, { resultId?: string; data: number[] }>();

function registerFeatureProviders() {
  featureSubs.forEach((d) => d.dispose());
  featureSubs = [];
  tokenCache.clear();
  const st = capabilities.semanticTokensProvider;
  for (const lang of LANGS) {
    if (st?.legend && st.full) {
      featureSubs.push(
        monaco.languages.registerDocumentSemanticTokensProvider(lang, {
          onDidChange: semanticChanged.event,
          getLegend: () => st.legend,
          async provideDocumentSemanticTokens(model, lastResultId, token) {
            if (!live(model) || !setting("editor.semanticHighlighting")) return null;
            const key = model.uri.toString();
            const prev = tokenCache.get(key);
            const delta = !!st.full.delta && !!prev?.resultId && prev.resultId === lastResultId;
            const res = await request(
              delta ? "textDocument/semanticTokens/full/delta" : "textDocument/semanticTokens/full",
              delta ? { textDocument: docId(model), previousResultId: prev!.resultId } : { textDocument: docId(model) },
              token,
            ).catch(() => null);
            if (!res) return null;
            const data: number[] = res.edits ? applyTokenEdits(prev!.data, res.edits) : (res.data ?? []);
            tokenCache.set(key, { resultId: res.resultId, data });
            return { resultId: res.resultId, data: new Uint32Array(data) };
          },
          releaseDocumentSemanticTokens() {},
        }),
      );
    }
    if (capabilities.inlayHintProvider) {
      featureSubs.push(
        monaco.languages.registerInlayHintsProvider(lang, {
          onDidChangeInlayHints: inlayChanged.event,
          async provideInlayHints(model, range, token) {
            const none = { hints: [], dispose() {} };
            if (!live(model) || !setting("editor.inlayHints")) return none;
            const res: Json[] | null = await request("textDocument/inlayHint", { textDocument: docId(model), range: lspRange(range) }, token).catch(() => null);
            const text = (t: Json) => (typeof t === "string" ? t : t?.value);
            return {
              hints: (res ?? []).map((hint) => ({
                position: { lineNumber: hint.position.line + 1, column: hint.position.character + 1 },
                label: typeof hint.label === "string" ? hint.label : hint.label.map((p: Json) => ({ label: p.value, tooltip: text(p.tooltip) })),
                kind: hint.kind,
                tooltip: text(hint.tooltip),
                paddingLeft: hint.paddingLeft,
                paddingRight: hint.paddingRight,
              })),
              dispose() {},
            };
          },
        }),
      );
    }
  }
}

onSettingsChange(() => {
  semanticChanged.fire();
  inlayChanged.fire();
});

events.modelClosed.on((model) => tokenCache.delete(model.uri.toString()));

/// Problems tool window

const problemsBody = h("div", { class: "problems" });
export const problemsView = h("div", { class: "problems-view" }, problemsBody);
const problemsStatus = statusSlot("problems", "left", () => bottom.show("problems"));

function renderProblems() {
  const markers = monaco.editor.getModelMarkers({}).filter((m) => m.resource.scheme === "file");
  const errors = markers.filter((m) => m.severity === monaco.MarkerSeverity.Error).length;
  const warnings = markers.filter((m) => m.severity === monaco.MarkerSeverity.Warning).length;
  problemsStatus.replaceChildren(icon("error"), ` ${errors}  `, icon("warning"), ` ${warnings}`);
  const byFile = new Map<string, monaco.editor.IMarker[]>();
  for (const m of markers) byFile.set(m.resource.fsPath, [...(byFile.get(m.resource.fsPath) ?? []), m]);
  if (!byFile.size) return problemsBody.replaceChildren(h("div", { class: "empty" }, "No problems in open files."));
  problemsBody.replaceChildren(
    ...[...byFile].map(([path, list]) =>
      h(
        "div",
        { class: "result-group" },
        h("div", { class: "result-file" }, icon("file"), h("span", { class: "result-name" }, rel(path)), h("span", { class: "badge" }, String(list.length))),
        ...list
          .sort((a, b) => a.startLineNumber - b.startLineNumber)
          .map((m) =>
            h(
              "div",
              { class: "result-line", onclick: () => openFile(path, { line: m.startLineNumber, column: m.startColumn, endLine: m.endLineNumber, endColumn: m.endColumn }) },
              icon(m.severity === monaco.MarkerSeverity.Error ? "error" : m.severity === monaco.MarkerSeverity.Warning ? "warning" : "info"),
              h("span", { class: "line-text" }, m.message),
              h("span", { class: "dim" }, `${m.source ?? ""}${m.code ? ` ${typeof m.code === "string" ? m.code : m.code.value}` : ""} [${m.startLineNumber}:${m.startColumn}]`),
            ),
          ),
      ),
    ),
  );
}

monaco.editor.onDidChangeMarkers(debounce(renderProblems, 100));
renderProblems();
setStatus("Ruby LSP: off", "off");

export const lspCapabilities = () => capabilities;
export const lspReady = () => ready && !!capabilities.textDocumentSync;
export const lspActiveForTab = () => {
  const t = activeTab();
  return !!t && live(t.model);
};
