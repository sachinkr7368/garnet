import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../editor", async () => await import("./fakeEditor"));
vi.mock("../git", () => ({ refreshGit: vi.fn() }));
vi.mock("../merge", () => ({ runGitOp: vi.fn(async () => true) }));

import { ask, message } from "@tauri-apps/plugin-dialog";
import { runGitOp } from "../merge";
import { loadSettings, setting, trustProject } from "../settings";
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

  /// A fake stash stack: `push` adds a commit unless `pushMakes` is empty, `fail` names subcommands that error.
  const stashRepo = (opts: { pushMakes?: string; fail?: string[] } = {}) => {
    const stack = ["older"];
    git = (a) => {
      if (opts.fail?.includes(a[0])) {
        if (a[0] === "stash" && a[1] === "push" && opts.pushMakes) stack.unshift(opts.pushMakes);
        if (a[0] !== "stash" || a[1] === "push") return Promise.reject(`cannot ${a[0]}`);
      }
      if (a[0] === "status") return " M a.rb\n";
      if (a.join(" ") === "rev-parse -q --verify refs/stash") return stack[0] ? `${stack[0]}\n` : Promise.reject("");
      if (a.join(" ") === "stash list --format=%H") return stack.join("\n");
      if (a[0] === "stash" && a[1] === "push" && opts.pushMakes) stack.unshift(opts.pushMakes);
      return "";
    };
    vi.mocked(message).mockResolvedValueOnce("Stash and Checkout" as never);
  };

  it("Stash and Checkout restores exactly its own stash on the new branch (B28)", async () => {
    stashRepo({ pushMakes: "mine" });
    await checkout("feature");
    expect(runs().filter((r) => !r.startsWith("rev-parse") && !r.startsWith("stash list")).slice(0, 3)).toEqual(["status --porcelain --untracked-files=no", "stash push -m garnet: before checkout feature", "checkout feature"]);
    expect(runGitOp).toHaveBeenCalledWith("Restore local changes", ["stash", "pop", "stash@{0}"]);
  });

  it("pops nothing when the stash push made no stash", async () => {
    stashRepo();
    await checkout("feature");
    expect(runs()).toContain("checkout feature");
    expect(runGitOp).not.toHaveBeenCalled();
  });

  it("puts the stash back when the checkout fails, and never checks out when the stash fails (B28)", async () => {
    stashRepo({ pushMakes: "mine", fail: ["checkout"] });
    await checkout("feature");
    expect(runGitOp).toHaveBeenCalledWith("Checkout failed; restore local changes", ["stash", "pop", "stash@{0}"]);

    fake.invocations.length = 0;
    vi.mocked(runGitOp).mockClear();
    document.getElementById("overlay-root")!.replaceChildren();
    stashRepo({ pushMakes: "partial", fail: ["stash"] });
    await checkout("feature");
    expect(runs().some((r) => r.startsWith("checkout"))).toBe(false);
    expect(runs()).toContain("stash drop stash@{0}");
    expect(runs()).not.toContain("stash drop stash@{1}");
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

describe("theme menu", () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));
  beforeEach(async () => {
    fake.reset();
    await loadSettings(null);
  });

  it("toolbar theme menu offers System, Light and Dark with a checkmark on the current one", async () => {
    const btn = document.getElementById("theme-toggle")!;
    expect(btn.title).toMatch(/^Theme: System/);
    btn.click();
    const items = () => [...document.querySelectorAll<HTMLElement>("#overlay-root .ctx-item")];
    expect(items().map((i) => i.textContent)).toEqual(["System", "Light", "Dark"]);
    expect(items().map((i) => i.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    items()[2].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await settle();
    await settle();
    expect(setting("appearance.theme")).toBe("dark");
    expect(btn.title).toBe("Theme: Dark");
    btn.click();
    expect(items().map((i) => i.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
    items()[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await settle();
    await settle();
    expect(setting("appearance.theme")).toBe("system");
  });

});
