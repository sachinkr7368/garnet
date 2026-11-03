import { describe, expect, it, vi } from "vitest";
vi.mock("../editor", async () => await import("./fakeEditor"));
vi.mock("../debug", () => ({ debugSession: vi.fn(), sessionFor: () => null, stopSession: vi.fn() }));

import { applyTextEdits, lspPos, lspRange, progressLabel, toRange } from "../lsp";

const r = (sl: number, sc: number, el: number, ec: number) => ({ start: { line: sl, character: sc }, end: { line: el, character: ec } });

describe("position conversion", () => {
  it("converts 1-based Monaco positions to 0-based LSP positions and back", () => {
    expect(lspPos({ lineNumber: 1, column: 1 })).toEqual({ line: 0, character: 0 });
    const monacoRange = { startLineNumber: 3, startColumn: 5, endLineNumber: 4, endColumn: 2 };
    expect(lspRange(monacoRange)).toEqual(r(2, 4, 3, 1));
    expect({ ...toRange(lspRange(monacoRange)) }).toEqual(monacoRange);
  });
});

describe("applyTextEdits", () => {
  it("applies edits from the end so earlier offsets stay valid", () => {
    const text = "def a\n  1\nend\n";
    expect(applyTextEdits(text, [{ range: r(0, 4, 0, 5), newText: "b" }, { range: r(1, 2, 1, 3), newText: "42" }])).toBe("def b\n  42\nend\n");
  });

  it("counts characters in UTF-16 code units like LSP", () => {
    expect(applyTextEdits("x = '😀'; y\n", [{ range: r(0, 10, 0, 11), newText: "z" }])).toBe("x = '😀'; z\n");
  });

  it("clamps positions past the end and supports inserts", () => {
    expect(applyTextEdits("a\n", [{ range: r(5, 0, 5, 0), newText: "b" }])).toBe("a\nb");
    expect(applyTextEdits("ac", [{ range: r(0, 1, 0, 1), newText: "b" }])).toBe("abc");
  });
});

describe("progressLabel", () => {
  it("drops the server's own name so the status bar says Ruby LSP once", () => {
    expect(progressLabel("Ruby LSP: indexing files", 0)).toBe("indexing files 0%");
    expect(progressLabel("Ruby LSP", 39)).toBe("39%");
    expect(progressLabel("Indexing")).toBe("Indexing");
  });
});
