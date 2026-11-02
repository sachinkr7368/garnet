import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ Channel: class {}, invoke: vi.fn(async () => null) }));

describe("search supersession", () => {
  it("tells a caller waiting for Done when a newer search cancels its search", async () => {
    const ipc = await vi.importActual<typeof import("../ipc")>("../ipc");
    const superseded = vi.fn();
    ipc.onSearchSuperseded(superseded);
    await ipc.invoke("git_status", {});
    expect(superseded).not.toHaveBeenCalled();
    await ipc.invoke("search_text", {});
    expect(superseded).toHaveBeenCalledOnce();
    await ipc.invoke("search_text", {});
    expect(superseded).toHaveBeenCalledOnce();
    const stop = ipc.onSearchSuperseded(superseded);
    stop();
    await ipc.invoke("search_text", {});
    expect(superseded).toHaveBeenCalledOnce();
  });
});
