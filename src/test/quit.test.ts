import { message } from "@tauri-apps/plugin-dialog";
import { describe, expect, it, vi } from "vitest";
import { confirmQuit } from "../quit";

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
