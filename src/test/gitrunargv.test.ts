import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/// Every git_run argv shape the UI sends must be in the fixture, which the Rust allowlist test runs through
/// check_run_args (src-tauri/src/git.rs), so a new caller cannot ship an argv the backend refuses.
const SRC = join(__dirname, "..");
const argvs: string[][] = JSON.parse(readFileSync(join(__dirname, "fixtures/git-run-argv.json"), "utf8"));
const subs = new Set(argvs.map((a) => a[0]));
const option = (s: string) => (s.startsWith("--") ? s.split("=")[0] : s);
const literals = (text: string) => [...text.matchAll(/"([^"$\\]*)"/g)].map((m) => m[1]);

function callSites() {
  const sites: { where: string; sub: string; opts: string[] }[] = [];
  for (const file of readdirSync(SRC).filter((f) => f.endsWith(".ts"))) {
    const text = readFileSync(join(SRC, file), "utf8");
    const add = (index: number, args: string, isArray: boolean) => {
      const lits = literals(args);
      const sub = lits.find((l) => /^[a-z][a-z-]*$/.test(l));
      if (!sub || (isArray && !subs.has(sub))) return;
      const line = text.slice(0, index).split("\n").length;
      sites.push({ where: `${file}:${line}`, sub, opts: lits.filter((l) => l.startsWith("-") && l !== "--").map(option) });
    };
    for (const m of text.matchAll(/(?<![\w.])(?:git|api\.git)\(((?:[^()]|\([^()]*\))*)\)/g)) add(m.index!, m[1], false);
    for (const m of text.matchAll(/runGitOp\([^,]+,\s*(\[[^\]]*\])/g)) add(m.index!, m[1], false);
    for (const m of text.matchAll(/\[\s*("[a-z-]+",[^\]]*)\]/g)) add(m.index!, m[1], true);
  }
  return sites;
}

describe("git_run callers", () => {
  it("finds the call sites", () => {
    const found = new Set(callSites().map((s) => s.sub));
    for (const sub of ["stash", "checkout", "worktree", "for-each-ref", "rev-parse", "push"]) expect(found).toContain(sub);
  });

  it("every caller's subcommand and options appear together in an allowlisted fixture argv", () => {
    const uncovered = callSites().filter(({ sub, opts }) => !argvs.some((a) => a[0] === sub && opts.every((o) => a.slice(1).map(option).includes(o))));
    expect(uncovered).toEqual([]);
  });
});
