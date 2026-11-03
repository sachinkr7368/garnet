import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../editor", async () => await import("./fakeEditor"));

import { checkTrust, trustProject } from "../settings";
import { newTerminal, pasteIntoTerminal, PtyView, showTerminalPanel, terminals } from "../terminal";
import { bottom } from "../ui";
import { state } from "../state";
import { fake } from "./fakeIpc";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
type Ch = { onmessage: (ev: unknown) => void };

beforeEach(async () => {
  fake.reset();
  await trustProject("/work/blog", true);
  document.getElementById("overlay-root")!.replaceChildren();
  state.project = { root: "/work/blog", name: "blog", git: true, rails: true, rspec: false, minitest: true, binRspec: false, debugBundled: false };
  for (const i of [...terminals.items]) terminals.close(i);
});

describe("terminal trust gate", () => {
  it("shows Trust Project instead of starting a shell in Safe Mode, and opens one once trusted", async () => {
    fake.config.delete("trusted.json");
    expect(await checkTrust("/work/blog")).toBe(false);
    fake.handlers.set("pty_spawn", () => 1);
    if (!bottom.views.has("terminal")) bottom.add({ id: "terminal", title: "Terminal", icon: "terminal", el: terminals.el });
    bottom.show("terminal");
    showTerminalPanel();
    newTerminal();
    expect(fake.invocations.some((i) => i.cmd === "pty_spawn")).toBe(false);
    expect(terminals.gate.hidden).toBe(false);
    expect(terminals.gate.textContent).toContain("Trust project to open a terminal");
    expect(terminals.gate.querySelector("button")?.textContent).toBe("Trust Project");
    await trustProject("/work/blog");
    await tick();
    expect(terminals.gate.hidden).toBe(true);
    expect(terminals.items).toHaveLength(1);
    expect(fake.invocations.filter((i) => i.cmd === "pty_spawn")).toHaveLength(1);
    bottom.hide();
  });
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

  it("keeps a shell tab that failed, so its error and exit code stay readable", async () => {
    let channel: Ch | null = null;
    fake.handlers.set("pty_spawn", (args: { onEvent: Ch }) => ((channel = args.onEvent), 1));
    newTerminal();
    await tick();
    channel!.onmessage({ type: "data", data: "zsh: bad option: -Z\r\n" });
    channel!.onmessage({ type: "exit", code: 1 });
    expect(terminals.items).toHaveLength(1);
  });
});

describe("dropping files on the terminal", () => {
  it("types quoted paths and refuses names with control characters", async () => {
    fake.handlers.set("pty_spawn", () => 1);
    const view = new PtyView({});
    document.body.append(view.el);
    const pasted: string[] = [];
    view.term.paste = (t: string) => void pasted.push(t);
    expect(pasteIntoTerminal(document.body, ["/a"])).toBe(false);
    expect(pasteIntoTerminal(view.el, ["/work/my app", "/x'y"])).toBe(true);
    expect(pasted).toEqual([`'/work/my app' '/x'\\''y'`]);
    expect(pasteIntoTerminal(view.el, ["/tmp/a\x1b[201~\ntouch pwned"])).toBe(true);
    expect(pasteIntoTerminal(view.el, ["/tmp/ok", "/tmp/b\nrm -rf x"])).toBe(true);
    expect(pasted).toHaveLength(1);
    expect(document.body.textContent).toContain("Path contains control characters; not inserted");
    view.dispose();
  });
});
