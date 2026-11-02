import { activeTab, editor, events, monaco, openFile } from "./editor";
import { Channel, invoke, type RpcEvent } from "./ipc";
import { isRunGlyph, launch, type RunConfig } from "./run";
import { onSettingsChange, setting } from "./settings";
import { rel, root, state } from "./state";
import type { PtyTabs } from "./terminal";
import { bottom, contextMenu, h, icon, iconButton, inputBox, quickPick, toast } from "./ui";

type Json = any;
type RunItem = PtyTabs["items"][number];

interface Breakpoint {
  condition?: string;
  logMessage?: string;
}

const breakpoints = new Map<string, Map<number, Breakpoint>>();
const watches: string[] = [];
const enabledFilters = new Set<string>();
let exceptionFilters: { filter: string; label: string }[] = [
  { filter: "any", label: "rescue any exception" },
  { filter: "RuntimeError", label: "rescue RuntimeError" },
];
const bpDecor = editor.createDecorationsCollection();
const lineDecor = editor.createDecorationsCollection();
const inlineDecor = editor.createDecorationsCollection();

interface Session {
  seq: number;
  pending: Map<number, (body: Json) => void>;
  threadId: number;
  entryHandled: boolean;
  frame: Json | null;
  cfg?: RunConfig;
  item?: RunItem;
  target: string;
  localfsMap?: string;
  ended: boolean;
}
let session: Session | null = null;

export const sessionFor = (item: RunItem) => (session?.item === item ? session : null);

/// Panel

const framesEl = h("div", { class: "frames" });
const varsEl = h("div", { class: "variables" });
const watchesEl = h("div", { class: "variables" });
const watchInput = h("input", { class: "search-input watch-input", placeholder: "Add watch expression (Enter)", spellcheck: false });
const consoleEl = h("pre", { class: "debug-console" });
const evalInput = h("input", { class: "search-input", placeholder: "Evaluate in the paused frame (Enter)", spellcheck: false });
const statusEl = h("span", { class: "search-summary" }, "Not debugging. Pick a configuration and press Debug, or Alt+click a test's run icon.");
const filtersEl = h("span", { class: "exc-filters" });

export const debugView = h(
  "div",
  { class: "debug-view" },
  h(
    "div",
    { class: "search-bar" },
    iconButton("debug-continue", "Resume (F9)", () => resume()),
    iconButton("debug-pause", "Pause", () => session && request("pause", { threadId: session.threadId })),
    iconButton("debug-step-over", "Step Over (F8)", () => step("next")),
    iconButton("debug-step-into", "Step Into (F7)", () => step("stepIn")),
    iconButton("debug-step-out", "Step Out (⇧F8)", () => step("stepOut")),
    iconButton("debug-restart", "Restart (⌘⇧F5)", () => restartDebug()),
    iconButton("debug-stop", "Stop (⌘F2)", () => stopDebug()),
    h("span", { class: "debug-toolbar-sep" }),
    filtersEl,
    statusEl,
  ),
  h(
    "div",
    { class: "debug-panes" },
    h("div", { class: "debug-pane" }, h("div", { class: "pane-title" }, "Frames"), framesEl),
    h("div", { class: "debug-pane" }, h("div", { class: "pane-title" }, "Variables"), varsEl, h("div", { class: "pane-title" }, "Watches"), watchesEl, watchInput),
    h("div", { class: "debug-pane wide" }, h("div", { class: "pane-title" }, "Console"), consoleEl, evalInput),
  ),
);

function renderFilters() {
  filtersEl.replaceChildren(
    ...exceptionFilters.map((f) => {
      const box = h("input", { type: "checkbox", checked: enabledFilters.has(f.filter) });
      box.onchange = () => {
        if (box.checked) enabledFilters.add(f.filter);
        else enabledFilters.delete(f.filter);
        if (session) sendExceptionFilters();
      };
      return h("label", { class: "exc-filter", title: "Pause when an exception is raised" }, box, `Break on ${f.label.replace(/^rescue /, "")}`);
    }),
  );
}
renderFilters();
onSettingsChange(() => {
  enabledFilters.clear();
  const def = setting<string>("debug.breakOnExceptions");
  if (def !== "none") enabledFilters.add(def);
  renderFilters();
});

evalInput.addEventListener("keydown", async (e) => {
  if (e.key !== "Enter" || !evalInput.value.trim()) return;
  const expression = evalInput.value;
  evalInput.value = "";
  out(`> ${expression}\n`);
  const r = await request("evaluate", { expression, frameId: session?.frame?.id, context: "repl" }).catch((err) => ({ result: String(err) }));
  out(`${r?.result ?? ""}\n`);
});

watchInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !watchInput.value.trim()) return;
  watches.push(watchInput.value.trim());
  watchInput.value = "";
  refreshWatches();
});

function out(text: string) {
  consoleEl.append(text);
  while (consoleEl.childNodes.length > 5000) consoleEl.firstChild?.remove();
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

/// Breakpoints

function renderBreakpoints() {
  const t = activeTab();
  const lines = t ? [...(breakpoints.get(t.path) ?? new Map<number, Breakpoint>())] : [];
  bpDecor.set(
    lines.map(([line, bp]) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        glyphMarginClassName: bp.logMessage
          ? "codicon codicon-debug-breakpoint-log glyph-bp logpoint"
          : bp.condition
            ? "codicon codicon-debug-breakpoint-conditional glyph-bp conditional"
            : "codicon codicon-circle-filled glyph-bp",
        glyphMarginHoverMessage: { value: bp.logMessage ? `Logpoint: ${bp.logMessage}` : bp.condition ? `Breakpoint if ${bp.condition}` : "Breakpoint (right-click to edit)" },
      },
    })),
  );
}

function setBreakpoint(path: string, line: number, bp: Breakpoint | null) {
  const map = breakpoints.get(path) ?? new Map<number, Breakpoint>();
  if (bp) map.set(line, bp);
  else map.delete(line);
  breakpoints.set(path, map);
  renderBreakpoints();
  if (session && !session.ended) sendBreakpoints(path);
}

export function toggleBreakpoint(line = editor.getPosition()?.lineNumber) {
  const t = activeTab();
  if (!t || !line) return;
  setBreakpoint(t.path, line, breakpoints.get(t.path)?.has(line) ? null : {});
}

async function editBreakpoint(path: string, line: number, kind: "condition" | "logMessage") {
  const bp = breakpoints.get(path)?.get(line) ?? {};
  const value = await inputBox(
    kind === "condition" ? `Break at line ${line} only when this Ruby expression is truthy` : `Log message for line ${line}; use {expr} to interpolate, e.g. user id={user.id}`,
    bp[kind] ?? "",
  );
  if (value === null) return;
  setBreakpoint(path, line, { ...bp, [kind]: value.trim() || undefined });
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
  const has = breakpoints.get(t.path)?.has(line);
  contextMenu(e.event.browserEvent, [
    { label: has ? "Remove breakpoint" : "Add breakpoint", run: () => toggleBreakpoint(line) },
    { label: "Edit condition…", run: () => editBreakpoint(t.path, line, "condition") },
    { label: "Make logpoint…", run: () => editBreakpoint(t.path, line, "logMessage") },
    null,
    { label: "Remove all breakpoints in file", run: () => (breakpoints.delete(t.path), renderBreakpoints(), session && sendBreakpoints(t.path)) },
  ]);
});

events.activated.on(() => {
  renderBreakpoints();
  renderCurrentLine();
});

// ponytail: breakpoint lines don't follow edits above them; re-toggle after inserting lines.

/// DAP transport

function send(msg: Json) {
  invoke("dap_send", { body: JSON.stringify(msg) }).catch(() => {});
}

function request(command: string, args: Json = {}): Promise<Json> {
  if (!session || session.ended) return Promise.reject(new Error("No debug session"));
  const s = session;
  const seq = ++s.seq;
  send({ seq, type: "request", command, arguments: args });
  return new Promise((resolve) => s.pending.set(seq, resolve));
}

function sendBreakpoints(path: string) {
  // rdbg has no native logpoints: they are breakpoints Garnet evaluates and resumes.
  return request("setBreakpoints", {
    source: { path, name: rel(path) },
    breakpoints: [...(breakpoints.get(path) ?? new Map<number, Breakpoint>())].map(([line, bp]) => ({ line, condition: bp.condition })),
  });
}

const sendExceptionFilters = () => request("setExceptionBreakpoints", { filters: [...enabledFilters] });

async function onMessage(msg: Json) {
  const s = session;
  if (!s) return;
  if (msg.type === "response") {
    const cb = s.pending.get(msg.request_seq);
    s.pending.delete(msg.request_seq);
    if (!msg.success && msg.message) out(`[${msg.command}] ${msg.message}\n`);
    cb?.(msg.body);
    return;
  }
  if (msg.type !== "event") return;
  const body = msg.body ?? {};
  switch (msg.event) {
    case "output":
      if (body.category !== "telemetry") out(body.output);
      break;
    case "stopped":
      s.threadId = body.threadId ?? s.threadId;
      if (!s.entryHandled && body.reason === "pause") {
        s.entryHandled = true;
        request("continue", { threadId: s.threadId });
        return;
      }
      s.entryHandled = true;
      if (body.reason === "breakpoint" && (await handleLogpoint())) return;
      statusEl.textContent = `Paused (${body.reason}${body.text && body.reason === "exception" ? `: ${body.text}` : ""})`;
      bottom.show("debug");
      await loadFrames();
      break;
    case "continued":
      clearStopped("Running…");
      break;
    case "terminated":
    case "exited":
      endSession("Debug session ended.");
      break;
  }
}

async function topFrame(): Promise<Json | null> {
  const r = await request("stackTrace", { threadId: session!.threadId, levels: 1 });
  return r?.stackFrames?.[0] ?? null;
}

async function handleLogpoint(): Promise<boolean> {
  const f = await topFrame();
  const bp = f?.source?.path && breakpoints.get(f.source.path)?.get(f.line);
  if (!bp?.logMessage) return false;
  let text = bp.logMessage;
  for (const m of [...bp.logMessage.matchAll(/\{([^}]+)\}/g)]) {
    const r = await request("evaluate", { expression: m[1], frameId: f.id, context: "repl" }).catch(() => null);
    text = text.replace(m[0], r?.result ?? "?");
  }
  out(`[logpoint ${rel(f.source.path)}:${f.line}] ${text}\n`);
  await request("continue", { threadId: session!.threadId });
  return true;
}

async function loadFrames() {
  const r = await request("stackTrace", { threadId: session!.threadId, levels: 60 });
  const frames: Json[] = r?.stackFrames ?? [];
  framesEl.replaceChildren(
    ...frames.map((f, i) =>
      h(
        "div",
        { class: "frame-row", onclick: () => selectFrame(f, i) },
        h("span", {}, f.name),
        h("span", { class: "dim" }, f.source?.path ? `${rel(f.source.path)}:${f.line}` : ""),
      ),
    ),
  );
  if (frames.length) await selectFrame(frames[0], 0);
}

async function selectFrame(frame: Json, index: number) {
  if (!session) return;
  session.frame = frame;
  framesEl.querySelectorAll(".frame-row").forEach((el, i) => el.classList.toggle("selected", i === index));
  if (frame.source?.path) await openFile(frame.source.path, { line: frame.line });
  renderCurrentLine();
  const scopes: Json[] = (await request("scopes", { frameId: frame.id }))?.scopes ?? [];
  varsEl.replaceChildren(...scopes.map((s, i) => varNode({ name: s.name, value: "", variablesReference: s.variablesReference }, 0, i === 0)));
  refreshWatches();
  const locals = scopes.find((s) => s.presentationHint === "locals") ?? scopes[0];
  if (locals) {
    const vars: Json[] = (await request("variables", { variablesReference: locals.variablesReference }))?.variables ?? [];
    renderInlineValues(frame, vars);
  }
}

async function refreshWatches() {
  const rows = await Promise.all(
    watches.map(async (expr, i) => {
      const r = session?.frame ? await request("evaluate", { expression: expr, frameId: session.frame.id, context: "watch" }).catch(() => null) : null;
      return h(
        "div",
        { class: "watch-row" },
        h("span", { class: "var-name" }, expr),
        h("span", { class: "var-value" }, ` = ${r?.result ?? (session?.frame ? "<error>" : "<not paused>")}`),
        h("span", { class: "spacer" }),
        iconButton("close", "Remove watch", () => (watches.splice(i, 1), refreshWatches())),
      );
    }),
  );
  watchesEl.replaceChildren(...rows);
}

function varNode(v: Json, depth: number, open = false): HTMLElement {
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
      const r = await request("variables", { variablesReference: v.variablesReference });
      children.replaceChildren(...(r?.variables ?? []).map((c: Json) => varNode(c, depth + 1)));
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
  const f = session?.frame;
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

function clearStopped(status: string) {
  if (session) session.frame = null;
  framesEl.replaceChildren();
  varsEl.replaceChildren();
  lineDecor.clear();
  inlineDecor.clear();
  statusEl.textContent = status;
  refreshWatches();
}

function endSession(status: string) {
  if (!session || session.ended) return;
  session.ended = true;
  clearStopped(status);
  invoke("dap_disconnect");
  smokeHooks.ended?.();
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
  if (session && !session.ended) await stopSession(session, false);
  consoleEl.replaceChildren();
  statusEl.textContent = `Connecting to rdbg (${opts.target})…`;
  bottom.show(opts.item ? "run" : "debug");
  const s: Session = { seq: 0, pending: new Map(), threadId: 1, entryHandled: !!opts.localfsMap || !opts.item, frame: null, cfg: opts.cfg, item: opts.item, target: opts.target, localfsMap: opts.localfsMap, ended: false };
  session = s;
  const channel = new Channel<RpcEvent>();
  channel.onmessage = (ev) => {
    if (session !== s) return;
    if (ev.type === "message") onMessage(JSON.parse(ev.body));
    else if (ev.type === "exit") endSession("Debugger disconnected.");
  };
  try {
    await invoke("dap_connect", { target: opts.target, timeoutSecs: opts.timeoutSecs ?? 10, onEvent: channel });
  } catch (e) {
    s.ended = true;
    statusEl.textContent = String(e);
    return toast(`Debugger did not start: ${e}`, "error");
  }
  statusEl.textContent = "Running…";
  const caps = await request("initialize", { clientID: "garnet", clientName: "Garnet", adapterID: "rdbg", linesStartAt1: true, columnsStartAt1: true, pathFormat: "path" });
  if (caps?.exceptionBreakpointFilters?.length) {
    exceptionFilters = caps.exceptionBreakpointFilters;
    renderFilters();
  }
  await request("attach", opts.localfsMap ? { localfsMap: opts.localfsMap } : { localfs: true });
  await Promise.all([...breakpoints.keys()].map(sendBreakpoints));
  if (enabledFilters.size) await sendExceptionFilters();
  await request("configurationDone");
  smokeHooks.connected?.();
}

export async function stopSession(s: Session | null, kill = true) {
  if (!s || s.ended) return;
  if (session === s) {
    await Promise.race([request("disconnect", { terminateDebuggee: kill && !!s.item }), new Promise((r) => setTimeout(r, 800))]);
    endSession("Debug session stopped.");
  }
  if (kill) s.item?.view.kill();
}

export const stopDebug = () => stopSession(session);

export async function restartDebug() {
  const s = session;
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
  if (session?.frame) request("continue", { threadId: session.threadId });
}

export function step(kind: "next" | "stepIn" | "stepOut") {
  if (session?.frame) request(kind, { threadId: session.threadId });
}

/// Hooks for the end-to-end smoke script (src/smoke.ts).
export const smokeHooks: { connected?: () => void; ended?: () => void } = {};
export const debugState = () => ({
  paused: !!session?.frame,
  frame: session?.frame ? { path: session.frame.source?.path as string, line: session.frame.line as number, name: session.frame.name as string } : null,
  variables: varsEl.textContent ?? "",
  inline: inlineDecor.getRanges().length,
});
export const evaluate = (expression: string) => request("evaluate", { expression, frameId: session?.frame?.id, context: "repl" });

export function viewBreakpoints() {
  const items = [...breakpoints].flatMap(([path, lines]) =>
    [...lines].map(([line, bp]) => ({
      label: `${rel(path)}:${line}`,
      description: bp.logMessage ? `log: ${bp.logMessage}` : bp.condition ? `if ${bp.condition}` : "",
      icon: bp.logMessage ? "debug-breakpoint-log" : bp.condition ? "debug-breakpoint-conditional" : "circle-filled",
      data: { path, line },
    })),
  );
  if (!items.length) return toast("No breakpoints. Click the gutter or press ⌘F8 to add one.");
  quickPick({
    placeholder: "Breakpoints (Enter to jump; remove with the gutter or ⌘F8)",
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
