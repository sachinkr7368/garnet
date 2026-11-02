import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../editor", async () => await import("./fakeEditor"));
vi.mock("../git", () => ({ ago: () => "now", fileTree: () => [] }));
vi.mock("@tauri-apps/api/core", () => import("./fakeIpc"));
vi.mock("../ipc", () => import("./realIpc"));

const { fake } = await import("./fakeIpc");
const { state } = await import("../state");
const { trustProject } = await import("../settings");
const { reload } = await import("../gitlog");
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

let branches = "main\n";
const branchLoads = () => fake.invocations.filter((i) => i.cmd === "git_run" && i.args.args[0] === "for-each-ref").length;
const options = () => [...document.querySelectorAll<HTMLOptionElement>(".gitlog-view select option")].map((o) => o.value);

beforeEach(async () => {
  fake.reset();
  state.project = { root: "/repo", git: true } as never;
  await trustProject("/repo", true);
  fake.handlers.set("git_run", ({ args }: { args: string[] }) => (args[0] === "for-each-ref" ? branches : ""));
  fake.handlers.set("git_log", () => []);
});

describe("Git log branch list (B64)", () => {
  it("reloads branches on every log load and on garnet:git-refresh", async () => {
    const { gitLogView } = await import("../gitlog");
    document.body.append(gitLogView);
    await reload();
    expect(options()).toEqual(["", "HEAD", "main"]);
    branches = "main\nfeature\n";
    window.dispatchEvent(new Event("garnet:git-refresh"));
    await flush();
    expect(options()).toEqual(["", "HEAD", "main", "feature"]);
    const before = branchLoads();
    await reload();
    expect(branchLoads()).toBe(before + 1);
  });
});
