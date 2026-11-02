import { describe, expect, it } from "vitest";
import { backtraceLink, buildTree, counts, emptyRun, feedEvents, filterTree, lineStatuses, plannedUnreliable, progress, rerunArgs } from "../testtree";
import { shellQuote } from "../state";

const ROOT = "/work/blog";
const rel = (p: string) => p.slice(ROOT.length + 1);

// Recorded from src/ruby/garnet_rspec_formatter.rb on a spec with a pass, a failure and a pending example.
const RSPEC = [
  `{"event":"start","count":3}`,
  `{"event":"result","id":"./spec/calc_spec.rb[1:2]","file":"${ROOT}/spec/calc_spec.rb","line":12,"groups":[{"name":"Calc","line":1}],"name":"is pending","status":"pending","duration":0.000043,"message":"later"}`,
  `{"event":"result","id":"./spec/calc_spec.rb[1:1:1]","file":"${ROOT}/spec/calc_spec.rb","line":3,"groups":[{"name":"Calc","line":1},{"name":"addition","line":2}],"name":"adds","status":"passed","duration":0.00047}`,
  `{"event":"result","id":"./spec/calc_spec.rb[1:1:2]","file":"${ROOT}/spec/calc_spec.rb","line":7,"groups":[{"name":"Calc","line":1},{"name":"addition","line":2}],"name":"fails on purpose","status":"failed","duration":0.003336,"message":"RSpec::Expectations::ExpectationNotMetError: \\nexpected: 5\\n     got: 4\\n","backtrace":["./spec/calc_spec.rb:8:in \`block (3 levels) in <top (required)>'"]}`,
  `{"event":"done","duration":0.004952}`,
].join("\n") + "\n";

// Recorded from src/ruby/minitest/garnet_plugin.rb under bin/rails test.
const MINITEST = [
  `{"event":"start","count":3}`,
  `{"event":"result","id":"SmokeCalcTest#test_deliberate_failure","file":"${ROOT}/test/models/smoke_calc_test.rb","line":8,"groups":[{"name":"SmokeCalcTest","line":3}],"name":"test_deliberate_failure","status":"failed","duration":0.0166,"message":"Failure: Expected: 5\\n  Actual: 4","backtrace":["test/models/smoke_calc_test.rb:9:in \`block in <class:SmokeCalcTest>'"]}`,
  `{"event":"result","id":"SmokeCalcTest#test_adds","file":"${ROOT}/test/models/smoke_calc_test.rb","line":4,"groups":[{"name":"SmokeCalcTest","line":3}],"name":"test_adds","status":"passed","duration":0.0023}`,
  `{"event":"result","id":"SmokeCalcTest#test_skipped","file":"${ROOT}/test/models/smoke_calc_test.rb","line":12,"groups":[{"name":"SmokeCalcTest","line":3}],"name":"test_skipped","status":"pending","duration":0.0005,"message":"Skipped: not yet"}`,
  `{"event":"done","duration":0.0236}`,
].join("\n") + "\n";

describe("feedEvents", () => {
  it("parses RSpec events into results, counts and progress", () => {
    const s = feedEvents(emptyRun(), RSPEC);
    expect(s.done).toBe(true);
    expect(s.planned).toBe(3);
    expect(counts(s.results)).toEqual({ passed: 1, failed: 1, pending: 1, total: 3 });
    const failed = s.results.find((r) => r.status === "failed")!;
    expect(failed.message).toBe("RSpec::Expectations::ExpectationNotMetError: \nexpected: 5\n     got: 4");
    expect(failed.backtrace).toHaveLength(1);
    expect(progress(s)).toBe(1);
  });

  it("parses incrementally, holding back a half-written line", () => {
    const cut = RSPEC.indexOf("\n", RSPEC.indexOf("is pending")) + 20;
    let s = feedEvents(emptyRun(), RSPEC.slice(0, cut));
    expect(s.results.map((r) => r.name)).toEqual(["is pending"]);
    expect(progress(s)).toBeCloseTo(1 / 3);
    s = feedEvents(s, RSPEC);
    expect(s.results.map((r) => r.name)).toEqual(["is pending", "adds", "fails on purpose"]);
  });

  it("ignores garbage lines and an unreliable planned count", () => {
    const s = feedEvents(emptyRun(), `not json\n{"event":"result","id":"x","status":"weird"}\n${MINITEST.split("\n").slice(0, 2).join("\n")}\n`, true);
    expect(s.planned).toBeNull();
    expect(s.results).toHaveLength(1);
    expect(progress(s)).toBeNull();
  });
});

describe("buildTree", () => {
  it("nests file → groups → examples with the worst status and summed durations", () => {
    const tree = buildTree(feedEvents(emptyRun(), RSPEC).results, rel);
    expect(tree).toHaveLength(1);
    const [file] = tree;
    expect(file.label).toBe("spec/calc_spec.rb");
    expect(file.status).toBe("failed");
    const calc = file.children[0];
    expect(calc.label).toBe("Calc");
    expect(calc.children.map((c) => c.label)).toEqual(["is pending", "addition"]);
    const addition = calc.children[1];
    expect(addition.line).toBe(2);
    expect(addition.status).toBe("failed");
    expect(addition.duration).toBeCloseTo(0.003806);
  });

  it("filters passed and ignored examples and prunes empty groups", () => {
    const tree = buildTree(feedEvents(emptyRun(), MINITEST).results, rel);
    const onlyFailed = filterTree(tree, { passed: false, pending: false });
    expect(onlyFailed[0].children[0].children.map((c) => c.label)).toEqual(["test_deliberate_failure"]);
    const passedOnly = buildTree(feedEvents(emptyRun(), MINITEST).results.filter((r) => r.status === "passed"), rel);
    expect(filterTree(passedOnly, { passed: false, pending: true })).toEqual([]);
  });

  it("maps examples and groups to gutter statuses", () => {
    const st = lineStatuses(feedEvents(emptyRun(), RSPEC).results).get(`${ROOT}/spec/calc_spec.rb`)!;
    expect(Object.fromEntries(st)).toEqual({ 1: "failed", 2: "failed", 3: "passed", 7: "failed", 12: "pending" });
  });
});

describe("rerunArgs", () => {
  const rspec = feedEvents(emptyRun(), RSPEC).results;
  const mt = feedEvents(emptyRun(), MINITEST).results;

  it("reruns RSpec examples by id", () => {
    expect(rerunArgs("rspec", true, rspec.filter((r) => r.status === "failed"), rel, shellQuote)).toBe("'./spec/calc_spec.rb[1:1:2]'");
  });

  it("reruns Rails Minitest tests by file:line", () => {
    expect(rerunArgs("minitest", true, mt.filter((r) => r.status !== "passed"), rel, shellQuote)).toBe("test/models/smoke_calc_test.rb:8 test/models/smoke_calc_test.rb:12");
  });

  it("reruns plain Minitest tests by requiring files and filtering Class#name", () => {
    expect(rerunArgs("minitest", false, mt.slice(0, 2), rel, shellQuote)).toBe(
      `-e 'require File.expand_path("test/models/smoke_calc_test.rb")' -- -n '/^(?:SmokeCalcTest#test_deliberate_failure|SmokeCalcTest#test_adds)$/'`,
    );
  });

  it("knows when Minitest's planned count is filtered", () => {
    expect(plannedUnreliable("minitest", "test/a_test.rb:8")).toBe(true);
    expect(plannedUnreliable("minitest", "test/a_test.rb -n /foo/")).toBe(true);
    expect(plannedUnreliable("minitest", "test/a_test.rb")).toBe(false);
    expect(plannedUnreliable("rspec", "spec/a_spec.rb:8")).toBe(false);
  });
});

describe("backtraceLink", () => {
  it("extracts file:line from Ruby backtrace lines", () => {
    expect(backtraceLink("./spec/calc_spec.rb:8:in `block (3 levels)'")).toEqual({ path: "spec/calc_spec.rb", line: 8 });
    expect(backtraceLink("/usr/lib/ruby/gems/x.rb:120:in `call'")).toEqual({ path: "/usr/lib/ruby/gems/x.rb", line: 120 });
    expect(backtraceLink("no link here")).toBeNull();
  });
});
