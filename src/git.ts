import { ask } from "@tauri-apps/plugin-dialog";
import DiffWorker from "./diffworker?worker";
import { activeTab, editor, events, monaco, openDiffTab, openFile, openTextDiff } from "./editor";
import { buildPatch, buildTree, displayLine, filterPaths, hunkKind, overlapsNew, patchHunks, patchLines, splitLines, stagePatch, swapHunk, type LineHunk } from "./difflogic";
import { api, invoke, type ChangedFile, type GitStatusEntry, type OpState } from "./ipc";
import { abortOperation, acceptSide, continueOperation, openResolver, showConflicts } from "./merge";
import { abs, basename, debounce, rel, root, state } from "./state";
import { setGitDecorations } from "./tree";
import { askTrust, isTrusted, onSettingsChange, setting, updateSetting } from "./settings";
import { branches, listWorktrees, newWorktree, openWorktree, removeWorktree, type Worktree } from "./toolbar";
import { contextMenu, h, icon, iconButton, quickPick, statusSlot, toast } from "./ui";

const branchEl = statusSlot("branch", "left");
const blameEl = statusSlot("blame", "left");

/// Diff worker: line diffs off the UI thread

const worker = new DiffWorker();
let diffSeq = 0;
const pendingDiffs = new Map<number, (h: LineHunk[]) => void>();
worker.onmessage = (e: MessageEvent<{ id: number; hunks: LineHunk[] }>) => {
  pendingDiffs.get(e.data.id)?.(e.data.hunks);
  pendingDiffs.delete(e.data.id);
};
export const diffAsync = (a: string, b: string) =>
  new Promise<LineHunk[]>((resolve) => {
    const id = ++diffSeq;
    pendingDiffs.set(id, resolve);
    worker.postMessage({ id, a, b });
  });

/// Commit tool window

const message = h("textarea", { class: "commit-message", placeholder: "Commit message (⌘↩ to commit)", rows: 4, spellcheck: true });
const commitBtn = h("button", { class: "btn primary", onclick: () => commit() }, "Commit");
const list = h("div", { class: "changes" });
const branchHead = h("div", { class: "commit-branch" });
const filterInput = h("input", { class: "changes-filter", placeholder: "Filter files", spellcheck: false });
const opBanner = h("div", { class: "op-banner" });
const compareBanner = h("div", { class: "op-banner" });
const worktreeList = h("div", { class: "worktrees" });
const worktreeSection = h(
  "div",
  { class: "worktree-section" },
  h(
    "div",
    { class: "change-head clickable", onclick: () => ((worktreeList.hidden = !worktreeList.hidden), worktreeList.hidden || refreshWorktrees()) },
    h("span", {}, "Worktrees"),
    h("span", { class: "spacer" }),
    iconButton("add", "New Worktree from Branch…", (e) => (e.stopPropagation(), newWorktree())),
    iconButton("refresh", "Refresh worktrees", (e) => (e.stopPropagation(), refreshWorktrees())),
  ),
  worktreeList,
);
const commitBox = h("div", { class: "commit-box" }, message, h("div", { class: "commit-actions" }, commitBtn));
const groupBtn = iconButton("list-tree", "Group by: Changelist / Directory", () =>
  updateSetting("git.groupBy", setting("git.groupBy") === "directory" ? "changelist" : "directory").then(render),
);
export const commitView = h(
  "div",
  { class: "commit-view" },
  h(
    "div",
    { class: "view-toolbar" },
    branchHead,
    h("span", { class: "spacer" }),
    groupBtn,
    iconButton("expand-all", "Expand All", () => (collapsed.clear(), render())),
    iconButton("collapse-all", "Collapse All", () => collapseAll()),
    iconButton("git-compare", "Compare with Branch…", () => compareWithBranch()),
    iconButton("refresh", "Refresh", () => refreshGit()),
  ),
  opBanner,
  compareBanner,
  filterInput,
  list,
  worktreeSection,
  commitBox,
);
filterInput.addEventListener("input", () => render());
message.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.metaKey) {
    e.preventDefault();
    commit();
  }
});

let entries: GitStatusEntry[] = [];
let opState: OpState = { op: "", conflicts: [] };
let unstagedCounts = new Map<string, ChangedFile>();
let stagedCounts = new Map<string, ChangedFile>();
let currentBranch = "";
const collapsed = new Set<string>();
const expandedHunks = new Set<string>();
let compare: { base: string; mergeBase: string; files: ChangedFile[] } | null = null;

const statusLabel: Record<string, string> = { M: "modified", A: "added", D: "deleted", R: "renamed", "?": "untracked", U: "conflict", C: "copied", T: "modified" };
const badge = (code: string) => h("span", { class: `status-badge st-${statusLabel[code] ?? "modified"}`, title: statusLabel[code] ?? code }, code === "?" ? "U" : code === "U" ? "!" : code);
const counts = (f?: { added: number | null; deleted: number | null }) =>
  f && (f.added !== null || f.deleted !== null)
    ? h("span", { class: "line-counts" }, h("span", { class: "plus" }, `+${f.added ?? 0}`), h("span", { class: "minus" }, `−${f.deleted ?? 0}`))
    : null;

/// "Viewed" marks, kept per project and branch; a mark clears when the file's +/- counts change.

let viewed: Record<string, Record<string, string>> = {};
let viewedLoaded = false;
const viewedKey = () => `${root()}\n${currentBranch}`;
const signature = (f?: { added: number | null; deleted: number | null }) => `${f?.added ?? "-"}:${f?.deleted ?? "-"}`;
async function loadViewed() {
  if (viewedLoaded) return;
  viewedLoaded = true;
  try {
    viewed = JSON.parse((await api.configRead("viewed.json")) ?? "{}");
  } catch {
    viewed = {};
  }
}
const isViewed = (path: string, f?: ChangedFile) => viewed[viewedKey()]?.[path] === signature(f);
function setViewed(path: string, f: ChangedFile | undefined, on: boolean) {
  const map = (viewed[viewedKey()] ??= {});
  if (on) map[path] = signature(f);
  else delete map[path];
  if (!Object.keys(map).length) delete viewed[viewedKey()];
  api.configWrite("viewed.json", JSON.stringify(viewed)).catch(() => {});
  render();
}
const viewedBox = (path: string, f?: ChangedFile) =>
  h("input", {
    type: "checkbox",
    class: "viewed-box",
    title: "Viewed",
    checked: isViewed(path, f),
    onclick: (e: MouseEvent) => e.stopPropagation(),
    onchange: (e: Event) => setViewed(path, f, (e.target as HTMLInputElement).checked),
  });

/// Generic collapsible file tree, also used by the Git log's commit details.

export function fileTree<T extends { path: string }>(files: T[], key: string, row: (f: T, depth: number) => HTMLElement, rerender: () => void, closed = collapsed): HTMLElement[] {
  const out: HTMLElement[] = [];
  const walk = (nodes: ReturnType<typeof buildTree<T>>, depth: number) => {
    for (const n of nodes) {
      if (n.file) {
        out.push(row(n.file, depth));
        continue;
      }
      const id = `${key}:${n.path}`;
      const open = !closed.has(id);
      out.push(
        h(
          "div",
          { class: "change-row dir-row", style: `padding-left:${6 + depth * 14}px`, onclick: () => (open ? closed.add(id) : closed.delete(id), rerender()) },
          icon(open ? "chevron-down" : "chevron-right"),
          icon("folder"),
          h("span", { class: "change-name" }, n.name),
        ),
      );
      if (open) walk(n.children, depth + 1);
    }
  };
  walk(buildTree(files), 0);
  return out;
}

function allDirKeys<T extends { path: string }>(files: T[], key: string) {
  const keys: string[] = [];
  const walk = (nodes: ReturnType<typeof buildTree<T>>) => nodes.forEach((n) => !n.file && (keys.push(`${key}:${n.path}`), walk(n.children)));
  walk(buildTree(files));
  return keys;
}

interface Row {
  path: string;
  code: string;
  staged: boolean;
  counts?: ChangedFile;
}

function rowsFor(): { title: string; key: string; rows: Row[]; staged: boolean | null }[] {
  const conflicts = new Set(opState.conflicts);
  const conflictRows = opState.conflicts.map((p) => ({ path: p, code: "U", staged: false }));
  const staged = entries.filter((e) => e.index !== " " && e.index !== "?" && !conflicts.has(e.path)).map((e) => ({ path: e.path, code: e.index, staged: true, counts: stagedCounts.get(e.path) }));
  const unstaged = entries
    .filter((e) => e.worktree !== " " && !conflicts.has(e.path))
    .map((e) => ({ path: e.path, code: e.worktree, staged: false, counts: unstagedCounts.get(e.path) }));
  const groups: { title: string; key: string; rows: Row[]; staged: boolean | null }[] = [];
  if (conflictRows.length) groups.push({ title: "Merge Conflicts", key: "conflicts", rows: conflictRows, staged: null });
  if (setting("git.groupBy") === "directory") {
    const byPath = new Map<string, Row>();
    for (const r of [...staged, ...unstaged]) {
      const prev = byPath.get(r.path);
      byPath.set(r.path, prev ? { ...r, staged: false, counts: r.counts ?? prev.counts } : r);
    }
    if (byPath.size) groups.push({ title: "Changes", key: "all", rows: [...byPath.values()], staged: null });
  } else {
    if (staged.length) groups.push({ title: "Staged", key: "staged", rows: staged, staged: true });
    if (unstaged.length) groups.push({ title: "Changes", key: "changes", rows: unstaged, staged: false });
  }
  return groups;
}

function collapseAll() {
  if (compare) allDirKeys(compare.files, "compare").forEach((k) => collapsed.add(k));
  else for (const g of rowsFor()) allDirKeys(g.rows, g.key).forEach((k) => collapsed.add(k));
  render();
}

function stageToggle(r: Row) {
  return iconButton(r.staged ? "remove" : "add", r.staged ? "Unstage" : "Stage", (ev) => {
    ev.stopPropagation();
    (r.staged ? api.gitUnstage : api.gitStage)(root(), [r.path]).then(refreshGit, (err) => toast(String(err), "error"));
  });
}

function changeRow(r: Row, depth: number, groupKey: string) {
  const path = abs(r.path);
  const hunkKey = `${groupKey}:${r.path}`;
  const canSplit = r.code !== "?" && r.code !== "U" && r.code !== "D" && r.code !== "A";
  const el = h(
    "div",
    {
      class: `change-row git-${statusLabel[r.code] ?? "modified"}${isViewed(r.path, r.counts) ? " viewed" : ""}`,
      style: `padding-left:${6 + depth * 14}px`,
      title: `${r.path} (${statusLabel[r.code] ?? r.code})`,
      onclick: () => (r.code === "U" ? openResolver(r.path) : showDiff(path, r.staged)),
      oncontextmenu: (e: MouseEvent) => rowMenu(e, r),
    },
    canSplit
      ? iconButton(expandedHunks.has(hunkKey) ? "chevron-down" : "chevron-right", "Show hunks (partial staging)", (ev) => {
          ev.stopPropagation();
          if (expandedHunks.has(hunkKey)) expandedHunks.delete(hunkKey);
          else expandedHunks.add(hunkKey);
          render();
        })
      : h("span", { class: "twisty-space" }),
    badge(r.code),
    h("span", { class: "change-name" }, basename(r.path)),
    h("span", { class: "spacer" }),
    counts(r.counts),
    r.code === "U" ? h("button", { class: "btn small", onclick: (e: MouseEvent) => (e.stopPropagation(), openResolver(r.path)) }, "Merge…") : stageToggle(r),
    viewedBox(r.path, r.counts),
  );
  if (!expandedHunks.has(hunkKey)) return el;
  const box = h("div", { class: "hunk-list" }, h("div", { class: "dim" }, "Loading hunks…"));
  renderHunks(box, r);
  return h("div", {}, el, box);
}

function rowMenu(e: MouseEvent, r: Row) {
  const path = abs(r.path);
  contextMenu(e, [
    r.code === "U" ? { label: "Merge…", run: () => openResolver(r.path) } : { label: "Show Diff", run: () => showDiff(path, r.staged) },
    ...(r.code === "U"
      ? [
          { label: "Accept Yours", run: () => acceptSide(r.path, "ours") },
          { label: "Accept Theirs", run: () => acceptSide(r.path, "theirs") },
        ]
      : [{ label: r.staged ? "Unstage" : "Stage", run: () => (r.staged ? api.gitUnstage : api.gitStage)(root(), [r.path]).then(refreshGit, (err) => toast(String(err), "error")) }]),
    r.code !== "D" ? { label: "Open File", run: () => openFile(path) } : null,
    { label: "Show History", run: () => window.dispatchEvent(new CustomEvent("garnet:show-history", { detail: path })) },
    null,
    { label: isViewed(r.path, r.counts) ? "Mark as Not Viewed" : "Mark as Viewed", run: () => setViewed(r.path, r.counts, !isViewed(r.path, r.counts)) },
  ]);
}

/// Partial staging: hunks of index→working copy (stage) or HEAD→index (unstage)

async function renderHunks(box: HTMLElement, r: Row) {
  const path = abs(r.path);
  try {
    const [a, b] = r.staged
      ? [(await api.gitFileAt(root(), "HEAD", path)) ?? "", (await api.gitFileAt(root(), "", path)) ?? ""]
      : [(await api.gitFileAt(root(), "", path)) ?? "", await api.readFile(path)];
    const hunks = patchHunks(a, b);
    const al = patchLines(a).map(displayLine);
    const bl = patchLines(b).map(displayLine);
    if (!hunks.length) return box.replaceChildren(h("div", { class: "dim" }, "No line changes."));
    box.replaceChildren(
      ...hunks.map((hk) => {
        const lines = [...al.slice(hk.a0, hk.a1).map((l) => ["del", l]), ...bl.slice(hk.b0, hk.b1).map((l) => ["add", l])];
        const shown = lines.slice(0, 12);
        return h(
          "div",
          { class: "hunk" },
          h(
            "div",
            { class: "hunk-head" },
            h("span", {}, `Lines ${hk.b0 + 1}–${Math.max(hk.b0 + 1, hk.b1)} (${hunkKind(hk)})`),
            h("span", { class: "spacer" }),
            h(
              "button",
              {
                class: "btn small",
                onclick: async () => {
                  const patch = r.staged ? buildPatch(r.path, b, a, [swapHunk(hk)]) : buildPatch(r.path, a, b, [hk]);
                  await api.gitStagePatch(root(), path, patch).then(refreshGit, (err) => toast(String(err), "error"));
                },
              },
              r.staged ? "Unstage Hunk" : "Stage Hunk",
            ),
          ),
          h("pre", { class: "hunk-body" }, ...shown.map(([k, l]) => h("div", { class: k }, `${k === "del" ? "-" : "+"} ${l}`)), lines.length > shown.length ? h("div", { class: "dim" }, `… ${lines.length - shown.length} more lines`) : null),
        );
      }),
    );
  } catch (e) {
    box.replaceChildren(h("div", { class: "error-text" }, String(e)));
  }
}

function render() {
  groupBtn.title = `Group by: ${setting("git.groupBy") === "directory" ? "Directory" : "Changelist"} (click to switch)`;
  const q = filterInput.value;
  commitBox.hidden = !!compare;
  if (compare) {
    const c = compare;
    const files = filterPaths(c.files, q);
    compareBanner.hidden = false;
    compareBanner.replaceChildren(
      icon("git-compare"),
      h("span", {}, `${c.base}…HEAD · ${c.files.length} file${c.files.length === 1 ? "" : "s"} · ${c.files.filter((f) => isViewed(f.path, f)).length} viewed`),
      h("span", { class: "spacer" }),
      h("button", { class: "btn small", onclick: () => ((compare = null), refreshGit()) }, "Exit"),
    );
    list.replaceChildren(
      ...(files.length
        ? fileTree(files, "compare", (f, depth) =>
            h(
              "div",
              {
                class: `change-row git-${statusLabel[f.status] ?? "modified"}${isViewed(f.path, f) ? " viewed" : ""}`,
                style: `padding-left:${6 + depth * 14}px`,
                title: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path,
                onclick: () => showCompareDiff(f),
              },
              h("span", { class: "twisty-space" }),
              badge(f.status),
              h("span", { class: "change-name" }, basename(f.path)),
              h("span", { class: "spacer" }),
              counts(f),
              viewedBox(f.path, f),
            ),
          render)
        : [h("div", { class: "empty" }, q ? "No files match." : "No differences.")]),
    );
    return;
  }
  compareBanner.hidden = true;
  const groups = rowsFor();
  list.replaceChildren(
    ...groups.map((g) => {
      const rows = filterPaths(g.rows, q);
      return h(
        "div",
        { class: "change-section" },
        h(
          "div",
          { class: "change-head" },
          h("span", {}, `${g.title} · ${g.rows.length}`),
          h("span", { class: "spacer" }),
          g.staged === null
            ? null
            : iconButton(g.staged ? "remove" : "add", g.staged ? "Unstage all" : "Stage all", () =>
                (g.staged ? api.gitUnstage : api.gitStage)(root(), g.rows.map((i) => i.path)).then(refreshGit, (err) => toast(String(err), "error")),
              ),
        ),
        ...fileTree(rows, g.key, (r, depth) => changeRow(r, depth, g.key), render),
      );
    }),
  );
  if (!groups.length) list.replaceChildren(h("div", { class: "empty" }, "No local changes."));
}

function renderOpBanner() {
  const { op, conflicts } = opState;
  opBanner.hidden = !op && !conflicts.length;
  if (opBanner.hidden) return;
  const label = op ? `${op[0].toUpperCase()}${op.slice(1)} in progress` : "Unresolved conflicts";
  opBanner.replaceChildren(
    ...[
    icon("warning"),
    h("span", {}, conflicts.length ? `${label} · ${conflicts.length} conflict${conflicts.length > 1 ? "s" : ""}` : label),
    h("span", { class: "spacer" }),
    conflicts.length ? h("button", { class: "btn small", onclick: () => showConflicts() }, "Resolve…") : null,
    op ? h("button", { class: "btn small", onclick: () => abortOperation(op) }, "Abort") : null,
    op && !conflicts.length ? h("button", { class: "btn small primary", onclick: () => continueOperation(op) }, "Continue") : null,
    ].filter((x): x is HTMLElement => !!x),
  );
}

export async function refreshGit() {
  headCache.clear();
  if (!state.project?.git) {
    list.replaceChildren(h("div", { class: "empty" }, "Not a git repository."));
    branchEl.textContent = "";
    opBanner.hidden = compareBanner.hidden = true;
    return;
  }
  if (!isTrusted()) {
    list.replaceChildren(h("div", { class: "empty" }, "Trust project to enable Git. ", h("button", { class: "btn", onclick: () => askTrust() }, "Trust Project…")));
    branchEl.textContent = "Trust project to enable Git";
    branchEl.onclick = () => askTrust();
    opBanner.hidden = compareBanner.hidden = true;
    return;
  }
  branchEl.onclick = null;
  const [status, branch, op, unstaged, staged] = await Promise.all([
    api.gitStatus(root()).catch(() => []),
    api.gitBranch(root()).catch(() => ""),
    api.gitOpState(root()).catch((): OpState => ({ op: "", conflicts: [] })),
    api.gitDiffFiles(root(), []).catch(() => []),
    api.gitDiffFiles(root(), ["--cached"]).catch(() => []),
    loadViewed(),
  ]);
  entries = status;
  opState = op;
  currentBranch = branch;
  unstagedCounts = new Map(unstaged.map((f) => [f.path, f]));
  stagedCounts = new Map(staged.map((f) => [f.path, f]));
  branchEl.replaceChildren(icon("git-branch"), ` ${branch}`);
  branchHead.replaceChildren(icon("git-branch"), ` ${branch}`);
  renderOpBanner();
  render();
  if (!worktreeList.hidden) refreshWorktrees();
  const decor = new Map<string, string>();
  for (const e of entries) {
    const code = e.worktree !== " " ? e.worktree : e.index;
    const label = statusLabel[code] ?? "modified";
    decor.set(abs(e.path), label);
    let dir = abs(e.path);
    while ((dir = dir.slice(0, dir.lastIndexOf("/"))).length > root().length) if (!decor.has(dir)) decor.set(dir, "dir-changed");
  }
  setGitDecorations(decor);
  refreshGutter();
}
window.addEventListener("garnet:git-refresh", () => refreshGit());

export const gitOpState = () => opState;

async function commit() {
  const msg = message.value.trim();
  if (!msg) return toast("Enter a commit message.");
  if (opState.conflicts.length) return toast("Resolve the merge conflicts first.", "error");
  const staged = entries.filter((e) => e.index !== " " && e.index !== "?");
  if (!staged.length) return toast("Nothing staged. Stage files with + first.");
  if (setting("git.checkProblemsBeforeCommit")) {
    const stagedPaths = new Set(staged.map((e) => abs(e.path)));
    const errors = monaco.editor.getModelMarkers({}).filter((m) => m.severity === monaco.MarkerSeverity.Error && stagedPaths.has(m.resource.fsPath));
    if (errors.length && !(await ask(`${errors.length} error(s) in staged files (see Problems). Commit anyway?`, { kind: "warning", okLabel: "Commit", cancelLabel: "Cancel" }))) return;
  }
  try {
    const out = await api.gitCommit(root(), msg);
    message.value = "";
    toast(out.split("\n")[0] || "Committed");
  } catch (e) {
    toast(String(e), "error");
  }
  refreshGit();
}

export async function showDiff(path: string, staged = false) {
  const original = await api.gitShow(root(), path, staged ? "HEAD" : "");
  const base = original || (staged ? "" : await api.gitShow(root(), path, "HEAD"));
  await openDiffTab(path, base, `${basename(path)} (diff)`);
}

export function diffActiveFile() {
  const t = activeTab();
  if (t) showDiff(t.path);
}

/// Compare with branch: the PR-style view of `git diff <base>...HEAD`

export async function compareWithBranch() {
  if (!state.project?.git || !isTrusted()) return toast("Trust project to enable Git.");
  const list = await branches().catch((e) => (toast(String(e), "error"), []));
  quickPick({
    placeholder: "Compare HEAD with branch (changes since the merge base, like a pull request)",
    items: list.filter((b) => !b.current).map((b) => ({ label: b.name, icon: b.remote ? "cloud" : "git-branch", data: b.name })),
    onAccept: async (item, q) => {
      const base = (item?.data as string | undefined) ?? q.trim();
      if (!base) return;
      try {
        const [mergeBase, files] = await Promise.all([api.git(root(), "merge-base", base, "HEAD"), api.gitDiffFiles(root(), [`${base}...HEAD`])]);
        compare = { base, mergeBase: mergeBase.trim(), files };
        collapsed.clear();
        render();
      } catch (e) {
        toast(`Compare failed: ${e}`, "error");
      }
    },
  });
}

async function showCompareDiff(f: ChangedFile) {
  if (!compare) return;
  const [left, right] = await Promise.all([api.gitFileAt(root(), compare.mergeBase, f.oldPath ?? f.path), api.gitFileAt(root(), "HEAD", f.path)]);
  openTextDiff(`compare:${compare.base}:${f.path}`, abs(f.path), left ?? "", right ?? "", `${basename(f.path)} (${compare.base}…HEAD)`, `${f.oldPath ?? f.path} @ merge base with ${compare.base} ↔ ${f.path} @ HEAD`);
}

/// Worktrees section

async function refreshWorktrees() {
  if (!state.project?.git || !isTrusted()) return worktreeList.replaceChildren();
  const trees = await listWorktrees().catch(() => [] as Worktree[]);
  const dirty = await Promise.all(trees.map((t) => api.git(t.path, "status", "--porcelain", "--untracked-files=no").then((s) => !!s.trim(), () => false)));
  worktreeList.replaceChildren(
    ...trees.map((t, i) => {
      const current = t.path === state.project?.root;
      const menu = (e: MouseEvent) =>
        contextMenu(e, [
          current ? null : { label: "Open in This Window", run: () => openWorktree(t.path, false) },
          { label: "Open in New Window", run: () => openWorktree(t.path, true) },
          { label: "Reveal in Finder", run: () => api.revealInFinder(t.path) },
          ...(current || i === 0 ? [] : [null, { label: "Remove Worktree…", run: () => removeWorktree(t).then(refreshWorktrees) }]),
        ]);
      return h(
        "div",
        { class: `change-row worktree-row${current ? " current" : ""}`, title: t.path, onclick: menu, oncontextmenu: menu },
        icon(current ? "check" : "repo"),
        h("span", { class: "change-name" }, basename(t.path)),
        h("span", { class: "change-dir" }, t.branch),
        dirty[i] ? h("span", { class: "dirty-dot", title: "Uncommitted changes" }, "●") : null,
      );
    }),
    h("div", { class: "change-row dim", onclick: () => newWorktree() }, icon("add"), h("span", {}, "New Worktree from Branch…")),
  );
}

/// Live gutter change markers: buffer vs HEAD, diffed in the worker while typing

const headCache = new Map<string, string | null>();
let gutter: monaco.editor.IEditorDecorationsCollection | null = null;
let gutterState: { path: string; hunks: LineHunk[]; head: string } | null = null;
let gutterSeq = 0;

async function headText(path: string): Promise<string | null> {
  if (!headCache.has(path)) {
    const text = await api.gitFileAt(root(), "HEAD", path).catch(() => null);
    const added = entries.some((e) => abs(e.path) === path && e.index === "A");
    headCache.set(path, text ?? (added ? "" : null));
  }
  return headCache.get(path)!;
}

async function updateGutter() {
  const t = activeTab();
  const mine = ++gutterSeq;
  if (!t || t.kind !== "file" || !state.project?.git || !isTrusted()) {
    gutterState = null;
    return gutter?.clear();
  }
  const head = await headText(t.path);
  if (head === null) {
    gutterState = null;
    return gutter?.clear();
  }
  const hunks = await diffAsync(head, t.model.getValue());
  if (mine !== gutterSeq || activeTab() !== t) return;
  gutterState = { path: t.path, hunks, head };
  gutter ??= editor.createDecorationsCollection();
  gutter.set(
    hunks.map((hk) => {
      const kind = hunkKind(hk);
      const start = kind === "deleted" ? Math.max(hk.b0, 1) : hk.b0 + 1;
      const end = kind === "deleted" ? start : hk.b1;
      return {
        range: new monaco.Range(start, 1, end, 1),
        options: { isWholeLine: true, linesDecorationsClassName: `git-gutter-${kind}`, linesDecorationsTooltip: "Click to show the change" },
      };
    }),
  );
}

export const refreshGutter = debounce(updateGutter, 120);

events.activated.on(() => {
  refreshGutter();
  clearBlame();
  closeHunkPopup();
});
events.saved.on(() => refreshGutter());
editor.onDidChangeModelContent(() => {
  closeHunkPopup();
  if (setting("git.liveGutter")) refreshGutter();
});

function hunkAtLine(line: number): LineHunk | undefined {
  return gutterState?.hunks.find((hk) => {
    const start = hunkKind(hk) === "deleted" ? Math.max(hk.b0, 1) : hk.b0 + 1;
    const end = hunkKind(hk) === "deleted" ? start : hk.b1;
    return line >= start && line <= end;
  });
}

editor.onMouseDown((e) => {
  if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS || !e.target.position) return;
  const hk = hunkAtLine(e.target.position.lineNumber);
  if (hk) showHunkPopup(hk);
});

/// Replaces the buffer lines of a hunk with the HEAD lines (undoable).
function rollbackHunk(hk: LineHunk) {
  const t = activeTab();
  if (!t || !gutterState) return;
  const model = t.model;
  const eol = model.getEOL();
  const old = splitLines(gutterState.head).slice(hk.a0, hk.a1).map((l) => l.replace(/\r$/, ""));
  const count = model.getLineCount();
  let range: monaco.Range;
  let text: string;
  if (hk.b1 < count) {
    range = new monaco.Range(hk.b0 + 1, 1, hk.b1 + 1, 1);
    text = old.map((l) => l + eol).join("");
  } else if (hk.b0 > 0) {
    range = new monaco.Range(hk.b0, model.getLineMaxColumn(hk.b0), count, model.getLineMaxColumn(count));
    text = old.map((l) => eol + l).join("");
  } else {
    range = model.getFullModelRange();
    text = old.join(eol);
  }
  model.pushEditOperations(editor.getSelections(), [{ range, text }], () => null);
  model.pushStackElement();
}

async function stageHunk(hk: LineHunk) {
  const t = activeTab();
  if (!t) return;
  try {
    const index = await api.gitFileAt(root(), "", t.path);
    if (index === null) return toast("The file is not tracked yet; stage the whole file from the Commit tool window.");
    const patch = stagePatch(rel(t.path), index, t.model.getValue(), hk.b0, hk.b1);
    if (patch === null) return toast("This change is already staged.");
    await api.gitStagePatch(root(), t.path, patch);
    toast("Hunk staged.");
    refreshGit();
  } catch (e) {
    toast(`Stage failed: ${e}`, "error");
  }
}

let closeHunkPopup = () => {};

async function showHunkPopup(hk: LineHunk) {
  closeHunkPopup();
  const t = activeTab();
  if (!t || !gutterState) return;
  const kind = hunkKind(hk);
  const old = splitLines(gutterState.head).slice(hk.a0, hk.a1).join("\n");
  const anchorLine = Math.max(1, Math.min(t.model.getLineCount(), kind === "deleted" ? Math.max(hk.b0, 1) : hk.b1));
  const pos = editor.getScrolledVisiblePosition({ lineNumber: anchorLine, column: 1 });
  const rect = editor.getDomNode()!.getBoundingClientRect();
  const index = gutterState.hunks.indexOf(hk);
  const go = (d: number) => {
    const hunks = gutterState?.hunks ?? [];
    const next = hunks[(index + d + hunks.length) % hunks.length];
    if (!next) return;
    editor.revealLineInCenterIfOutsideViewport(next.b0 + 1);
    editor.setPosition({ lineNumber: Math.max(1, next.b0 + 1), column: 1 });
    requestAnimationFrame(() => showHunkPopup(next));
  };
  const body = h("pre", { class: "hunk-old" });
  const popup = h(
    "div",
    { class: "hunk-popup", style: `left:${rect.left + 40}px;top:${rect.top + (pos?.top ?? 0) + (pos?.height ?? 18) + 2}px` },
    h(
      "div",
      { class: "view-toolbar" },
      iconButton("arrow-up", "Previous Change (⌃⌥⇧↑)", () => go(-1)),
      iconButton("arrow-down", "Next Change (⌃⌥⇧↓)", () => go(1)),
      h("button", { class: "btn small", title: "Rollback Lines (⌘⌥Z)", onclick: () => (closeHunkPopup(), rollbackHunk(hk)) }, "Rollback"),
      h("button", { class: "btn small", onclick: () => (closeHunkPopup(), stageHunk(hk)) }, "Stage This Hunk"),
      h("button", { class: "btn small", onclick: () => (closeHunkPopup(), showDiff(t.path)) }, "Show Diff"),
      h("span", { class: "spacer" }),
      h("span", { class: "dim" }, `${index + 1} of ${gutterState.hunks.length}`),
      iconButton("close", "Close (Esc)", () => closeHunkPopup()),
    ),
    kind === "added" ? h("div", { class: "dim hunk-note" }, "Added lines; nothing in HEAD.") : body,
  );
  const backdrop = h("div", { class: "ctx-backdrop", onmousedown: (e: MouseEvent) => e.target === backdrop && closeHunkPopup() }, popup);
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeHunkPopup();
  closeHunkPopup = () => {
    backdrop.remove();
    window.removeEventListener("keydown", onKey, true);
    closeHunkPopup = () => {};
  };
  window.addEventListener("keydown", onKey, true);
  document.getElementById("overlay-root")!.append(backdrop);
  if (kind !== "added") {
    body.innerHTML = await monaco.editor.colorize(old, t.model.getLanguageId(), { tabSize: t.model.getOptions().tabSize });
  }
  const r = popup.getBoundingClientRect();
  if (r.bottom > window.innerHeight) popup.style.top = `${Math.max(0, window.innerHeight - r.height - 8)}px`;
}

function caretHunk(): LineHunk | undefined {
  const line = editor.getPosition()?.lineNumber;
  return line ? hunkAtLine(line) : undefined;
}

export function rollbackLines() {
  const sel = editor.getSelection();
  if (!sel || !gutterState) return;
  const chosen = gutterState.hunks.filter((hk) => overlapsNew(hk, sel.startLineNumber - 1, sel.endLineNumber));
  if (!chosen.length) return toast("No changes at the caret.");
  for (const hk of [...chosen].reverse()) rollbackHunk(hk);
}

export function stageHunkAtCaret() {
  const hk = caretHunk();
  if (hk) stageHunk(hk);
  else toast("No change at the caret.");
}

export function showChangeAtCaret() {
  const hk = caretHunk();
  if (hk) showHunkPopup(hk);
  else toast("No change at the caret.");
}

export function goToChange(dir: 1 | -1) {
  const hunks = gutterState?.hunks ?? [];
  const line = editor.getPosition()?.lineNumber ?? 1;
  if (!hunks.length) return toast("No changes in this file.");
  const starts = hunks.map((hk) => Math.max(1, hk.b0 + (hunkKind(hk) === "deleted" ? 0 : 1)));
  let i = dir > 0 ? starts.findIndex((s) => s > line) : starts.map((s, j) => [s, j]).filter(([s]) => s < line).pop()?.[1] ?? -1;
  if (i < 0) i = dir > 0 ? 0 : hunks.length - 1;
  editor.setPosition({ lineNumber: starts[i], column: 1 });
  editor.revealLineInCenterIfOutsideViewport(starts[i]);
  showHunkPopup(hunks[i]);
}

/// For the smoke test.
export const gutterHunks = () => gutterState?.hunks ?? [];
export const updateGutterNow = updateGutter;

/// Blame for the current line

let blameDecor: monaco.editor.IEditorDecorationsCollection | null = null;
let blameLine = 0;

function clearBlame() {
  blameDecor?.clear();
  blameEl.textContent = "";
  blameLine = 0;
}

editor.onDidChangeCursorPosition((e) => {
  if (blameLine && e.position.lineNumber !== blameLine) clearBlame();
});

export function ago(unix: number) {
  const s = Date.now() / 1000 - unix;
  const units: [number, string][] = [[31536000, "year"], [2592000, "month"], [86400, "day"], [3600, "hour"], [60, "minute"]];
  for (const [n, u] of units) if (s >= n) return `${Math.floor(s / n)} ${u}${Math.floor(s / n) > 1 ? "s" : ""} ago`;
  return "just now";
}

export async function blameCurrentLine() {
  const t = activeTab();
  const pos = editor.getPosition();
  if (!t || !pos) return;
  try {
    const b = await api.gitBlameLine(root(), t.path, pos.lineNumber);
    const text = b.hash.startsWith("00000000") ? "Not committed yet" : `${b.author}, ${ago(b.time)} · ${b.summary} (${b.hash})`;
    blameLine = pos.lineNumber;
    blameEl.replaceChildren(icon("git-commit"), ` ${text}`);
    blameDecor ??= editor.createDecorationsCollection();
    blameDecor.set([
      {
        range: new monaco.Range(pos.lineNumber, 1, pos.lineNumber, 1),
        options: { isWholeLine: true, after: { content: `    ${text}`, inlineClassName: "blame-inline" } },
      },
    ]);
  } catch (e) {
    toast(`Blame failed: ${e}`, "error");
  }
}

export const onGitChanged = debounce(() => refreshGit(), 400);
let fetchTimer = 0;
function scheduleFetch() {
  clearInterval(fetchTimer);
  const minutes = setting<number>("git.autoFetchMinutes");
  if (minutes > 0 && isTrusted())
    fetchTimer = window.setInterval(() => {
      if (state.project?.git) invoke("git_fetch", { root: root() }).then(() => refreshGit(), () => {});
    }, minutes * 60000);
}
onSettingsChange(() => {
  invoke("git_set_path", { path: setting<string>("git.path") }).catch((e) => toast(String(e), "error"));
  scheduleFetch();
});
window.addEventListener("garnet:trusted", () => {
  scheduleFetch();
  refreshGit();
});
