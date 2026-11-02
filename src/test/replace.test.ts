import { describe, expect, it } from "vitest";
import { editsFor, matchKey, previewLine, segments, type LineMatch } from "../replace";

const line: LineMatch = { line: 4, text: "  user_id = post_id", ranges: [[2, 9], [12, 19]], replacements: ["userId", "postId"] };

describe("replace preview", () => {
  it("splits a line into plain text and matches with replacements", () => {
    expect(segments(line)).toEqual([
      { kind: "plain", text: "  " },
      { kind: "match", index: 0, old: "user_id", new: "userId" },
      { kind: "plain", text: " = " },
      { kind: "match", index: 1, old: "post_id", new: "postId" },
    ]);
  });

  it("previews the replaced line, keeping excluded matches", () => {
    expect(previewLine(line)).toBe("  userId = postId");
    expect(previewLine(line, new Set([matchKey(4, 1)]))).toBe("  userId = post_id");
  });

  it("shows the original text when not replacing", () => {
    const find: LineMatch = { line: 1, text: "abc", ranges: [[1, 2]] };
    expect(segments(find)[1]).toEqual({ kind: "match", index: 0, old: "b", new: null });
    expect(previewLine(find)).toBe("abc");
  });

  it("handles UTF-16 offsets after astral characters", () => {
    const emoji: LineMatch = { line: 1, text: "😀 foo", ranges: [[3, 6]], replacements: ["bar"] };
    expect(previewLine(emoji)).toBe("😀 bar");
  });
});

describe("replace edits", () => {
  it("builds edits for every match, or only included ones", () => {
    expect(editsFor([line], null)).toEqual([
      { line: 4, start: 2, end: 9, old: "user_id", new: "userId" },
      { line: 4, start: 12, end: 19, old: "post_id", new: "postId" },
    ]);
    expect(editsFor([line], new Set([matchKey(4, 0)]))).toEqual([{ line: 4, start: 12, end: 19, old: "post_id", new: "postId" }]);
  });

  it("produces nothing for find-only results", () => {
    expect(editsFor([{ line: 1, text: "x", ranges: [[0, 1]] }], null)).toEqual([]);
  });

  it("keys exclusions by line and match index", () => {
    const two: LineMatch = { line: 9, text: "a a", ranges: [[0, 1], [2, 3]], replacements: ["b", "b"] };
    expect(editsFor([line, two], new Set([matchKey(9, 0), matchKey(4, 0), matchKey(4, 1)]))).toEqual([{ line: 9, start: 2, end: 3, old: "a", new: "b" }]);
  });
});
