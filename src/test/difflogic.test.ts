import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyHunks, buildPatch, buildTree, diffLines, filterPaths, gutterDiff, hasConflictMarkers, hunkKind, matchEol, overlapsNew, parseConflicts, patchHunks, revertHunks, rollbackEdits, stagePatch, swapHunk, unstagePatch, type LineEdit } from "../difflogic";

const rand = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

describe("diffLines", () => {
  it("round-trips random edits through apply and revert", () => {
    const r = rand(7);
    for (let t = 0; t < 2000; t++) {
      const gen = () => Array.from({ length: Math.floor(r() * 20) }, () => "abcdef"[Math.floor(r() * 6)]);
      const a = gen();
      const b = gen();
      const hunks = diffLines(a, b);
      expect(applyHunks(a, b, hunks)).toEqual(b);
      expect(revertHunks(a, b, hunks)).toEqual(a);
    }
  });

  it("returns minimal hunks and kinds", () => {
    const hunks = diffLines(["a", "b", "c", "d"], ["a", "X", "c", "d", "e"]);
    expect(hunks).toEqual([
      { a0: 1, a1: 2, b0: 1, b1: 2 },
      { a0: 4, a1: 4, b0: 4, b1: 5 },
    ]);
    expect(hunks.map(hunkKind)).toEqual(["modified", "added"]);
    expect(hunkKind({ a0: 2, a1: 3, b0: 2, b1: 2 })).toBe("deleted");
    expect(diffLines(["same"], ["same"])).toEqual([]);
  });

  it("falls back to one hunk past the edit budget", () => {
    expect(diffLines(["a", "b", "c"], ["x", "y", "z"], 1)).toEqual([{ a0: 0, a1: 3, b0: 0, b1: 3 }]);
  });
});

describe("hunk staging patches", () => {
  it("builds a zero-context patch for only the hunk under the range", () => {
    expect(stagePatch("f.rb", "1\n2\n3\n4\n", "1\nX\n3\n4\nY\n", 1, 2)).toBe("diff --git a/f.rb b/f.rb\n--- a/f.rb\n+++ b/f.rb\n@@ -2,1 +2,1 @@\n-2\n+X\n");
    expect(stagePatch("f.rb", "1\n2\n3\n4\n", "1\nX\n3\n4\nY\n", 4, 5)).toBe("diff --git a/f.rb b/f.rb\n--- a/f.rb\n+++ b/f.rb\n@@ -4,0 +5,1 @@\n+Y\n");
    expect(stagePatch("f.rb", "1\nS\n3\n", "1\nS\n3\n", 1, 2)).toBeNull();
  });

  it("marks a missing final newline and quotes unusual paths", () => {
    expect(stagePatch("a b.rb", "x", "y", 0, 1)).toBe("diff --git a/a b.rb b/a b.rb\n--- a/a b.rb\n+++ b/a b.rb\n@@ -1,1 +1,1 @@\n-x\n\\ No newline at end of file\n+y\n\\ No newline at end of file\n");
    expect(buildPatch('é"q.rb', "", "z\n", patchHunks("", "z\n"))).toContain('--- "a/\\303\\251\\"q.rb"');
  });

  it("detects overlap with empty ranges", () => {
    expect(overlapsNew({ a0: 3, a1: 4, b0: 3, b1: 3 }, 2, 3)).toBe(true);
    expect(overlapsNew({ a0: 1, a1: 2, b0: 1, b1: 3 }, 3, 3)).toBe(true);
    expect(overlapsNew({ a0: 1, a1: 2, b0: 1, b1: 3 }, 4, 6)).toBe(false);
  });

  it("applies with git apply --cached for random single-hunk stages and unstages", () => {
    const dir = mkdtempSync(join(tmpdir(), "garnet-patch-"));
    const git = (args: string[], input?: string) => execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd: dir, input, encoding: "utf8" });
    try {
      git(["init", "-q"]);
      const r = rand(11);
      const gen = () => {
        const lines = Array.from({ length: 1 + Math.floor(r() * 8) }, () => "abcd"[Math.floor(r() * 4)]);
        return lines.join("\n") + (r() < 0.7 ? "\n" : "");
      };
      for (let t = 0; t < 25; t++) {
        const index = gen();
        const work = gen();
        writeFileSync(join(dir, "f.rb"), index);
        git(["add", "f.rb"]);
        const hunks = patchHunks(index, work);
        if (!hunks.length) continue;
        const pick = hunks[Math.floor(r() * hunks.length)];
        git(["apply", "--cached", "--unidiff-zero", "-"], buildPatch("f.rb", index, work, [pick]));
        const staged = git(["show", ":f.rb"]);
        const expected = applyHunks(index.split("\n"), work.split("\n"), diffLines(index.split("\n"), work.split("\n")).filter((h) => overlapsNew(h, pick.b0, Math.max(pick.b0, pick.b1))));
        if (index.endsWith("\n") === work.endsWith("\n")) expect(staged).toBe(expected.join("\n"));
        git(["apply", "--cached", "--unidiff-zero", "-"], buildPatch("f.rb", staged, index, patchHunks(staged, index)));
        expect(git(["show", ":f.rb"])).toBe(index);
        const all = patchHunks(index, work);
        git(["apply", "--cached", "--unidiff-zero", "-"], buildPatch("f.rb", index, work, all));
        expect(git(["show", ":f.rb"])).toBe(work);
        git(["apply", "--cached", "--unidiff-zero", "-"], buildPatch("f.rb", work, index, all.map(swapHunk)));
        expect(git(["show", ":f.rb"])).toBe(index);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});

/// Applies edits (all relative to the original text, as Monaco does in one pushEditOperations) to "\n" text.
function applyEdits(text: string, edits: LineEdit[]) {
  const lines = text.split("\n");
  const offset = (line: number, col: number) => lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + col - 1;
  let out = text;
  for (const e of [...edits].sort((x, y) => y.startLine - x.startLine)) out = out.slice(0, offset(e.startLine, e.startCol)) + e.text + out.slice(offset(e.endLine, e.endCol));
  return out;
}

describe("rollback lines (B6) and CRLF (B33)", () => {
  const head = "a\nb\nc\nd\ne\n";
  it("rolls back only the hunk under the selection, from the current text", () => {
    const buf = "a\nB\nc\nd\nE\n";
    expect(applyEdits(buf, rollbackEdits(head, buf, 1, 2, "\n"))).toBe("a\nb\nc\nd\nE\n");
    // Three lines inserted above after the gutter last ran: the same hunk is found at its new place.
    const shifted = "x\ny\nz\n" + buf;
    expect(applyEdits(shifted, rollbackEdits(head, shifted, 4, 5, "\n"))).toBe("x\ny\nz\na\nb\nc\nd\nE\n");
  });

  it("rolls back several hunks, end-of-file edits and deletions in one batch", () => {
    for (const buf of ["a\nB\nc\nd\nE\n", "a\nc\nd\ne\n", "a\nb\nc\nd\ne\nf\ng", "", "z\n", "a\nb\nc\n"]) {
      const lines = buf.split("\n").length;
      expect(applyEdits(buf, rollbackEdits(head, buf, 0, lines, "\n"))).toBe(head);
    }
    expect(rollbackEdits(head, head, 0, 5, "\n")).toEqual([]);
  });

  it("ignores CRLF vs LF in the gutter and when staging", () => {
    expect(gutterDiff(head, head.replace(/\n/g, "\r\n"))).toEqual([]);
    expect(gutterDiff(head, "a\r\nB\r\nc\r\nd\r\ne\r\n")).toEqual([{ a0: 1, a1: 2, b0: 1, b1: 2 }]);
    expect(matchEol("a\nb\n", "a\r\nB\r\n")).toBe("a\nB\n");
    expect(matchEol("a\r\nb\r\n", "a\r\nB\r\n")).toBe("a\r\nB\r\n");
    expect(stagePatch("f.rb", "a\nb\n", matchEol("a\nb\n", "a\r\nB\r\n"), 1, 2)).toBe("diff --git a/f.rb b/f.rb\n--- a/f.rb\n+++ b/f.rb\n@@ -2,1 +2,1 @@\n-b\n+B\n");
  });
});

describe("unstagePatch (B31)", () => {
  it("finds the hunk by its HEAD lines after an earlier hunk was unstaged", () => {
    const head = "1\n2\n3\n";
    const index = "0\n1\n2\n2b\n3\n";
    const first = patchHunks(head, index)[0];
    const second = patchHunks(head, index)[1];
    const afterFirst = "1\n2\n2b\n3\n";
    expect(unstagePatch("f.rb", head, index, first.a0, first.a1)).toBe("diff --git a/f.rb b/f.rb\n--- a/f.rb\n+++ b/f.rb\n@@ -1,1 +0,0 @@\n-0\n");
    expect(unstagePatch("f.rb", head, afterFirst, second.a0, second.a1)).toBe("diff --git a/f.rb b/f.rb\n--- a/f.rb\n+++ b/f.rb\n@@ -3,1 +2,0 @@\n-2b\n");
    expect(unstagePatch("f.rb", head, head, second.a0, second.a1)).toBeNull();
  });
});

describe("parseConflicts", () => {
  it("splits diff3 output into plain and conflict segments", () => {
    expect(parseConflicts("a\n<<<<<<< Yours\nx\n||||||| Base\nb\n=======\ny\n>>>>>>> Theirs\nz\n")).toEqual([
      { lines: ["a"] },
      { ours: ["x"], base: ["b"], theirs: ["y"] },
      { lines: ["z"] },
    ]);
  });

  it("handles merge style without a base and empty sides", () => {
    expect(parseConflicts("<<<<<<< HEAD\n=======\nnew\n>>>>>>> b\n")).toEqual([{ ours: [], base: [], theirs: ["new"] }]);
  });

  it("keeps an unterminated block as plain text", () => {
    expect(parseConflicts("a\n<<<<<<< x\nb\n")).toEqual([{ lines: ["a"] }, { lines: ["b"] }]);
  });

  it("finds leftover markers", () => {
    expect(hasConflictMarkers("ok\n<<<<<<< HEAD\n")).toBe(true);
    expect(hasConflictMarkers("a <<<<<<< b\n")).toBe(false);
  });
});

describe("buildTree", () => {
  it("compresses single-child directories and lists folders first", () => {
    const tree = buildTree([{ path: "app/models/a.rb" }, { path: "app/models/b.rb" }, { path: "README" }, { path: "lib/x/y/z.rb" }]);
    expect(tree.map((n) => n.name)).toEqual(["app/models", "lib/x/y", "README"]);
    expect(tree[0].children.map((n) => n.name)).toEqual(["a.rb", "b.rb"]);
    expect(tree[0].path).toBe("app/models");
    expect(tree[2].file).toEqual({ path: "README" });
  });

  it("filters by case-insensitive path substring", () => {
    expect(filterPaths([{ path: "app/Models/User.rb" }, { path: "lib/x.rb" }], "models/u")).toEqual([{ path: "app/Models/User.rb" }]);
    expect(filterPaths([{ path: "a" }], "  ")).toHaveLength(1);
  });
});
