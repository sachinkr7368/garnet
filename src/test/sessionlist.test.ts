import { describe, expect, it } from "vitest";
import { SessionList } from "../sessionlist";

const mk = (name: string) => ({ name, ended: false, paused: false });

describe("SessionList", () => {
  it("names sessions uniquely and selects the newest", () => {
    const list = new SessionList<ReturnType<typeof mk>>();
    const a = list.add(mk("Sidekiq"));
    const b = list.add(mk("Sidekiq"));
    expect([a.name, b.name]).toEqual(["Sidekiq", "Sidekiq (2)"]);
    expect(list.selected).toBe(b);
  });

  it("moves focus to a session that pauses unless the selected one is paused", () => {
    const list = new SessionList<ReturnType<typeof mk>>();
    const web = list.add(mk("Rails server"));
    const jobs = list.add(mk("Sidekiq"));
    web.paused = true;
    expect(list.focusOnStop(web)).toBe(true);
    expect(list.selected).toBe(web);
    jobs.paused = true;
    expect(list.focusOnStop(jobs)).toBe(false);
    expect(list.selected).toBe(web);
    web.paused = false;
    expect(list.focusOnStop(jobs)).toBe(true);
  });

  it("prefers a paused session after removing the selected one", () => {
    const list = new SessionList<ReturnType<typeof mk>>();
    const a = list.add(mk("A"));
    const b = list.add(mk("B"));
    const c = list.add(mk("C"));
    a.paused = true;
    list.remove(c);
    expect(list.selected).toBe(a);
    b.ended = true;
    expect(list.live()).toEqual([a]);
    list.remove(a);
    list.remove(b);
    expect(list.selected).toBeNull();
  });
});
