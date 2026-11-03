import { describe, expect, it } from "vitest";
import { dapBreakpoints, deserialize, interpolate, passCountReached, serialize, trackLines, type Breakpoint, isBreakpointClick } from "../bpmodel";

const ROOT = "/work/blog";
const rel = (p: string) => p.slice(ROOT.length + 1);
const abs = (p: string) => `${ROOT}/${p}`;

describe("persistence", () => {
  it("round-trips through the stored shape with relative paths and no runtime fields", () => {
    const map = new Map<string, Breakpoint[]>([
      [`${ROOT}/app/b.rb`, [{ line: 9, enabled: false, condition: "x > 1", decorationId: "d1" }, { line: 2, enabled: true, logMessage: "id={id}", hitCount: 3 }]],
      [`${ROOT}/app/a.rb`, [{ line: 4, enabled: true }]],
      [`${ROOT}/app/empty.rb`, []],
    ]);
    const stored = serialize(map, rel);
    expect(stored).toEqual({
      "app/a.rb": [{ line: 4, enabled: true }],
      "app/b.rb": [{ line: 2, enabled: true, logMessage: "id={id}", hitCount: 3 }, { line: 9, enabled: false, condition: "x > 1" }],
    });
    const back = deserialize(JSON.parse(JSON.stringify(stored)), abs);
    expect([...back.keys()]).toEqual([`${ROOT}/app/a.rb`, `${ROOT}/app/b.rb`]);
    expect(back.get(`${ROOT}/app/b.rb`)![1]).toEqual({ id: expect.any(Number), line: 9, enabled: false, condition: "x > 1" });
  });

  it("keeps each breakpoint's identity when lines shift, so pass counts survive edits", () => {
    const [a, b] = deserialize({ "a.rb": [{ line: 3, enabled: true, hitCount: 3 }, { line: 7, enabled: true }] }, abs).get(`${ROOT}/a.rb`)!;
    expect(a.id).not.toBe(b.id);
    const moved = trackLines([a, b], [5, 9]).bps;
    expect(moved.map((x) => [x.id, x.line])).toEqual([[a.id, 5], [b.id, 9]]);
  });

  it("skips malformed entries", () => {
    const back = deserialize({ "a.rb": [{ line: 0 }, { line: 2.5 }, { line: "3" }, null, { line: 4, hitCount: -1, condition: 5 }, { line: 4 }], "b.rb": "x" }, abs);
    expect([...back]).toEqual([[`${ROOT}/a.rb`, [{ id: expect.any(Number), line: 4, enabled: true }]]]);
    expect(deserialize(null, abs).size).toBe(0);
    expect(deserialize([], abs).size).toBe(0);
  });
});

describe("line tracking", () => {
  const bps: Breakpoint[] = [{ line: 3, enabled: true }, { line: 7, enabled: true, condition: "c" }, { line: 10, enabled: true }];

  it("moves breakpoints with inserted lines and reports the change", () => {
    const r = trackLines(bps, [5, 9, 12]);
    expect(r.changed).toBe(true);
    expect(r.bps.map((b) => b.line)).toEqual([5, 9, 12]);
    expect(r.bps[1].condition).toBe("c");
  });

  it("keeps identity when nothing moved", () => {
    const r = trackLines(bps, [3, 7, 10]);
    expect(r.changed).toBe(false);
    expect(r.bps[0]).toBe(bps[0]);
  });

  it("drops a breakpoint whose line was deleted or merged into another's", () => {
    expect(trackLines(bps, [3, 3, 8]).bps.map((b) => b.line)).toEqual([3, 8]);
    expect(trackLines(bps, [3, null, 8]).bps.map((b) => b.line)).toEqual([3, 8]);
  });
});

describe("DAP and runtime behaviour", () => {
  it("sends only enabled breakpoints with their conditions", () => {
    expect(dapBreakpoints([{ line: 1, enabled: true, condition: "a", logMessage: "m" }, { line: 2, enabled: false }, { line: 3, enabled: true }])).toEqual([{ line: 1, condition: "a" }, { line: 3 }]);
  });

  it("pauses from the Nth hit on", () => {
    const bp: Breakpoint = { line: 1, enabled: true, hitCount: 3 };
    expect([1, 2, 3, 4].map((n) => passCountReached(bp, n))).toEqual([false, false, true, true]);
    expect(passCountReached({ line: 1, enabled: true }, 1)).toBe(true);
  });

  it("interpolates logpoint expressions and survives evaluation errors", async () => {
    const values: Record<string, string> = { "user.id": "7", name: '"bob"' };
    const text = await interpolate("user {user.id} {name} {boom}", async (e) => (e in values ? values[e] : Promise.reject(new Error("x"))));
    expect(text).toBe('user 7 "bob" ?');
  });

  it("inserts values literally, even when they contain $& or $'", async () => {
    expect(await interpolate("got {a} and {b}", async (e) => (e === "a" ? '"$&"' : "$'tail"))).toBe(`got "$&" and $'tail`);
  });
});

describe("line-number click", () => {
  const down = { line: 4, x: 10, y: 50, left: true, modifiers: false, clicks: 1 };
  it("toggles on a plain single left click released on the same line", () => {
    expect(isBreakpointClick(down, { line: 4, x: 12, y: 51 })).toBe(true);
  });
  it("ignores drags, other lines, modifiers, double clicks and other buttons", () => {
    expect(isBreakpointClick(down, { line: 4, x: 10, y: 70 })).toBe(false);
    expect(isBreakpointClick(down, { line: 5, x: 10, y: 50 })).toBe(false);
    expect(isBreakpointClick({ ...down, modifiers: true }, { line: 4, x: 10, y: 50 })).toBe(false);
    expect(isBreakpointClick({ ...down, clicks: 2 }, { line: 4, x: 10, y: 50 })).toBe(false);
    expect(isBreakpointClick({ ...down, left: false }, { line: 4, x: 10, y: 50 })).toBe(false);
    expect(isBreakpointClick(null, { line: 4, x: 10, y: 50 })).toBe(false);
  });
});
