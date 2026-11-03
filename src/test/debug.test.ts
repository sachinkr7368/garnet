import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../editor", async () => await import("./fakeEditor"));

import { breakpointsIn, debugSession, debugSessions, debugView, flushBreakpoints, loadBreakpoints, resume, stopAllSessions, viewBreakpoints } from "../debug";
import { loadSettings, updateSetting } from "../settings";
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

/// A minimal rdbg: answers every request (setBreakpoints slowly) and records what Garnet sent.
function fakeRdbg() {
  const sent: string[] = [];
  const requests: { command: string; arguments: any }[] = [];
  let channel: { onmessage: (ev: unknown) => void } | null = null;
  const message = (body: unknown) => channel!.onmessage({ type: "message", body: JSON.stringify(body) });
  fake.handlers.set("dap_connect", (args: { onEvent: typeof channel }) => ((channel = args.onEvent), 1));
  fake.handlers.set("dap_send", ({ body }: { body: string }) => {
    const msg = JSON.parse(body);
    sent.push(msg.command);
    requests.push(msg);
    const body2 =
      msg.command === "initialize" ? { exceptionBreakpointFilters: [{ filter: "RuntimeError", label: "rescue RuntimeError" }] } : msg.command === "stackTrace" ? { stackFrames: [] } : {};
    const reply = () => message({ type: "response", request_seq: msg.seq, success: true, command: msg.command, body: body2 });
    setTimeout(reply, msg.command === "setBreakpoints" ? 30 : 0);
  });
  return { sent, requests, event: (event: string, body: unknown) => message({ type: "event", event, body }) };
}
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe("debugging", () => {
  it("sends a breakpoint removed while paused before resuming", async () => {
    fake.config.set("breakpoints.json", JSON.stringify({ [ROOT]: { "lib/smoke_debug.rb": [{ line: 3, enabled: true }] } }));
    await loadBreakpoints();
    const rdbg = fakeRdbg();
    await debugSession({ target: "12345" });
    rdbg.event("stopped", { reason: "breakpoint", threadId: 1 });
    await settle();
    expect(debugSessions()[0].paused).toBe(true);
    viewBreakpoints(`${ROOT}/lib/smoke_debug.rb`, 3);
    [...document.querySelectorAll<HTMLButtonElement>(".bp-backdrop button")].find((b) => b.textContent === "Remove")!.click();
    document.getElementById("overlay-root")!.replaceChildren();
    rdbg.sent.length = 0;
    await resume();
    expect(rdbg.sent).toEqual(["setBreakpoints", "continue"]);
    await stopAllSessions();
  });

  it("keeps exception breakpoint choices across unrelated settings changes and pushes a new default to live sessions", async () => {
    await loadSettings(null);
    await loadBreakpoints();
    const rdbg = fakeRdbg();
    await debugSession({ target: "12345" });
    const box = () => debugView.querySelector<HTMLInputElement>(".exc-filter input")!;
    box().checked = true;
    box().dispatchEvent(new Event("change"));
    await updateSetting("editor.fontSize", 15);
    expect(box().checked).toBe(true);
    rdbg.requests.length = 0;
    await updateSetting("debug.breakOnExceptions", "RuntimeError");
    await settle(10);
    expect(rdbg.requests.find((r) => r.command === "setExceptionBreakpoints")?.arguments).toEqual({ filters: ["RuntimeError"] });
    await updateSetting("debug.breakOnExceptions", undefined);
    await stopAllSessions();
  });
});
