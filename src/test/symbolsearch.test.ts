import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { symbolSearch } from "../symbolsearch";

const source = () => {
  const token = { isCancellationRequested: false };
  return { token, cancel: () => void (token.isCancellationRequested = true) };
};

describe("symbolSearch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = (reply: () => unknown[] | null, busy = true) => {
    const request = vi.fn(async () => reply());
    const refresh = vi.fn();
    const s = symbolSearch({ request, newSource: source, busy: () => busy, current: () => "Post", refresh, retries: 3, delayMs: 1000 });
    return { s, request, refresh };
  };

  it("closing the popup cancels the pending retry", async () => {
    const { s, request, refresh } = setup(() => []);
    expect(s.get("Post")).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);
    s.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("stops retrying an empty reply after the cap and caches it", async () => {
    const { s, request, refresh } = setup(() => []);
    s.get("Post");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(4);
    expect(refresh).toHaveBeenCalledOnce();
    expect(s.get("Post")).toEqual([]);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("shows late symbols once ruby-lsp has indexed them", async () => {
    let calls = 0;
    const { s, refresh } = setup(() => (++calls < 3 ? [] : [{ name: "Post" }]));
    s.get("Post");
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledOnce();
    expect(s.get("Post")).toEqual([{ name: "Post" }]);
  });

  it("caches an empty reply at once when ruby-lsp is idle", async () => {
    const { s, request } = setup(() => [], false);
    s.get("Post");
    await vi.advanceTimersByTimeAsync(5000);
    expect(request).toHaveBeenCalledOnce();
  });
});
