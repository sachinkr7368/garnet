import { describe, expect, it } from "vitest";
import { diagnose, pushLine, STDERR_KEEP } from "../lspdiag";

describe("ruby-lsp failure diagnosis", () => {
  it("reports missing gems from bundle exec (Bundler::GemNotFound)", () => {
    const lines = [
      "bundler: failed to load command: ruby-lsp (/Users/me/.local/share/mise/installs/ruby/3.3.4/bin/ruby-lsp)",
      "/Users/me/.local/share/mise/installs/ruby/3.3.4/lib/ruby/3.3.0/bundler/definition.rb:594:in `materialize': Could not find garnet-missing-gem-xyz-9.9.9 in locally installed gems (Bundler::GemNotFound)",
      "\tfrom /Users/me/.local/share/mise/installs/ruby/3.3.4/lib/ruby/3.3.0/bundler/definition.rb:193:in `specs'",
    ];
    expect(diagnose(lines, 1)).toEqual({ reason: "Missing gems (garnet-missing-gem-xyz): run bundle install", fix: "bundleInstall" });
  });

  it("reports missing gems from the composed bundle", () => {
    expect(diagnose(["Ruby LSP> Running bundle install for the composed bundle.", "The following gems are missing", " * pg (1.5.4)", "Install missing gems with `bundle install`"], 1).fix).toBe("bundleInstall");
    expect(diagnose(["Could not find gem 'pg' in any of the gem sources listed in your Gemfile."], 1).reason).toBe("Missing gems (pg): run bundle install");
  });

  it("reads ruby-lsp's launcher telemetry when it falls back to running without the bundle", () => {
    const msg = "Your bundle is locked to garnet-missing-gem-xyz (9.9.9) from rubygems repository https://rubygems.org/ or installed locally, but that version can no longer be found in that source.";
    expect(diagnose([msg], null)).toEqual({ reason: "Missing gems (garnet-missing-gem-xyz): run bundle install", fix: "bundleInstall" });
  });

  it("reports a missing ruby-lsp for the selected Ruby", () => {
    for (const line of ["rbenv: ruby-lsp: command not found", "mise ERROR No such command: ruby-lsp", "unknown command: ruby-lsp. Perhaps you have to reshim?"])
      expect(diagnose([line], 127), line).toEqual({ reason: "ruby-lsp is not installed for this Ruby", fix: "installRubyLsp" });
  });

  it("reports a Ruby that is not installed", () => {
    expect(diagnose(["rbenv: version `3.4.1' is not installed (set by /p/.ruby-version)"], 1)).toEqual({ reason: "The project's Ruby 3.4.1 is not installed", fix: "installRuby" });
    expect(diagnose(["Your Ruby version is 3.3.4, but your Gemfile specified 3.4.1"], 18).reason).toBe("Ruby 3.3.4 does not match the Gemfile (3.4.1)");
  });

  it("asks for a retry without the launcher on old ruby-lsp", () => {
    expect(diagnose(["ruby-lsp: invalid option: --use-launcher"], 1).fix).toBe("noLauncher");
  });

  it("falls back to the last meaningful stderr line, then the exit code", () => {
    expect(diagnose(["Ruby LSP> Starting", "SomeError: boom", "\tfrom x.rb:1:in `y'", ""], 1)).toEqual({ reason: "SomeError: boom", fix: null });
    expect(diagnose([], 9)).toEqual({ reason: "exited with code 9", fix: null });
    expect(diagnose([], null).reason).toBe("exited with a signal");
  });

  it("keeps only the last 200 stderr lines", () => {
    const buf: string[] = [];
    for (let i = 0; i < 250; i++) pushLine(buf, `line ${i}`);
    expect(buf.length).toBe(STDERR_KEEP);
    expect(buf[0]).toBe("line 50");
    expect(buf.at(-1)).toBe("line 249");
  });
});
