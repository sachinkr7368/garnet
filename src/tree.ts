import { handlePathMoved, openFile } from "./editor";
import { api, type DirEntry } from "./ipc";
import { globToRegExp, setting } from "./settings";
import { basename, dirname, rel, state } from "./state";
import { bottom, contextMenu, fileIcon, h, icon, iconButton, inputBox, modal, toast } from "./ui";
import { newTerminal } from "./terminal";
import { railsTreeEl, refreshRailsTree } from "./railsview";

interface Node {
  entry: DirEntry;
  depth: number;
  expanded: boolean;
  children: Node[] | null;
  row: HTMLElement;
  childBox: HTMLElement;
}

export const treeEl = h("div", { class: "tree", tabIndex: 0, role: "tree", "aria-label": "Project" });
const railsToggle = iconButton("list-tree", "Rails View (Models, Controllers, Views, …)", () => toggleRailsView());
let railsMode = false;
railsToggle.hidden = true;
railsTreeEl.hidden = true;

export function toggleRailsView(on = !railsMode) {
  railsMode = on && !!state.project?.rails;
  railsToggle.classList.toggle("active", railsMode);
  treeEl.hidden = railsMode;
  railsTreeEl.hidden = !railsMode;
  if (railsMode) refreshRailsTree();
}
export const treeView = h(
  "div",
  { class: "tree-view" },
  h(
    "div",
    { class: "view-toolbar" },
    iconButton("new-file", "New File", () => newPath(false)),
    iconButton("new-folder", "New Folder", () => newPath(true)),
    iconButton("refresh", "Refresh", () => refreshTree()),
    iconButton("collapse-all", "Collapse All", () => collapseAll()),
    railsToggle,
  ),
  treeEl,
  railsTreeEl,
);

const nodes = new Map<string, Node>();
let rootNode: Node | null = null;
let selected: string | null = null;
let gitDecor = new Map<string, string>();

function createNode(entry: DirEntry, depth: number): Node {
  const row = h("div", { class: "tree-row", style: `padding-left:${depth * 14 + 6}px` });
  const node: Node = { entry, depth, expanded: false, children: null, row, childBox: h("div", { class: "tree-children" }) };
  // Like RubyMine's single-click open: focus stays in the tree (keys keep working); double-click goes to the editor.
  row.addEventListener("click", () => {
    select(entry.path);
    if (entry.dir) toggle(node);
    else void openFile(entry.path).then(() => treeEl.focus({ preventScroll: true }));
  });
  row.addEventListener("dblclick", () => !entry.dir && void openFile(entry.path));
  row.addEventListener("contextmenu", (e) => showMenu(e, node));
  nodes.set(entry.path, node);
  paintRow(node);
  return node;
}

function paintRow(node: Node) {
  const { entry } = node;
  const status = gitDecor.get(entry.path);
  node.row.className = `tree-row${selected === entry.path ? " selected" : ""}${status ? ` git-${status}` : ""}`;
  node.row.setAttribute("role", "treeitem");
  node.row.setAttribute("aria-selected", String(selected === entry.path));
  if (entry.dir) node.row.setAttribute("aria-expanded", String(node.expanded));
  node.row.replaceChildren(
    entry.dir ? icon(node.expanded ? "chevron-down" : "chevron-right", "twisty") : h("span", { class: "twisty" }),
    entry.dir ? icon(node.expanded ? "folder-opened" : "folder", "file-icon dir") : fileIcon(entry.name),
    h("span", { class: "tree-label" }, entry.name),
  );
}

async function loadChildren(node: Node) {
  let entries: DirEntry[];
  try {
    entries = await api.listDir(node.entry.path);
  } catch (e) {
    toast(`Cannot read ${rel(node.entry.path)}: ${e}`, "error");
    return;
  }
  const hidden = (setting<string[]>("files.exclude") ?? []).map(globToRegExp);
  entries = entries.filter((e) => !hidden.some((re) => re.test(e.name) || re.test(rel(e.path))));
  const previous = new Map((node.children ?? []).map((c) => [c.entry.path, c]));
  node.children = entries.map((entry) => {
    const old = previous.get(entry.path);
    if (old && old.entry.dir === entry.dir) {
      previous.delete(entry.path);
      return old;
    }
    return createNode(entry, node.depth + 1);
  });
  for (const gone of previous.values()) forget(gone);
  node.childBox.replaceChildren(...node.children.flatMap((c) => [c.row, c.childBox]));
}

function forget(node: Node) {
  nodes.delete(node.entry.path);
  node.children?.forEach(forget);
}

async function toggle(node: Node, expand = !node.expanded) {
  node.expanded = expand;
  if (expand && !node.children) await loadChildren(node);
  node.childBox.hidden = !expand;
  paintRow(node);
}

function select(path: string) {
  const prev = selected ? nodes.get(selected) : null;
  selected = path;
  if (prev) paintRow(prev);
  const node = nodes.get(path);
  if (node) paintRow(node);
}

export async function initTree(expanded: string[] = []) {
  const project = state.project!;
  railsToggle.hidden = !project.rails;
  nodes.clear();
  rootNode = createNode({ name: project.name, path: project.root, dir: true }, 0);
  rootNode.row.hidden = true;
  rootNode.depth = -1;
  treeEl.replaceChildren(rootNode.childBox);
  await toggle(rootNode, true);
  for (const path of expanded.sort((a, b) => a.length - b.length)) {
    const node = nodes.get(path);
    if (node?.entry.dir) await toggle(node, true);
  }
}

export function expandedPaths(): string[] {
  return [...nodes.values()].filter((n) => n.expanded && n !== rootNode).map((n) => n.entry.path);
}

export async function refreshTree(paths?: string[]) {
  if (railsMode) refreshRailsTree();
  const dirs = paths
    ? new Set(paths.map(dirname))
    : new Set([...nodes.values()].filter((n) => n.expanded).map((n) => n.entry.path));
  for (const d of dirs) {
    const node = nodes.get(d);
    if (node?.expanded) await loadChildren(node);
  }
}

function collapseAll() {
  for (const n of nodes.values()) if (n !== rootNode && n.expanded) toggle(n, false);
}

export async function revealInTree(path: string) {
  const root = state.project?.root;
  if (!root || !path.startsWith(root + "/")) return;
  const parts = rel(path).split("/");
  let cur = root;
  for (const part of parts.slice(0, -1)) {
    cur = `${cur}/${part}`;
    const node = nodes.get(cur);
    if (!node) return;
    if (!node.expanded) await toggle(node, true);
  }
  select(path);
  nodes.get(path)?.row.scrollIntoView({ block: "nearest" });
}

export function setGitDecorations(decor: Map<string, string>) {
  gitDecor = decor;
  for (const n of nodes.values()) paintRow(n);
}

function targetDir(node?: Node): string {
  if (node) return node.entry.dir ? node.entry.path : dirname(node.entry.path);
  const sel = selected ? nodes.get(selected) : null;
  return sel ? targetDir(sel) : state.project!.root;
}

async function newPath(dir: boolean, node?: Node) {
  const base = targetDir(node);
  const name = await inputBox(dir ? `New folder in ${rel(base) || "/"}` : `New file in ${rel(base) || "/"} (use / for subfolders)`);
  if (!name) return;
  const path = `${base}/${name}`;
  try {
    await api.createPath(path, dir);
    await refreshTree([path]);
    if (!dir) {
      await revealInTree(path);
      openFile(path);
    }
  } catch (e) {
    toast(String(e), "error");
  }
}

async function renameNode(node: Node) {
  const from = node.entry.path;
  const name = basename(from);
  const dot = name.lastIndexOf(".");
  const next = await inputBox(`Rename ${name}`, name, node.entry.dir || dot <= 0 ? undefined : dot);
  if (!next || next === name) return;
  const to = `${dirname(from)}/${next}`;
  try {
    await api.renamePath(from, to);
    handlePathMoved(from, to);
    await refreshTree([from, to]);
  } catch (e) {
    toast(String(e), "error");
  }
}

/// RubyMine's Delete… dialog: Cancel has focus, so Enter or Escape keeps the file.
export function confirmTrash(what: string): Promise<boolean> {
  return new Promise((resolve) => {
    let backdrop: HTMLElement | null = null;
    const done = (yes: boolean) => {
      backdrop?.remove();
      backdrop = null;
      treeEl.focus({ preventScroll: true });
      resolve(yes);
    };
    const cancel = h("button", { class: "btn primary", onclick: () => done(false) }, "Cancel");
    backdrop = modal(
      h(
        "div",
        { class: "st-dialog trash-dialog" },
        h("div", { class: "rc-title" }, icon("trash"), " Delete"),
        h("div", { class: "st-page" }, `Move ${what} to the Trash?`),
        h("div", { class: "rc-actions" }, h("button", { class: "btn", onclick: () => done(true) }, "Move to Trash"), cancel),
      ),
      () => done(false),
      { autofocus: cancel },
    );
  });
}

async function deleteNode(node: Node) {
  if (!(await confirmTrash(`${rel(node.entry.path)}${node.entry.dir ? " and everything in it" : ""}`))) return;
  try {
    await api.trashPath(node.entry.path);
    handlePathMoved(node.entry.path, null);
    await refreshTree([node.entry.path]);
  } catch (e) {
    toast(String(e), "error");
  }
}

/// Project tree clipboard (⌘C / ⌘V copies files, as in RubyMine).
let copied: string | null = null;

function copyNode(node: Node) {
  copied = node.entry.path;
  void navigator.clipboard.writeText(node.entry.path).catch(() => {});
}

export const copyName = (name: string) => (name.lastIndexOf(".") > 0 ? `${name.slice(0, name.lastIndexOf("."))}_copy${name.slice(name.lastIndexOf("."))}` : `${name}_copy`);

async function pasteInto(node?: Node) {
  const from = copied;
  if (!from) return toast("Copy a file in the Project tree first (⌘C).");
  const dir = targetDir(node);
  const name = basename(from);
  const proposal = nodes.has(`${dir}/${name}`) ? copyName(name) : name;
  const dot = proposal.lastIndexOf(".");
  const next = await inputBox(`Copy ${name} to ${rel(dir) || "/"}`, proposal, dot > 0 ? dot : undefined);
  if (!next) return;
  const to = `${dir}/${next}`;
  try {
    await api.copyPath(from, to);
    await refreshTree([to]);
    await revealInTree(to);
  } catch (e) {
    toast(String(e), "error");
  }
}

export function openInTerminal(path = selected ?? state.project?.root) {
  if (!path) return;
  const node = nodes.get(path);
  newTerminal(node && !node.entry.dir ? dirname(path) : path);
  bottom.show("terminal");
}

export const selectedTreePath = () => selected;

/// Rows in display order: the keyboard walks these.
export function visibleNodes(): Node[] {
  const out: Node[] = [];
  const walk = (n: Node) => {
    for (const c of n.children ?? []) {
      out.push(c);
      if (c.expanded) walk(c);
    }
  };
  if (rootNode) walk(rootNode);
  return out;
}

let typed = "";
let typedAt = 0;

/// RubyMine Project view keys: arrows, ←/→ collapse/expand, Enter/F4 open, type to select, ⌘⌫ delete,
/// ⇧F6/F2 rename, ⌘C/⌘V copy and paste files. ⌘⌫ moves to the Trash after a confirm that defaults to Cancel.
treeEl.addEventListener("keydown", (e) => {
  const list = visibleNodes();
  const i = list.findIndex((n) => n.entry.path === selected);
  const cur = list[i];
  const move = (j: number) => {
    const n = list[Math.max(0, Math.min(list.length - 1, j))];
    if (!n) return;
    select(n.entry.path);
    n.row.scrollIntoView({ block: "nearest" });
  };
  const mods = e.metaKey || e.ctrlKey || e.altKey;
  const k = e.key;
  if (k === "ArrowDown" && !mods) move(i + 1);
  else if (k === "ArrowUp" && !mods) move(i < 0 ? 0 : i - 1);
  else if (k === "Home") move(0);
  else if (k === "End") move(list.length - 1);
  else if (k === "ArrowRight" && cur) cur.entry.dir && !cur.expanded ? void toggle(cur, true) : cur.entry.dir && move(i + 1);
  else if (k === "ArrowLeft" && cur) {
    if (cur.entry.dir && cur.expanded) void toggle(cur, false);
    else move(list.indexOf(nodes.get(dirname(cur.entry.path))!));
  } else if ((k === "Enter" || k === "F4") && !mods && cur) cur.entry.dir ? void toggle(cur) : void openFile(cur.entry.path);
  else if (k === "Backspace" && e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && cur) void deleteNode(cur);
  else if (((k === "F6" && e.shiftKey) || (k === "F2" && !e.shiftKey)) && !mods && cur) void renameNode(cur);
  else if (e.metaKey && !e.shiftKey && !e.altKey && e.code === "KeyC" && cur) copyNode(cur);
  else if (e.metaKey && !e.shiftKey && !e.altKey && e.code === "KeyV") void pasteInto(cur);
  else if (k === "Escape" && typed) typed = "";
  else if (k.length === 1 && !mods && k !== " ") {
    typed = Date.now() - typedAt > 800 ? k.toLowerCase() : typed + k.toLowerCase();
    typedAt = Date.now();
    const order = [...list.slice(Math.max(i, 0)), ...list.slice(0, Math.max(i, 0))];
    const hit = order.find((n) => n.entry.name.toLowerCase().startsWith(typed));
    if (hit) move(list.indexOf(hit));
  } else return;
  e.preventDefault();
  e.stopPropagation();
});

function showMenu(e: MouseEvent, node: Node) {
  select(node.entry.path);
  contextMenu(e, [
    { label: "New File…", run: () => newPath(false, node) },
    { label: "New Folder…", run: () => newPath(true, node) },
    null,
    { label: "Copy", shortcut: "⌘C", run: () => copyNode(node) },
    { label: "Paste", shortcut: "⌘V", run: () => void pasteInto(node), disabled: !copied },
    { label: "Rename…", shortcut: "⇧F6", run: () => renameNode(node) },
    { label: "Delete…", shortcut: "⌘⌫", run: () => deleteNode(node) },
    null,
    { label: "Open in Terminal", icon: "terminal", command: "openInTerminal", run: () => openInTerminal(node.entry.path) },
    { label: "Copy Path", run: () => navigator.clipboard.writeText(node.entry.path) },
    { label: "Copy Relative Path", run: () => navigator.clipboard.writeText(rel(node.entry.path)) },
    { label: "Reveal in Finder", run: () => api.revealInFinder(node.entry.path) },
    null,
    { label: "Show History", run: () => window.dispatchEvent(new CustomEvent("garnet:show-history", { detail: node.entry.path })) },
    {
      label: "Find in Folder…",
      run: () => window.dispatchEvent(new CustomEvent("garnet:find-in", { detail: rel(targetDir(node)) })),
    },
  ]);
}
