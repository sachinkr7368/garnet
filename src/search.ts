import { allTabs, editor, monaco, openFile, uriFor } from "./editor";
import { Channel, invoke } from "./ipc";
import { editsFor, matchKey, segments, type LineMatch, type ReplaceEdit } from "./replace";
import { rel } from "./state";
import { bottom, fileIcon, h, toast } from "./ui";

type SearchEvent =
  | { type: "file"; path: string; matches: LineMatch[]; truncated?: boolean }
  | { type: "done"; total: number; truncated: boolean };

const query = h("input", { class: "search-input", placeholder: "Search in project (Enter)", spellcheck: false });
const include = h("input", { class: "search-include", placeholder: "Files to include, e.g. app/**, *.rb", spellcheck: false });
const toggle = (label: string, title: string) => {
  const b = h("button", { class: "toggle", title }, label);
  b.onclick = () => {
    b.classList.toggle("on");
    run();
  };
  return b;
};
const caseBtn = toggle("Aa", "Match case");
const wordBtn = toggle("W", "Whole word");
const regexBtn = toggle(".*", "Regular expression");
const summary = h("span", { class: "search-summary" });
const results = h("div", { class: "results" });
const replaceInput = h("input", { class: "search-input", placeholder: "Replace with ($1 for regex groups)", spellcheck: false });
const replaceSelectedBtn = h("button", { class: "btn", title: "Replace the checked matches", onclick: () => replaceMatches(false) }, "Replace Selected");
const replaceAllBtn = h("button", { class: "btn primary", title: "Replace every listed match", onclick: () => replaceMatches(true) }, "Replace All");
const replaceBar = h("div", { class: "search-bar replace-bar" }, replaceInput, replaceSelectedBtn, replaceAllBtn);
replaceBar.hidden = true;

export const searchView = h(
  "div",
  { class: "search-view" },
  h("div", { class: "search-bar" }, query, caseBtn, wordBtn, regexBtn, include, summary),
  replaceBar,
  results,
);

query.addEventListener("keydown", (e) => e.key === "Enter" && run());
include.addEventListener("keydown", (e) => e.key === "Enter" && run());
replaceInput.addEventListener("keydown", (e) => e.key === "Enter" && run());
let replaceTimer = 0;
replaceInput.addEventListener("input", () => {
  clearTimeout(replaceTimer);
  replaceTimer = window.setTimeout(run, 250);
});

const replacing = () => !replaceBar.hidden;
interface FileResult {
  path: string;
  matches: LineMatch[];
  excluded: Set<string>;
  el: HTMLElement;
}
let found: FileResult[] = [];

function highlight(text: string, ranges: [number, number][]) {
  const parts: (string | HTMLElement)[] = [];
  let last = 0;
  for (const [s, e] of ranges) {
    parts.push(text.slice(last, s), h("mark", {}, text.slice(s, e)));
    last = e;
  }
  parts.push(text.slice(last));
  const lead = text.length - text.trimStart().length;
  if (typeof parts[0] === "string") parts[0] = parts[0].slice(Math.min(lead, ranges[0]?.[0] ?? lead));
  return parts;
}

const countRanges = (matches: LineMatch[]) => matches.reduce((n, m) => n + m.ranges.length, 0);
const moreNote = () => h("div", { class: "result-more dim" }, "More matches in this file aren't listed; narrow the search to see them.");

/// One line for the summary: the last line of the regex engine's multi-line error ("error: unclosed group").
export function searchError(e: unknown): string {
  const text = String(e).trim();
  const last = text.split("\n").pop()!.replace(/^error:\s*/, "");
  return text.startsWith("regex parse error") ? `Invalid regular expression: ${last}` : last;
}

function fileGroup(path: string, matches: LineMatch[], more = false) {
  const list = h(
    "div",
    { class: "result-lines" },
    ...matches.map((m) =>
      h(
        "div",
        {
          class: "result-line",
          onclick: () => {
            const [s, e] = m.ranges[0] ?? [0, 0];
            openFile(path, { line: m.line, column: s + 1, endLine: m.line, endColumn: e + 1 });
          },
        },
        h("span", { class: "line-no" }, String(m.line)),
        h("span", { class: "line-text" }, ...highlight(m.text, m.ranges)),
      ),
    ),
  );
  const head = h(
    "div",
    { class: "result-file", onclick: () => (list.hidden = !list.hidden) },
    fileIcon(path),
    h("span", { class: "result-name" }, rel(path).split("/").pop()!),
    h("span", { class: "result-dir" }, rel(path).split("/").slice(0, -1).join("/")),
    h("span", { class: "badge" }, `${countRanges(matches)}${more ? "+" : ""}`),
  );
  if (more) list.append(moreNote());
  return h("div", { class: "result-group" }, head, list);
}

function replaceGroup(path: string, matches: LineMatch[], more = false): FileResult {
  const result: FileResult = { path, matches, excluded: new Set(), el: h("div") };
  const total = matches.reduce((n, m) => n + m.ranges.length, 0);
  const fileBox = h("input", { type: "checkbox", checked: true, title: "Include this file" }) as HTMLInputElement;
  const badge = h("span", { class: "badge" }, `${total}${more ? "+" : ""}`);
  const lineBoxes: { m: LineMatch; box: HTMLInputElement; marks: HTMLElement[] }[] = [];
  const sync = () => {
    for (const { m, box, marks } of lineBoxes) {
      const off = marks.filter((_, i) => result.excluded.has(matchKey(m.line, i))).length;
      box.checked = off < marks.length;
      box.indeterminate = off > 0 && off < marks.length;
      marks.forEach((el, i) => el.classList.toggle("excluded", result.excluded.has(matchKey(m.line, i))));
    }
    const off = result.excluded.size;
    fileBox.checked = off < total;
    fileBox.indeterminate = off > 0 && off < total;
    badge.textContent = (off ? `${total - off}/${total}` : String(total)) + (more ? "+" : "");
  };
  const setAll = (keys: string[], include: boolean) => {
    for (const k of keys) include ? result.excluded.delete(k) : result.excluded.add(k);
    sync();
  };
  const keysOf = (m: LineMatch) => m.ranges.map((_, i) => matchKey(m.line, i));
  fileBox.onclick = (e) => {
    e.stopPropagation();
    setAll(matches.flatMap(keysOf), fileBox.checked);
  };
  const list = h(
    "div",
    { class: "result-lines" },
    ...matches.map((m) => {
      const box = h("input", { type: "checkbox", checked: true, title: "Include this line" }) as HTMLInputElement;
      box.onclick = (e) => {
        e.stopPropagation();
        setAll(keysOf(m), box.checked);
      };
      const marks: HTMLElement[] = [];
      const lead = m.text.length - m.text.trimStart().length;
      const parts = segments(m).map((seg, i) => {
        if (seg.kind === "plain") return i === 0 ? seg.text.slice(Math.min(lead, m.ranges[0]?.[0] ?? lead)) : seg.text;
        const el = h("span", { class: "rep-match", title: "Click to exclude or include this match" }, h("del", {}, seg.old), h("ins", {}, seg.new ?? ""));
        el.onclick = (e) => {
          e.stopPropagation();
          const k = matchKey(m.line, seg.index);
          setAll([k], result.excluded.has(k));
        };
        marks.push(el);
        return el;
      });
      lineBoxes.push({ m, box, marks });
      return h(
        "div",
        {
          class: "result-line",
          onclick: () => {
            const [s, e] = m.ranges[0] ?? [0, 0];
            openFile(path, { line: m.line, column: s + 1, endLine: m.line, endColumn: e + 1 });
          },
        },
        box,
        h("span", { class: "line-no" }, String(m.line)),
        h("span", { class: "line-text" }, ...parts),
      );
    }),
  );
  const head = h(
    "div",
    { class: "result-file", onclick: () => (list.hidden = !list.hidden) },
    fileBox,
    fileIcon(path),
    h("span", { class: "result-name" }, rel(path).split("/").pop()!),
    h("span", { class: "result-dir" }, rel(path).split("/").slice(0, -1).join("/")),
    badge,
  );
  if (more) list.append(moreNote());
  result.el = h("div", { class: "result-group" }, head, list);
  return result;
}

let files = 0;
let started = 0;
let truncated = false;
let active: Channel<SearchEvent> | null = null;

export function run() {
  const q = query.value;
  results.replaceChildren();
  found = [];
  truncated = false;
  files = 0;
  started = performance.now();
  summary.textContent = q ? "Searching…" : "";
  summary.classList.remove("error");
  summary.title = "";
  query.classList.remove("invalid");
  active = null;
  if (!q) return;
  const channel = new Channel<SearchEvent>();
  active = channel;
  channel.onmessage = (ev) => {
    // Events from a superseded search (the Replace box re-runs on each keystroke) carry old replacement text.
    if (channel !== active) return;
    if (ev.type === "file") {
      files++;
      truncated ||= !!ev.truncated;
      if (replacing()) {
        const r = replaceGroup(ev.path, ev.matches, ev.truncated);
        found.push(r);
        results.append(r.el);
      } else results.append(fileGroup(ev.path, ev.matches, ev.truncated));
    } else {
      const ms = Math.round(performance.now() - started);
      truncated ||= ev.truncated;
      const n = ev.total;
      summary.textContent = `${n}${truncated ? "+" : ""} match${n === 1 ? "" : "es"} in ${files} file${files === 1 ? "" : "s"} · ${ms} ms${truncated && replacing() ? " · only listed matches are replaced" : ""}`;
      if (!n && include.value.trim()) results.append(h("div", { class: "empty" }, "No matches. Files ignored by .gitignore (and .git) are skipped, even when the include pattern names them."));
    }
  };
  invoke("search_text", {
    opts: {
      query: q,
      regex: regexBtn.classList.contains("on"),
      caseSensitive: caseBtn.classList.contains("on"),
      wholeWord: wordBtn.classList.contains("on"),
      include: include.value || null,
      replace: replacing() ? replaceInput.value : null,
    },
    onEvent: channel,
  }).catch((e) => {
    if (channel !== active) return;
    summary.textContent = searchError(e);
    summary.title = String(e);
    summary.classList.add("error");
    query.classList.add("invalid");
  });
}

export function findInFiles(folder?: string, replace = false) {
  bottom.show("find");
  if (replaceBar.hidden === replace) {
    replaceBar.hidden = !replace;
    results.replaceChildren();
    summary.textContent = "";
  }
  const sel = editor.getModel() && editor.getSelection();
  const text = sel && !sel.isEmpty() ? editor.getModel()!.getValueInRange(sel) : "";
  if (text && !text.includes("\n")) query.value = text;
  if (folder !== undefined) include.value = folder ? `${folder}/**` : "";
  query.focus();
  query.select();
  if (query.value) run();
}

export const replaceInFiles = () => findInFiles(undefined, true);

/// Open buffers are edited through Monaco (one undo step per file); other files are rewritten on disk.
async function replaceMatches(all: boolean) {
  if (!found.length) return;
  const open = new Set(allTabs().map((t) => t.model));
  let applied = 0;
  let planned = 0;
  let changedFiles = 0;
  const failed: string[] = [];
  for (const f of found) {
    const edits = editsFor(f.matches, all ? null : f.excluded);
    if (!edits.length) continue;
    planned += edits.length;
    const model = monaco.editor.getModel(uriFor(f.path));
    let n = 0;
    if (model && open.has(model)) n = applyToModel(model, edits);
    else n = await invoke<number>("replace_in_file", { path: f.path, edits }).catch((e) => (failed.push(`${rel(f.path)}: ${e}`), 0));
    applied += n;
    if (n) changedFiles++;
  }
  const skipped = planned - applied;
  toast(
    `Replaced ${applied} match${applied === 1 ? "" : "es"} in ${changedFiles} file${changedFiles === 1 ? "" : "s"}${skipped ? `; ${skipped} skipped because the text changed since the search` : ""}.${truncated ? " Results were truncated; search again for more." : ""}`,
    failed.length || skipped ? "error" : "info",
  );
  if (failed.length) console.error(failed.join("\n"));
  run();
}

function applyToModel(model: monaco.editor.ITextModel, edits: ReplaceEdit[]): number {
  const ops = edits
    .map((e) => ({ range: new monaco.Range(e.line, e.start + 1, e.line, e.end + 1), text: e.new, old: e.old }))
    .filter((o) => o.range.endLineNumber <= model.getLineCount() && model.getValueInRange(o.range) === o.old)
    .map(({ range, text }) => ({ range, text }));
  if (!ops.length) return 0;
  model.pushStackElement();
  model.pushEditOperations([], ops, () => null);
  model.pushStackElement();
  return ops.length;
}

window.addEventListener("garnet:find-in", (e) => findInFiles((e as CustomEvent<string>).detail));

/// Location lists (Find Usages, etc.) rendered in the same results panel.
export interface Loc {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  text: string;
}

export function showLocations(title: string, locs: Loc[]) {
  bottom.show("find");
  summary.textContent = `${title}: ${locs.length} results`;
  const byFile = new Map<string, LineMatch[]>();
  for (const l of locs) {
    const list = byFile.get(l.path) ?? [];
    const end = l.endLine === l.line ? l.endColumn - 1 : l.text.length;
    list.push({ line: l.line, text: l.text, ranges: [[l.column - 1, end]] });
    byFile.set(l.path, list);
  }
  results.replaceChildren(...[...byFile].map(([path, m]) => fileGroup(path, m)));
}
