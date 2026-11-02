import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../editor", async () => await import("./fakeEditor"));

import { breakpointsIn, debugSessions, flushBreakpoints, loadBreakpoints } from "../debug";
import { state } from "../state";
import { fake } from "./fakeIpc";

const ROOT = "/work/blog";

beforeEach(() => {
  fake.reset();
  state.project = { root: ROOT, name: "blog", git: true, rails: true, rspec: false, minitest: true, binRspec: false, debugBundled: false };
});

describe("breakpoint persistence", () => {
  it("restores the project's breakpoints from Garnet's state dir and writes them back without touching other projects", async () => {
    fake.config.set("breakpoints.json", JSON.stringify({ [ROOT]: { "app/a.rb": [{ line: 4, enabled: true, condition: "x" }] }, "/other": { "b.rb": [{ line: 1, enabled: true }] } }));
    await loadBreakpoints();
    expect(breakpointsIn(`${ROOT}/app/a.rb`)).toEqual([{ line: 4, enabled: true, condition: "x" }]);
    await flushBreakpoints();
    const stored = JSON.parse(fake.config.get("breakpoints.json")!);
    expect(stored["/other"]).toEqual({ "b.rb": [{ line: 1, enabled: true }] });
    expect(stored[ROOT]).toEqual({ "app/a.rb": [{ line: 4, enabled: true, condition: "x" }] });
    expect([...fake.files.keys()].some((p) => p.startsWith(ROOT))).toBe(false);
  });

  it("starts empty for a project without saved breakpoints or with a corrupt store", async () => {
    fake.config.set("breakpoints.json", "{not json");
    await loadBreakpoints();
    expect(breakpointsIn(`${ROOT}/app/a.rb`)).toEqual([]);
    expect(debugSessions()).toEqual([]);
  });
});
