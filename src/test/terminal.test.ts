import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../editor", async () => await import("./fakeEditor"));

import { newTerminal, PtyView, terminals } from "../terminal";
import { state } from "../state";
import { fake } from "./fakeIpc";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
type Ch = { onmessage: (ev: unknown) => void };

beforeEach(() => {
  fake.reset();
  document.getElementById("overlay-root")!.replaceChildren();
  state.project = { root: "/work/blog", name: "blog", git: true, rails: true, rspec: false, minitest: true, binRspec: false, debugBundled: false };
  for (const i of [...terminals.items]) terminals.close(i);
});

describe("terminals", () => {
  it("shows a shell that cannot start instead of a blank tab and an unhandled rejection", async () => {
    fake.handlers.set("pty_spawn", () => Promise.reject("Unable to spawn /nonexistent/sh: No such file or directory"));
    const exited = vi.fn();
    const view = new PtyView({ onExit: exited });
    await view.start(document.createElement("div"));
    expect(view.exited).toBe(true);
    expect(exited).toHaveBeenCalledWith(null);
    expect(document.querySelector(".toast.error")?.textContent).toContain("Unable to spawn");
  });

  it("kills a process whose tab closed while it was still starting", async () => {
    let finish = (_id: number) => {};
    fake.handlers.set("pty_spawn", () => new Promise<number>((r) => (finish = r)));
    const view = new PtyView({ command: "bin/rails s" });
    const started = view.start(document.createElement("div"));
    view.dispose();
    finish(7);
    await started;
    expect(fake.invocations.filter((i) => i.cmd === "pty_kill").map((i) => i.args)).toEqual([{ id: 7 }]);
  });

  it("still reports the exit of a process whose tab is gone", async () => {
    let channel: Ch | null = null;
    fake.handlers.set("pty_spawn", (args: { onEvent: Ch }) => ((channel = args.onEvent), 3));
    const exited = vi.fn();
    const view = new PtyView({ command: "rspec", onExit: exited });
    await view.start(document.createElement("div"));
    view.dispose();
    channel!.onmessage({ type: "data", data: "late output" });
    channel!.onmessage({ type: "exit", code: 1 });
    expect(exited).toHaveBeenCalledWith(1);
  });

  it("closes a shell tab when the shell exits, like RubyMine", async () => {
    const channels: Ch[] = [];
    fake.handlers.set("pty_spawn", (args: { onEvent: Ch }) => (channels.push(args.onEvent), channels.length));
    newTerminal();
    newTerminal();
    await tick();
    expect(terminals.items).toHaveLength(2);
    channels[0].onmessage({ type: "exit", code: 0 });
    expect(terminals.items).toHaveLength(1);
    channels[1].onmessage({ type: "exit", code: null });
    expect(terminals.items).toHaveLength(1);
  });
});
