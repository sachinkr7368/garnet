import { ask, message, open } from "@tauri-apps/plugin-dialog";
import { saveAll } from "./editor";
import { refreshGit } from "./git";
import { cloneDialog, createPullRequest } from "./github";
import { api, invoke } from "./ipc";
import { isDarkTheme, isTrusted, onSettingsChange, recentProjects, toggleTheme } from "./settings";
import { basename, dirname, root, state } from "./state";
import { h, icon, iconButton, inputBox, quickPick, toast, withTip, type PickItem } from "./ui";

const switchers = document.getElementById("switchers")!;
const projectBtn = withTip(h("button", { class: "switcher" }), "Projects", "projects");
const worktreeBtn = withTip(h("button", { class: "switcher" }), "Git worktrees", "worktrees");
const branchBtn = withTip(h("button", { class: "switcher" }), "Git branches", "branches");
switchers.append(projectBtn, worktreeBtn, branchBtn);

const themeBtn = iconButton("color-mode", "", () => toggleTheme());
themeBtn.id = "theme-toggle";
document.getElementById("toolbar")!.append(themeBtn);
const labelThemeBtn = () => (themeBtn.title = `Toggle theme (now ${isDarkTheme() ? "dark" : "light"})`);
labelThemeBtn();
onSettingsChange(labelThemeBtn);

let openProjectHere: (path: string) => void = () => {};
export function initToolbar(switchProject: (path: string) => void) {
  openProjectHere = switchProject;
}

const git = (...args: string[]) => invoke<string>("git_run", { root: root(), args });

async function run(label: string, fn: () => Promise<unknown>) {
  try {
    const out = await fn();
    toast(typeof out === "string" && out.trim() ? `${label}: ${out.trim().split("\n").slice(-2).join(" ")}` : `${label}: done`);
  } catch (e) {
    toast(`${label} failed: ${e}`, "error");
  }
  refreshGit();
  refreshToolbar();
}

/// Toolbar labels

export async function refreshToolbar() {
  const p = state.project;
  if (!p) return;
  projectBtn.replaceChildren(icon("folder"), h("span", { class: "name" }, p.name), icon("chevron-down"));
  if (!p.git || !isTrusted()) {
    worktreeBtn.hidden = branchBtn.hidden = true;
    return;
  }
  const [branch, counts, worktrees] = await Promise.all([
    git("rev-parse", "--abbrev-ref", "HEAD").catch(() => ""),
    git("rev-list", "--left-right", "--count", "HEAD...@{upstream}").catch(() => ""),
    git("worktree", "list", "--porcelain").catch(() => ""),
  ]);
  const [ahead, behind] = counts.trim().split(/\s+/).map(Number);
  branchBtn.hidden = false;
  branchBtn.replaceChildren(
    icon("git-branch"),
    h("span", { class: "name" }, branch.trim() || "detached"),
    h("span", { class: "counts" }, counts ? `${ahead ? `↑${ahead}` : ""}${behind ? ` ↓${behind}` : ""}`.trim() : ""),
    icon("chevron-down"),
  );
  const label = worktreeLabel(parseWorktrees(worktrees), p.root);
  worktreeBtn.hidden = !label;
  if (label)
    worktreeBtn.replaceChildren(
      ...[icon(label.main ? "repo" : "repo-forked"), h("span", { class: "name" }, label.name), label.main && h("span", { class: "tag" }, "main worktree"), icon("chevron-down")].filter((n): n is HTMLSpanElement => !!n),
    );
}

export interface Worktree {
  path: string;
  branch: string;
  main: boolean;
}

/// `git worktree list --porcelain`; the first entry is the main checkout.
export function parseWorktrees(out: string): Worktree[] {
  return out
    .split(/\n\n+/)
    .map((b) => b.trim())
    .filter((b) => b.startsWith("worktree "))
    .map((b, i) => ({
      path: b.match(/^worktree (.+)$/m)![1],
      branch: b.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? (/^detached$/m.test(b) ? "detached" : /^bare$/m.test(b) ? "bare" : ""),
      main: i === 0,
    }));
}

/// The worktree that contains `root` (the deepest one, since worktrees can live inside the main checkout).
export function currentWorktree(trees: Worktree[], root: string): Worktree | undefined {
  return trees.filter((t) => root === t.path || root.startsWith(t.path + "/")).sort((a, b) => b.path.length - a.path.length)[0];
}

/// Toolbar label: the current worktree's folder name; the main checkout shows the repository name and a tag.
export function worktreeLabel(trees: Worktree[], root: string): { name: string; main: boolean } | null {
  const t = currentWorktree(trees, root);
  return t ? { name: basename(t.path), main: t.main } : null;
}

/// Project switcher

projectBtn.onclick = async () => {
  const recent = (await recentProjects()).filter((p) => p !== state.project?.root);
  quickPick({
    placeholder: "Open project (Enter: this window, choose “new window” entries to open side by side)",
    items: [
      ...recent.map((p) => ({ label: basename(p), description: p, icon: "folder", data: { path: p, newWindow: false } })),
      ...recent.map((p) => ({ label: `${basename(p)} — new window`, description: p, icon: "empty-window", data: { path: p, newWindow: true } })),
      { label: "Open Folder…", icon: "folder-opened", data: { path: "", newWindow: false } },
      { label: "Open Folder in New Window…", icon: "empty-window", data: { path: "", newWindow: true } },
      { label: "Clone from GitHub…", icon: "github", data: { clone: true } },
    ],
    onAccept: async (item) => {
      const d = item?.data as { path?: string; newWindow?: boolean; clone?: boolean } | undefined;
      if (!d) return;
      if (d.clone) return cloneDialog(openProjectHere);
      let path = d.path;
      if (!path) {
        const picked = await open({ directory: true });
        if (typeof picked !== "string") return;
        path = picked;
      }
      if (d.newWindow) invoke("open_new_window", { path });
      else openProjectHere(path);
    },
  });
};

/// Branch switcher

export interface Branch {
  name: string;
  remote: boolean;
  current: boolean;
  upstream: string;
  track: string;
}

export async function branches(): Promise<Branch[]> {
  const out = await git("for-each-ref", "--sort=-committerdate", "--format=%(refname)%09%(HEAD)%09%(upstream:short)%09%(upstream:track)", "refs/heads", "refs/remotes");
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [ref, head, upstream, track] = l.split("\t");
      const remote = ref.startsWith("refs/remotes/");
      return { name: ref.replace(/^refs\/(heads|remotes)\//, ""), remote, current: head === "*", upstream, track };
    })
    .filter((b) => !b.name.endsWith("/HEAD"));
}

branchBtn.onclick = async () => {
  const list = await branches().catch((e) => (toast(String(e), "error"), [] as Branch[]));
  const current = list.find((b) => b.current);
  const actions: PickItem[] = [
    { label: "New Branch from Current…", icon: "add", data: { action: "new" } },
    { label: "Fetch", icon: "sync", description: "git fetch --all --prune", data: { action: "fetch" } },
    { label: "Pull", icon: "arrow-down", description: current?.upstream ? `from ${current.upstream}` : "", data: { action: "pull" } },
    { label: "Push", icon: "arrow-up", description: current?.upstream ? `to ${current.upstream}` : "sets upstream on origin", data: { action: "push" } },
    { label: "Create Pull Request…", icon: "git-pull-request", description: "GitHub", data: { action: "pr" } },
  ];
  quickPick({
    placeholder: "Branches (type to filter, Enter for actions)",
    items: [
      ...actions,
      ...list.map((b) => ({
        label: b.name,
        icon: b.current ? "check" : b.remote ? "cloud" : "git-branch",
        description: [b.remote ? "remote" : "local", b.track].filter(Boolean).join(" "),
        data: { branch: b },
      })),
    ],
    onAccept: (item) => {
      const d = item?.data as { action?: string; branch?: Branch } | undefined;
      if (!d) return;
      if (d.branch) return branchActions(d.branch);
      if (d.action === "new") return newBranch();
      if (d.action === "fetch") return run("Fetch", () => git("fetch", "--all", "--prune"));
      if (d.action === "pull") return run("Pull", () => git("pull", "--ff-only"));
      if (d.action === "push") return push(current);
      if (d.action === "pr") return createPullRequest();
    },
  });
};

function push(current?: Branch) {
  if (!current) return toast("Not on a branch.", "error");
  return run("Push", () => (current.upstream ? git("push") : git("push", "--set-upstream", "origin", current.name)));
}

function branchActions(b: Branch) {
  const items: PickItem[] = b.current
    ? [
        { label: "Rename…", icon: "edit", data: "rename" },
        { label: "Push", icon: "arrow-up", data: "push" },
      ]
    : [
        { label: b.remote ? "Checkout as local tracking branch" : "Checkout", icon: "check", data: "checkout" },
        { label: "New Branch from This…", icon: "add", data: "branchFrom" },
        ...(b.remote ? [] : [{ label: "Rename…", icon: "edit", data: "rename" }]),
        { label: `Delete${b.remote ? " remote branch" : ""}…`, icon: "trash", data: "delete" },
      ];
  quickPick({
    placeholder: b.name,
    items,
    onAccept: async (item) => {
      switch (item?.data) {
        case "checkout":
          return checkout(b.remote ? b.name.replace(/^[^/]+\//, "") : b.name, b.remote ? b.name : undefined);
        case "branchFrom": {
          const name = await inputBox(`New branch from ${b.name}`);
          if (name) checkout(name.trim(), b.name, true);
          return;
        }
        case "rename": {
          const name = await inputBox(`Rename ${b.name}`, b.name);
          if (name && name !== b.name) run("Rename", () => git("branch", "-m", b.name, name.trim()));
          return;
        }
        case "push":
          return push(b);
        case "delete": {
          const ok = await ask(`Delete ${b.remote ? "remote " : ""}branch ${b.name}?`, { kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" });
          if (!ok) return;
          if (b.remote) {
            const [remote, ...rest] = b.name.split("/");
            return run("Delete", () => git("push", remote, "--delete", rest.join("/")));
          }
          return run("Delete", () =>
            git("branch", "-d", b.name).catch(async (e) => {
              if (await ask(`${b.name} is not fully merged. Force delete?\n\n${e}`, { kind: "warning", okLabel: "Force Delete", cancelLabel: "Cancel" })) return git("branch", "-D", b.name);
              return "kept";
            }),
          );
        }
      }
    },
  });
}

async function newBranch() {
  const name = await inputBox("New branch name (created from the current HEAD)");
  if (name) checkout(name.trim(), undefined, true);
}

/// Checks out a branch, asking how to handle local changes first.
async function checkout(name: string, from?: string, create = false) {
  await saveAll();
  const dirty = (await git("status", "--porcelain", "--untracked-files=no").catch(() => "")).trim();
  let stashed = false;
  if (dirty && !create) {
    const answer = await message(`You have uncommitted changes. How should they be handled when switching to ${name}?`, {
      kind: "warning",
      buttons: { yes: "Stash and Checkout", no: "Carry Changes", cancel: "Cancel" },
    });
    if (answer === "Stash and Checkout" || answer === "Yes") {
      await git("stash", "push", "-m", `garnet: before checkout ${name}`);
      stashed = true;
    } else if (answer !== "Carry Changes" && answer !== "No") return;
  }
  const args = create ? ["checkout", "-b", name, ...(from ? [from] : [])] : from ? ["checkout", "-b", name, "--track", from] : ["checkout", name];
  await run(`Checkout ${name}`, () =>
    git(...args).catch((e) => {
      if (!create && from && /already exists/.test(String(e))) return git("checkout", name);
      throw e;
    }),
  );
  if (stashed) toast(`Your changes were stashed ("garnet: before checkout ${name}"). Run git stash pop to restore them.`);
}

/// Worktree switcher

export const listWorktrees = async (): Promise<Worktree[]> => parseWorktrees(await git("worktree", "list", "--porcelain"));

worktreeBtn.onclick = async () => {
  const out = await git("worktree", "list", "--porcelain").catch((e) => (toast(String(e), "error"), ""));
  const trees = parseWorktrees(out);
  const current = currentWorktree(trees, state.project?.root ?? "");
  quickPick({
    title: `${trees.length} worktree${trees.length === 1 ? "" : "s"}`,
    placeholder: "Switch worktree or type to filter",
    items: [
      ...trees.map((t) => ({
        label: basename(t.path),
        description: `${t.main ? "main worktree · " : ""}${t.branch} · ${t.path}`,
        icon: t === current ? "check" : t.main ? "repo" : "repo-forked",
        data: t,
      })),
      { label: "New Worktree from Branch…", icon: "add", data: "new" },
    ],
    onAccept: (item) => {
      if (item?.data === "new") return newWorktree();
      const t = item?.data as Worktree | undefined;
      if (t) worktreeActions(t, trees[0]?.path);
    },
  });
};

export const openWorktree = (path: string, newWindow: boolean) => (newWindow ? invoke("open_new_window", { path }) : openProjectHere(path));

export async function removeWorktree(t: Worktree) {
  const ok = await ask(`Remove worktree ${t.path}? Its folder is deleted; the branch ${t.branch} is kept.`, { kind: "warning", okLabel: "Remove", cancelLabel: "Cancel" });
  if (!ok) return;
  await run("Remove worktree", () =>
    git("worktree", "remove", t.path).catch(async (e) => {
      if (await ask(`The worktree has local changes.\n\n${e}\n\nRemove anyway and discard them?`, { kind: "warning", okLabel: "Force Remove", cancelLabel: "Cancel" }))
        return git("worktree", "remove", "--force", t.path);
      return "kept";
    }),
  );
}

function worktreeActions(t: Worktree, mainPath?: string) {
  const isCurrent = t.path === state.project?.root;
  quickPick({
    placeholder: `${basename(t.path)} (${t.branch})`,
    items: [
      ...(isCurrent ? [] : [{ label: "Open in This Window", icon: "folder", data: "here" }]),
      { label: "Open in New Window", icon: "empty-window", data: "window" },
      { label: "Reveal in Finder", icon: "go-to-file", data: "reveal" },
      ...(isCurrent || t.path === mainPath ? [] : [{ label: "Remove Worktree…", icon: "trash", data: "remove" }]),
    ],
    onAccept: (item) => {
      if (item?.data === "here" || item?.data === "window") openWorktree(t.path, item.data === "window");
      if (item?.data === "reveal") api.revealInFinder(t.path);
      if (item?.data === "remove") removeWorktree(t);
    },
  });
}

export async function newWorktree() {
  const list = await branches();
  quickPick({
    placeholder: "Branch for the new worktree (or type a new branch name)",
    items: list.filter((b) => !b.current).map((b) => ({ label: b.name, icon: b.remote ? "cloud" : "git-branch", data: b })),
    onAccept: async (item, query) => {
      const b = item?.data as Branch | undefined;
      const branch = b ? b.name.replace(b.remote ? /^[^/]+\// : /^$/, "") : query.trim();
      if (!branch) return;
      const suggested = `${dirname(root())}/${basename(root())}-${branch.replace(/[^\w.-]+/g, "-")}`;
      const path = await inputBox("Worktree folder", suggested);
      if (!path) return;
      const exists = list.some((x) => !x.remote && x.name === branch);
      const args = exists ? ["worktree", "add", path, branch] : b?.remote ? ["worktree", "add", "-b", branch, path, b.name] : ["worktree", "add", "-b", branch, path];
      await run("New worktree", () => git(...args));
      if (await ask(`Open ${basename(path)} in a new window?`, { okLabel: "Open", cancelLabel: "Not now" })) invoke("open_new_window", { path });
    },
  });
}

export const showBranches = () => branchBtn.click();
export const showWorktrees = () => worktreeBtn.click();
export const showProjects = () => projectBtn.click();
export const pushCurrent = async () => push((await branches().catch(() => [] as Branch[])).find((b) => b.current));
export const pullCurrent = () => run("Update Project", () => git("pull", "--ff-only"));
