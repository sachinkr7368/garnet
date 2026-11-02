import "./railstools.css";
import { openFile } from "./editor";
import { api } from "./ipc";
import { abs } from "./state";
import { h, icon } from "./ui";

/// Rails project view: a logical tree (Models, Controllers, Views, …) instead of the file system.

export interface LogicalNode {
  label: string;
  path?: string;
  detail?: string;
  children: LogicalNode[];
}

const GROUPS: [string, RegExp][] = [
  ["Models", /^app\/models\/(.+\.rb)$/],
  ["Controllers", /^app\/controllers\/(.+\.rb)$/],
  ["Views", /^app\/views\/(.+)$/],
  ["Helpers", /^app\/helpers\/(.+\.rb)$/],
  ["Mailers", /^app\/mailers\/(.+\.rb)$/],
  ["Jobs", /^app\/jobs\/(.+\.rb)$/],
  ["Migrations", /^db\/(?:\w+_)?migrate\/(.+\.rb)$/],
  ["Specs", /^spec\/(.+\.rb)$/],
  ["Tests", /^test\/(.+\.rb)$/],
];

function insert(parent: LogicalNode, parts: string[], path: string) {
  if (parts.length === 1) {
    parent.children.push({ label: parts[0], path, children: [] });
    return;
  }
  let dir = parent.children.find((c) => !c.path && c.label === parts[0]);
  if (!dir) parent.children.push((dir = { label: parts[0], children: [] }));
  insert(dir, parts.slice(1), path);
}

function sortTree(node: LogicalNode, newestFirst: boolean) {
  node.children.sort((a, b) => Number(!!a.path) - Number(!!b.path) || (newestFirst ? b.label.localeCompare(a.label) : a.label.localeCompare(b.label)));
  node.children.forEach((c) => sortTree(c, newestFirst));
}

export function buildRailsTree(files: string[]): LogicalNode[] {
  const groups = GROUPS.map(([label]) => ({ label, children: [] as LogicalNode[] }) as LogicalNode);
  for (const f of files) {
    const i = GROUPS.findIndex(([, re]) => re.test(f));
    if (i < 0) continue;
    const inner = f.match(GROUPS[i][1])![1];
    if (GROUPS[i][0] === "Migrations") {
      const m = inner.match(/^(\d+)_(.+)\.rb$/);
      groups[i].children.push({ label: m ? m[2] : inner, detail: m?.[1], path: f, children: [] });
    } else insert(groups[i], inner.split("/"), f);
  }
  groups.forEach((g) => (g.label === "Migrations" ? g.children.sort((a, b) => (b.detail ?? "").localeCompare(a.detail ?? "")) : sortTree(g, false)));
  return groups.filter((g) => g.children.length);
}

export const railsTreeEl = h("div", { class: "tree rails-tree", tabIndex: 0 });
const expanded = new Set<string>(["Models", "Controllers"]);

function renderNode(node: LogicalNode, depth: number, key: string): HTMLElement[] {
  const open = expanded.has(key);
  const row = h(
    "div",
    { class: "tree-row", style: `padding-left:${depth * 14 + 6}px`, title: node.path ?? "" },
    node.path ? h("span", { class: "twisty" }) : icon(open ? "chevron-down" : "chevron-right", "twisty"),
    icon(node.path ? "file" : depth === 0 ? "symbol-namespace" : open ? "folder-opened" : "folder", `file-icon ${node.path ? "" : "dir"}`),
    h("span", { class: "tree-label" }, node.label),
    node.detail ? h("span", { class: "dim tree-detail" }, ` ${node.detail}`) : null,
    depth === 0 ? h("span", { class: "dim tree-detail" }, ` ${count(node)}`) : null,
  );
  row.onclick = () => {
    if (node.path) return openFile(abs(node.path));
    if (open) expanded.delete(key);
    else expanded.add(key);
    renderRailsTree();
  };
  return [row, ...(open ? node.children.flatMap((c) => renderNode(c, depth + 1, `${key}/${c.label}`)) : [])];
}

const count = (n: LogicalNode): number => (n.path ? 1 : n.children.reduce((s, c) => s + count(c), 0));

let tree: LogicalNode[] = [];

function renderRailsTree() {
  railsTreeEl.replaceChildren(...(tree.length ? tree.flatMap((g) => renderNode(g, 0, g.label)) : [h("div", { class: "empty" }, "No Rails files found.")]));
}

export async function refreshRailsTree() {
  tree = buildRailsTree(await api.indexFiles().catch(() => []));
  renderRailsTree();
}
