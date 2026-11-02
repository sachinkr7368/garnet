import { editor, openFile } from "./editor";
import { Channel, invoke } from "./ipc";
import { rel } from "./state";
import { bottom, h, icon } from "./ui";

interface LineMatch {
  line: number;
  text: string;
  ranges: [number, number][];
}

type SearchEvent =
  | { type: "file"; path: string; matches: LineMatch[] }
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

export const searchView = h(
  "div",
  { class: "search-view" },
  h("div", { class: "search-bar" }, query, caseBtn, wordBtn, regexBtn, include, summary),
  results,
);

query.addEventListener("keydown", (e) => e.key === "Enter" && run());
include.addEventListener("keydown", (e) => e.key === "Enter" && run());

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

function fileGroup(path: string, matches: LineMatch[]) {
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
    icon("file"),
    h("span", { class: "result-name" }, rel(path).split("/").pop()!),
    h("span", { class: "result-dir" }, rel(path).split("/").slice(0, -1).join("/")),
    h("span", { class: "badge" }, String(matches.length)),
  );
  return h("div", { class: "result-group" }, head, list);
}

let files = 0;
let started = 0;

export function run() {
  const q = query.value;
  results.replaceChildren();
  files = 0;
  started = performance.now();
  summary.textContent = q ? "Searching…" : "";
  if (!q) return;
  const channel = new Channel<SearchEvent>();
  channel.onmessage = (ev) => {
    if (ev.type === "file") {
      files++;
      results.append(fileGroup(ev.path, ev.matches));
    } else {
      const ms = Math.round(performance.now() - started);
      summary.textContent = `${ev.total}${ev.truncated ? "+" : ""} matches in ${files} files · ${ms} ms`;
    }
  };
  invoke("search_text", {
    opts: {
      query: q,
      regex: regexBtn.classList.contains("on"),
      caseSensitive: caseBtn.classList.contains("on"),
      wholeWord: wordBtn.classList.contains("on"),
      include: include.value || null,
    },
    onEvent: channel,
  }).catch((e) => (summary.textContent = String(e)));
}

export function findInFiles(folder?: string) {
  bottom.show("find");
  const sel = editor.getModel() && editor.getSelection();
  const text = sel && !sel.isEmpty() ? editor.getModel()!.getValueInRange(sel) : "";
  if (text && !text.includes("\n")) query.value = text;
  if (folder !== undefined) include.value = folder ? `${folder}/**` : "";
  query.focus();
  query.select();
  if (query.value) run();
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
