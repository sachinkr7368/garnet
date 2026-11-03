import { beforeEach, describe, expect, it, vi } from "vitest";
import { gutterDiff } from "../difflogic";

interface FakeModel {
  text: string;
  getValue: () => string;
  getEOL: () => string;
  pushStackElement: () => void;
  pushEditOperations: ReturnType<typeof vi.fn>;
}
const model = (text: string): FakeModel => ({ text, getValue: () => text, getEOL: () => "\n", pushStackElement: () => {}, pushEditOperations: vi.fn() });
const ed = vi.hoisted(() => ({
  tab: null as null | { path: string; kind: string; model: unknown },
  selection: { startLineNumber: 1, endLineNumber: 1 },
  openTextDiff: vi.fn(),
  openDiffTab: vi.fn(),
  handleFsChanged: vi.fn(async () => {}),
}));
vi.mock("../editor", async () => {
  const fake = await import("./fakeEditor");
  return {
    ...fake,
    activeTab: () => ed.tab,
    openTextDiff: ed.openTextDiff,
    openDiffTab: ed.openDiffTab,
    handleFsChanged: ed.handleFsChanged,
    editor: new Proxy(fake.editor, { get: (t, k) => (k === "getSelection" ? () => ed.selection : k === "getSelections" ? () => [] : t[k as never]) }),
  };
});
vi.mock("@tauri-apps/api/core", () => import("./fakeIpc"));
vi.mock("../ipc", () => import("./realIpc"));
vi.mock("../diffworker?worker", () => ({
  default: class {
    onmessage: (e: { data: unknown }) => void = () => {};
    postMessage(d: { id: number; a: string; b: string }) {
      setTimeout(() => this.onmessage({ data: { id: d.id, hunks: gutterDiff(d.a, d.b) } }));
    }
  },
}));

const { fake } = await import("./fakeIpc");
const { ask } = await import("@tauri-apps/plugin-dialog");
const { state } = await import("../state");
const { trustProject, updateSetting } = await import("../settings");
const git = await import("../git");
document.body.append(git.commitView);

const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 6; i++) await flush();
};

/// A fake repository behind the git IPC commands.
const repo = {
  status: [] as { path: string; index: string; worktree: string; orig?: string | null }[],
  branch: "main",
  files: new Map<string, string>(),
  runs: [] as string[][],
  delay: null as null | Promise<void>,
};
const inv = (cmd: string) => fake.invocations.filter((i) => i.cmd === cmd);

beforeEach(async () => {
  fake.reset();
  Object.assign(repo, { status: [], branch: "main", files: new Map(), runs: [], delay: null });
  state.project = { root: "/repo", name: "repo", git: true } as never;
  await trustProject("/repo", true);
  await updateSetting("git.checkProblemsBeforeCommit", false);
  vi.mocked(ask).mockReset().mockResolvedValue(false);
  ed.openTextDiff.mockReset();
  ed.handleFsChanged.mockClear();
  ed.tab = null;
  document.getElementById("overlay-root")!.replaceChildren();
  const h = fake.handlers;
  h.set("git_status", async () => {
    const st = repo.status;
    await repo.delay;
    return st;
  });
  h.set("git_branch", async () => {
    const b = repo.branch;
    await repo.delay;
    return b;
  });
  h.set("git_op_state", () => ({ op: "", conflicts: [] }));
  h.set("git_diff_files", () => []);
  h.set("git_file_at", ({ rev, path }: { rev: string; path: string }) => repo.files.get(`${rev}:${path}`) ?? null);
  h.set("git_run", ({ args }: { args: string[] }) => {
    repo.runs.push(args);
    if (args[0] === "log") return "Last message\n\nBody\n";
    if (args.join(" ") === "rev-parse HEAD") return "abc1234def5678\n";
    if (args[0] === "for-each-ref") return "refs/heads/main\t*\torigin/main\t\n";
    return "";
  });
  h.set("git_commit", () => "[main 1234567] done");
  h.set("git_rollback", () => ({ reverted: 1, deleted: 0 }));
  h.set("git_stage", () => {});
  await git.refreshGit();
});

const message = () => document.querySelector<HTMLTextAreaElement>(".commit-message")!;
const commitBtn = () => document.querySelector<HTMLButtonElement>(".commit-btn")!;
const pushBtn = () => document.querySelector<HTMLButtonElement>(".commit-actions .split")!;
const include = (path: string) => {
  const box = row(path).querySelector<HTMLInputElement>(".include-box")!;
  box.checked = !box.checked;
  box.dispatchEvent(new Event("change"));
};
const toasts = () => [...document.querySelectorAll("#overlay-root .toast")].map((t) => t.textContent ?? "");
const amendBox = () => document.querySelector<HTMLInputElement>(".amend-box")!;
const type = (text: string) => {
  message().value = text;
  message().dispatchEvent(new Event("input"));
};
const row = (path: string) => document.querySelector<HTMLElement>(`.change-row[data-path="${path}"]`)!;
const menuItem = (label: string) => [...document.querySelectorAll<HTMLElement>(".ctx-item")].find((i) => i.querySelector(".ctx-label")?.textContent === label);

describe("commit (B8, B21)", () => {
  it("is enabled only with a message and files to commit, or amend", () => {
    const base = { message: "msg", files: 1, amend: false, busy: false, conflicts: 0 };
    expect(git.commitReady(base)).toBe(true);
    expect(git.commitReady({ ...base, message: "  " })).toBe(false);
    expect(git.commitReady({ ...base, files: 0 })).toBe(false);
    expect(git.commitReady({ ...base, files: 0, amend: true })).toBe(true);
    expect(git.commitReady({ ...base, busy: true })).toBe(false);
    expect(git.commitReady({ ...base, conflicts: 1 })).toBe(false);
  });

  it("disables the button until staged and runs one commit on a double-click", async () => {
    repo.status = [{ path: "a.rb", index: "M", worktree: " " }];
    await git.refreshGit();
    expect(commitBtn().disabled).toBe(true);
    type("Fix it");
    expect(commitBtn().disabled).toBe(false);
    expect(commitBtn().textContent).toBe("Commit 1 file");
    let finish = () => {};
    fake.handlers.set("git_commit", () => new Promise((r) => (finish = () => r("[main 1] Fix it"))));
    commitBtn().click();
    expect(commitBtn().disabled).toBe(true);
    commitBtn().click();
    git.commit();
    finish();
    await settle();
    expect(inv("git_commit")).toHaveLength(1);
    expect(inv("git_commit")[0].args).toMatchObject({ message: "Fix it", amend: false, paths: null });
  });

  it("amends with the last message prefilled and nothing staged; Commit and Push is off meanwhile", async () => {
    amendBox().checked = true;
    amendBox().dispatchEvent(new Event("change"));
    await settle();
    expect(message().value).toBe("Last message\n\nBody");
    expect(commitBtn().disabled).toBe(false);
    expect(pushBtn().disabled).toBe(true);
    commitBtn().click();
    await settle();
    expect(inv("git_commit")[0].args).toMatchObject({ message: "Last message\n\nBody", amend: true, paths: null });
    expect(ask).not.toHaveBeenCalled();
    expect(amendBox().checked).toBe(false);
  });

  it("never commits the selection: a stale selection is ignored by Amend", async () => {
    repo.status = [{ path: "b.rb", index: " ", worktree: "M" }];
    await git.refreshGit();
    row("b.rb").click();
    amendBox().checked = true;
    amendBox().dispatchEvent(new Event("change"));
    await settle();
    await git.commit();
    await settle();
    expect(inv("git_stage")).toHaveLength(0);
    expect(inv("git_commit")[0].args).toMatchObject({ amend: true, paths: null });
  });

  it("asks before amending a commit that is already on its upstream", async () => {
    const run = fake.handlers.get("git_run")!;
    fake.handlers.set("git_run", (a: { args: string[] }) => (a.args[0] === "rev-list" ? (repo.runs.push(a.args), "0\n") : run(a)));
    amendBox().checked = true;
    amendBox().dispatchEvent(new Event("change"));
    await settle();
    await git.commit();
    expect(repo.runs).toContainEqual(["rev-list", "--count", "@{upstream}..HEAD"]);
    expect(ask).toHaveBeenCalledWith(expect.stringContaining("already pushed"), expect.anything());
    expect(inv("git_commit")).toHaveLength(0);
    vi.mocked(ask).mockResolvedValue(true);
    await git.commit();
    expect(inv("git_commit")[0].args).toMatchObject({ amend: true });
  });

  it("commits only the ticked files, staging untracked ones, and Commit and Push pushes after", async () => {
    repo.status = [
      { path: "b.rb", index: " ", worktree: "M" },
      { path: "c.rb", index: "?", worktree: "?" },
      { path: "s.rb", index: "M", worktree: " " },
    ];
    await git.refreshGit();
    row("s.rb").click();
    include("b.rb");
    include("c.rb");
    type("Ticked");
    expect(commitBtn().textContent).toBe("Commit 2 files");
    expect(commitBtn().title).toContain("2 files");
    await git.commit(true);
    await settle();
    expect(inv("git_stage").map((i) => i.args.paths)).toEqual([["c.rb"]]);
    expect(inv("git_commit")[0].args).toMatchObject({ message: "Ticked", paths: ["b.rb", "c.rb"] });
    expect(repo.runs).toContainEqual(["push"]);
  });

  it("refuses to commit unstaged changes that are neither staged nor ticked", async () => {
    repo.status = [{ path: "b.rb", index: " ", worktree: "M" }];
    await git.refreshGit();
    row("b.rb").click();
    type("Nothing");
    expect(commitBtn().disabled).toBe(true);
    await git.commit();
    expect(inv("git_commit")).toHaveLength(0);
  });
});

describe("refreshGit (B34, B62)", () => {
  it("ignores an older refresh that finishes last", async () => {
    let release = () => {};
    repo.delay = new Promise((r) => (release = r));
    repo.branch = "old";
    const first = git.refreshGit();
    repo.delay = null;
    repo.branch = "new";
    await git.refreshGit();
    release();
    await first;
    expect(document.querySelector(".commit-branch")!.textContent).toContain("new");
  });

  it("labels a detached HEAD with its commit", async () => {
    repo.branch = "HEAD";
    await git.refreshGit();
    expect(document.querySelector(".commit-branch")!.textContent).toContain("detached at abc1234");
  });
});

describe("diffs from the Commit panel (B29, B30, B32)", () => {
  it("shows HEAD ↔ index for staged rows, using the old path of a rename", async () => {
    repo.status = [{ path: "new.rb", orig: "old.rb", index: "R", worktree: "M" }];
    repo.files.set("HEAD:/repo/old.rb", "head\n").set(":/repo/new.rb", "index\n");
    await git.refreshGit();
    await git.showRowDiff({ path: "new.rb", code: "R", staged: true });
    expect(ed.openTextDiff).toHaveBeenCalledWith("staged:new.rb", "/repo/new.rb", "head\n", "index\n", "new.rb (staged)", expect.any(String));
  });

  it("shows the last content of a deleted file against nothing", async () => {
    repo.status = [{ path: "gone.rb", index: " ", worktree: "D" }];
    repo.files.set(":/repo/gone.rb", "bye\n");
    await git.refreshGit();
    row("gone.rb").click();
    await settle();
    expect(ed.openTextDiff).toHaveBeenCalledWith("deleted:gone.rb", "/repo/gone.rb", "bye\n", "", "gone.rb (deleted)", expect.any(String));
  });

  it("unstages both paths of a staged rename", async () => {
    repo.status = [{ path: "new.rb", orig: "old.rb", index: "R", worktree: " " }];
    await git.refreshGit();
    row("new.rb").querySelector<HTMLElement>('[aria-label="Unstage"], [title^="Unstage"]')!.click();
    await settle();
    expect(inv("git_unstage")[0].args.paths).toEqual(["new.rb", "old.rb"]);
  });
});

describe("Stage Hunk in the Commit panel (B31)", () => {
  it("rebuilds each patch from the current index when clicked", async () => {
    repo.status = [{ path: "f.rb", index: " ", worktree: "M" }];
    repo.files.set(":/repo/f.rb", "a\nb\n");
    fake.files.set("/repo/f.rb", "x\na\nb\ny\n");
    fake.handlers.set("git_stage_patch", ({ patch }: { patch: string }) => void repo.files.set(":/repo/f.rb", patch.includes("+x") ? "x\na\nb\n" : "x\na\nb\ny\n"));
    await git.refreshGit();
    row("f.rb").querySelector<HTMLElement>('[title^="Show hunks"]')!.click();
    await settle();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".hunk-head button")];
    expect(buttons).toHaveLength(2);
    buttons[0].click();
    await settle();
    buttons[1].click();
    await settle();
    const patches = inv("git_stage_patch").map((i) => i.args.patch);
    expect(patches[0]).toContain("@@ -0,0 +1,1 @@\n+x\n");
    expect(patches[1]).toContain("@@ -3,0 +4,1 @@\n+y\n");
  });
});

describe("Rollback Lines (B6)", () => {
  it("recomputes from the active file, never another tab's gutter state", async () => {
    repo.files.set("HEAD:/repo/a.rb", "1\n2\n").set("HEAD:/repo/b.rb", "p\nq\nr\n");
    const a = model("1\nX\n");
    const b = model("p\nQ\nr\n");
    ed.tab = { path: "/repo/a.rb", kind: "file", model: a };
    await git.updateGutterNow();
    await settle();
    expect(git.gutterHunks()).toHaveLength(1);
    ed.tab = { path: "/repo/b.rb", kind: "file", model: b };
    ed.selection = { startLineNumber: 2, endLineNumber: 2 };
    (document.activeElement as HTMLElement | null)?.blur();
    await git.rollbackLines();
    expect(a.pushEditOperations).not.toHaveBeenCalled();
    expect(b.pushEditOperations).toHaveBeenCalledTimes(1);
    expect(b.pushEditOperations.mock.calls[0][1]).toEqual([{ range: { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 1 }, text: "q\n" }]);
  });
});

describe("Rollback files (B7)", () => {
  beforeEach(async () => {
    repo.status = [
      { path: "app/m.rb", index: " ", worktree: "M" },
      { path: "app/u.rb", index: "?", worktree: "?" },
      { path: "lib/s.rb", index: "M", worktree: " " },
    ];
    await git.refreshGit();
  });

  it("lists the files with a delete-added option and rolls back what was confirmed", async () => {
    git.rollbackDialog(["app"]);
    const dialog = document.querySelector(".rollback-dialog")!;
    expect([...dialog.querySelectorAll(".change-name")].map((n) => n.textContent)).toEqual(["app/m.rb", "app/u.rb"]);
    expect(dialog.querySelector(".rollback-note")!.textContent).toMatch(/^1 file will be reverted/);
    const del = dialog.querySelector<HTMLInputElement>(".rollback-delete input")!;
    del.checked = true;
    del.dispatchEvent(new Event("change"));
    expect(dialog.querySelector(".rollback-note")!.textContent).toMatch(/^2 files will be reverted to HEAD or deleted/);
    fake.handlers.set("git_rollback", () => ({ reverted: 1, deleted: 1 }));
    [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Rollback")!.click();
    await settle();
    expect(inv("git_rollback")[0].args).toMatchObject({ paths: ["app/m.rb", "app/u.rb"], deleteAdded: true });
    expect(ed.handleFsChanged).toHaveBeenCalledWith(["/repo/app/m.rb", "/repo/app/u.rb"]);
    expect(document.querySelector(".rollback-dialog")).toBeNull();
    expect(toasts()).toContain("Rolled back 1 file, deleted 1 file.");
  });

  it("reports untracked files kept instead of counting them", async () => {
    git.rollbackDialog(["app/u.rb"]);
    expect(document.querySelector(".rollback-note")!.textContent).toContain("kept");
    fake.handlers.set("git_rollback", () => ({ reverted: 0, deleted: 0 }));
    [...document.querySelectorAll<HTMLButtonElement>(".rollback-dialog button")].find((b) => b.textContent === "Rollback")!.click();
    await settle();
    expect(toasts()).toContain("Nothing to roll back; untracked files were kept.");
  });

  it("offers no delete option without added files, and Cancel does nothing", () => {
    git.rollbackDialog(["lib/s.rb"]);
    const dialog = document.querySelector(".rollback-dialog")!;
    expect(dialog.querySelector(".rollback-delete")).toBeNull();
    [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Cancel")!.click();
    expect(inv("git_rollback")).toHaveLength(0);
  });

  it("⌥⌘Z in the Commit panel rolls back the selected files; with none, all changes", async () => {
    row("lib/s.rb").click();
    expect(document.activeElement?.classList.contains("changes")).toBe(true);
    await git.rollbackLines();
    expect([...document.querySelectorAll(".rollback-dialog .change-name")].map((n) => n.textContent)).toEqual(["lib/s.rb"]);
    document.getElementById("overlay-root")!.replaceChildren();
    await git.refreshGit();
    git.rollbackSelected();
    expect(document.querySelectorAll(".rollback-dialog .change-name")).toHaveLength(1);
  });

  it("has the RubyMine context menu and shelves the selection", async () => {
    row("app/u.rb").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    for (const label of ["Show Diff", "Jump to Source", "Rollback…", "Shelve Changes…", "Copy Path", "Add to .gitignore", "Delete…"]) expect(menuItem(label), label).toBeTruthy();
    menuItem("Shelve Changes…")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await flush();
    const input = document.querySelector<HTMLInputElement>(".qp-input")!;
    input.value = "wip";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await settle();
    expect(repo.runs).toContainEqual(["stash", "push", "--include-untracked", "-m", "wip", "--", "app/u.rb"]);
  });

  const shelveVia = async (path: string, name: string) => {
    row(path).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    menuItem("Shelve Changes…")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await flush();
    const input = document.querySelector<HTMLInputElement>(".qp-input");
    if (input) {
      input.value = name;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    }
    await settle();
  };

  it("shelves dash-named files with a dash message as plain arguments", async () => {
    repo.status = [{ path: "-dash.rb", index: " ", worktree: "M" }];
    await git.refreshGit();
    await shelveVia("-dash.rb", "-wip");
    expect(repo.runs).toContainEqual(["stash", "push", "--include-untracked", "-m", "-wip", "--", "-dash.rb"]);
  });

  it("refuses to shelve a staged rename", async () => {
    repo.status = [{ path: "new.rb", orig: "old.rb", index: "R", worktree: " " }];
    await git.refreshGit();
    await shelveVia("new.rb", "x");
    expect(repo.runs.filter((a) => a[0] === "stash")).toEqual([]);
    expect(toasts().join()).toContain("Renamed files can't be shelved");
  });

  it("drops the stash a failed shelve created, and only that one", async () => {
    let top = "old";
    const run = fake.handlers.get("git_run")!;
    fake.handlers.set("git_run", (a: { args: string[] }) => {
      const cmd = a.args.slice(0, 2).join(" ");
      if (cmd === "rev-parse -q") return `${top}\n`;
      if (cmd === "stash list") return `${top}\nold\n`;
      if (cmd === "stash push") {
        top = "new";
        throw new Error("could not restore untracked files");
      }
      return run(a);
    });
    await shelveVia("app/m.rb", "wip");
    expect(repo.runs).toContainEqual(["stash", "drop", "stash@{0}"]);
    expect(toasts().join()).toContain("git stash apply new");
  });

  it("⌘D in the focused list opens the diff instead of an editor action", async () => {
    row("lib/s.rb").click();
    ed.openTextDiff.mockReset();
    const e = new KeyboardEvent("keydown", { code: "KeyD", metaKey: true, bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(e);
    await settle();
    expect(e.defaultPrevented).toBe(true);
    expect(ed.openTextDiff).toHaveBeenCalledWith("staged:lib/s.rb", "/repo/lib/s.rb", "", "", "s.rb (staged)", expect.any(String));
  });

  it("adds anchored .gitignore entries once", () => {
    expect(git.withIgnored("", ["tmp/a.log"])).toBe("/tmp/a.log\n");
    expect(git.withIgnored("node_modules", ["x"])).toBe("node_modules\n/x\n");
    expect(git.withIgnored("/x\n", ["x"])).toBe("/x\n");
  });
});
