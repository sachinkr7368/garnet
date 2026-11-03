import { beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
(globalThis as any).Worker ??= class {
  onmessage = null;
  postMessage() {}
  terminate() {}
  addEventListener() {}
};

import { editorHasFocus } from "../commands";
import type { Tab } from "../editor";

let basics: typeof import("../basics");
let editorMod: typeof import("../editor");
let lsp: typeof import("../lsp");
let tree: typeof import("../tree");
beforeAll(async () => {
  [basics, editorMod, lsp, tree] = await Promise.all([import("../basics"), import("../editor"), import("../lsp"), import("../tree")]);
});

describe("tab context menu groups", () => {
  const tab = (title: string, pinned = false) => ({ title, pinned }) as Tab;
  const [a, b, c, d] = [tab("a"), tab("b", true), tab("c"), tab("d")];
  const list = [a, b, c, d];
  const dirty = (t: Tab) => t === d;
  const names = (ts: Tab[]) => ts.map((t) => t.title).join("");
  it.each([
    ["others", "ad"],
    ["all", "abcd"],
    ["unmodified", "ac"],
    ["right", "d"],
    ["unpinned", "acd"],
  ] as const)("%s closes %s (pinned b stays except for Close All)", (action, want) => {
    expect(names(editorMod.tabsToClose(list, c, action, dirty))).toBe(want);
  });
});

describe("copy reference", () => {
  it("builds Ruby references from the symbols around the caret", () => {
    const K = editorMod.monaco.languages.SymbolKind;
    expect(basics.rubyReference([{ name: "Admin", kind: K.Module }, { name: "PostsController", kind: K.Class }, { name: "index", kind: K.Method }])).toBe("Admin::PostsController#index");
    expect(basics.rubyReference([{ name: "Post", kind: K.Class }, { name: "self.recent", kind: K.Method }])).toBe("Post.recent");
    expect(basics.rubyReference([{ name: "Post", kind: K.Class }, { name: "LIMIT", kind: K.Constant }])).toBe("Post::LIMIT");
    expect(basics.rubyReference([])).toBe("");
  });
});

describe("extract constant", () => {
  it("puts the constant under the enclosing class, else after the file's leading comments", () => {
    const src = ["# frozen_string_literal: true", "", "module Admin", "  class Post", "    def x", "      limit(25)", "    end", "  end", "end"];
    expect(basics.constantSite(src, 6)).toEqual({ line: 5, indent: "    " });
    expect(basics.constantSite(["# frozen_string_literal: true", "puts 25"], 2)).toEqual({ line: 2, indent: "" });
  });
});

describe("auto end edits", () => {
  it("joins inserts at one position in order", () => {
    const r = new editorMod.monaco.Range(2, 3, 2, 3);
    expect(basics.mergeInserts([{ range: r, text: "\n" }, { range: r, text: "end" }])).toEqual([{ range: r, text: "\nend" }]);
  });
});

describe("ruby-lsp results", () => {
  it("turns a SelectionRange parent chain into Extend Selection steps, innermost first", () => {
    const r = (l: number, a: number, b: number) => ({ start: { line: l, character: a }, end: { line: l, character: b } });
    const chain = lsp.selectionChain({ range: r(0, 4, 8), parent: { range: r(0, 0, 12), parent: { range: { start: { line: 0, character: 0 }, end: { line: 3, character: 3 } } } } });
    expect(chain.map((c) => `${c.range.startLineNumber}:${c.range.startColumn}-${c.range.endLineNumber}:${c.range.endColumn}`)).toEqual(["1:5-1:9", "1:1-1:13", "1:1-4:4"]);
  });

  it("maps signature help for Parameter Info", () => {
    const help = lsp.signatureHelp({ activeParameter: 1, signatures: [{ label: "link_to(name, options)", parameters: [{ label: "name" }, { label: [13, 20] }] }] });
    expect(help.activeParameter).toBe(1);
    expect(help.signatures[0].parameters.map((p) => p.label)).toEqual(["name", [13, 20]]);
  });
});

describe("project tree", () => {
  it("proposes a _copy name on paste", () => {
    expect(tree.copyName("post.rb")).toBe("post_copy.rb");
    expect(tree.copyName("Gemfile")).toBe("Gemfile_copy");
  });
});

describe("editor shortcuts and focus", () => {
  it("runs editor commands only from an editor or the editor area, not a tool window or field", () => {
    const at = (cls: string, tag = "div") => {
      const host = document.createElement("div");
      host.className = cls;
      const el = document.createElement(tag);
      host.append(el);
      document.body.append(host);
      return el;
    };
    expect(editorHasFocus(document.body)).toBe(true);
    expect(editorHasFocus(at("monaco-editor", "textarea"))).toBe(true);
    expect(editorHasFocus(document.getElementById("tabs"))).toBe(true);
    expect(editorHasFocus(at("tree"))).toBe(false);
    expect(editorHasFocus(at("xterm", "textarea"))).toBe(false);
    expect(editorHasFocus(at("x", "input"))).toBe(false);
  });
});

describe("encodings", () => {
  it("edits to closed files keep their encoding and BOM, and refuse damaged loads", () => {
    const file = { text: "caf\u00e9\n", encoding: "windows-1252", bom: false, size: 6, truncated: false, lossy: false };
    const edit = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "CAF" }];
    expect(lsp.closedFileEdit(file, edit)).toEqual({ text: "CAF\u00e9\n", encoding: "windows-1252", bom: false });
    expect(lsp.closedFileEdit({ ...file, encoding: "UTF-8", bom: true }, edit).bom).toBe(true);
    expect(() => lsp.closedFileEdit({ ...file, lossy: true }, edit)).toThrow();
    expect(() => lsp.closedFileEdit({ ...file, truncated: true }, edit)).toThrow();
  });

  it("keeps a UTF-8 BOM on convert unless UTF-8 (no BOM) is picked", () => {
    expect(editorMod.convertedBom({ encoding: "UTF-8", bom: true }, "UTF-8")).toBe(true);
    expect(editorMod.convertedBom({ encoding: "UTF-8", bom: true }, "UTF-8 (no BOM)")).toBe(false);
    expect(editorMod.convertedBom({ encoding: "windows-1252", bom: false }, "UTF-8")).toBe(false);
    expect(editorMod.convertedBom({ encoding: "UTF-8", bom: false }, "UTF-16LE")).toBe(true);
  });

  it("locks buffers that did not decode or were cut", () => {
    expect(editorMod.lockedReason({ encoding: "UTF-8", bom: false, large: false, lossy: true })).toContain("not valid UTF-8");
    expect(editorMod.lockedReason({ encoding: "UTF-8", bom: false, large: true })).toContain("10 MB");
    expect(editorMod.lockedReason({ encoding: "UTF-8", bom: false, large: false })).toBeNull();
  });
});

describe("project tree delete", () => {
  it("asks with Cancel focused; Escape keeps the file", async () => {
    const answer = tree.confirmTrash("app/models/post.rb");
    const dialog = document.querySelector(".trash-dialog")!;
    expect(dialog.textContent).toContain("Move app/models/post.rb to the Trash?");
    expect(document.activeElement?.textContent).toBe("Cancel");
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(await answer).toBe(false);
    expect(document.querySelector(".trash-dialog")).toBeNull();
  });
});
