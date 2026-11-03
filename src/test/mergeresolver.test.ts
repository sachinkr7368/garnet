import { beforeEach, describe, expect, it, vi } from "vitest";

/// Monaco with real version ids on the merge models; everything else is the fake editor's no-op proxy.
vi.mock("../editor", async () => {
  const fake = await import("./fakeEditor");
  const model = (text: string) => {
    let version = 1;
    const m = {
      getValue: () => text,
      getAlternativeVersionId: () => version,
      pushEditOperations: () => void version++,
      pushStackElement: () => {},
      deltaDecorations: (_old: string[], next: unknown[]) => next.map((_, i) => `d${i}`),
      getDecorationRange: () => new fake.monaco.Range(1, 1, 1, 1),
      onDidChangeContent: () => ({ dispose() {} }),
      dispose: () => {},
    };
    return new Proxy(m, { get: (t, k: string) => (k in t ? t[k as keyof typeof t] : fake.monaco.editor[k]) });
  };
  const editorNs = new Proxy({ createModel: model, create: () => fake.editor }, { get: (t, k: string) => (k in t ? t[k as keyof typeof t] : fake.monaco.editor[k]) });
  return { ...fake, monaco: new Proxy({}, { get: (_t, k: string) => (k === "editor" ? editorNs : fake.monaco[k]) }) };
});
vi.mock("../ipc", () => ({
  api: {
    git: vi.fn(async () => ""),
    gitOpState: vi.fn(async () => ({ op: "merge", conflicts: ["f.rb"] })),
    gitMergeInput: vi.fn(async () => ({ symlink: false, nonUtf8: false, base: "b\n", ours: "o\n", theirs: "t\n", merged: "<<<<<<< Yours\no\n||||||| Base\nb\n=======\nt\n>>>>>>> Theirs\n" })),
  },
}));

const { ask } = await import("@tauri-apps/plugin-dialog");
const { activeResolver, openResolver } = await import("../merge");
const { state } = await import("../state");
const escape = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  state.project = { root: "/repo" } as never;
  vi.mocked(ask).mockReset().mockResolvedValue(false);
});

describe("merge resolver Escape (B65)", () => {
  it("closes an untouched resolver without asking", async () => {
    expect(await openResolver("f.rb")).toBe(activeResolver());
    expect(activeResolver()).not.toBeNull();
    escape();
    await flush();
    expect(ask).not.toHaveBeenCalled();
    expect(activeResolver()).toBeNull();
  });

  it("asks before discarding edits, and keeps the resolver open on Keep Editing", async () => {
    const r = (await openResolver("f.rb"))!;
    r.accept(0, "ours");
    escape();
    await flush();
    expect(ask).toHaveBeenCalledWith("Discard the changes made in the merge result?", expect.anything());
    expect(activeResolver()).toBe(r);
    vi.mocked(ask).mockResolvedValueOnce(true);
    escape();
    await flush();
    expect(activeResolver()).toBeNull();
  });
});
