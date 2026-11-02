import { openFile } from "./editor";
import { api } from "./ipc";
import { launch, runs, stopRun, type RunConfig } from "./run";
import rspecFormatter from "./ruby/garnet_rspec_formatter.rb?raw";
import minitestPlugin from "./ruby/minitest/garnet_plugin.rb?raw";
import { setting } from "./settings";
import { abs, dirname, rel, root, shellQuote, state } from "./state";
import type { PtyTabs } from "./terminal";
import {
  backtraceLink,
  buildTree,
  counts,
  emptyRun,
  feedEvents,
  filterTree,
  lineStatuses,
  plannedUnreliable,
  prependRubylib,
  progress,
  rerunArgs,
  type TestKind,
  type TestResult,
  type TestRunState,
  type TestStatus,
  type TreeNode,
} from "./testtree";
import { bottom, contextMenu, h, icon, iconButton, toast } from "./ui";

type RunItem = PtyTabs["items"][number];

export interface TestRunHandle {
  kind: TestKind;
  eventsPath: string;
  args: string;
  env: Record<string, string>;
  ignorePlanned: boolean;
  finished: () => void;
}

interface TestRun {
  handle: TestRunHandle;
  cfg: RunConfig;
  item: RunItem;
  state: TestRunState;
  exited: boolean;
}

let current: TestRun | null = null;
let selectedKey: string | null = null;
const collapsed = new Set<string>();
const show = { passed: true, pending: true };
const statuses = new Map<string, Map<number, TestStatus>>();
const statusListeners: (() => void)[] = [];
let supportDir: Promise<string> | null = null;

/// Writes the formatter and the Minitest plugin into Garnet's state dir (never into the project).
function support(): Promise<string> {
  supportDir ??= (async () => {
    const dir = `${dirname(await api.configPath("settings.json"))}/ruby`;
    await api.createPath(`${dir}/minitest`, true).catch(() => {});
    await api.createPath(`${dir}/events`, true).catch(() => {});
    await api.writeFile(`${dir}/garnet_rspec_formatter.rb`, rspecFormatter);
    await api.writeFile(`${dir}/minitest/garnet_plugin.rb`, minitestPlugin);
    return dir;
  })().catch((e) => {
    supportDir = null;
    throw e;
  });
  return supportDir;
}

let runCounter = 0;
let shellRubylibValue: Promise<string> | null = null;
/// RUBYLIB from the login shell environment Garnet runs commands in (read once per window).
const shellRubylib = () => (shellRubylibValue ??= api.runCapture(root(), 'printf %s "$RUBYLIB"', 20).catch(() => ""));

/// Formatter arguments and environment for an RSpec / Minitest configuration; null for anything else.
export async function prepareTestRun(cfg: RunConfig, runEnv: Record<string, string> = {}): Promise<TestRunHandle | null> {
  if (cfg.type !== "rspec" && cfg.type !== "minitest") return null;
  let dir: string;
  try {
    dir = await support();
  } catch (e) {
    toast(`Test results tree unavailable: ${e}`, "error");
    return null;
  }
  const eventsPath = `${dir}/events/${Date.now()}-${++runCounter}.ndjson`;
  await api.writeFile(eventsPath, "");
  const userArgs = `${cfg.args} ${cfg.type === "rspec" ? setting("testing.rspecArgs") : setting("testing.minitestArgs")}`;
  let args = "";
  const env: Record<string, string> = { GARNET_TEST_EVENTS: eventsPath };
  if (cfg.type === "rspec") {
    args = `--require ${shellQuote(`${dir}/garnet_rspec_formatter.rb`)} --format GarnetFormatter`;
    if (!/(^|\s)(-f|--format)\b/.test(userArgs)) args = `--format progress ${args}`;
  } else env.RUBYLIB = prependRubylib(dir, runEnv.RUBYLIB, setting<Record<string, string>>("terminal.env")?.RUBYLIB, await shellRubylib());
  return { kind: cfg.type, eventsPath, args, env, ignorePlanned: plannedUnreliable(cfg.type, userArgs), finished: () => {} };
}

export function startTestRun(handle: TestRunHandle, cfg: RunConfig, item: RunItem) {
  const run: TestRun = { handle, cfg, item, state: emptyRun(), exited: false };
  current = run;
  selectedKey = null;
  bottom.show("tests");
  render();
  const poll = async () => {
    const text = await api.readFile(handle.eventsPath).catch(() => "");
    const next = feedEvents(run.state, text, handle.ignorePlanned);
    if (next !== run.state && (next.results.length !== run.state.results.length || next.done !== run.state.done || next.planned !== run.state.planned)) {
      run.state = next;
      mergeStatuses(run.state.results);
      if (current === run) render();
    } else run.state = next;
  };
  // ponytail: polls the events file every 400 ms and re-reads it whole; tail by offset in Rust if huge suites make this slow
  const timer = window.setInterval(poll, 400);
  handle.finished = async () => {
    clearInterval(timer);
    run.exited = true;
    await poll();
    api.deletePath(handle.eventsPath).catch(() => {});
    if (current === run) render();
  };
}

function mergeStatuses(results: TestResult[]) {
  for (const [file, lines] of lineStatuses(results)) {
    const m = statuses.get(file) ?? new Map<number, TestStatus>();
    for (const [line, s] of lines) m.set(line, s);
    statuses.set(file, m);
  }
  statusListeners.forEach((fn) => fn());
}

export const testStatusAt = (path: string, line: number) => statuses.get(path)?.get(line);
export const onTestStatuses = (fn: () => void) => statusListeners.push(fn);

/// Panel

const treeEl = h("div", { class: "tr-tree", tabIndex: 0 });
const detailEl = h("div", { class: "tr-detail" });
const bar = h("div", { class: "tr-bar" });
const summaryEl = h("span", { class: "search-summary" }, "No test run yet. Run a spec or test (⌃⇧R) to see results here.");
const passedBox = h("input", { type: "checkbox", checked: true });
const pendingBox = h("input", { type: "checkbox", checked: true });
passedBox.onchange = () => ((show.passed = passedBox.checked), render());
pendingBox.onchange = () => ((show.pending = pendingBox.checked), render());

export const testResultsView = h(
  "div",
  { class: "tests-view" },
  h(
    "div",
    { class: "search-bar" },
    iconButton("debug-rerun", "Rerun", () => rerunAll()),
    iconButton("run-errors", "Rerun Failed Tests", () => rerunFailed()),
    iconButton("debug-stop", "Stop", () => current && !current.exited && stopRun(current.item)),
    h("span", { class: "debug-toolbar-sep" }),
    h("label", { class: "exc-filter", title: "Show passed tests" }, passedBox, "Passed"),
    h("label", { class: "exc-filter", title: "Show ignored (pending / skipped) tests" }, pendingBox, "Ignored"),
    iconButton("expand-all", "Expand All", () => (collapsed.clear(), render())),
    iconButton("collapse-all", "Collapse All", () => {
      const walk = (ns: TreeNode[]) => ns.forEach((n) => n.children.length && (collapsed.add(n.key), walk(n.children)));
      if (current) walk(buildTree(current.state.results, rel));
      render();
    }),
    iconButton("terminal", "Show Console", () => {
      if (!current) return;
      bottom.show("run");
      if (runs.items.includes(current.item)) runs.select(current.item);
    }),
    h("span", { class: "debug-toolbar-sep" }),
    h("div", { class: "tr-progress" }, bar),
    summaryEl,
  ),
  h("div", { class: "tr-body" }, treeEl, detailEl),
);

const STATUS_ICON: Record<TestStatus, string> = { passed: "pass", failed: "error", pending: "circle-slash" };
export const statusIcon = (s: TestStatus) => STATUS_ICON[s];

const fmtDuration = (secs: number) => (secs >= 1 ? `${secs.toFixed(2)} s` : `${Math.round(secs * 1000)} ms`);

function render() {
  if (!current) return;
  const run = current;
  const c = counts(run.state.results);
  const p = progress(run.state);
  const running = !run.exited && !run.state.done;
  bar.className = `tr-bar ${c.failed ? "failed" : "passed"}${p === null ? " indeterminate" : ""}`;
  bar.style.width = p === null ? "" : `${Math.round(p * 100)}%`;
  const parts = [c.failed && `${c.failed} failed`, `${c.passed} passed`, c.pending && `${c.pending} ignored`].filter(Boolean).join(", ");
  const of = run.state.planned && running ? ` of ${run.state.planned}` : "";
  const time = run.state.duration !== null ? ` · ${fmtDuration(run.state.duration)}` : "";
  const ended = run.exited && !run.state.done ? (c.total ? " · run ended early" : " · no results (did the runner start? see the console)") : "";
  summaryEl.textContent = `${run.cfg.name}: ${running ? "running… " : ""}${parts}${of}${time}${ended}`;
  const tree = filterTree(buildTree(run.state.results, rel), show);
  treeEl.replaceChildren(...tree.flatMap((n) => nodeRows(n, 0)));
  if (!selectedKey && c.failed) selectedKey = firstFailed(buildTree(run.state.results, rel))?.key ?? null;
  renderDetail(findNode(buildTree(run.state.results, rel), selectedKey));
}

function firstFailed(nodes: TreeNode[]): TreeNode | undefined {
  for (const n of nodes) {
    if (n.result?.status === "failed") return n;
    const f = firstFailed(n.children);
    if (f) return f;
  }
}

function findNode(nodes: TreeNode[], key: string | null): TreeNode | undefined {
  if (!key) return;
  for (const n of nodes) {
    if (n.key === key) return n;
    const f = findNode(n.children, key);
    if (f) return f;
  }
}

function leaves(n: TreeNode): TestResult[] {
  return n.result ? [n.result] : n.children.flatMap(leaves);
}

function nodeRows(n: TreeNode, depth: number): HTMLElement[] {
  const open = !collapsed.has(n.key);
  const twisty = n.children.length ? icon(`chevron-${open ? "down" : "right"}`, "twisty") : h("span", { class: "twisty" });
  twisty.onclick = (e) => {
    e.stopPropagation();
    if (open) collapsed.add(n.key);
    else collapsed.delete(n.key);
    render();
  };
  const row = h(
    "div",
    {
      class: `tr-row${n.key === selectedKey ? " selected" : ""}`,
      style: `padding-left:${depth * 14 + 4}px`,
      onclick: () => ((selectedKey = n.key), render()),
      ondblclick: () => jump(n),
      oncontextmenu: (e: MouseEvent) => {
        e.preventDefault();
        selectedKey = n.key;
        render();
        contextMenu(e, [
          { label: "Run", run: () => rerun(leaves(n), n.label, "run") },
          { label: "Debug", run: () => rerun(leaves(n), n.label, "debug") },
          null,
          { label: "Jump to Source", run: () => jump(n) },
        ]);
      },
    },
    twisty,
    icon(STATUS_ICON[n.status], `tr-icon ${n.status}`),
    h("span", { class: "tr-label" }, n.label),
    h("span", { class: "dim tr-time" }, fmtDuration(n.duration)),
  );
  row.dataset.status = n.status;
  return [row, ...(open ? n.children.flatMap((c) => nodeRows(c, depth + 1)) : [])];
}

function jump(n: TreeNode) {
  if (n.file) openFile(n.file, n.line ? { line: n.line } : undefined);
}

function renderDetail(n: TreeNode | undefined) {
  if (!n) return detailEl.replaceChildren(h("div", { class: "empty" }, current?.state.results.length ? "Select a test to see its output." : ""));
  const failures = leaves(n).filter((r) => r.status !== "passed");
  const section = (r: TestResult) =>
    h(
      "div",
      { class: "tr-failure" },
      h("div", { class: `tr-failure-title ${r.status}` }, icon(STATUS_ICON[r.status]), ` ${[...r.groups.map((g) => g.name), r.name].join(" › ")}`, h("span", { class: "dim" }, `  ${fmtDuration(r.duration)}`)),
      r.message ? h("pre", { class: "tr-message" }, r.message) : null,
      r.backtrace?.length
        ? h(
            "pre",
            { class: "tr-backtrace" },
            ...r.backtrace.map((line) => {
              const link = backtraceLink(line);
              return link ? h("div", {}, h("a", { href: "#", onclick: (e: MouseEvent) => (e.preventDefault(), openFile(abs(link.path), { line: link.line })) }, line)) : h("div", { class: "dim" }, line);
            }),
          )
        : null,
    );
  if (n.result) {
    detailEl.replaceChildren(n.result.status === "passed" && !n.result.message ? h("div", { class: "tr-failure-title passed" }, icon("pass"), ` ${n.label} passed in ${fmtDuration(n.duration)}`) : section(n.result));
    return;
  }
  const c = counts(leaves(n));
  detailEl.replaceChildren(h("div", { class: "dim" }, `${n.label}: ${c.failed} failed, ${c.passed} passed, ${c.pending} ignored`), ...failures.filter((r) => r.status === "failed").map(section));
}

/// Rerun

function rerun(results: TestResult[], label: string, mode: "run" | "debug" = "run") {
  if (!current || !results.length || !state.project) return;
  const args = rerunArgs(current.handle.kind, state.project.rails, results, rel, shellQuote);
  launch({ ...current.cfg, name: `${label} (rerun)`, args }, mode);
}

export function rerunFailed() {
  if (!current) return toast("No test run yet.");
  const failed = current.state.results.filter((r) => r.status === "failed");
  if (!failed.length) return toast("No failed tests in the last run.");
  rerun(failed, "Failed tests");
}

export function rerunAll() {
  if (!current) return toast("No test run yet.");
  launch(current.cfg, "run");
}

/// Hooks for the smoke script.
export const testRunState = () =>
  current && { id: current.handle.eventsPath, name: current.cfg.name, exited: current.exited, done: current.state.done, counts: counts(current.state.results), results: current.state.results, rows: treeEl.querySelectorAll(".tr-row").length, progressWidth: bar.style.width };
