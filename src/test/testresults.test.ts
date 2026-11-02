import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../editor", async () => await import("./fakeEditor"));

import { newConfig } from "../run";
import { loadSettings } from "../settings";
import { state } from "../state";
import { prepareTestRun } from "../testresults";
import { fake } from "./fakeIpc";

const ROOT = "/work/blog";

beforeEach(async () => {
  fake.reset();
  state.project = { root: ROOT, name: "blog", git: true, rails: true, rspec: false, minitest: true, binRspec: false, debugBundled: false };
  await loadSettings(ROOT);
});

describe("prepareTestRun RUBYLIB", () => {
  it("prepends the reporter dir to the login shell's RUBYLIB", async () => {
    fake.capture = (cmd) => (cmd.includes("RUBYLIB") ? "/opt/ruby/lib" : "");
    const t = await prepareTestRun(newConfig("minitest", "t", "test/a_test.rb"));
    expect(t?.env.RUBYLIB).toBe("/config/ruby:/opt/ruby/lib");
    expect(t?.env.GARNET_TEST_EVENTS).toMatch(/^\/config\/ruby\/events\/.+\.ndjson$/);
  });

  it("prefers a RUBYLIB from the configuration's env", async () => {
    fake.capture = () => "/opt/ruby/lib";
    const t = await prepareTestRun(newConfig("minitest", "t"), { RUBYLIB: "lib:vendor/lib" });
    expect(t?.env.RUBYLIB).toBe("/config/ruby:lib:vendor/lib");
  });

  it("leaves RSpec runs' RUBYLIB alone", async () => {
    const t = await prepareTestRun(newConfig("rspec", "s"), { RUBYLIB: "lib" });
    expect(t?.env.RUBYLIB).toBeUndefined();
  });
});
