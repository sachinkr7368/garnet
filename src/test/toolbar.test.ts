import { describe, expect, it, vi } from "vitest";
vi.mock("../editor", async () => await import("./fakeEditor"));
vi.mock("../git", () => ({ refreshGit: vi.fn() }));

import { currentWorktree, parseWorktrees, worktreeLabel } from "../toolbar";

const porcelain = `worktree /src/garnet
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /src/garnet/.claude/worktrees/ux-quality
HEAD 2222222222222222222222222222222222222222
branch refs/heads/feat/ux-quality

worktree /src/garnet-hotfix
HEAD 3333333333333333333333333333333333333333
detached

`;

describe("worktree switcher", () => {
  it("parses git worktree list --porcelain", () => {
    expect(parseWorktrees(porcelain)).toEqual([
      { path: "/src/garnet", branch: "main", main: true },
      { path: "/src/garnet/.claude/worktrees/ux-quality", branch: "feat/ux-quality", main: false },
      { path: "/src/garnet-hotfix", branch: "detached", main: false },
    ]);
    expect(parseWorktrees("")).toEqual([]);
  });

  it("labels the main checkout with the repository name and a main tag", () => {
    expect(worktreeLabel(parseWorktrees(porcelain), "/src/garnet")).toEqual({ name: "garnet", main: true });
  });

  it("labels a linked worktree with its folder name, even when nested inside the main checkout", () => {
    const trees = parseWorktrees(porcelain);
    expect(worktreeLabel(trees, "/src/garnet/.claude/worktrees/ux-quality")).toEqual({ name: "ux-quality", main: false });
    expect(worktreeLabel(trees, "/src/garnet-hotfix")).toEqual({ name: "garnet-hotfix", main: false });
    expect(currentWorktree(trees, "/src/garnet/app")?.path).toBe("/src/garnet");
    expect(worktreeLabel(trees, "/elsewhere")).toBeNull();
  });

  it("never shows a worktree count on the button", () => {
    const btn = document.querySelector("#switchers .switcher:nth-child(2)")!;
    expect(btn.getAttribute("title")).toBe("Git worktrees");
    expect(btn.textContent ?? "").not.toMatch(/\d+ worktrees/);
  });
});
