import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../editor", async () => await import("./fakeEditor"));
vi.mock("../git", () => ({ refreshGit: vi.fn() }));
vi.mock("../merge", () => ({ runGitOp: vi.fn(async () => true) }));

import { ask, message } from "@tauri-apps/plugin-dialog";
import { runGitOp } from "../merge";
import { trustProject } from "../settings";
import { state } from "../state";
import { checkout, currentWorktree, headLabel, newWorktree, parseWorktrees, refreshToolbar, worktreeLabel } from "../toolbar";
import { fake } from "./fakeIpc";

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

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const runs = () => fake.invocations.filter((i) => i.cmd === "git_run").map((i) => (i.args.args as string[]).join(" "));
const enter = async (value?: string) => {
  const input = document.querySelector<HTMLInputElement>(".qp-input")!;
  if (value !== undefined) input.value = value;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flush();
};

describe("git actions", () => {
  let git: (args: string[]) => unknown;
  beforeEach(async () => {
    fake.reset();
    state.project = { root: "/src/garnet", name: "garnet", git: true } as never;
    await trustProject("/src/garnet", true);
    vi.mocked(runGitOp).mockClear();
    vi.mocked(ask).mockReset().mockResolvedValue(true);
    document.getElementById("overlay-root")!.replaceChildren();
    git = () => "";
    fake.handlers.set("git_run", ({ args }: { args: string[] }) => git(args));
  });

  it("Stash and Checkout restores the changes on the new branch (B28)", async () => {
    git = (a) => (a[0] === "status" ? " M a.rb\n" : "");
    vi.mocked(message).mockResolvedValueOnce("Stash and Checkout" as never);
    await checkout("feature");
    expect(runs().slice(0, 3)).toEqual(["status --porcelain --untracked-files=no", "stash push -m garnet: before checkout feature", "checkout feature"]);
    expect(runGitOp).toHaveBeenCalledWith("Restore local changes", ["stash", "pop"]);
  });

  it("puts the stash back when the checkout fails, and never checks out when the stash fails (B28)", async () => {
    git = (a) => (a[0] === "status" ? " M a.rb\n" : a[0] === "checkout" ? Promise.reject("error: would be overwritten") : "");
    vi.mocked(message).mockResolvedValueOnce("Stash and Checkout" as never);
    await checkout("feature");
    expect(runGitOp).toHaveBeenCalledWith("Checkout failed; restore local changes", ["stash", "pop"]);

    fake.invocations.length = 0;
    vi.mocked(runGitOp).mockClear();
    document.getElementById("overlay-root")!.replaceChildren();
    git = (a) => (a[0] === "status" ? " M a.rb\n" : a[0] === "stash" ? Promise.reject("cannot stash") : "");
    vi.mocked(message).mockResolvedValueOnce("Stash and Checkout" as never);
    await checkout("feature");
    expect(runs().some((r) => r.startsWith("checkout"))).toBe(false);
    expect(runGitOp).not.toHaveBeenCalled();
    expect(document.querySelector(".toast.error")?.textContent).toContain("cannot stash");
  });

  it("offers to open a new worktree only when git worktree add worked (B35)", async () => {
    git = (a) => (a[0] === "worktree" ? Promise.reject("fatal: already exists") : "");
    newWorktree();
    await flush();
    await enter("feat");
    await enter();
    expect(runs()).toContain("worktree add -b feat /src/garnet-feat");
    expect(ask).not.toHaveBeenCalled();

    git = () => "";
    newWorktree();
    await flush();
    await enter("feat2");
    await enter();
    expect(ask).toHaveBeenCalledWith("Open garnet-feat2 in a new window?", expect.anything());
  });

  it("labels a detached HEAD and shows full names on hover (B62, B63)", async () => {
    const long = "a-very-long-worktree-folder-name-that-will-not-fit";
    git = (a) =>
      a.join(" ") === "rev-parse --abbrev-ref HEAD" ? "HEAD\n" : a.join(" ") === "rev-parse HEAD" ? "abc1234def\n" : a[0] === "worktree" ? `worktree /src/garnet\nbranch refs/heads/main\n\nworktree /src/${long}\ndetached\n\n` : "";
    state.project = { root: `/src/${long}`, name: long, git: true } as never;
    await refreshToolbar();
    const [, worktreeBtn, branchBtn] = document.querySelectorAll("#switchers .switcher");
    expect(branchBtn.querySelector(".name")!.textContent).toBe("detached at abc1234");
    expect(worktreeBtn.querySelector(".name")!.getAttribute("title")).toBe(`${long} (detached)\n/src/${long}`);
    expect(headLabel("main", "")).toBe("main");
  });
});
