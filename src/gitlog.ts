import { ask } from "@tauri-apps/plugin-dialog";
import { openTextDiff } from "./editor";
import { ago, fileTree } from "./git";
import { api, type ChangedFile, type CommitDetails, type LogCommit } from "./ipc";
import { runGitOp } from "./merge";
import { abs, basename, debounce, rel, root, state } from "./state";
import { isTrusted, setting, updateSetting } from "./settings";
import { bottom, contextMenu, h, icon, iconButton, inputBox, quickPick, toast } from "./ui";

const ROW = 24;
const LANE = 12;
const COLORS = ["--accent", "--modified", "--added", "--warn", "--purple", "--blue", "--yellow", "--dim"].map((t) => `var(${t})`);
const refresh = () => window.dispatchEvent(new Event("garnet:git-refresh"));
const git = (...args: string[]) => api.git(root(), ...args);

let mode: "log" | "stash" = "log";
let commits: LogCommit[] = [];
let stashes: { name: string; time: number; message: string }[] = [];
let selected = -1;
let limit = 0;
let loadSeq = 0;
const detailsCollapsed = new Set<string>();

const textInput = h("input", { class: "log-filter", placeholder: "Text or message", spellcheck: false });
const authorInput = h("input", { class: "log-filter", placeholder: "User", spellcheck: false });
authorInput.setAttribute("list", "git-log-authors");
const pathInput = h("input", { class: "log-filter", placeholder: "Path", spellcheck: false });
const authors = h("datalist", { id: "git-log-authors" });
const branchSelect = h("select", { class: "run-select", title: "Branch" });
const logTab = h("button", { class: "seg active", onclick: () => setMode("log") }, "Log");
const stashTab = h("button", { class: "seg", onclick: () => setMode("stash") }, "Stashes");
const logFilters = h("div", { class: "log-filters" }, branchSelect, textInput, authorInput, pathInput, authors);
const stashTools = h("div", { class: "log-filters" }, h("button", { class: "btn small", onclick: () => stashChanges() }, "Stash Changes…"));
const listEl = h("div", { class: "log-list", tabIndex: 0 });
const spacer = h("div", { class: "log-spacer" });
const details = h("div", { class: "log-details" });
listEl.append(spacer);

export const gitLogView = h(
  "div",
  { class: "gitlog-view" },
  h("div", { class: "view-toolbar" }, h("div", { class: "segs" }, logTab, stashTab), logFilters, stashTools, h("span", { class: "spacer" }), iconButton("refresh", "Refresh", () => reload())),
  h("div", { class: "log-split" }, listEl, details),
);
stashTools.hidden = true;

const reloadSoon = debounce(() => ((limit = 0), reload()), 300);
for (const el of [textInput, authorInput, pathInput]) el.addEventListener("input", reloadSoon);
branchSelect.addEventListener("change", () => ((limit = 0), reload()));

function setMode(m: typeof mode) {
  mode = m;
  logTab.classList.toggle("active", m === "log");
  stashTab.classList.toggle("active", m === "stash");
  logFilters.hidden = m !== "log";
  stashTools.hidden = m !== "stash";
  selected = -1;
  details.replaceChildren();
  reload();
}

/// Loading

async function loadBranches() {
  const prev = branchSelect.value;
  const out = await git("for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes").catch(() => "");
  const names = out.split("\n").filter((n) => n && !n.endsWith("/HEAD"));
  branchSelect.replaceChildren(h("option", { value: "" }, "All branches"), h("option", { value: "HEAD" }, "HEAD"), ...names.map((n) => h("option", { value: n }, n)));
  branchSelect.value = names.includes(prev) || prev === "HEAD" ? prev : "";
}

export async function reload() {
  if (!state.project?.git) return showMessage("Not a git repository.");
  if (!isTrusted()) return showMessage("Trust project to enable Git.");
  const mine = ++loadSeq;
  const keep = mode === "log" ? commits[selected]?.hash : stashes[selected]?.name;
  if (mode === "stash") {
    const out = await git("stash", "list", "--format=%gd%x1f%at%x1f%s").catch((e) => (toast(String(e), "error"), ""));
    if (mine !== loadSeq) return;
    stashes = out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [name, time, message] = l.split("\x1f");
        return { name, time: Number(time), message };
      });
    selected = stashes.findIndex((s) => s.name === keep);
    renderList();
    if (selected >= 0) select(selected);
    else details.replaceChildren(h("div", { class: "empty" }, stashes.length ? "Select a stash to see its changes." : "No stashes. Use Stash Changes… to shelve your local changes."));
    return;
  }
  if (!limit) limit = setting<number>("git.logLimit");
  if (!branchSelect.options.length) await loadBranches();
  try {
    commits = await api.gitLog(root(), { branch: branchSelect.value, text: textInput.value.trim(), author: authorInput.value.trim(), path: pathInput.value.trim() ? abs(pathInput.value.trim()) : "", limit });
  } catch (e) {
    if (mine === loadSeq) showMessage(String(e));
    return;
  }
  if (mine !== loadSeq) return;
  authors.replaceChildren(...[...new Set(commits.map((c) => c.author))].sort().map((a) => h("option", { value: a })));
  selected = commits.findIndex((c) => c.hash === keep);
  renderList();
  if (selected < 0 && commits.length) selected = 0;
  if (selected >= 0) select(selected);
  else details.replaceChildren(h("div", { class: "empty" }, "No commits match the filters."));
}

function showMessage(text: string) {
  commits = [];
  stashes = [];
  renderList();
  details.replaceChildren(h("div", { class: "empty" }, text));
}

/// Virtualized commit list

const count = () => (mode === "log" ? commits.length : stashes.length);

function graphSvg(c: LogCommit, width: number) {
  const x = (i: number) => i * LANE + LANE / 2 + 2;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(ROW));
  svg.classList.add("log-graph");
  for (const e of c.edges) {
    const line = document.createElementNS(ns, "line");
    const [x1, y1, x2, y2] = e.kind === 0 ? [x(e.from), 0, x(e.to), ROW] : e.kind === 1 ? [x(e.from), 0, x(c.col), ROW / 2] : [x(c.col), ROW / 2, x(e.to), ROW];
    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(y1));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y2", String(y2));
    line.style.stroke = COLORS[(e.kind === 1 ? e.from : e.to) % COLORS.length];
    svg.append(line);
  }
  const dot = document.createElementNS(ns, "circle");
  dot.setAttribute("cx", String(x(c.col)));
  dot.setAttribute("cy", String(ROW / 2));
  dot.setAttribute("r", c.parents.length > 1 ? "3" : "3.5");
  dot.style.fill = c.parents.length > 1 ? "var(--panel)" : COLORS[c.col % COLORS.length];
  dot.style.stroke = COLORS[c.col % COLORS.length];
  svg.append(dot);
  return svg;
}

function refChips(refs: string) {
  return refs
    .split(", ")
    .filter(Boolean)
    .map((r) => {
      const head = r.startsWith("HEAD -> ");
      const tag = r.startsWith("tag: ");
      const name = r.replace(/^HEAD -> |^tag: /, "");
      return h("span", { class: `ref-chip${head ? " head" : tag ? " tag" : name.includes("/") ? " remote" : ""}` }, icon(tag ? "tag" : "git-branch"), name);
    });
}

const shortDate = (t: number) => {
  const d = new Date(t * 1000);
  return Date.now() / 1000 - t < 86400 * 7 ? ago(t) : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

function renderRow(i: number) {
  if (mode === "stash") {
    const s = stashes[i];
    return h(
      "div",
      { class: `log-row${i === selected ? " selected" : ""}`, onmousedown: () => select(i), oncontextmenu: (e: MouseEvent) => (select(i), stashMenu(e, s)) },
      icon("archive"),
      h("span", { class: "log-subject" }, s.message),
      h("span", { class: "log-author" }, s.name),
      h("span", { class: "log-date" }, shortDate(s.time)),
      iconButton("check", "Apply", () => applyStash(s.name, false)),
      iconButton("arrow-up", "Pop", () => applyStash(s.name, true)),
      iconButton("trash", "Drop…", () => dropStash(s.name)),
    );
  }
  const c = commits[i];
  return h(
    "div",
    { class: `log-row${i === selected ? " selected" : ""}`, title: c.hash, onmousedown: () => select(i), oncontextmenu: (e: MouseEvent) => (select(i), commitMenu(e, c)) },
    graphSvg(c, lanes * LANE + 4),
    ...refChips(c.refs),
    h("span", { class: "log-subject" }, c.subject),
    h("span", { class: "log-author" }, c.author),
    h("span", { class: "log-date" }, shortDate(c.time)),
  );
}

let lanes = 1;
function renderList() {
  lanes = commits.reduce((m, x) => Math.max(m, x.col + 1, ...x.edges.map((e) => Math.max(e.from, e.to) + 1)), 1);
  spacer.style.height = `${count() * ROW}px`;
  paint();
}

function paint() {
  const n = count();
  const first = Math.max(0, Math.floor(listEl.scrollTop / ROW) - 5);
  const last = Math.min(n, Math.ceil((listEl.scrollTop + listEl.clientHeight) / ROW) + 5);
  const rows: HTMLElement[] = [];
  for (let i = first; i < last; i++) {
    const r = renderRow(i);
    r.style.top = `${i * ROW}px`;
    rows.push(r);
  }
  spacer.replaceChildren(...rows);
  if (mode === "log" && n && n >= limit && last >= n - 1) {
    limit += setting<number>("git.logLimit");
    reload();
  }
}
listEl.addEventListener("scroll", () => requestAnimationFrame(paint));
new ResizeObserver(() => paint()).observe(listEl);

listEl.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const next = Math.max(0, Math.min(count() - 1, selected + (e.key === "ArrowDown" ? 1 : -1)));
    select(next);
    if (next * ROW < listEl.scrollTop) listEl.scrollTop = next * ROW;
    else if ((next + 1) * ROW > listEl.scrollTop + listEl.clientHeight) listEl.scrollTop = (next + 1) * ROW - listEl.clientHeight;
  } else if (e.key === "c" && e.metaKey && mode === "log" && commits[selected]) {
    e.preventDefault();
    copyHash(commits[selected].hash);
  }
});

/// Details

let detailSeq = 0;
async function select(i: number) {
  selected = i;
  paint();
  const mine = ++detailSeq;
  const rev = mode === "log" ? commits[i]?.hash : stashes[i]?.name;
  if (!rev) return;
  let d: CommitDetails;
  try {
    d = await api.gitCommitDetails(root(), rev);
  } catch (e) {
    if (mine === detailSeq) details.replaceChildren(h("div", { class: "error-text" }, String(e)));
    return;
  }
  if (mine !== detailSeq) return;
  renderDetails(d, rev);
}

function renderDetails(d: CommitDetails, rev: string) {
  const history = pathInput.value.trim();
  const files = history ? [...d.files].sort((a, b) => Number(!a.path.startsWith(history) && a.oldPath !== history) - Number(!b.path.startsWith(history) && b.oldPath !== history)) : d.files;
  const [subject, ...rest] = d.body.split("\n");
  const fileRow = (f: ChangedFile, depth: number) =>
    h(
      "div",
      {
        class: `change-row${history && (f.path === history || f.oldPath === history) ? " selected" : ""}`,
        style: `padding-left:${6 + depth * 14}px`,
        title: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path,
        onclick: () => openFileDiff(f, rev, d),
      },
      h("span", { class: `status-badge st-${f.status}` }, f.status === "?" ? "U" : f.status),
      h("span", { class: "change-name" }, basename(f.path)),
      h("span", { class: "spacer" }),
      f.added !== null ? h("span", { class: "line-counts" }, h("span", { class: "plus" }, `+${f.added}`), h("span", { class: "minus" }, `−${f.deleted ?? 0}`)) : null,
    );
  const rerender = () => renderDetails(d, rev);
  const body = rest.join("\n").trim();
  details.replaceChildren(
    h("div", { class: "log-subject-full" }, subject || rev),
    h("pre", { class: "log-body", hidden: !body }, body),
    h(
      "div",
      { class: "log-meta" },
      h("span", { class: "log-hash", title: "Copy revision number", onclick: () => copyHash(d.hash) }, d.hash.slice(0, 10)),
      h("span", {}, `${d.author} <${d.email}>`),
      h("span", { class: "dim" }, new Date(d.time * 1000).toLocaleString()),
      d.committer !== d.author ? h("span", { class: "dim" }, `committed by ${d.committer}`) : null,
      d.parents.length ? h("span", { class: "dim" }, `parent${d.parents.length > 1 ? "s" : ""} ${d.parents.map((p) => p.slice(0, 8)).join(", ")}`) : null,
    ),
    h("div", { class: "change-head" }, `${files.length} changed file${files.length === 1 ? "" : "s"}${d.parents.length > 1 ? " (against first parent)" : ""}`),
    ...fileTree(files, rev, fileRow, rerender, detailsCollapsed),
  );
}

async function openFileDiff(f: ChangedFile, rev: string, d: CommitDetails) {
  const [left, right] = await Promise.all([
    f.status === "A" || f.status === "?" ? Promise.resolve("") : api.gitFileAt(root(), f.oldRev, f.oldPath ?? f.path),
    f.status === "D" ? Promise.resolve("") : api.gitFileAt(root(), f.newRev, f.path),
  ]);
  const label = rev.startsWith("stash@") ? rev : d.hash.slice(0, 8);
  openTextDiff(`rev:${rev}:${f.path}`, abs(f.path), left ?? "", right ?? "", `${basename(f.path)} (${label})`, `${f.oldPath ?? f.path} @ ${f.oldRev.slice(0, 8)} ↔ ${f.path} @ ${label}`);
}

function copyHash(hash: string) {
  navigator.clipboard.writeText(hash).then(() => toast(`Copied ${hash.slice(0, 10)}`));
}

/// Commit actions

const validRef = (name: string | null) => {
  const n = name?.trim();
  if (!n) return null;
  if (n.startsWith("-") || /\s/.test(n)) {
    toast(`Invalid name: ${n}`, "error");
    return null;
  }
  return n;
};

function commitMenu(e: MouseEvent, c: LogCommit) {
  const merge = c.parents.length > 1 ? ["-m", "1"] : [];
  contextMenu(e, [
    { label: "Copy Revision Number", run: () => copyHash(c.hash) },
    null,
    { label: "New Branch…", run: () => createBranch(c) },
    { label: "New Tag…", run: () => createTag(c) },
    null,
    { label: "Cherry-Pick", run: () => runGitOp("Cherry-pick", ["cherry-pick", ...merge, c.hash]).then(() => reload()) },
    { label: "Revert Commit", run: () => runGitOp("Revert", ["revert", "--no-edit", ...merge, c.hash]).then(() => reload()) },
    { label: "Reset Current Branch to Here…", run: () => resetTo(c) },
  ]);
}

async function createBranch(c: LogCommit) {
  const name = validRef(await inputBox(`New branch at ${c.hash.slice(0, 8)}`));
  if (!name) return;
  try {
    await git("branch", name, c.hash);
    toast(`Created branch ${name}.`, "info", [{ label: "Checkout", run: () => runGitOp(`Checkout ${name}`, ["checkout", name]).then(() => reload()) }]);
    branchSelect.replaceChildren();
    reload();
  } catch (e) {
    toast(String(e), "error");
  }
}

async function createTag(c: LogCommit) {
  const name = validRef(await inputBox(`New tag at ${c.hash.slice(0, 8)}`));
  if (!name) return;
  await git("tag", name, c.hash).then(() => (toast(`Created tag ${name}.`), reload()), (e) => toast(String(e), "error"));
}

const RESET_MODES = [
  { label: "Soft", data: "--soft", description: "Keep all changes staged" },
  { label: "Mixed", data: "--mixed", description: "Keep changes in the working tree, unstaged" },
  { label: "Hard", data: "--hard", description: "Discard all uncommitted changes and commits after this one" },
];

function resetTo(c: LogCommit) {
  quickPick({
    placeholder: `Reset the current branch to ${c.hash.slice(0, 8)} "${c.subject}"`,
    items: RESET_MODES,
    selected: 1,
    onAccept: async (item) => {
      if (!item) return;
      const hard = item.data === "--hard";
      const ok = await ask(
        `Reset the current branch to ${c.hash.slice(0, 8)} (${item.label})?\n\n${item.description}.${hard ? "\n\nUncommitted changes are lost and cannot be recovered." : ""}`,
        { kind: "warning", okLabel: `${item.label} Reset`, cancelLabel: "Cancel" },
      );
      if (!ok) return;
      await runGitOp(`Reset (${item.label.toLowerCase()})`, ["reset", item.data as string, c.hash]);
      reload();
    },
  });
}

/// Stashes

export async function stashChanges() {
  if (!state.project?.git || !isTrusted()) return toast("Trust project to enable Git.");
  const input = h("input", { class: "qp-input", placeholder: "Message (optional)", spellcheck: false });
  const untracked = h("input", { type: "checkbox", checked: setting<boolean>("git.stashIncludeUntracked") });
  const done = (go: boolean) => {
    backdrop.remove();
    if (!go) return;
    updateSetting("git.stashIncludeUntracked", untracked.checked);
    const args = ["stash", "push", ...(untracked.checked ? ["--include-untracked"] : []), ...(input.value.trim() ? ["-m", input.value.trim()] : [])];
    runGitOp("Stash", args).then(() => {
      if (mode === "stash") reload();
    });
  };
  const box = h(
    "div",
    { class: "qp" },
    h("div", { class: "qp-title" }, "Stash Changes"),
    input,
    h("label", { class: "dialog-check" }, untracked, " Include untracked files"),
    h("div", { class: "dialog-actions" }, h("span", { class: "spacer" }), h("button", { class: "btn", onclick: () => done(false) }, "Cancel"), h("button", { class: "btn primary", onclick: () => done(true) }, "Create Stash")),
  );
  const backdrop = h("div", { class: "qp-backdrop", onmousedown: (e: MouseEvent) => e.target === backdrop && done(false) }, box);
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter") done(true);
    if (e.key === "Escape") done(false);
  });
  document.getElementById("overlay-root")!.append(backdrop);
  input.focus();
}

async function applyStash(name: string, pop: boolean) {
  await runGitOp(pop ? "Pop stash" : "Apply stash", ["stash", pop ? "pop" : "apply", name]);
  reload();
}

async function dropStash(name: string) {
  const s = stashes.find((x) => x.name === name);
  if (!(await ask(`Drop ${name}${s ? ` "${s.message}"` : ""}? The stashed changes are deleted.`, { kind: "warning", okLabel: "Drop", cancelLabel: "Cancel" }))) return;
  await git("stash", "drop", name).then(() => toast(`Dropped ${name}.`), (e) => toast(String(e), "error"));
  refresh();
  reload();
}

function stashMenu(e: MouseEvent, s: { name: string }) {
  contextMenu(e, [
    { label: "Apply", run: () => applyStash(s.name, false) },
    { label: "Pop", run: () => applyStash(s.name, true) },
    null,
    { label: "Drop…", run: () => dropStash(s.name) },
  ]);
}

export async function unstashChanges() {
  if (!state.project?.git || !isTrusted()) return toast("Trust project to enable Git.");
  const out = await git("stash", "list", "--format=%gd%x1f%s").catch(() => "");
  const items = out.split("\n").filter(Boolean).map((l) => {
    const [name, message] = l.split("\x1f");
    return { label: message, description: name, icon: "archive", data: name };
  });
  if (!items.length) return toast("No stashes.");
  quickPick({
    placeholder: "Unstash: choose a stash to pop (open the Git tool window's Stashes tab to apply or view)",
    items,
    onAccept: (item) => item && applyStash(item.data as string, true),
  });
}

/// Entry points

export function showGitLog(path?: string) {
  if (path !== undefined) {
    pathInput.value = path ? rel(path) : "";
    textInput.value = authorInput.value = "";
    branchSelect.value = "";
    limit = 0;
  }
  if (mode !== "log") setMode("log");
  bottom.show("gitlog");
}

window.addEventListener("garnet:show-history", (e) => showGitLog((e as CustomEvent<string>).detail));

/// For the smoke test.
export const logState = () => ({ commits, stashes, selected, details });
export const setLogMode = setMode;
