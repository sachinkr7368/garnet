import { activeTab, editor, events, monaco, openFile } from "./editor";
import { api, Channel, invoke, type RpcEvent } from "./ipc";
import { dapBreakpoints, describe, deserialize, interpolate, passCountReached, serialize, trackLines, type Breakpoint, type BreakpointMap } from "./bpmodel";
import { isRunGlyph, launch, type RunConfig } from "./run";
import { SessionList } from "./sessionlist";
import { onSettingsChange, setting } from "./settings";
import { abs, debounce, rel, root, state } from "./state";
import type { PtyTabs } from "./terminal";
import { bottom, contextMenu, h, icon, iconButton, inputBox, quickPick, toast } from "./ui";

type Json = any;
type RunItem = PtyTabs["items"][number];

let breakpoints: BreakpointMap = new Map();
const watches: string[] = [];
const enabledFilters = new Set<string>();
let exceptionFilters: { filter: string; label: string }[] = [
  { filter: "any", label: "rescue any exception" },
  { filter: "RuntimeError", label: "rescue RuntimeError" },
];
const lineDecor = editor.createDecorationsCollection();
const inlineDecor = editor.createDecorationsCollection();

interface Session {
  id: number | null;
  name: string;
  seq: number;
  pending: Map<number, (body: Json) => void>;
  threadId: number;
  threads: Json[];
  frames: Json[];
  entryHandled: boolean;
  frame: Json | null;
  paused: boolean;
  status: string;
  console: string[];
  hits: Map<Breakpoint, number>;
  cfg?: RunConfig;
  item?: RunItem;
  target: string;
  localfsMap?: string;
  ended: boolean;
}
const sessions = new SessionList<Session>();
const sel = () => sessions.selected;

export const sessionFor = (item: RunItem) => sessions.items.find((s) => s.item === item && !s.ended) ?? null;

/// Panel

const sessionsEl = h("div", { class: "debug-sessions" });
const threadSelect = h("select", { class: "run-select thread-select", title: "Thread" });
const framesEl = h("div", { class: "frames" });
const varsEl = h("div", { class: "variables" });
const watchesEl = h("div", { class: "variables" });
const watchInput = h("input", { class: "search-input watch-input", placeholder: "Add watch expression (Enter)", spellcheck: false });
const consoleEl = h("pre", { class: "debug-console" });
const evalInput = h("input", { class: "search-input", placeholder: "Evaluate in the paused frame (Enter)", spellcheck: false });
const IDLE = "Not debugging. Pick a configuration and press Debug, or Alt+click a test's run icon.";
const statusEl = h("span", { class: "search-summary" }, IDLE);
const filtersEl = h("span", { class: "exc-filters" });

export const debugView = h(
  "div",
  { class: "debug-view" },
  sessionsEl,
  h(
    "div",
    { class: "search-bar" },
    iconButton("debug-continue", "Resume (F9)", () => resume()),
    iconButton("debug-pause", "Pause", () => {
      const s = sel();
      if (s && !s.paused) request(s, "pause", { threadId: s.threadId });
    }),
    iconButton("debug-step-over", "Step Over (F8)", () => step("next")),
    iconButton("debug-step-into", "Step Into (F7)", () => step("stepIn")),
    iconButton("debug-step-out", "Step Out (⇧F8)", () => step("stepOut")),
    iconButton("debug-restart", "Restart (⌘⇧F5)", () => restartDebug()),
    iconButton("debug-stop", "Stop (⌘F2)", () => stopDebug()),
    h("span", { class: "debug-toolbar-sep" }),
    iconButton("debug-breakpoint-log-unverified", "View Breakpoints (⌘⇧F8)", () => viewBreakpoints()),
    filtersEl,
    statusEl,
  ),
  h(
    "div",
    { class: "debug-panes" },
    h("div", { class: "debug-pane" }, h("div", { class: "pane-title" }, "Frames ", threadSelect), framesEl),
    h("div", { class: "debug-pane" }, h("div", { class: "pane-title" }, "Variables"), varsEl, h("div", { class: "pane-title" }, "Watches"), watchesEl, watchInput),
    h("div", { class: "debug-pane wide" }, h("div", { class: "pane-title" }, "Console"), consoleEl, evalInput),
  ),
);

threadSelect.onchange = async () => {
  const s = sel();
  if (!s?.paused) return;
  s.threadId = Number(threadSelect.value);
  await loadFrames(s);
};

function renderSessions() {
  const list = sessions.items;
  sessionsEl.hidden = list.length < 2 && !list.some((s) => s.ended);
  sessionsEl.replaceChildren(
    ...list.map((s) =>
      h(
        "div",
        { class: `debug-session${s === sel() ? " active" : ""}${s.ended ? " ended" : ""}`, title: s.status, onmousedown: (e: MouseEvent) => e.button === 0 && selectSession(s) },
        icon(s.ended ? "debug-disconnect" : s.paused ? "debug-pause" : "debug-start", s.paused ? "paused" : ""),
        h("span", {}, s.name),
        h("button", {
          class: "tab-close",
          title: s.ended ? "Close" : "Stop",
          onmousedown: (e: MouseEvent) => e.stopPropagation(),
          onclick: () => (s.ended ? (sessions.remove(s), renderAll()) : stopSession(s)),
        }, icon(s.ended ? "close" : "debug-stop")),
      ),
    ),
  );
}

function setStatus(s: Session, text: string) {
  s.status = text;
  if (s === sel()) statusEl.textContent = list().length > 1 ? `${s.name}: ${text}` : text;
  renderSessions();
}
const list = () => sessions.items;

/// Re-renders every session-dependent pane for the selected session.
function renderAll() {
  const s = sel();
  renderSessions();
  statusEl.textContent = s ? (list().length > 1 ? `${s.name}: ${s.status}` : s.status) : IDLE;
  consoleEl.replaceChildren(s?.console.join("") ?? "");
  consoleEl.scrollTop = consoleEl.scrollHeight;
  renderThreads(s);
  renderFrames(s);
  varsEl.replaceChildren();
  inlineDecor.clear();
  renderCurrentLine();
  refreshWatches();
  if (s?.frame) selectFrame(s, s.frame, s.frames.indexOf(s.frame), false);
}

function selectSession(s: Session) {
  if (sel() === s) return;
  sessions.select(s);
  renderAll();
}

function renderFilters() {
  filtersEl.replaceChildren(
    ...exceptionFilters.map((f) => {
      const box = h("input", { type: "checkbox", checked: enabledFilters.has(f.filter) });
      box.onchange = () => setExceptionFilter(f.filter, box.checked);
      return h("label", { class: "exc-filter", title: "Pause when an exception is raised" }, box, `Break on ${f.label.replace(/^rescue /, "")}`);
    }),
  );
}

function setExceptionFilter(filter: string, on: boolean) {
  if (on) enabledFilters.add(filter);
  else enabledFilters.delete(filter);
  renderFilters();
  for (const s of sessions.live()) sendExceptionFilters(s);
}

renderFilters();
onSettingsChange(() => {
  enabledFilters.clear();
  const def = setting<string>("debug.breakOnExceptions");
  if (def !== "none") enabledFilters.add(def);
  renderFilters();
});

evalInput.addEventListener("keydown", async (e) => {
  const s = sel();
  if (e.key !== "Enter" || !evalInput.value.trim() || !s) return;
  const expression = evalInput.value;
  evalInput.value = "";
  out(s, `> ${expression}\n`);
  const r = await request(s, "evaluate", { expression, frameId: s.frame?.id, context: "repl" }).catch((err) => ({ result: String(err) }));
  out(s, `${r?.result ?? ""}\n`);
});

watchInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !watchInput.value.trim()) return;
  watches.push(watchInput.value.trim());
  watchInput.value = "";
  refreshWatches();
});

function out(s: Session, text: string) {
  s.console.push(text);
  if (s.console.length > 5000) s.console.splice(0, s.console.length - 5000);
  if (s !== sel()) return;
  consoleEl.append(text);
  while (consoleEl.childNodes.length > 5000) consoleEl.firstChild?.remove();
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

/// Breakpoints: stored per project in Garnet's state dir, tracked by model decorations while files are open.

const fileModel = (path: string) => monaco.editor.getModel(monaco.Uri.file(path));

function glyph(bp: Breakpoint): monaco.editor.IModelDecorationOptions {
  const kind = bp.logMessage ? "-log" : bp.condition || bp.hitCount ? "-conditional" : "";
  const name = bp.enabled ? (kind ? `debug-breakpoint${kind}` : "circle-filled") : `debug-breakpoint${kind}-disabled`;
  const hover = [bp.logMessage ? `Logpoint: ${bp.logMessage}` : "Breakpoint", describe(bp), "right-click to edit, ⌘⇧F8 for all"].filter(Boolean).join(" · ");
  return {
    glyphMarginClassName: `codicon codicon-${name} glyph-bp${bp.logMessage ? " logpoint" : ""}${bp.enabled ? "" : " disabled"}`,
    glyphMarginHoverMessage: { value: hover },
    stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
  };
}

/// (Re)creates the tracking decorations of a file's breakpoints on its model, if the file is open.
function decorate(path: string) {
  const model = fileModel(path);
  if (!model) return;
  const bps = breakpoints.get(path) ?? [];
  const old = [...(decorationIds.get(model) ?? [])];
  const ids = model.deltaDecorations(
    old,
    bps.map((bp) => {
      const line = Math.min(bp.line, model.getLineCount());
      return { range: new monaco.Range(line, 1, line, model.getLineMaxColumn(line)), options: glyph(bp) };
    }),
  );
  decorationIds.set(model, ids);
  bps.forEach((bp, i) => (bp.decorationId = ids[i]));
}
const decorationIds = new WeakMap<monaco.editor.ITextModel, string[]>();

function watchModel(model: monaco.editor.ITextModel) {
  if (model.uri.scheme !== "file") return;
  const path = model.uri.fsPath;
  decorate(path);
  model.onDidChangeContent((e) => {
    const bps = breakpoints.get(path);
    if (!bps?.length) return;
    if (e.isFlush) return decorate(path);
    const lines = bps.map((bp) => (bp.decorationId ? (model.getDecorationRange(bp.decorationId)?.startLineNumber ?? null) : bp.line));
    const { bps: next, changed } = trackLines(bps, lines);
    if (!changed) return;
    const dropped = next.length !== bps.length;
    breakpoints.set(path, next);
    if (dropped) decorate(path);
    breakpointsChanged(path);
  });
  model.onWillDispose(() => breakpoints.get(path)?.forEach((bp) => (bp.decorationId = undefined)));
}
monaco.editor.onDidCreateModel(watchModel);
monaco.editor.getModels().forEach(watchModel);

const resendSoon = new Map<string, () => void>();
/// Persists and pushes a file's breakpoints to every live session.
function breakpointsChanged(path: string) {
  persistSoon();
  let fn = resendSoon.get(path);
  if (!fn) {
    fn = debounce(() => sessions.live().forEach((s) => sendBreakpoints(s, path)), 250);
    resendSoon.set(path, fn);
  }
  fn();
  bpListeners.forEach((l) => l());
}
const bpListeners = new Set<() => void>();

function setBreakpoint(path: string, line: number, bp: Omit<Breakpoint, "line"> | null) {
  const bps = (breakpoints.get(path) ?? []).filter((b) => b.line !== line);
  if (bp) bps.push({ ...bp, line, decorationId: undefined });
  bps.sort((a, b) => a.line - b.line);
  if (bps.length) breakpoints.set(path, bps);
  else breakpoints.delete(path);
  decorate(path);
  breakpointsChanged(path);
}

const findBp = (path: string, line: number) => breakpoints.get(path)?.find((b) => b.line === line);

export function toggleBreakpoint(line = editor.getPosition()?.lineNumber) {
  const t = activeTab();
  if (!t || !line) return;
  setBreakpoint(t.path, line, findBp(t.path, line) ? null : { enabled: true });
}

export function toggleBreakpointEnabled(line = editor.getPosition()?.lineNumber) {
  const t = activeTab();
  const bp = t && line ? findBp(t.path, line) : undefined;
  if (!t || !bp) return toast("No breakpoint on this line.");
  setBreakpoint(t.path, bp.line, { ...bp, enabled: !bp.enabled });
}

async function editBreakpoint(path: string, line: number, kind: "condition" | "logMessage" | "hitCount") {
  const bp = findBp(path, line) ?? { line, enabled: true };
  const prompt = {
    condition: `Break at line ${line} only when this Ruby expression is truthy`,
    logMessage: `Log message for line ${line}; use {expr} to interpolate, e.g. user id={user.id}`,
    hitCount: `Pass count for line ${line}: pause from the Nth hit on (empty = every hit)`,
  }[kind];
  const value = await inputBox(prompt, String(bp[kind] ?? ""));
  if (value === null) return;
  const v = value.trim();
  if (kind === "hitCount" && v && !(Number.isInteger(Number(v)) && Number(v) > 0)) return toast("Pass count must be a positive whole number.", "error");
  setBreakpoint(path, line, { ...bp, [kind]: kind === "hitCount" ? (Number(v) > 1 ? Number(v) : undefined) : v || undefined });
}

editor.onMouseDown((e) => {
  if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || e.event.rightButton) return;
  const line = e.target.position?.lineNumber;
  if (line && !isRunGlyph(line)) toggleBreakpoint(line);
});

editor.onContextMenu((e) => {
  if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
  const line = e.target.position?.lineNumber;
  const t = activeTab();
  if (!line || !t) return;
  const bp = findBp(t.path, line);
  contextMenu(e.event.browserEvent, [
    { label: bp ? "Remove breakpoint" : "Add breakpoint", run: () => toggleBreakpoint(line) },
    ...(bp ? [{ label: bp.enabled ? "Disable breakpoint" : "Enable breakpoint", run: () => setBreakpoint(t.path, line, { ...bp, enabled: !bp.enabled }) }] : []),
    { label: "Edit condition…", run: () => editBreakpoint(t.path, line, "condition") },
    { label: "Make logpoint…", run: () => editBreakpoint(t.path, line, "logMessage") },
    { label: "Pass count…", run: () => editBreakpoint(t.path, line, "hitCount") },
    { label: "More (⌘⇧F8)…", run: () => viewBreakpoints(t.path, line) },
    null,
    { label: "Remove all breakpoints in file", run: () => removeBreakpoints(t.path) },
  ]);
});

function removeBreakpoints(path?: string) {
  const paths = path ? [path] : [...breakpoints.keys()];
  for (const p of paths) {
    breakpoints.delete(p);
    decorate(p);
    breakpointsChanged(p);
  }
}

events.activated.on(() => renderCurrentLine());

/// Persistence (`breakpoints.json` in Garnet's config dir, keyed by canonical project root)

let projectKey: string | null = null;
let loadedFor: string | null = null;

async function readStore(): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse((await api.configRead("breakpoints.json")) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

let saving: Promise<void> = Promise.resolve();
async function persist() {
  if (!projectKey || loadedFor !== projectKey) return;
  const key = projectKey;
  const files = serialize(breakpoints, rel);
  saving = saving.then(async () => {
    const all = await readStore();
    if (Object.keys(files).length) all[key] = files;
    else delete all[key];
    await api.configWrite("breakpoints.json", JSON.stringify(all, null, 2));
  });
  await saving.catch((e) => toast(`Could not save breakpoints: ${e}`, "error"));
}
const persistSoon = debounce(persist, 300);

/// Restores the project's breakpoints; call when a project opens.
export async function loadBreakpoints() {
  if (!state.project) return;
  const r = root();
  projectKey = await api.canonicalPath(r).catch(() => r);
  for (const p of breakpoints.keys()) {
    breakpoints.set(p, []);
    decorate(p);
  }
  breakpoints = deserialize((await readStore())[projectKey], (p) => abs(p));
  loadedFor = projectKey;
  for (const p of breakpoints.keys()) decorate(p);
  bpListeners.forEach((l) => l());
}

/// Writes pending breakpoint changes now (smoke tests, shutdown).
export async function flushBreakpoints() {
  await persist();
}

window.addEventListener("beforeunload", () => void persist());

/// DAP transport

function request(s: Session, command: string, args: Json = {}): Promise<Json> {
  if (s.ended || s.id === null) return Promise.reject(new Error("No debug session"));
  const seq = ++s.seq;
  invoke("dap_send", { id: s.id, body: JSON.stringify({ seq, type: "request", command, arguments: args }) }).catch(() => {});
  return new Promise((resolve) => s.pending.set(seq, resolve));
}

function sendBreakpoints(s: Session, path: string) {
  // rdbg has no native logpoints or pass counts: Garnet evaluates those on each stop and resumes.
  return request(s, "setBreakpoints", { source: { path, name: rel(path) }, breakpoints: dapBreakpoints(breakpoints.get(path) ?? []) }).catch(() => {});
}

const sendExceptionFilters = (s: Session) => request(s, "setExceptionBreakpoints", { filters: [...enabledFilters] }).catch(() => {});

async function onMessage(s: Session, msg: Json) {
  if (msg.type === "response") {
    const cb = s.pending.get(msg.request_seq);
    s.pending.delete(msg.request_seq);
    if (!msg.success && msg.message) out(s, `[${msg.command}] ${msg.message}\n`);
    cb?.(msg.body);
    return;
  }
  if (msg.type !== "event") return;
  const body = msg.body ?? {};
  switch (msg.event) {
    case "output":
      if (body.category !== "telemetry") out(s, body.output);
      break;
    case "stopped": {
      s.threadId = body.threadId ?? s.threadId;
      if (!s.entryHandled && body.reason === "pause") {
        s.entryHandled = true;
        request(s, "continue", { threadId: s.threadId });
        return;
      }
      s.entryHandled = true;
      if (body.reason === "breakpoint" && (await skipStop(s))) return;
      s.paused = true;
      setStatus(s, `Paused (${body.reason}${body.text && body.reason === "exception" ? `: ${body.text}` : ""})`);
      const focused = sessions.focusOnStop(s);
      if (focused) {
        renderAll();
        bottom.show("debug");
      }
      await loadThreads(s);
      await loadFrames(s);
      smokeHooks.stopped?.(s.name);
      break;
    }
    case "continued":
      clearStopped(s, "Running…");
      break;
    case "terminated":
    case "exited":
      endSession(s, "Debug session ended.");
      break;
  }
}

/// Handles pass counts and logpoints; true when the session was resumed instead of pausing.
async function skipStop(s: Session): Promise<boolean> {
  const f = (await request(s, "stackTrace", { threadId: s.threadId, levels: 1 }))?.stackFrames?.[0];
  const bp = f?.source?.path && findBp(f.source.path, f.line);
  if (!bp) return false;
  const hits = (s.hits.get(bp) ?? 0) + 1;
  s.hits.set(bp, hits);
  bpListeners.forEach((l) => l());
  if (passCountReached(bp, hits) && !bp.logMessage) return false;
  if (bp.logMessage && passCountReached(bp, hits)) {
    const text = await interpolate(bp.logMessage, async (expression) => (await request(s, "evaluate", { expression, frameId: f.id, context: "repl" }))?.result ?? "?");
    out(s, `[logpoint ${rel(f.source.path)}:${f.line}] ${text}\n`);
  }
  await request(s, "continue", { threadId: s.threadId });
  return true;
}

async function loadThreads(s: Session) {
  s.threads = (await request(s, "threads").catch(() => null))?.threads ?? [];
  if (s === sel()) renderThreads(s);
}

function renderThreads(s: Session | null) {
  const threads = s?.paused ? s.threads : [];
  threadSelect.hidden = threads.length < 2;
  threadSelect.replaceChildren(...threads.map((t) => h("option", { value: String(t.id), selected: t.id === s!.threadId }, t.name ?? `Thread ${t.id}`)));
}

async function loadFrames(s: Session) {
  const r = await request(s, "stackTrace", { threadId: s.threadId, levels: 60 });
  s.frames = r?.stackFrames ?? [];
  s.frame = s.frames[0] ?? null;
  if (s !== sel()) return renderSessions();
  renderFrames(s);
  if (s.frame) await selectFrame(s, s.frame, 0);
}

function renderFrames(s: Session | null) {
  const frames = s?.paused ? s.frames : [];
  framesEl.replaceChildren(
    ...frames.map((f, i) =>
      h(
        "div",
        { class: `frame-row${f === s!.frame ? " selected" : ""}`, onclick: () => selectFrame(s!, f, i) },
        h("span", {}, f.name),
        h("span", { class: "dim" }, f.source?.path ? `${rel(f.source.path)}:${f.line}` : ""),
      ),
    ),
  );
}

async function selectFrame(s: Session, frame: Json, index: number, reveal = true) {
  s.frame = frame;
  if (s !== sel()) return;
  framesEl.querySelectorAll(".frame-row").forEach((el, i) => el.classList.toggle("selected", i === index));
  if (reveal && frame.source?.path) await openFile(frame.source.path, { line: frame.line });
  renderCurrentLine();
  const scopes: Json[] = (await request(s, "scopes", { frameId: frame.id }).catch(() => null))?.scopes ?? [];
  if (s !== sel() || s.frame !== frame) return;
  varsEl.replaceChildren(...scopes.map((sc, i) => varNode(s, { name: sc.name, value: "", variablesReference: sc.variablesReference }, 0, i === 0)));
  refreshWatches();
  const locals = scopes.find((sc) => sc.presentationHint === "locals") ?? scopes[0];
  if (locals) {
    const vars: Json[] = (await request(s, "variables", { variablesReference: locals.variablesReference }).catch(() => null))?.variables ?? [];
    if (s === sel() && s.frame === frame) renderInlineValues(frame, vars);
  }
}

async function refreshWatches() {
  const s = sel();
  const rows = await Promise.all(
    watches.map(async (expr, i) => {
      const r = s?.frame ? await request(s, "evaluate", { expression: expr, frameId: s.frame.id, context: "watch" }).catch(() => null) : null;
      return h(
        "div",
        { class: "watch-row" },
        h("span", { class: "var-name" }, expr),
        h("span", { class: "var-value" }, ` = ${r?.result ?? (s?.frame ? "<error>" : "<not paused>")}`),
        h("span", { class: "spacer" }),
        iconButton("close", "Remove watch", () => (watches.splice(i, 1), refreshWatches())),
      );
    }),
  );
  watchesEl.replaceChildren(...rows);
}

function varNode(s: Session, v: Json, depth: number, open = false): HTMLElement {
  const children = h("div", { class: "var-children" });
  const expandable = v.variablesReference > 0;
  const twisty = expandable ? icon("chevron-right", "twisty") : h("span", { class: "twisty" });
  const row = h(
    "div",
    { class: "var-row", style: `padding-left:${depth * 14 + 4}px` },
    twisty,
    h("span", { class: "var-name" }, v.name),
    v.value ? h("span", { class: "var-value" }, ` = ${v.value}`) : null,
    v.type ? h("span", { class: "dim" }, ` ${v.type}`) : null,
  );
  let loaded = false;
  const toggle = async () => {
    if (!expandable) return;
    const opening = children.hidden || !loaded;
    if (opening && !loaded) {
      const r = await request(s, "variables", { variablesReference: v.variablesReference }).catch(() => null);
      children.replaceChildren(...(r?.variables ?? []).map((c: Json) => varNode(s, c, depth + 1)));
      loaded = true;
    }
    children.hidden = !opening;
    twisty.className = `codicon codicon-chevron-${opening ? "down" : "right"} twisty`;
  };
  row.onclick = toggle;
  if (open) toggle();
  return h("div", {}, row, children);
}

/// Shows `name = value` after the nearest line above the stop that mentions each local.
function renderInlineValues(frame: Json, vars: Json[]) {
  const model = editor.getModel();
  if (!model || frame.source?.path !== model.uri.fsPath) return inlineDecor.clear();
  const perLine = new Map<number, string[]>();
  for (const v of vars) {
    if (!/^[a-z_]\w*$/.test(v.name)) continue;
    const re = new RegExp(`\\b${v.name}\\b`);
    for (let l = frame.line; l >= Math.max(1, frame.line - 40); l--) {
      if (re.test(model.getLineContent(l))) {
        perLine.set(l, [...(perLine.get(l) ?? []), `${v.name} = ${String(v.value).slice(0, 60)}`]);
        break;
      }
    }
  }
  inlineDecor.set(
    [...perLine].map(([line, parts]) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: { isWholeLine: true, after: { content: `    ${parts.join(", ")}`, inlineClassName: "inline-value" } },
    })),
  );
}

function renderCurrentLine() {
  const f = sel()?.frame;
  const t = activeTab();
  if (!f || !t || f.source?.path !== t.path) {
    lineDecor.clear();
    return;
  }
  lineDecor.set([
    {
      range: new monaco.Range(f.line, 1, f.line, 1),
      options: { isWholeLine: true, className: "debug-current-line", glyphMarginClassName: "codicon codicon-debug-stackframe glyph-frame" },
    },
  ]);
}

function clearStopped(s: Session, status: string) {
  s.frame = null;
  s.frames = [];
  s.threads = [];
  s.paused = false;
  setStatus(s, status);
  if (s !== sel()) return;
  renderThreads(s);
  framesEl.replaceChildren();
  varsEl.replaceChildren();
  lineDecor.clear();
  inlineDecor.clear();
  refreshWatches();
}

function endSession(s: Session, status: string) {
  if (s.ended) return;
  clearStopped(s, status);
  s.ended = true;
  if (s.id !== null) invoke("dap_disconnect", { id: s.id });
  for (const cb of s.pending.values()) cb(null);
  s.pending.clear();
  const prev = sel();
  if (prev === s) {
    const next = sessions.live().find((x) => x.paused) ?? sessions.live()[0];
    if (next) sessions.select(next);
  }
  renderAll();
  smokeHooks.ended?.(s.name);
}

/// Sessions

export interface SessionOptions {
  target: string;
  cfg?: RunConfig;
  item?: RunItem;
  localfsMap?: string;
  timeoutSecs?: number;
}

export async function debugSession(opts: SessionOptions) {
  for (const old of sessions.items.filter((x) => (opts.item && x.item === opts.item) || x.ended)) {
    if (!old.ended) await stopSession(old, false);
    sessions.remove(old);
  }
  const s = sessions.add({
    id: null,
    name: opts.cfg?.name ?? `Attach ${opts.target}`,
    seq: 0,
    pending: new Map(),
    threadId: 1,
    threads: [],
    frames: [],
    entryHandled: !opts.item,
    frame: null,
    paused: false,
    status: `Connecting to rdbg (${opts.target})…`,
    console: [],
    hits: new Map(),
    cfg: opts.cfg,
    item: opts.item,
    target: opts.target,
    localfsMap: opts.localfsMap,
    ended: false,
  });
  renderAll();
  bottom.show(opts.item ? "run" : "debug");
  const channel = new Channel<RpcEvent>();
  channel.onmessage = (ev) => {
    if (s.ended) return;
    if (ev.type === "message") onMessage(s, JSON.parse(ev.body));
    else if (ev.type === "exit") endSession(s, "Debugger disconnected.");
  };
  try {
    s.id = await invoke<number>("dap_connect", { target: opts.target, timeoutSecs: opts.timeoutSecs ?? 10, onEvent: channel });
  } catch (e) {
    s.ended = true;
    setStatus(s, String(e));
    renderAll();
    return toast(`Debugger did not start: ${e}`, "error");
  }
  if (s.ended) return invoke("dap_disconnect", { id: s.id });
  setStatus(s, "Running…");
  const caps = await request(s, "initialize", { clientID: "garnet", clientName: "Garnet", adapterID: "rdbg", linesStartAt1: true, columnsStartAt1: true, pathFormat: "path" });
  if (caps?.exceptionBreakpointFilters?.length) {
    exceptionFilters = caps.exceptionBreakpointFilters;
    renderFilters();
  }
  await request(s, "attach", opts.localfsMap ? { localfsMap: opts.localfsMap } : { localfs: true });
  await Promise.all([...breakpoints.keys()].map((p) => sendBreakpoints(s, p)));
  if (enabledFilters.size) await sendExceptionFilters(s);
  await request(s, "configurationDone");
  smokeHooks.connected?.(s.name);
}

export async function stopSession(s: Session | null, kill = true) {
  if (!s || s.ended) return;
  await Promise.race([request(s, "disconnect", { terminateDebuggee: kill && !!s.item }).catch(() => {}), new Promise((r) => setTimeout(r, 800))]);
  endSession(s, "Debug session stopped.");
  if (kill) s.item?.view.kill();
}

export const stopDebug = () => stopSession(sel());

export async function restartDebug() {
  const s = sel();
  if (!s) return;
  await stopSession(s);
  if (s.cfg) launch(s.cfg, "debug");
  else debugSession({ target: s.target, localfsMap: s.localfsMap });
}

export async function attachToProcess() {
  if (!state.project) return;
  const target = await inputBox("Attach to rdbg: port, host:port, or socket path (start your app with rdbg --open --port 12345, or RUBY_DEBUG_OPEN=true)", "12345");
  if (!target) return;
  const remote = await inputBox("Remote app root for Docker/remote (e.g. /app); leave empty for a local process", "");
  if (remote === null) return;
  debugSession({ target: target.trim(), localfsMap: remote.trim() ? `${remote.trim()}:${root()}` : undefined, timeoutSecs: 5 });
}

export function resume() {
  const s = sel();
  if (s?.paused) request(s, "continue", { threadId: s.threadId });
}

export function step(kind: "next" | "stepIn" | "stepOut") {
  const s = sel();
  if (s?.paused) request(s, kind, { threadId: s.threadId });
}

/// Hooks for the end-to-end smoke script (src/smoke.ts).
export const smokeHooks: { connected?: (name: string) => void; stopped?: (name: string) => void; ended?: (name: string) => void } = {};
const frameInfo = (s: Session | null) => (s?.frame ? { path: s.frame.source?.path as string, line: s.frame.line as number, name: s.frame.name as string } : null);
export const debugState = () => ({
  paused: !!sel()?.paused,
  frame: frameInfo(sel()),
  variables: varsEl.textContent ?? "",
  inline: inlineDecor.getRanges().length,
});
export const debugSessions = () => sessions.items.map((s) => ({ name: s.name, paused: s.paused, ended: s.ended, frame: frameInfo(s), selected: s === sel() }));
export const selectDebugSession = (name: string) => {
  const s = sessions.items.find((x) => x.name === name);
  if (s) selectSession(s);
};
export const resumeSession = (name: string) => {
  const s = sessions.items.find((x) => x.name === name);
  if (s?.paused) request(s, "continue", { threadId: s.threadId });
};
export const stopAllSessions = () => Promise.all(sessions.live().map((s) => stopSession(s)));
export const breakpointsIn = (path: string) => (breakpoints.get(path) ?? []).map(({ decorationId: _, ...b }) => b);
export const evaluate = (expression: string) => {
  const s = sel();
  return s ? request(s, "evaluate", { expression, frameId: s.frame?.id, context: "repl" }) : Promise.reject(new Error("No debug session"));
};

/// Breakpoints dialog (⌘⇧F8)

const totalHits = (bp: Breakpoint) => sessions.items.reduce((n, s) => n + (s.hits.get(bp) ?? 0), 0);

export function viewBreakpoints(focusPath?: string, focusLine?: number) {
  if (!state.project) return;
  document.querySelector(".bp-backdrop")?.remove();
  let current: { path: string; line: number } | null = focusPath && focusLine ? { path: focusPath, line: focusLine } : null;
  const listEl = h("div", { class: "rc-list" });
  const form = h("div", { class: "rc-form" });

  const all = () => [...breakpoints].sort(([a], [b]) => a.localeCompare(b)).flatMap(([path, bps]) => bps.map((bp) => ({ path, bp })));
  const currentBp = () => (current ? findBp(current.path, current.line) : undefined);
  const update = (patch: Partial<Breakpoint>) => {
    const bp = currentBp();
    if (!bp || !current) return;
    Object.assign(bp, patch);
    decorate(current.path);
    breakpointsChanged(current.path);
  };

  const renderList = () => {
    const rows = all();
    if (!currentBp()) current = rows[0] ? { path: rows[0].path, line: rows[0].bp.line } : null;
    let lastPath = "";
    listEl.replaceChildren(
      ...rows.flatMap(({ path, bp }) => {
        const header = path !== lastPath ? h("div", { class: "bp-file dim" }, icon("file"), ` ${rel(path)}`) : null;
        lastPath = path;
        const box = h("input", { type: "checkbox", checked: bp.enabled, title: "Enabled" });
        box.onclick = (e) => e.stopPropagation();
        box.onchange = () => {
          bp.enabled = box.checked;
          decorate(path);
          breakpointsChanged(path);
        };
        const hits = totalHits(bp);
        const row = h(
          "div",
          {
            class: `rc-item bp-item${current?.path === path && current.line === bp.line ? " selected" : ""}`,
            onclick: () => ((current = { path, line: bp.line }), render()),
            ondblclick: () => (close(), openFile(path, { line: bp.line })),
          },
          h("span", { class: "bp-item-head" }, box, icon(glyph(bp).glyphMarginClassName!.split(" ")[1].replace("codicon-", ""), bp.enabled ? "bp-icon" : "bp-icon disabled"), ` ${rel(path).split("/").pop()}:${bp.line}`),
          h("small", { class: "dim" }, [describe(bp), hits ? `${hits} hit${hits > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ")),
        );
        return header ? [header, row] : [row];
      }),
    );
  };

  const field = (label: string, input: HTMLElement, hint = "") => h("label", { class: "rc-field" }, h("span", {}, label), input, hint ? h("small", { class: "dim" }, hint) : null);

  const renderForm = () => {
    const bp = currentBp();
    const exc = h(
      "div",
      { class: "rc-field" },
      h("span", {}, "Exception breakpoints (all sessions)"),
      ...exceptionFilters.map((f) => {
        const box = h("input", { type: "checkbox", checked: enabledFilters.has(f.filter) });
        box.onchange = () => setExceptionFilter(f.filter, box.checked);
        return h("label", { class: "rc-check" }, box, ` Break on ${f.label.replace(/^rescue /, "")}`);
      }),
    );
    if (!bp || !current) return form.replaceChildren(h("div", { class: "empty" }, "No line breakpoints. Click the gutter or press ⌘F8 to add one."), exc);
    const path = current.path;
    const enabled = h("input", { type: "checkbox", checked: bp.enabled });
    enabled.onchange = () => (update({ enabled: enabled.checked }), renderList());
    const text = (key: "condition" | "logMessage", placeholder: string) => {
      const input = h("input", { class: "search-input", value: bp[key] ?? "", placeholder, spellcheck: false });
      input.oninput = () => (update({ [key]: input.value.trim() || undefined }), renderList());
      return input;
    };
    const suspend = h("input", { type: "checkbox", checked: !bp.logMessage, disabled: !bp.logMessage });
    const pass = h("input", { class: "search-input", type: "number", min: 1, value: bp.hitCount ? String(bp.hitCount) : "", placeholder: "every hit" });
    pass.oninput = () => {
      const n = Number(pass.value);
      update({ hitCount: Number.isInteger(n) && n > 1 ? n : undefined });
      renderList();
    };
    const hits = totalHits(bp);
    form.replaceChildren(
      h("div", { class: "bp-title" }, h("a", { href: "#", onclick: (e: MouseEvent) => (e.preventDefault(), close(), openFile(path, { line: bp.line })) }, `${rel(path)}:${bp.line}`), h("span", { class: "dim" }, hits ? `  hit ${hits} time${hits > 1 ? "s" : ""} in this window's debug sessions` : "  not hit yet")),
      h("label", { class: "rc-check" }, enabled, " Enabled"),
      field("Condition", text("condition", "e.g. user.admin?"), "Ruby expression; pauses only when truthy (evaluated by rdbg)"),
      field("Log message (logpoint)", text("logMessage", "e.g. user id={user.id}"), "when set, Garnet logs the message to the debug console and resumes; {expr} is evaluated in the frame"),
      h("label", { class: "rc-check", title: "Clear the log message to pause again" }, suspend, " Suspend execution"),
      field("Pass count", pass, "pause only from the Nth hit on; counted per debug session"),
      h(
        "div",
        { class: "rc-check" },
        h("button", { class: "btn", onclick: () => (setBreakpoint(path, bp.line, null), render()) }, "Remove"),
        h("button", { class: "btn", onclick: () => (removeBreakpoints(), render()) }, "Remove All"),
      ),
      exc,
    );
  };

  const render = () => {
    renderList();
    renderForm();
  };
  const listener = () => backdrop.isConnected && renderList();
  bpListeners.add(listener);
  const close = () => {
    bpListeners.delete(listener);
    backdrop.remove();
  };
  const dialog = h(
    "div",
    { class: "rc-dialog" },
    h("div", { class: "rc-title" }, icon("debug-breakpoint-log-unverified"), " Breakpoints", h("span", { class: "spacer" }), h("small", { class: "dim" }, "saved in Garnet's settings, not in the project")),
    h("div", { class: "rc-body" }, h("div", { class: "rc-side bp-side" }, listEl), form),
    h("div", { class: "rc-actions" }, h("button", { class: "btn primary", onclick: () => close() }, "Done")),
  );
  const backdrop = h("div", { class: "qp-backdrop bp-backdrop", onmousedown: (e: MouseEvent) => e.target === backdrop && close() }, dialog);
  backdrop.addEventListener("keydown", (e) => e.key === "Escape" && close());
  document.getElementById("overlay-root")!.append(backdrop);
  render();
}

/// Quick list for jumping (kept for the palette: "Debug: Go to Breakpoint…").
export function gotoBreakpoint() {
  const items = [...breakpoints].flatMap(([path, bps]) =>
    bps.map((bp) => ({ label: `${rel(path)}:${bp.line}`, description: describe(bp), icon: bp.logMessage ? "debug-breakpoint-log" : bp.condition ? "debug-breakpoint-conditional" : "circle-filled", data: { path, line: bp.line } })),
  );
  if (!items.length) return toast("No breakpoints. Click the gutter or press ⌘F8 to add one.");
  quickPick({
    placeholder: "Go to breakpoint",
    items,
    onAccept: (item) => {
      const d = item?.data as { path: string; line: number } | undefined;
      if (d) openFile(d.path, { line: d.line });
    },
  });
}

export function evaluateSelection() {
  bottom.show("debug");
  const model = editor.getModel();
  const sel = editor.getSelection();
  const text = model && sel && !sel.isEmpty() ? model.getValueInRange(sel) : model && sel ? (model.getWordAtPosition(sel.getPosition())?.word ?? "") : "";
  evalInput.value = text;
  evalInput.focus();
  evalInput.select();
}
