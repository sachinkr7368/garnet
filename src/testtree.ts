// Pure model for the test results tree: parses the NDJSON events written by
// src/ruby/garnet_rspec_formatter.rb and src/ruby/minitest/garnet_plugin.rb.

export type TestStatus = "passed" | "failed" | "pending";
export type TestKind = "rspec" | "minitest";

export interface TestResult {
  id: string;
  file: string;
  line: number;
  groups: { name: string; line?: number }[];
  name: string;
  status: TestStatus;
  duration: number;
  message?: string;
  backtrace?: string[];
}

export interface TestRunState {
  planned: number | null;
  results: TestResult[];
  done: boolean;
  duration: number | null;
  /// Unparsed tail of the events file (a line still being written).
  pending: string;
  consumed: number;
}

export const emptyRun = (): TestRunState => ({ planned: null, results: [], done: false, duration: null, pending: "", consumed: 0 });

const STATUSES = new Set(["passed", "failed", "pending"]);

/// Feeds the full current contents of the events file; only the part after `state.consumed` is parsed.
export function feedEvents(state: TestRunState, text: string, ignorePlanned = false): TestRunState {
  if (text.length < state.consumed) return state;
  const chunk = state.pending + text.slice(state.consumed);
  const lines = chunk.split("\n");
  const pending = lines.pop() ?? "";
  const next: TestRunState = { ...state, results: [...state.results], pending, consumed: text.length };
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.event === "start") next.planned = ignorePlanned || typeof ev.count !== "number" ? null : ev.count;
    else if (ev.event === "done") {
      next.done = true;
      next.duration = typeof ev.duration === "number" ? ev.duration : null;
    } else if (ev.event === "result" && typeof ev.id === "string" && STATUSES.has(ev.status)) {
      next.results.push({
        id: ev.id,
        file: String(ev.file ?? ""),
        line: Number(ev.line) || 0,
        groups: Array.isArray(ev.groups) ? ev.groups.map((g: any) => ({ name: String(g?.name ?? ""), line: typeof g?.line === "number" ? g.line : undefined })) : [],
        name: String(ev.name ?? ev.id),
        status: ev.status,
        duration: Number(ev.duration) || 0,
        message: typeof ev.message === "string" ? ev.message.trim() : undefined,
        backtrace: Array.isArray(ev.backtrace) ? ev.backtrace.map(String) : undefined,
      });
    }
  }
  return next;
}

export interface Counts {
  passed: number;
  failed: number;
  pending: number;
  total: number;
}

export function counts(results: TestResult[]): Counts {
  const c = { passed: 0, failed: 0, pending: 0, total: results.length };
  for (const r of results) c[r.status]++;
  return c;
}

/// 0..1, or null when the planned count is unknown and the run is still going.
export function progress(state: TestRunState): number | null {
  if (state.done) return 1;
  if (!state.planned) return null;
  return Math.min(1, state.results.length / state.planned);
}

export interface TreeNode {
  key: string;
  label: string;
  file: string;
  line?: number;
  status: TestStatus;
  duration: number;
  children: TreeNode[];
  result?: TestResult;
}

const worst = (a: TestStatus, b: TestStatus): TestStatus => (a === "failed" || b === "failed" ? "failed" : a === "passed" || b === "passed" ? "passed" : "pending");

/// file → describe/class groups → examples, with aggregated status and duration.
export function buildTree(results: TestResult[], relPath: (p: string) => string = (p) => p): TreeNode[] {
  const roots: TreeNode[] = [];
  const index = new Map<string, TreeNode>();
  const child = (siblings: TreeNode[], key: string, make: () => TreeNode) => {
    let n = index.get(key);
    if (!n) {
      n = make();
      index.set(key, n);
      siblings.push(n);
    }
    return n;
  };
  for (const r of results) {
    const fileNode = child(roots, r.file, () => ({ key: r.file, label: relPath(r.file), file: r.file, status: r.status, duration: 0, children: [] }));
    let parent = fileNode;
    let key = r.file;
    for (const g of r.groups) {
      key += `\u0000${g.name}`;
      const p = parent;
      parent = child(p.children, key, () => ({ key, label: g.name, file: r.file, line: g.line, status: r.status, duration: 0, children: [] }));
    }
    parent.children.push({ key: `${key}\u0000#${r.id}`, label: r.name, file: r.file, line: r.line, status: r.status, duration: r.duration, children: [], result: r });
  }
  const aggregate = (n: TreeNode): void => {
    if (n.result) return;
    n.children.forEach(aggregate);
    // Results arrive in completion order; the tree follows the source, like RubyMine.
    n.children.sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity));
    n.status = n.children.map((c) => c.status).reduce(worst);
    n.duration = n.children.reduce((s, c) => s + c.duration, 0);
  };
  roots.forEach(aggregate);
  return roots;
}

/// Drops passed / pending leaves (and groups left empty) according to the filter toggles.
export function filterTree(nodes: TreeNode[], show: { passed: boolean; pending: boolean }): TreeNode[] {
  return nodes.flatMap((n) => {
    if (n.result) return (n.status === "passed" && !show.passed) || (n.status === "pending" && !show.pending) ? [] : [n];
    const children = filterTree(n.children, show);
    return children.length ? [{ ...n, children }] : [];
  });
}

/// Last known status per file and line (examples and groups) for gutter icons.
export function lineStatuses(results: TestResult[]): Map<string, Map<number, TestStatus>> {
  const map = new Map<string, Map<number, TestStatus>>();
  const put = (file: string, line: number | undefined, s: TestStatus) => {
    if (!line) return;
    const m = map.get(file) ?? new Map<number, TestStatus>();
    m.set(line, m.has(line) ? worst(m.get(line)!, s) : s);
    map.set(file, m);
  };
  for (const r of results) {
    put(r.file, r.line, r.status);
    for (const g of r.groups) put(r.file, g.line, r.status);
  }
  return map;
}

/// Arguments that rerun exactly the given results.
/// RSpec: example ids (`./spec/a_spec.rb[1:2]`). Rails Minitest: `file:line`. Plain Minitest: require each file and filter by `Class#test`.
export function rerunArgs(kind: TestKind, rails: boolean, results: TestResult[], relPath: (p: string) => string, quote: (s: string) => string): string {
  if (kind === "rspec") return results.map((r) => quote(r.id)).join(" ");
  if (rails) return [...new Set(results.map((r) => `${relPath(r.file)}:${r.line}`))].map(quote).join(" ");
  const files = [...new Set(results.map((r) => relPath(r.file)))];
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const pattern = `/^(?:${results.map((r) => escape(r.id)).join("|")})$/`;
  return `-e ${quote(`${files.map((f) => `require File.expand_path(${JSON.stringify(f)})`).join("; ")}`)} -- -n ${quote(pattern)}`;
}

/// RUBYLIB for a Minitest run: Garnet's reporter dir in front of the value the process would otherwise get
/// (`inherited` in precedence order, e.g. config env, then terminal env, then the login shell's).
export function prependRubylib(dir: string, ...inherited: (string | undefined)[]): string {
  const base = inherited.find((v) => v !== undefined && v.trim() !== "") ?? "";
  return [dir, ...base.split(":").filter((p) => p && p !== dir)].join(":");
}

/// Minitest with a line or name filter reports the unfiltered test count; don't trust it.
export const plannedUnreliable = (kind: TestKind, args: string) => kind === "minitest" && /:\d+|(^|\s)(-n|--name)\b/.test(args);

/// Splits a backtrace line into a file:line link when it points at a Ruby file.
export function backtraceLink(line: string): { path: string; line: number } | null {
  const m = line.match(/^\s*(?:#\s*)?((?:\.{0,2}\/)?[^\s:]+\.(?:rb|erb|rake|haml|slim|jbuilder|ru)):(\d+)/);
  return m ? { path: m[1].replace(/^\.\//, ""), line: Number(m[2]) } : null;
}
