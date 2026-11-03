import { message } from "@tauri-apps/plugin-dialog";
import { beforeEach, describe, expect, it, vi } from "vitest";
const events = vi.hoisted(() => new Map<string, () => void>());
vi.mock("@tauri-apps/api/event", () => ({ listen: async (name: string, fn: () => void) => (events.set(name, fn), () => {}) }));

import { backupUnsaved, offerRestore } from "../hotexit";
import { confirmQuit, listenForQuit, type QuitHooks } from "../quit";
import { fake } from "./fakeIpc";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("quit with unsaved changes", () => {
  it("quits without asking when nothing is unsaved", async () => {
    vi.mocked(message).mockClear();
    expect(await confirmQuit([], async () => false)).toBe(true);
    expect(message).not.toHaveBeenCalled();
  });

  it("asks once with Save All / Don't Save / Cancel", async () => {
    const save = vi.fn(async () => true);
    vi.mocked(message).mockResolvedValueOnce("Cancel" as never);
    expect(await confirmQuit(["a.rb", "b.rb"], save)).toBe(false);
    expect(vi.mocked(message).mock.calls.at(-1)![1]).toMatchObject({ buttons: { yes: "Save All", no: "Don't Save", cancel: "Cancel" } });
    expect(String(vi.mocked(message).mock.calls.at(-1)![0])).toContain("a.rb\nb.rb");
    vi.mocked(message).mockResolvedValueOnce("Don't Save" as never);
    expect(await confirmQuit(["a.rb"], save)).toBe(true);
    expect(save).not.toHaveBeenCalled();
    vi.mocked(message).mockResolvedValueOnce("Save All" as never);
    expect(await confirmQuit(["a.rb"], save)).toBe(true);
    expect(save).toHaveBeenCalledOnce();
    vi.mocked(message).mockResolvedValueOnce("Save All" as never);
    expect(await confirmQuit(["a.rb"], async () => false)).toBe(false);
  });
});

describe("quit flow", () => {
  beforeEach(() => {
    fake.reset();
    document.getElementById("overlay-root")!.replaceChildren();
  });

  const hooks = (over: Partial<QuitHooks> = {}): QuitHooks => ({ unsaved: () => ["a.rb"], saveAll: async () => true, persist: async () => true, ...over });
  const answers = () => fake.invocations.filter((i) => ["frontend_ready", "close_ack", "quit_now"].includes(i.cmd)).map((i) => (i.cmd === "quit_now" ? `quit_now:${i.args.quit}` : i.cmd));

  it("acknowledges a close request at once, prompts, then quits", async () => {
    await listenForQuit(hooks());
    let answer = (_: string) => {};
    vi.mocked(message).mockImplementationOnce(() => new Promise((r) => (answer = r as never)) as never);
    events.get("close-requested")!();
    await tick();
    expect(answers()).toEqual(["frontend_ready", "close_ack"]);
    events.get("close-requested")!();
    await tick();
    expect(vi.mocked(message).mock.calls.length).toBeGreaterThan(0);
    answer("Don't Save");
    await tick();
    await tick();
    expect(answers()).toEqual(["frontend_ready", "close_ack", "close_ack", "quit_now:true"]);
  });

  it("stays open and says why when saving the session or breakpoints fails", async () => {
    await listenForQuit(hooks({ unsaved: () => [], persist: async () => false }));
    events.get("close-requested")!();
    await tick();
    await tick();
    expect(answers().at(-1)).toBe("quit_now:false");
    expect(document.querySelector(".toast.error")?.textContent).toContain("stayed open");
  });

  it("stays open when Save All fails", async () => {
    await listenForQuit(hooks({ saveAll: async () => false }));
    vi.mocked(message).mockResolvedValueOnce("Save All" as never);
    events.get("close-requested")!();
    await tick();
    await tick();
    expect(answers().at(-1)).toBe("quit_now:false");
  });
});

describe("hot exit", () => {
  beforeEach(() => {
    fake.reset();
    document.getElementById("overlay-root")!.replaceChildren();
  });

  it("backs up unsaved buffers and offers them on the next launch", async () => {
    await backupUnsaved("/p", [{ path: "/p/a.rb", text: "edited" }]);
    expect(JSON.parse(fake.config.get("unsaved.json")!)).toEqual({ "/p": [{ path: "/p/a.rb", text: "edited" }] });
    const restored: string[] = [];
    await offerRestore("/p", async (b) => (restored.push(`${b.path}=${b.text}`), true));
    // Until answered, the backup survives later backups that no longer have the buffer.
    await backupUnsaved("/p", []);
    expect(JSON.parse(fake.config.get("unsaved.json")!)["/p"]).toHaveLength(1);
    const restore = [...document.querySelectorAll<HTMLButtonElement>(".toast button")].find((b) => b.textContent === "Restore")!;
    restore.click();
    await tick();
    expect(restored).toEqual(["/p/a.rb=edited"]);
    await backupUnsaved("/p", []);
    expect(JSON.parse(fake.config.get("unsaved.json")!)["/p"]).toBeUndefined();
  });

  it("offers nothing when the last run ended cleanly", async () => {
    await offerRestore("/p", async () => true);
    expect(document.querySelector(".toast")).toBeNull();
  });
});
