import { ask } from "@tauri-apps/plugin-dialog";
import { activeTab, editor, events, monaco, openDiffTab, openFile } from "./editor";
import { api, invoke, type GitStatusEntry } from "./ipc";
import { abs, basename, debounce, root, state } from "./state";
import { setGitDecorations } from "./tree";
import { onSettingsChange, setting } from "./settings";
import { h, icon, iconButton, statusSlot, toast } from "./ui";

const branchEl = statusSlot("branch", "left");
const blameEl = statusSlot("blame", "left");

const message = h("textarea", { class: "commit-message", placeholder: "Commit message (⌘↩ to commit)", rows: 4, spellcheck: true });
const commitBtn = h("button", { class: "btn primary", onclick: () => commit() }, "Commit");
const list = h("div", { class: "changes" });
const branchHead = h("div", { class: "commit-branch" });
export const commitView = h(
  "div",
  { class: "commit-view" },
  h("div", { class: "view-toolbar" }, branchHead, h("span", { class: "spacer" }), iconButton("refresh", "Refresh", () => refreshGit())),
  list,
  h("div", { class: "commit-box" }, message, h("div", { class: "commit-actions" }, commitBtn)),
);
message.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.metaKey) {
    e.preventDefault();
    commit();
  }
});

let entries: GitStatusEntry[] = [];

const statusLabel: Record<string, string> = { M: "modified", A: "added", D: "deleted", R: "renamed", "?": "untracked", U: "conflict", C: "copied" };

function row(e: GitStatusEntry, staged: boolean) {
  const code = staged ? e.index : e.worktree;
  const path = abs(e.path);
  return h(
    "div",
    { class: `change-row git-${statusLabel[code] ?? "modified"}`, title: `${e.path} (${statusLabel[code] ?? code})`, onclick: () => showDiff(path, staged) },
    icon("file"),
    h("span", { class: "change-name" }, basename(e.path)),
    h("span", { class: "change-dir" }, e.path.split("/").slice(0, -1).join("/")),
    h("span", { class: "change-code" }, code === "?" ? "U" : code),
    iconButton(staged ? "remove" : "add", staged ? "Unstage" : "Stage", (ev) => {
      ev.stopPropagation();
      (staged ? api.gitUnstage : api.gitStage)(root(), [e.path]).then(refreshGit, (err) => toast(String(err), "error"));
    }),
    !staged && code !== "D" ? iconButton("go-to-file", "Open file", (ev) => (ev.stopPropagation(), openFile(path))) : null,
  );
}

function section(title: string, items: GitStatusEntry[], staged: boolean) {
  if (!items.length) return null;
  return h(
    "div",
    { class: "change-section" },
    h(
      "div",
      { class: "change-head" },
      h("span", {}, `${title} · ${items.length}`),
      h("span", { class: "spacer" }),
      iconButton(staged ? "remove" : "add", staged ? "Unstage all" : "Stage all", () =>
        (staged ? api.gitUnstage : api.gitStage)(root(), items.map((i) => i.path)).then(refreshGit, (err) => toast(String(err), "error")),
      ),
    ),
    ...items.map((e) => row(e, staged)),
  );
}

export async function refreshGit() {
  if (!state.project?.git) {
    list.replaceChildren(h("div", { class: "empty" }, "Not a git repository."));
    branchEl.textContent = "";
    return;
  }
  const [status, branch] = await Promise.all([api.gitStatus(root()).catch(() => []), api.gitBranch(root()).catch(() => "")]);
  entries = status;
  branchEl.replaceChildren(icon("git-branch"), ` ${branch}`);
  branchHead.replaceChildren(icon("git-branch"), ` ${branch}`);
  const staged = entries.filter((e) => e.index !== " " && e.index !== "?");
  const unstaged = entries.filter((e) => e.worktree !== " ");
  list.replaceChildren(
    ...[section("Staged", staged, true), section("Changes", unstaged, false)].filter((x): x is HTMLDivElement => !!x),
  );
  if (!entries.length) list.replaceChildren(h("div", { class: "empty" }, "No local changes."));
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

async function commit() {
  const msg = message.value.trim();
  if (!msg) return toast("Enter a commit message.");
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

/// Gutter change markers for the active editor

let gutter: monaco.editor.IEditorDecorationsCollection | null = null;

export const refreshGutter = debounce(async () => {
  const t = activeTab();
  if (!t || t.kind !== "file" || !state.project?.git) return gutter?.clear();
  const hunks = await api.gitDiffHunks(root(), t.path).catch(() => []);
  if (activeTab() !== t) return;
  gutter ??= editor.createDecorationsCollection();
  gutter.set(
    hunks.map((hk) => ({
      range: new monaco.Range(hk.start, 1, hk.end, 1),
      options: { isWholeLine: true, linesDecorationsClassName: `git-gutter-${hk.kind}` },
    })),
  );
}, 150);

events.activated.on(() => {
  refreshGutter();
  clearBlame();
});
events.saved.on(() => refreshGutter());

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

function ago(unix: number) {
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
onSettingsChange(() => {
  invoke("git_set_path", { path: setting<string>("git.path") });
  clearInterval(fetchTimer);
  const minutes = setting<number>("git.autoFetchMinutes");
  if (minutes > 0)
    fetchTimer = window.setInterval(() => {
      if (state.project?.git) invoke("git_fetch", { root: root() }).then(() => refreshGit(), () => {});
    }, minutes * 60000);
});
