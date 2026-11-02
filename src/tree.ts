import { ask } from "@tauri-apps/plugin-dialog";
import { handlePathMoved, openFile } from "./editor";
import { api, type DirEntry } from "./ipc";
import { globToRegExp, setting } from "./settings";
import { basename, dirname, rel, state } from "./state";
import { contextMenu, h, icon, iconButton, inputBox, toast } from "./ui";

interface Node {
  entry: DirEntry;
  depth: number;
  expanded: boolean;
  children: Node[] | null;
  row: HTMLElement;
  childBox: HTMLElement;
}

export const treeEl = h("div", { class: "tree", tabIndex: 0 });
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
  ),
  treeEl,
);

const nodes = new Map<string, Node>();
let rootNode: Node | null = null;
let selected: string | null = null;
let gitDecor = new Map<string, string>();

function createNode(entry: DirEntry, depth: number): Node {
  const row = h("div", { class: "tree-row", style: `padding-left:${depth * 14 + 6}px` });
  const node: Node = { entry, depth, expanded: false, children: null, row, childBox: h("div", { class: "tree-children" }) };
  row.addEventListener("click", () => {
    select(entry.path);
    if (entry.dir) toggle(node);
    else openFile(entry.path);
  });
  row.addEventListener("contextmenu", (e) => showMenu(e, node));
  nodes.set(entry.path, node);
  paintRow(node);
  return node;
}

function paintRow(node: Node) {
  const { entry } = node;
  const status = gitDecor.get(entry.path);
  node.row.className = `tree-row${selected === entry.path ? " selected" : ""}${status ? ` git-${status}` : ""}`;
  node.row.replaceChildren(
    entry.dir ? icon(node.expanded ? "chevron-down" : "chevron-right", "twisty") : h("span", { class: "twisty" }),
    icon(entry.dir ? (node.expanded ? "folder-opened" : "folder") : "file", `file-icon ${entry.dir ? "dir" : extClass(entry.name)}`),
    h("span", { class: "tree-label" }, entry.name),
  );
}

function extClass(name: string) {
  const m = name.match(/\.([a-z0-9]+)$/i);
  return m ? `ext-${m[1].toLowerCase()}` : "";
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

async function deleteNode(node: Node) {
  const ok = await ask(`Delete ${rel(node.entry.path)}${node.entry.dir ? " and everything in it" : ""}? This cannot be undone.`, {
    title: "Delete",
    kind: "warning",
    okLabel: "Delete",
    cancelLabel: "Cancel",
  });
  if (!ok) return;
  try {
    await api.deletePath(node.entry.path);
    handlePathMoved(node.entry.path, null);
    await refreshTree([node.entry.path]);
  } catch (e) {
    toast(String(e), "error");
  }
}

function showMenu(e: MouseEvent, node: Node) {
  select(node.entry.path);
  contextMenu(e, [
    { label: "New File…", run: () => newPath(false, node) },
    { label: "New Folder…", run: () => newPath(true, node) },
    null,
    { label: "Rename…", run: () => renameNode(node) },
    { label: "Delete…", run: () => deleteNode(node) },
    null,
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
