// Pure diff/merge/tree helpers shared by the gutter worker, the commit panel, the log and the merge resolver.

/// Half-open line ranges: a[a0, a1) in the old text was replaced by b[b0, b1) in the new text.
export interface LineHunk {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

export const splitLines = (text: string) => text.split("\n");

/// Myers line diff. Falls back to one hunk over the changed middle when the edit distance exceeds maxD.
export function diffLines(a: string[], b: string[], maxD = 4000): LineHunk[] {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) ea--, eb--;
  const n = ea - s;
  const m = eb - s;
  if (!n && !m) return [];
  if (!n || !m) return [{ a0: s, a1: ea, b0: s, b1: eb }];
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, maxD) && found < 0; d++) {
    trace.push(v.slice(max - d, max + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[max + k - 1] < v[max + k + 1]) ? v[max + k + 1] : v[max + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[s + x] === b[s + y]) x++, y++;
      v[max + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return [{ a0: s, a1: ea, b0: s, b1: eb }];
  const moves: LineHunk[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const at = (k: number) => prev[k + d];
    const k = x - y;
    const insert = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const px = at(insert ? k + 1 : k - 1);
    const py = px - (insert ? k + 1 : k - 1);
    moves.push(insert ? { a0: px, a1: px, b0: py, b1: py + 1 } : { a0: px, a1: px + 1, b0: py, b1: py });
    x = px;
    y = py;
  }
  const hunks: LineHunk[] = [];
  for (const mv of moves.reverse()) {
    const last = hunks[hunks.length - 1];
    if (last && last.a1 === mv.a0 + s && last.b1 === mv.b0 + s) {
      last.a1 = mv.a1 + s;
      last.b1 = mv.b1 + s;
    } else hunks.push({ a0: mv.a0 + s, a1: mv.a1 + s, b0: mv.b0 + s, b1: mv.b1 + s });
  }
  return hunks;
}

export const hunkKind = (h: LineHunk) => (h.a0 === h.a1 ? "added" : h.b0 === h.b1 ? "deleted" : "modified");

/// True when hunk h touches lines [r0, r1) of the new text (empty ranges count when they touch).
export function overlapsNew(h: LineHunk, r0: number, r1: number) {
  if (h.b0 === h.b1) return r0 <= h.b0 && h.b0 <= Math.max(r0, r1);
  if (r0 === r1) return h.b0 <= r0 && r0 <= h.b1;
  return h.b0 < r1 && r0 < h.b1;
}

/// `a` with the chosen hunks of diff(a, b) applied, e.g. index + one hunk of the working copy = staged hunk.
export function applyHunks(a: string[], b: string[], chosen: LineHunk[]): string[] {
  const out: string[] = [];
  let pos = 0;
  for (const h of [...chosen].sort((x, y) => x.a0 - y.a0)) {
    out.push(...a.slice(pos, h.a0), ...b.slice(h.b0, h.b1));
    pos = h.a1;
  }
  return out.concat(a.slice(pos));
}

/// `b` with the chosen hunks of diff(a, b) reverted to a's lines, e.g. unstaging one hunk.
export const revertHunks = (a: string[], b: string[], chosen: LineHunk[]) =>
  applyHunks(b, a, chosen.map((h) => ({ a0: h.b0, a1: h.b1, b0: h.a0, b1: h.a1 })));

/// Lines for a patch: a missing final newline is folded into the last line so it diffs like any other change.
const NOEOL = "\u0000noeol";
export function patchLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  else lines[lines.length - 1] += NOEOL;
  return lines;
}
export const displayLine = (line: string) => (line.endsWith(NOEOL) ? `${line.slice(0, -NOEOL.length)} ⏎̸` : line);
export const patchHunks = (oldText: string, newText: string) => diffLines(patchLines(oldText), patchLines(newText));
export const swapHunk = (h: LineHunk): LineHunk => ({ a0: h.b0, a1: h.b1, b0: h.a0, b1: h.a1 });

function quotePath(p: string) {
  if (!/[^\x20-\x7e]|["\\]/.test(p)) return p;
  let out = "";
  for (const byte of new TextEncoder().encode(p)) {
    const ch = String.fromCharCode(byte);
    out += ch === '"' || ch === "\\" ? `\\${ch}` : byte < 0x20 || byte > 0x7e ? `\\${byte.toString(8).padStart(3, "0")}` : ch;
  }
  return `"${out}"`;
}

/// Zero-context unified patch (for `git apply --cached --unidiff-zero`) of the chosen hunks of patchHunks(oldText, newText).
export function buildPatch(path: string, oldText: string, newText: string, chosen: LineHunk[]): string {
  const a = patchLines(oldText);
  const b = patchLines(newText);
  const q = (side: string) => quotePath(`${side}/${path}`);
  const line = (prefix: string, l: string) => (l.endsWith(NOEOL) ? `${prefix}${l.slice(0, -NOEOL.length)}\n\\ No newline at end of file\n` : `${prefix}${l}\n`);
  let out = `diff --git ${q("a")} ${q("b")}\n--- ${q("a")}\n+++ ${q("b")}\n`;
  let delta = 0;
  for (const h of [...chosen].sort((x, y) => x.a0 - y.a0)) {
    const oc = h.a1 - h.a0;
    const nc = h.b1 - h.b0;
    out += `@@ -${oc ? h.a0 + 1 : h.a0},${oc} +${(nc ? h.a0 + 1 : h.a0) + delta},${nc} @@\n`;
    out += a.slice(h.a0, h.a1).map((l) => line("-", l)).join("") + b.slice(h.b0, h.b1).map((l) => line("+", l)).join("");
    delta += nc - oc;
  }
  return out;
}

/// Patch staging the part of `work` covered by work lines [r0, r1) onto `index`; null when already staged.
export function stagePatch(path: string, index: string, work: string, r0: number, r1: number): string | null {
  const chosen = patchHunks(index, work).filter((h) => overlapsNew(h, r0, r1));
  return chosen.length ? buildPatch(path, index, work, chosen) : null;
}

/// Conflict file segments from a diff3-style merge: plain lines, or a conflict with the three sides.
export type Segment = { lines: string[] } | { ours: string[]; base: string[]; theirs: string[] };

export function parseConflicts(merged: string): Segment[] {
  const segs: Segment[] = [];
  let plain: string[] = [];
  let cur: { ours: string[]; base: string[]; theirs: string[] } | null = null;
  let side: "ours" | "base" | "theirs" = "ours";
  const lines = splitLines(merged);
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    if (!cur && line.startsWith("<<<<<<<")) {
      if (plain.length) segs.push({ lines: plain });
      plain = [];
      cur = { ours: [], base: [], theirs: [] };
      side = "ours";
    } else if (cur && side === "ours" && line.startsWith("|||||||")) side = "base";
    else if (cur && side !== "theirs" && line.startsWith("=======")) side = "theirs";
    else if (cur && side === "theirs" && line.startsWith(">>>>>>>")) {
      segs.push(cur);
      cur = null;
    } else if (cur) cur[side].push(line);
    else plain.push(line);
  }
  if (cur) plain = [...plain, ...cur.ours];
  if (plain.length) segs.push({ lines: plain });
  return segs;
}

export const hasConflictMarkers = (text: string) => /^(<{7}|>{7})( |$)/m.test(text);

/// Directory tree of changed files; single-child directories are compressed ("app/models").
export interface TreeNode<T> {
  name: string;
  path: string;
  children: TreeNode<T>[];
  file?: T;
}

export function buildTree<T extends { path: string }>(files: T[]): TreeNode<T>[] {
  const root: TreeNode<T> = { name: "", path: "", children: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      if (i === parts.length - 1) return node.children.push({ name: part, path, children: [], file: f });
      let next = node.children.find((c) => !c.file && c.name === part);
      if (!next) node.children.push((next = { name: part, path, children: [] }));
      node = next;
    });
  }
  const compress = (n: TreeNode<T>): TreeNode<T> => {
    n.children = n.children.map(compress).sort((x, y) => Number(!!x.file) - Number(!!y.file) || x.name.localeCompare(y.name));
    if (!n.file && n.path && n.children.length === 1 && !n.children[0].file) {
      const c = n.children[0];
      return { ...c, name: `${n.name}/${c.name}` };
    }
    return n;
  };
  return compress(root).children;
}

/// Pick-list filter for the changes tree: case-insensitive substring of the path.
export const filterPaths = <T extends { path: string }>(files: T[], q: string) =>
  q.trim() ? files.filter((f) => f.path.toLowerCase().includes(q.trim().toLowerCase())) : files;
