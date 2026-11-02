import { describe, expect, it } from "vitest";
import { symbolPath, type SymbolNode } from "../breadcrumbs";

const r = (sl: number, sc: number, el: number, ec: number) => ({ startLineNumber: sl, startColumn: sc, endLineNumber: el, endColumn: ec });
const sym = (name: string, range: ReturnType<typeof r>, children: SymbolNode[] = []): SymbolNode => ({ name, kind: 4, range, selectionRange: range, children });

const tree = [
  sym("Admin", r(1, 1, 20, 4), [
    sym("PostsController", r(2, 3, 19, 6), [sym("index", r(3, 5, 5, 8)), sym("show", r(7, 5, 9, 8)), sym("helper_method", r(7, 5, 7, 30))]),
  ]),
  sym("Other", r(22, 1, 24, 4)),
];
const names = (line: number, col: number) => symbolPath(tree, line, col).map((s) => s.name);

describe("breadcrumb symbol path", () => {
  it("returns the enclosing chain, outermost first", () => {
    expect(names(4, 7)).toEqual(["Admin", "PostsController", "index"]);
    expect(names(23, 1)).toEqual(["Other"]);
  });

  it("stops at the innermost container between children", () => {
    expect(names(6, 1)).toEqual(["Admin", "PostsController"]);
    expect(names(21, 1)).toEqual([]);
  });

  it("includes range edges and prefers the later of overlapping siblings", () => {
    expect(names(3, 5)).toEqual(["Admin", "PostsController", "index"]);
    expect(names(5, 8)).toEqual(["Admin", "PostsController", "index"]);
    expect(names(5, 9)).toEqual(["Admin", "PostsController"]);
    expect(names(7, 10)).toEqual(["Admin", "PostsController", "helper_method"]);
  });

  it("handles empty symbol lists", () => {
    expect(symbolPath([], 1, 1)).toEqual([]);
  });
});
