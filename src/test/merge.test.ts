import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[][] = [];
const state = { ours: "x" as string | null, theirs: "y" as string | null, fail: false, conflicts: [] as string[], op: "" };
vi.mock("../editor", async () => await import("./fakeEditor"));
vi.mock("../ipc", () => ({
  api: {
    git: vi.fn(async (_root: string, ...args: string[]) => {
      calls.push(args);
      if (state.fail) throw new Error("CONFLICT (content)");
      return "ok\n";
    }),
    gitFileAt: vi.fn(async (_r: string, rev: string) => (rev === ":2" ? state.ours : state.theirs)),
    gitOpState: vi.fn(async () => ({ op: state.op, conflicts: state.conflicts })),
    gitMergeInput: vi.fn(async () => ({ symlink: false, nonUtf8: true, base: "caf\ufffd\n", ours: "a\n", theirs: "b\n", merged: "" })),
    writeFile: vi.fn(async () => {}),
  },
}));

const { ask, message } = await import("@tauri-apps/plugin-dialog");
const { abortOperation, acceptSide, continueOperation, openResolver, runGitOp } = await import("../merge");
const { api } = await import("../ipc");
const { state: appState } = await import("../state");

beforeEach(() => {
  calls.length = 0;
  Object.assign(state, { ours: "x", theirs: "y", fail: false, conflicts: [], op: "" });
  appState.project = { root: "/repo" } as never;
  document.getElementById("overlay-root")!.replaceChildren();
});

describe("conflict actions", () => {
  it("accepts a side with checkout and add", async () => {
    await acceptSide("a.rb", "theirs");
    expect(calls).toEqual([
      ["checkout", "--theirs", "--", "a.rb"],
      ["add", "--", "a.rb"],
    ]);
  });

  it("deletes the file when the chosen side deleted it", async () => {
    state.ours = null;
    await acceptSide("a.rb", "ours");
    expect(calls).toEqual([["rm", "-q", "--", "a.rb"]]);
  });

  it("continues a merge by committing and a rebase with --continue", async () => {
    await continueOperation("merge");
    await continueOperation("rebase");
    expect(calls).toEqual([
      ["commit", "--no-edit"],
      ["rebase", "--continue"],
    ]);
  });

  it("asks before aborting", async () => {
    vi.mocked(ask).mockResolvedValueOnce(false);
    await abortOperation("cherry-pick");
    expect(calls).toEqual([]);
    vi.mocked(ask).mockResolvedValueOnce(true);
    await abortOperation("cherry-pick");
    expect(calls).toEqual([["cherry-pick", "--abort"]]);
  });
});

describe("runGitOp", () => {
  it("opens the conflicts list when an operation stops on conflicts", async () => {
    state.fail = true;
    state.op = "cherry-pick";
    state.conflicts = ["app/a.rb"];
    expect(await runGitOp("Cherry-pick", ["cherry-pick", "abc"])).toBe(false);
    const overlay = document.getElementById("overlay-root")!;
    expect(overlay.querySelector(".conflicts-dialog")?.textContent).toContain("cherry-pick in progress");
    expect(overlay.querySelectorAll(".conflict-row")).toHaveLength(1);
  });

  it("reports a plain failure without opening the list", async () => {
    state.fail = true;
    expect(await runGitOp("Revert", ["revert", "abc"])).toBe(false);
    const overlay = document.getElementById("overlay-root")!;
    expect(overlay.querySelector(".conflicts-dialog")).toBeNull();
    expect(overlay.querySelector(".toast.error")?.textContent).toContain("Revert failed");
  });
});

describe("non-UTF-8 conflicts (B14)", () => {
  it("offers only whole-side resolution, so the bytes are never rewritten as text", async () => {
    vi.mocked(message).mockResolvedValueOnce("Accept Yours" as never);
    expect(await openResolver("latin1.txt")).toBeNull();
    expect(vi.mocked(message).mock.calls[0][0]).toContain("not UTF-8");
    expect(calls).toEqual([
      ["checkout", "--ours", "--", "latin1.txt"],
      ["add", "--", "latin1.txt"],
    ]);
    expect(api.writeFile).not.toHaveBeenCalled();
  });
});
