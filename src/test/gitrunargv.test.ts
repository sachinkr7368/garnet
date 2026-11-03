import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/// Every argv the UI can send through git_run, extracted from the source. The Rust allowlist test runs each one through
/// check_run_args (src-tauri/src/git.rs), whose RUN_ALLOWED list is also the source of known subcommands here.
/// Regenerate the fixture with GARNET_UPDATE_GIT_ARGV=1 after adding a caller.
const SRC = join(__dirname, "..");
const FIXTURE = join(__dirname, "fixtures/git-run-argv.json");
const VALUE = "<v>";
const ALLOWED = new Set([...readFileSync(join(SRC, "../src-tauri/src/git.rs"), "utf8").split("const RUN_ALLOWED")[1].split("];")[0].matchAll(/\("([a-z-]+)", &\[/g)].map((m) => m[1]));

type Argv = string[];
type Source = { file: string; text: string };

function skipQuoted(s: string, i: number): number {
  const q = s[i];
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (q === "`" && s[j] === "$" && s[j + 1] === "{") j = closing(s, j + 1);
    else if (s[j] === q) return j + 1;
  }
  return s.length;
}

/// Index of the bracket closing the one at `open`, skipping strings, templates and comments.
function closing(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") i = skipQuoted(s, i) - 1;
    else if (c === "/" && s[i + 1] === "/") i = s.indexOf("\n", i);
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) && --depth === 0) return i;
    if (i < 0) break;
  }
  return s.length;
}

/// Top-level positions of `ch` (outside strings and brackets); `?` skips `?.` and `??`.
function topLevel(s: string, ch: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") i = skipQuoted(s, i) - 1;
    else if ("([{".includes(c)) i = closing(s, i);
    else if (c === ch && !(ch === "?" && (s[i + 1] === "." || s[i + 1] === "?" || s[i - 1] === "?"))) out.push(i);
  }
  return out;
}

const splitTop = (s: string) => {
  const cuts = topLevel(s, ",");
  return [-1, ...cuts].map((c, n) => s.slice(c + 1, cuts[n] ?? s.length).trim()).filter(Boolean);
};

function stripParens(e: string): string {
  e = e.trim().replace(/\s+as\s+[\w.[\]"| <>]+$/, "");
  while (e.startsWith("(") && closing(e, 0) === e.length - 1) e = e.slice(1, -1).trim();
  return e;
}

function ternary(e: string): [string, string] | null {
  const q = topLevel(e, "?")[0];
  if (q === undefined) return null;
  let depth = 0;
  for (const c of topLevel(e, ":").concat(topLevel(e, "?")).sort((a, b) => a - b)) {
    if (c <= q) continue;
    if (e[c] === "?") depth++;
    else if (depth-- === 0) return [e.slice(q + 1, c), e.slice(c + 1)];
  }
  return null;
}

function literal(e: string): string | null | undefined {
  const m = e.match(/^(["'])((?:\\.|(?!\1).)*)\1$/s) ?? e.match(/^(`)([^`$]*)`$/);
  if (m) return m[2];
  if (/^`.*`$/s.test(e)) return null;
  return undefined;
}

const cartesian = (parts: Argv[][]): Argv[] => parts.reduce<Argv[]>((acc, p) => acc.flatMap((a) => p.map((b) => [...a, ...b])), [[]]);

/// Token sequences one argument expression can produce.
function tokens(expr: string, src: Source, at: number): Argv[] {
  const e = stripParens(expr);
  if (e.startsWith("...")) return argvs(e.slice(3), src, at);
  const t = ternary(e);
  if (t) return [...tokens(t[0], src, at), ...tokens(t[1], src, at)];
  if (e.startsWith("[") && closing(e, 0) === e.length - 1) return cartesian(splitTop(e.slice(1, -1)).map((x) => tokens(x, src, at)));
  const lit = literal(e);
  if (lit === null) return [[e.startsWith("`-") ? `<option ${e}>` : VALUE]];
  return [[lit ?? VALUE]];
}

/// Argvs an array-valued expression can evaluate to (an array literal, a ternary, a spread, or a resolvable name).
function argvs(expr: string, src: Source, at: number): Argv[] {
  const e = stripParens(expr);
  const t = ternary(e);
  if (t) return [...argvs(t[0], src, at), ...argvs(t[1], src, at)];
  if (e.startsWith("[")) return tokens(e, src, at);
  const name = e.match(/^([A-Za-z_$][\w$]*)(?:\[[^\]]+\]|\.\w+)?$/)?.[1];
  const def = name && definition(name, src, at);
  if (!def) return [[`<unresolved ${e} at ${src.file}:${line(src, at)}>`]];
  if (def.startsWith("{")) return splitTop(def.slice(1, -1)).flatMap((kv) => argvs(kv.slice(topLevel(kv, ":")[0] + 1), src, at));
  return argvs(def, src, at);
}

/// The initializer of `const|let name = …` nearest before `at` (else the first in the file).
function definition(name: string, src: Source, at: number): string | null {
  const defs = [...src.text.matchAll(new RegExp(`(?:const|let)\\s+${name.replace("$", "\\$")}(?:\\s*:[^=;]+)?\\s*=\\s*`, "g"))];
  const def = defs.filter((d) => d.index! < at).pop() ?? defs[0];
  if (!def) return null;
  const start = def.index! + def[0].length;
  const end = topLevel(src.text.slice(start), ";")[0];
  return src.text.slice(start, start + (end ?? 0)).trim();
}

/// Argvs inside a list of argvs (`steps: [[…], ...(c ? [[…]] : [[…]])]`).
function argvList(expr: string, src: Source): Argv[] {
  const e = stripParens(expr);
  const t = ternary(e);
  if (t) return [...argvList(t[0], src), ...argvList(t[1], src)];
  return splitTop(e.slice(1, -1)).flatMap((item) => (item.startsWith("...") ? argvList(item.slice(3), src) : tokens(item, src, 0)));
}

const line = (src: Source, at: number) => src.text.slice(0, at).split("\n").length;

/// Arguments of every git_run caller: api.git(root, …), a file's `git(…)` wrapper around it, and runGitOp(label, argv).
/// Wrappers that only forward their own `...args` parameter are skipped; `git(...step)` in prs.ts runs the
/// checkoutPlan steps from ghmodel.ts.
export function extract(sources: Source[]): { where: string; argv: Argv }[] {
  const out: { where: string; argv: Argv }[] = [];
  const all = new Map(sources.map((s) => [s.file, s]));
  for (const src of sources) {
    const wrapper = /const git = \(\.\.\.args: string\[\]\) => api\.git\(/.test(src.text);
    for (const m of src.text.matchAll(/(?<![\w.$])(api\.git|git|runGitOp)\(/g)) {
      const open = m.index! + m[0].length - 1;
      const args = splitTop(src.text.slice(open + 1, closing(src.text, open)));
      const before = src.text.slice(Math.max(0, m.index! - 200), m.index!);
      const forwards = (args.at(-1) === "...args" && /args: string\[\]\)[^\n]*$|args: string\[\]\)[^]*\{[^}]*$/.test(before)) || /function\s+$/.test(before);
      if (forwards || !args.length) continue;
      const where = `${src.file}:${line(src, m.index!)}`;
      // After `--` every argument is a pathspec (git_run passes --literal-pathspecs), so any expression there is a value.
      const paths = (argv: Argv) => argv.map((a, i) => (i > argv.indexOf("--") && argv.includes("--") ? (a.startsWith("<unresolved") ? VALUE : a) : a));
      const add = (list: Argv[]) => list.forEach((argv) => out.push({ where, argv: paths(argv) }));
      if (m[1] === "runGitOp") add(argvs(args[1] ?? "", src, m.index!));
      else if (m[1] === "git" && !wrapper) out.push({ where, argv: ["<git( without the api.git wrapper>"] });
      else if (args.join(",") === "...step" && src.file === "prs.ts") {
        const plan = all.get("ghmodel.ts")!;
        for (const s of plan.text.matchAll(/steps:\s*(?=\[)/g)) add(argvList(plan.text.slice(s.index! + s[0].length, closing(plan.text, s.index! + s[0].length) + 1), plan));
      } else add(cartesian((m[1] === "api.git" ? args.slice(1) : args).map((a) => tokens(a, src, m.index!))));
    }
  }
  return out;
}

function sources(dir = SRC): Source[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "test" ? [] : sources(p);
    return f.endsWith(".ts") ? [{ file: relative(SRC, p), text: readFileSync(p, "utf8") }] : [];
  });
}

/// Subcommands whose first argument is an action (stash push/pop…, worktree add…, remote get-url) need it literal too.
const ACTIONS = new Set(["stash", "worktree", "remote"]);
const problem = (argv: Argv) =>
  !ALLOWED.has(argv[0]) ? `unknown subcommand ${argv[0]}` : ACTIONS.has(argv[0]) && argv[1] === VALUE ? `variable ${argv[0]} action` : (argv.find((a) => a.startsWith("<") && a !== VALUE) ?? null);

describe("git_run callers", () => {
  const src = sources();
  const found = extract(src);

  it("reach git_run only through api.git", () => {
    expect(src.filter((s) => s.text.includes('"git_run"')).map((s) => s.file)).toEqual(["ipc.ts"]);
    expect(src.some((s) => s.file.startsWith("languages/"))).toBe(true);
  });

  it("only send argv shapes with a known subcommand and literal options", () => {
    expect(found.filter((f) => problem(f.argv)).map((f) => `${f.where}: ${problem(f.argv)} in ${JSON.stringify(f.argv)}`)).toEqual([]);
  });

  it("match the fixture the Rust allowlist test checks", () => {
    const shapes = [...new Set(found.map((f) => JSON.stringify(f.argv)))].sort().map((s) => JSON.parse(s) as Argv);
    if (process.env.GARNET_UPDATE_GIT_ARGV) writeFileSync(FIXTURE, `[\n${shapes.map((s) => `  ${JSON.stringify(s)}`).join(",\n")}\n]\n`);
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(shapes);
  });

  it("sees through spreads, nested arrays, ternaries, lookup tables and every string form", () => {
    const text = [
      'const git = (...args: string[]) => api.git(root(), ...args);',
      'const args = ["stash", "push", ...(u ? ["--include-untracked"] : []), ...(m ? ["-m", m] : [])];',
      'runGitOp("Stash", args);',
      'const ABORT: Record<Op, string[]> = { merge: ["merge", "--abort"], revert: [\'revert\', `--abort`] };',
      'runGitOp(`Abort ${op}`, ABORT[op]);',
      'git("checkout", side === "ours" ? "--ours" : "--theirs", "--", path);',
      'runGitOp("x", [op, "--continue"]);',
      'git("checkout", `--${side}`);',
      'api.git(root(), ...unknown);',
    ].join("\n");
    const argv = extract([{ file: "x.ts", text }]).map((f) => f.argv);
    expect(argv).toEqual([
      ["stash", "push", "--include-untracked", "-m", VALUE], ["stash", "push", "--include-untracked"], ["stash", "push", "-m", VALUE], ["stash", "push"],
      ["merge", "--abort"], ["revert", "--abort"],
      ["checkout", "--ours", "--", VALUE], ["checkout", "--theirs", "--", VALUE],
      [VALUE, "--continue"],
      ["checkout", "<option `--${side}`>"],
      ["<unresolved unknown at x.ts:9>"],
    ]);
    expect(argv.slice(-3).map(problem)).toEqual(["unknown subcommand <v>", "<option `--${side}`>", "unknown subcommand <unresolved unknown at x.ts:9>"]);
  });
});
