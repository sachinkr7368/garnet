import { ask, message } from "@tauri-apps/plugin-dialog";
import { languageFor, monaco } from "./editor";
import { hasConflictMarkers, parseConflicts, type Segment } from "./difflogic";
import { api, type OpState } from "./ipc";
import { abs, basename, root } from "./state";
import { h, icon, iconButton, toast } from "./ui";

const refresh = () => window.dispatchEvent(new Event("garnet:git-refresh"));
const git = (...args: string[]) => api.git(root(), ...args);

/// Runs a git operation that may stop on conflicts (merge, cherry-pick, revert, stash apply/pop, rebase continue).
export async function runGitOp(label: string, args: string[]): Promise<boolean> {
  try {
    const out = await git(...args);
    toast(`${label}: ${out.trim().split("\n").pop() || "done"}`);
    return true;
  } catch (e) {
    const st = await api.gitOpState(root()).catch((): OpState => ({ op: "", conflicts: [] }));
    if (st.conflicts.length) {
      toast(`${label} stopped with ${st.conflicts.length} conflict${st.conflicts.length > 1 ? "s" : ""}.`, "error", [{ label: "Resolve…", run: () => showConflicts() }]);
      showConflicts();
    } else toast(`${label} failed: ${e}`, "error");
    return false;
  } finally {
    refresh();
  }
}

export async function abortOperation(op: OpState["op"]) {
  if (!op) return;
  if (!(await ask(`Abort the ${op}? Changes made by it are discarded and the branch returns to where it was.`, { kind: "warning", okLabel: "Abort", cancelLabel: "Cancel" }))) return;
  closeList();
  await runGitOp(`Abort ${op}`, [op, "--abort"]);
}

export async function continueOperation(op: OpState["op"]) {
  if (!op) return;
  closeList();
  const ok = await runGitOp(`Continue ${op}`, op === "merge" ? ["commit", "--no-edit"] : [op, "--continue"]);
  if (ok) {
    const st = await api.gitOpState(root()).catch(() => null);
    if (st?.conflicts.length) showConflicts();
  }
}

/// Resolves a whole file with one side; a side that deleted the file deletes it.
export async function acceptSide(path: string, side: "ours" | "theirs") {
  try {
    const exists = await api.gitFileAt(root(), side === "ours" ? ":2" : ":3", path);
    if (exists === null) await git("rm", "-q", "--", path);
    else {
      await git("checkout", `--${side}`, "--", path);
      await git("add", "--", path);
    }
    toast(`${basename(path)}: accepted ${side === "ours" ? "yours" : "theirs"}.`);
  } catch (e) {
    toast(String(e), "error");
  }
  refresh();
  if (listEl) showConflicts();
}

/// Conflicts list

let listEl: HTMLElement | null = null;
const closeList = () => {
  listEl?.remove();
  listEl = null;
};

export async function showConflicts() {
  const st = await api.gitOpState(root()).catch((e) => (toast(String(e), "error"), null));
  if (!st) return;
  closeList();
  const op = st.op;
  const box = h(
    "div",
    { class: "qp conflicts-dialog" },
    h("div", { class: "qp-title" }, op ? `Conflicts (${op} in progress)` : "Conflicts"),
    st.conflicts.length
      ? h(
          "div",
          { class: "qp-list" },
          ...st.conflicts.map((p) =>
            h(
              "div",
              { class: "conflict-row" },
              icon("warning"),
              h("span", { class: "change-name" }, basename(p)),
              h("span", { class: "change-dir" }, p.split("/").slice(0, -1).join("/")),
              h("button", { class: "btn small", onclick: () => acceptSide(p, "ours") }, "Accept Yours"),
              h("button", { class: "btn small", onclick: () => acceptSide(p, "theirs") }, "Accept Theirs"),
              h("button", { class: "btn small primary", onclick: () => (closeList(), openResolver(p)) }, "Merge…"),
            ),
          ),
        )
      : h("div", { class: "empty" }, op ? `All conflicts are resolved. Continue the ${op} to finish.` : "No conflicts."),
    h(
      "div",
      { class: "dialog-actions" },
      op ? h("button", { class: "btn", onclick: () => abortOperation(op) }, `Abort ${op}`) : null,
      h("span", { class: "spacer" }),
      op && !st.conflicts.length ? h("button", { class: "btn primary", onclick: () => continueOperation(op) }, `Continue ${op}`) : null,
      h("button", { class: "btn", onclick: closeList }, "Close"),
    ),
  );
  listEl = h("div", { class: "qp-backdrop", onmousedown: (e: MouseEvent) => e.target === listEl && closeList() }, box);
  document.getElementById("overlay-root")!.append(listEl);
}

/// Three-pane resolver: yours | result | theirs

type ChunkState = "unresolved" | "ours" | "theirs" | "both";
interface Chunk {
  ours: string[];
  base: string[];
  theirs: string[];
  state: ChunkState;
  left: [number, number];
  right: [number, number];
}

export interface Resolver {
  chunks: Chunk[];
  result: monaco.editor.ITextModel;
  accept: (i: number, side: "ours" | "theirs" | "both") => void;
  apply: () => Promise<boolean>;
  close: () => void;
}
let current: Resolver | null = null;
export const activeResolver = () => current;

const joinLines = (lines: string[]) => lines.map((l) => `${l}\n`).join("");

export async function openResolver(relPath: string): Promise<Resolver | null> {
  const path = abs(relPath);
  let input;
  try {
    input = await api.gitMergeInput(root(), path);
  } catch (e) {
    toast(`Cannot read conflict: ${e}`, "error");
    return null;
  }
  if (input.ours === null || input.theirs === null) {
    const changed = input.ours === null ? "theirs" : "ours";
    const answer = await message(`${relPath} was deleted in ${changed === "ours" ? "theirs" : "yours"} and changed in ${changed === "ours" ? "yours" : "theirs"}. Keep the changed file or delete it?`, {
      kind: "warning",
      buttons: { yes: "Keep Changed", no: "Delete", cancel: "Cancel" },
    });
    if (answer === "Keep Changed" || answer === "Yes") await acceptSide(relPath, changed);
    else if (answer === "Delete" || answer === "No") await acceptSide(relPath, changed === "ours" ? "theirs" : "ours");
    return null;
  }
  current?.close();
  const st = await api.gitOpState(root()).catch((): OpState => ({ op: "", conflicts: [] }));
  const segs: Segment[] = parseConflicts(input.merged);
  const chunks: Chunk[] = [];
  let left = "";
  let right = "";
  let result = "";
  let ll = 1;
  let rl = 1;
  const resultStarts: number[] = [];
  let cl = 1;
  for (const s of segs) {
    if ("lines" in s) {
      const t = joinLines(s.lines);
      left += t;
      right += t;
      result += t;
      ll += s.lines.length;
      rl += s.lines.length;
      cl += s.lines.length;
    } else {
      chunks.push({ ...s, state: "unresolved", left: [ll, ll + s.ours.length], right: [rl, rl + s.theirs.length] });
      resultStarts.push(cl);
      left += joinLines(s.ours);
      right += joinLines(s.theirs);
      result += joinLines(s.base);
      ll += s.ours.length;
      rl += s.theirs.length;
      cl += s.base.length;
    }
  }
  const lang = languageFor(path);
  const mk = (text: string, side: string) => monaco.editor.createModel(text, lang, monaco.Uri.from({ scheme: "garnet-merge", path, query: `${side}-${Date.now()}` }));
  const models = { left: mk(left, "left"), result: mk(result, "result"), right: mk(right, "right") };
  const panes = { left: h("div", { class: "merge-pane" }), result: h("div", { class: "merge-pane" }), right: h("div", { class: "merge-pane" }) };
  const status = h("span", { class: "dim" });
  const opts = { automaticLayout: true, minimap: { enabled: false }, glyphMargin: true, scrollBeyondLastLine: false, fontSize: 13, lineNumbersMinChars: 3 };
  const rebase = st.op === "rebase";
  const dialog = h(
    "div",
    { class: "merge-dialog" },
    h(
      "div",
      { class: "view-toolbar" },
      icon("git-merge"),
      h("strong", {}, relPath),
      status,
      h("span", { class: "spacer" }),
      iconButton("arrow-up", "Previous Conflict", () => goChunk(-1)),
      iconButton("arrow-down", "Next Conflict", () => goChunk(1)),
      h("button", { class: "btn small", onclick: () => acceptAt("ours") }, "Accept Yours"),
      h("button", { class: "btn small", onclick: () => acceptAt("theirs") }, "Accept Theirs"),
      h("button", { class: "btn small", onclick: () => acceptAt("both") }, "Accept Both"),
      h("span", { class: "sep" }),
      h("button", { class: "btn small", onclick: () => chunks.forEach((_, i) => chunks[i].state === "unresolved" && accept(i, "ours")) }, "All Yours"),
      h("button", { class: "btn small", onclick: () => chunks.forEach((_, i) => chunks[i].state === "unresolved" && accept(i, "theirs")) }, "All Theirs"),
      h("span", { class: "sep" }),
      h("button", { class: "btn small primary", onclick: () => apply() }, "Apply"),
      h("button", { class: "btn small", onclick: () => close() }, "Cancel"),
    ),
    h(
      "div",
      { class: "merge-heads" },
      h("div", {}, rebase ? "Yours (branch being rebased onto)" : "Yours (HEAD)"),
      h("div", {}, "Result"),
      h("div", {}, rebase ? "Theirs (commit being applied)" : "Theirs (incoming)"),
    ),
    h("div", { class: "merge-body" }, panes.left, panes.result, panes.right),
  );
  document.getElementById("overlay-root")!.append(dialog);
  const eds = {
    left: monaco.editor.create(panes.left, { ...opts, model: models.left, readOnly: true }),
    result: monaco.editor.create(panes.result, { ...opts, model: models.result }),
    right: monaco.editor.create(panes.right, { ...opts, model: models.right, readOnly: true }),
  };
  const lineRange = (s: number, e: number) => new monaco.Range(s, 1, e, 1);
  const tracked = models.result.deltaDecorations(
    [],
    chunks.map((c, i) => ({
      range: lineRange(resultStarts[i], resultStarts[i] + c.base.length),
      options: { stickiness: monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges },
    })),
  );
  const resultRange = (i: number) => models.result.getDecorationRange(tracked[i])!;
  const resultLines = (i: number): [number, number] => {
    const r = resultRange(i);
    return [r.startLineNumber, r.endLineNumber];
  };
  const marks = {
    left: eds.left.createDecorationsCollection(),
    result: eds.result.createDecorationsCollection(),
    right: eds.right.createDecorationsCollection(),
  };
  const zoneIds: Record<string, string[]> = { left: [], result: [], right: [] };
  const highlight = ([s, e]: [number, number], cls: string, glyph?: string): monaco.editor.IModelDeltaDecoration[] => [
    e > s
      ? { range: new monaco.Range(s, 1, e - 1, 1), options: { isWholeLine: true, className: cls, glyphMarginClassName: glyph } }
      : { range: new monaco.Range(s, 1, s, 1), options: { isWholeLine: true, className: `${cls}-empty`, glyphMarginClassName: glyph } },
  ];

  const layout = () => {
    if (!current) return;
    const spans = chunks.map((c, i) => ({ l: c.left, r: c.right, c: resultLines(i) }));
    marks.left.set(chunks.flatMap((c, i) => highlight(spans[i].l, `merge-${c.state === "unresolved" ? "conflict" : "done"}`, c.state === "unresolved" ? "merge-accept-left" : undefined)));
    marks.right.set(chunks.flatMap((c, i) => highlight(spans[i].r, `merge-${c.state === "unresolved" ? "conflict" : "done"}`, c.state === "unresolved" ? "merge-accept-right" : undefined)));
    marks.result.set(chunks.flatMap((c, i) => highlight(spans[i].c, `merge-${c.state === "unresolved" ? "conflict" : "done"}`)));
    for (const side of ["left", "result", "right"] as const) {
      eds[side].changeViewZones((acc) => {
        zoneIds[side].forEach((id) => acc.removeZone(id));
        zoneIds[side] = spans.flatMap((sp) => {
          const [s, e] = side === "left" ? sp.l : side === "right" ? sp.r : sp.c;
          const max = Math.max(sp.l[1] - sp.l[0], sp.r[1] - sp.r[0], sp.c[1] - sp.c[0]);
          const pad = max - (e - s);
          return pad > 0 ? [acc.addZone({ afterLineNumber: e - 1, heightInLines: pad, domNode: h("div", { class: "merge-pad" }) })] : [];
        });
      });
    }
    const open = chunks.filter((c) => c.state === "unresolved").length;
    status.textContent = open ? `${open} of ${chunks.length} conflict${chunks.length > 1 ? "s" : ""} unresolved` : "All conflicts resolved";
  };

  const accept = (i: number, side: "ours" | "theirs" | "both") => {
    const c = chunks[i];
    let lines: string[];
    let next: ChunkState;
    if (side === "both") [lines, next] = [[...c.ours, ...c.theirs], "both"];
    else if ((c.state === "ours" && side === "theirs") || (c.state === "theirs" && side === "ours"))
      [lines, next] = [c.state === "ours" ? [...c.ours, ...c.theirs] : [...c.theirs, ...c.ours], "both"];
    else [lines, next] = [side === "ours" ? c.ours : c.theirs, side];
    const r = resultRange(i);
    models.result.pushEditOperations([], [{ range: new monaco.Range(r.startLineNumber, 1, r.endLineNumber, 1), text: joinLines(lines) }], () => null);
    models.result.pushStackElement();
    const start = r.startLineNumber;
    models.result.deltaDecorations([tracked[i]], []);
    tracked[i] = models.result.deltaDecorations([], [{ range: lineRange(start, start + lines.length), options: { stickiness: monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges } }])[0];
    c.state = next;
    layout();
  };

  const chunkAtCursor = () => {
    const line = eds.result.getPosition()?.lineNumber ?? 1;
    const i = chunks.findIndex((_, j) => {
      const [s, e] = resultLines(j);
      return line >= s && line <= Math.max(s, e - 1);
    });
    return i >= 0 ? i : chunks.findIndex((c) => c.state === "unresolved");
  };
  const acceptAt = (side: "ours" | "theirs" | "both") => {
    const i = chunkAtCursor();
    if (i >= 0) accept(i, side);
  };
  const goChunk = (d: number) => {
    if (!chunks.length) return;
    const line = eds.result.getPosition()?.lineNumber ?? 1;
    const starts = chunks.map((_, i) => resultLines(i)[0]);
    let i = d > 0 ? starts.findIndex((s) => s > line) : starts.map((s, j) => [s, j]).filter(([s]) => s < line).pop()?.[1] ?? -1;
    if (i < 0) i = d > 0 ? 0 : chunks.length - 1;
    eds.result.setPosition({ lineNumber: starts[i], column: 1 });
    eds.result.revealLineInCenter(starts[i]);
    eds.result.focus();
  };

  for (const side of ["left", "right"] as const) {
    eds[side].onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !e.target.position) return;
      const line = e.target.position.lineNumber;
      const i = chunks.findIndex((c) => (side === "left" ? c.left : c.right)[0] === line && c.state === "unresolved");
      if (i >= 0) accept(i, side === "left" ? "ours" : "theirs");
    });
  }
  let syncing = false;
  for (const side of ["left", "result", "right"] as const) {
    eds[side].onDidScrollChange((e) => {
      if (syncing || !e.scrollTopChanged) return;
      syncing = true;
      for (const other of ["left", "result", "right"] as const) if (other !== side) eds[other].setScrollTop(e.scrollTop);
      syncing = false;
    });
  }
  let relayout = 0;
  models.result.onDidChangeContent(() => {
    clearTimeout(relayout);
    relayout = window.setTimeout(layout, 100);
  });

  const close = () => {
    clearTimeout(relayout);
    Object.values(eds).forEach((e) => e.dispose());
    Object.values(models).forEach((m) => m.dispose());
    dialog.remove();
    window.removeEventListener("keydown", onKey, true);
    current = null;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  window.addEventListener("keydown", onKey, true);

  const apply = async () => {
    const text = models.result.getValue();
    const open = chunks.filter((c) => c.state === "unresolved").length;
    if (open && !(await ask(`${open} conflict${open > 1 ? "s are" : " is"} not resolved with Yours/Theirs. Save the result as shown and mark the file resolved?`, { kind: "warning", okLabel: "Mark Resolved", cancelLabel: "Keep Editing" })))
      return false;
    if (hasConflictMarkers(text) && !(await ask("The result still contains conflict markers. Mark resolved anyway?", { kind: "warning", okLabel: "Mark Resolved", cancelLabel: "Keep Editing" }))) return false;
    try {
      await api.writeFile(path, text);
      await git("add", "--", relPath);
    } catch (e) {
      toast(`Could not save the result: ${e}`, "error");
      return false;
    }
    close();
    refresh();
    const st2 = await api.gitOpState(root()).catch(() => null);
    if (st2?.conflicts.length) showConflicts();
    else if (st2?.op) toast(`All conflicts resolved.`, "info", [{ label: `Continue ${st2.op}`, run: () => continueOperation(st2.op) }]);
    else toast(`${basename(relPath)} resolved.`);
    return true;
  };

  current = { chunks, result: models.result, accept, apply, close };
  layout();
  goChunk(1);
  return current;
}
