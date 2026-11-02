import { describe, expect, it } from "vitest";
import { applyTokenEdits, decodeTokens, ruleFor, SEMANTIC_RULES, type ThemeKind } from "../semantic";

// ruby-lsp's legend (ResponseBuilders::SemanticHighlighting) and the types it emits.
const legend = {
  tokenTypes: ["namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property", "enumMember", "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator", "decorator"],
  tokenModifiers: ["declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification", "documentation", "defaultLibrary"],
};
const EMITTED = ["namespace", "type", "class", "parameter", "variable", "method"];

describe("semantic token decoding", () => {
  it("turns relative LSP encoding into absolute positions with names", () => {
    const data = [0, 6, 15, 2, 1, 1, 6, 5, 13, 0, 0, 7, 4, 7, 0, 2, 2, 3, 8, 0];
    expect(decodeTokens(data, legend)).toEqual([
      { line: 0, character: 6, length: 15, type: "class", modifiers: ["declaration"] },
      { line: 1, character: 6, length: 5, type: "method", modifiers: [] },
      { line: 1, character: 13, length: 4, type: "parameter", modifiers: [] },
      { line: 3, character: 2, length: 3, type: "variable", modifiers: [] },
    ]);
  });

  it("decodes several modifier bits", () => {
    expect(decodeTokens([0, 0, 1, 8, 0b101], legend)[0].modifiers).toEqual(["declaration", "readonly"]);
  });

  it("applies delta edits from the end", () => {
    expect(applyTokenEdits([1, 2, 3, 4, 5, 6], [{ start: 0, deleteCount: 1, data: [9] }, { start: 4, deleteCount: 2 }])).toEqual([9, 2, 3, 4]);
    expect(applyTokenEdits([1, 2], [{ start: 2, deleteCount: 0, data: [3, 4] }])).toEqual([1, 2, 3, 4]);
  });
});

describe("semantic token colors", () => {
  for (const kind of ["dark", "light"] as ThemeKind[]) {
    it(`styles every ruby-lsp token type in the ${kind} theme`, () => {
      for (const type of EMITTED) expect(ruleFor(type, [], SEMANTIC_RULES[kind])?.foreground, `${kind} ${type}`).toMatch(/^[0-9a-f]{6}$/);
    });
  }

  it("matches modifiers by the longest prefix", () => {
    const rules = SEMANTIC_RULES.dark;
    expect(ruleFor("variable", ["defaultLibrary"], rules)?.token).toBe("variable.defaultLibrary");
    expect(ruleFor("class", ["declaration"], rules)?.token).toBe("class");
    expect(ruleFor("unknownType", [], rules)).toBeUndefined();
  });

  it("uses different colors per theme so tokens stay readable", () => {
    for (const type of EMITTED) expect(ruleFor(type, [], SEMANTIC_RULES.dark)?.foreground).not.toBe(ruleFor(type, [], SEMANTIC_RULES.light)?.foreground);
  });

  it("defines the same token keys for both themes", () => {
    expect(SEMANTIC_RULES.dark.map((r) => r.token)).toEqual(SEMANTIC_RULES.light.map((r) => r.token));
  });
});
