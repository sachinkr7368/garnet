/// Turns ruby-lsp's stderr into a one-line reason and the fix to offer.

export type LspFix = "bundleInstall" | "installRubyLsp" | "installRuby" | "noLauncher" | null;

export interface LspDiagnosis {
  reason: string;
  fix: LspFix;
}

export const STDERR_KEEP = 200;

/// Keeps the last `STDERR_KEEP` lines.
export function pushLine(buf: string[], line: string) {
  buf.push(line);
  if (buf.length > STDERR_KEEP) buf.splice(0, buf.length - STDERR_KEEP);
}

const RULES: [RegExp, (m: RegExpMatchArray) => LspDiagnosis][] = [
  [/invalid option: --use-launcher|unrecognized option.*--use-launcher/, () => ({ reason: "this ruby-lsp is too old for launcher mode", fix: "noLauncher" })],
  [
    /Could not find (?:gem )?'?([\w.-]+?)(?:-\d[\w.]*)?'? in (?:locally installed gems|any of the (?:gem )?sources)|Your bundle is locked to ([\w.-]+) \(|Bundler::GemNotFound|following gems are missing|Install missing gems with `bundle install`/,
    (m) => ({ reason: `Missing gems${m[1] ?? m[2] ? ` (${m[1] ?? m[2]})` : ""}: run bundle install`, fix: "bundleInstall" }),
  ],
  [/Your Ruby version is ([\d.]+), but your Gemfile specified ([\d.~> ]+)/, (m) => ({ reason: `Ruby ${m[1]} does not match the Gemfile (${m[2].trim()})`, fix: "installRuby" })],
  [
    /rbenv: version `?([\w.-]+)'? is not installed|asdf: No version is set|No preset version installed for command ruby|mise .*ruby@?([\w.-]+)? (?:is )?not installed|chruby: unknown Ruby: ([\w.-]+)|ruby-([\d.]+) is not installed/,
    (m) => ({ reason: `The project's Ruby${m[1] ?? m[2] ?? m[3] ?? m[4] ? ` ${m[1] ?? m[2] ?? m[3] ?? m[4]}` : ""} is not installed`, fix: "installRuby" }),
  ],
  [
    /ruby-lsp: command not found|ruby-lsp: No such file|unknown command: ruby-lsp|No such command.*ruby-lsp|can't find gem ruby-lsp|executable ruby-lsp not found|ruby-lsp.*(?:not found|isn't installed)/,
    () => ({ reason: "ruby-lsp is not installed for this Ruby", fix: "installRubyLsp" }),
  ],
];

const NOISE = /^\s*(?:from |\S+:\d+:in |Ruby LSP> |$)/;

export function diagnose(lines: string[], code: number | null): LspDiagnosis {
  const text = lines.join("\n");
  for (const [re, f] of RULES) {
    const m = text.match(re);
    if (m) return f(m);
  }
  const last = [...lines].reverse().find((l) => !NOISE.test(l))?.trim();
  return { reason: last ? last.slice(0, 200) : `exited with ${code === null ? "a signal" : `code ${code}`}`, fix: null };
}
