import { describe, expect, it } from "vitest";
import { autoEndText } from "../autoend";

/// `^` marks the caret line after pressing Enter.
const at = (src: string) => {
  const lines = src.split("\n");
  const i = lines.findIndex((l) => l.includes("^"));
  lines[i] = lines[i].replace("^", "");
  return autoEndText(lines, i + 1);
};

describe("auto end", () => {
  it.each([
    ["def show\n  ^", "\nend"],
    ["class Post < ApplicationRecord\n  ^", "\nend"],
    ["  module Admin\n    ^", "\n  end"],
    ["if ok\n  ^", "\nend"],
    ["unless ok\n  ^", "\nend"],
    ["case x\n  ^", "\nend"],
    ["while running\n  ^", "\nend"],
    ["begin\n  ^", "\nend"],
    ["posts.each do |post|\n  ^", "\nend"],
    ["  it \"works\" do\n    ^", "\n  end"],
    ["x = if ok\n  ^", "\nend"],
    ["@total ||= begin\n  ^", "\nend"],
    ["def a # comment\n  ^\ndef b\nend", "\nend"],
  ])("adds end after %j", (src, want) => expect(at(src)).toBe(want));

  it.each([
    ["def show\n  ^\n  render\nend"],
    ["def show\n  ^\nend"],
    ["if ok\n  ^\nelse\nend"],
    ["return if ok\n^"],
    ["def full_name = \"#{first} #{last}\"\n^"],
    ["class Foo; end\n^"],
    ["# def commented\n^"],
    ["puts 'done'\n^"],
    ["x = 1 if y\n^"],
  ])("leaves %j alone", (src) => expect(at(src)).toBeNull());
});
