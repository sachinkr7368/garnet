import { describe, expect, it, vi } from "vitest";
vi.mock("../editor", async () => await import("./fakeEditor"));

import { FILE_LINE } from "../terminal";
import { fuzzyFilter, fuzzyScore } from "../ui";

const links = (line: string) => [...line.matchAll(FILE_LINE)].map((m) => [m[1], m[2], m[3]]);

describe("file:line links in consoles", () => {
  it.each([
    ["rspec ./spec/models/post_spec.rb:12 # Post works", [["./spec/models/post_spec.rb", "12", undefined]]],
    ["app/models/post.rb:3:in 'Post#title'", [["app/models/post.rb", "3", undefined]]],
    ["/Users/me/blog/app/x.rb:10:5: warning", [["/Users/me/blog/app/x.rb", "10", "5"]]],
    ["config/locales/en.yml:4 and app/views/a.html.erb:7", [["config/locales/en.yml", "4", undefined], ["app/views/a.html.erb", "7", undefined]]],
    ["from ../lib/tasks/x.rake:2", [["../lib/tasks/x.rake", "2", undefined]]],
    ["http://localhost:3000 and README.md:1", []],
  ])("%s", (line, expected) => expect(links(line)).toEqual(expected));

  it("finds links once xterm has stripped ANSI colour codes", () => {
    const colored = "\x1b[31mFailure/Error:\x1b[0m \x1b[36m# ./spec/a_spec.rb:9\x1b[0m";
    expect(links(colored.replace(/\x1b\[[0-9;]*m/g, ""))).toEqual([["./spec/a_spec.rb", "9", undefined]]);
  });
});

describe("fuzzy matcher", () => {
  it("requires every query character in order", () => {
    expect(fuzzyScore("pc", "posts_controller.rb")).not.toBeNull();
    expect(fuzzyScore("cp", "pc")).toBeNull();
    expect(fuzzyScore("", "anything")).toBe(0);
    expect(fuzzyScore("Post", "post.rb")).not.toBeNull();
  });

  it("prefers word starts, camel humps and consecutive runs", () => {
    const items = ["app/models/post_comment.rb", "app/controllers/posts_controller.rb", "lib/compact.rb"];
    expect(fuzzyFilter("pc", items, (s) => s)[0]).toBe("app/models/post_comment.rb");
    expect(fuzzyFilter("post", ["p_o_s_t.rb", "post.rb"], (s) => s)).toEqual(["post.rb", "p_o_s_t.rb"]);
    expect(fuzzyFilter("gtf", ["gotofile", "goToFile"], (s) => s)).toEqual(["goToFile", "gotofile"]);
    expect(fuzzyFilter("zz", items, (s) => s)).toEqual([]);
  });

  it("ignores spaces in the query and keeps order for an empty query", () => {
    expect(fuzzyScore("go file", "goToFile")).not.toBeNull();
    expect(fuzzyFilter(" ", ["b", "a"], (s) => s)).toEqual(["b", "a"]);
  });
});
