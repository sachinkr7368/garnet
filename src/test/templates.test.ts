import { describe, expect, it } from "vitest";
import * as monaco from "monaco-editor";
import { conf as rubyConf } from "monaco-editor/languages/definitions/ruby/ruby";
import { conf as htmlConf, language as htmlLanguage } from "monaco-editor/languages/definitions/html/html";
import { erbLanguage, rubyLanguage } from "../languages/ruby";
import { hamlConf, hamlLanguage } from "../languages/haml";
import { slimConf, slimLanguage } from "../languages/slim";
import { snippetsFor } from "../languages/snippets";

monaco.languages.setMonarchTokensProvider("ruby", rubyLanguage);
monaco.languages.setLanguageConfiguration("ruby", rubyConf);
monaco.languages.register({ id: "erb" });
monaco.languages.setMonarchTokensProvider("erb", erbLanguage(htmlLanguage));
monaco.languages.setLanguageConfiguration("erb", htmlConf);
for (const [id, lang, conf] of [["haml", hamlLanguage, hamlConf], ["slim", slimLanguage, slimConf]] as const) {
  monaco.languages.register({ id });
  monaco.languages.setMonarchTokensProvider(id, lang);
  monaco.languages.setLanguageConfiguration(id, conf);
}

/// [text, type, language] per token, per line.
function tokens(text: string, lang: string) {
  const lines = text.split("\n");
  return monaco.editor.tokenize(text, lang).map((line, i) =>
    line.map((t, j) => [lines[i].slice(t.offset, line[j + 1]?.offset ?? lines[i].length), t.type, t.language] as const),
  );
}
const typeOf = (line: readonly (readonly [string, string, string])[], text: string) => line.find(([t]) => t === text)?.[1];

describe("Ruby and ERB grammar", () => {
  it("highlights `<% end %>` and stray `end`s instead of throwing on an empty state stack", () => {
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => errors.push(e.error);
    window.addEventListener("error", onError);
    const erb = tokens('<% @posts.each do |post| %>\n  <p><%= post.title %></p>\n<% end %>\n<%= end %>', "erb");
    expect(typeOf(erb[2], "end")).toBe("keyword.ruby");
    expect(typeOf(erb[3], "end")).toBe("keyword.ruby");
    const rb = tokens("class A\nend\nend\nend\nx = 1", "ruby");
    for (const line of [1, 2, 3]) expect(typeOf(rb[line], "end")).toMatch(/^keyword/);
    expect(typeOf(rb[4], "x")).toBe("identifier.ruby");
    window.removeEventListener("error", onError);
    expect(errors).toEqual([]);
  });

  it("still closes declarations with `end`", () => {
    const rb = tokens("class A\n  def b\n  end\nend\nfoo", "ruby");
    expect(typeOf(rb[2], "end")).toBe("keyword.def.ruby");
    expect(typeOf(rb[3], "end")).toBe("keyword.class.ruby");
    expect(typeOf(rb[4], "foo")).toBe("identifier.ruby");
  });
});

describe("HAML grammar", () => {
  it("tokenizes tags, class/id shortcuts and Ruby output", () => {
    const [line] = tokens("%p.title#main= @post.title", "haml");
    expect(line[0]).toEqual(["%p", "tag.haml", "haml"]);
    expect(typeOf(line, ".title#main")).toBe("attribute.name.haml");
    expect(typeOf(line, "=")).toBe("metatag.haml");
    expect(line.some(([, , lang]) => lang === "ruby")).toBe(true);
  });

  it("leaves embedded Ruby at the end of the line", () => {
    const [, second] = tokens("- if @posts.any?\n  %ul", "haml");
    expect(second.find(([t]) => t === "%ul")).toEqual(["%ul", "tag.haml", "haml"]);
  });

  it("handles nested attribute hashes, html attributes and interpolation", () => {
    const [hash, html, text] = tokens('%a{ href: "#{root}", data: { id: 1 } } Go\n%img(src="x.png" alt=@alt)\n%p Hi #{name}!', "haml");
    expect(typeOf(hash, "href:")).toBe("key.haml");
    expect(typeOf(hash, "data:")).toBe("key.haml");
    expect(typeOf(hash, "#{")).toBe("delimiter.interpolation.haml");
    expect(hash.filter(([, t]) => t === "delimiter.curly.haml").length).toBe(5);
    expect(hash.at(-1)?.[0]).toContain("Go");
    expect(typeOf(html, "src")).toBe("attribute.name.haml");
    expect(typeOf(html, "@alt")).toBe("variable.instance.haml");
    expect(typeOf(text, "#{")).toBe("delimiter.interpolation.haml");
    expect(typeOf(text, "name")).toBe("identifier.haml");
  });

  it("colors instance and class variables in Ruby attribute values but not bare words", () => {
    const [line] = tokens("%a{ n: @@count, m: @m, k: name }", "haml");
    expect(typeOf(line, "@@count")).toBe("variable.instance.haml");
    expect(typeOf(line, "@m")).toBe("variable.instance.haml");
    expect(typeOf(line, "name")).toBe("identifier.haml");
  });

  it("recognises comments, doctype and filters", () => {
    const [c1, c2, doc, filter] = tokens("-# hidden\n/ html comment\n!!! 5\n:javascript", "haml");
    expect(c1.at(-1)?.[1]).toBe("comment.haml");
    expect(c2.at(-1)?.[1]).toBe("comment.haml");
    expect(doc[0][1]).toBe("metatag.doctype.haml");
    expect(filter.at(-1)?.[1]).toBe("keyword.haml");
  });
});

describe("Slim grammar", () => {
  it("tokenizes tags, attributes with Ruby values and trailing text", () => {
    const [line] = tokens('a.btn href=post_path(@post) title="Edit #{@post.id}" Show', "slim");
    expect(line[0]).toEqual(["a", "tag.slim", "slim"]);
    expect(typeOf(line, ".btn")).toBe("attribute.name.slim");
    expect(typeOf(line, "href")).toBe("attribute.name.slim");
    expect(typeOf(line, "#{")).toBe("delimiter.interpolation.slim");
    expect(line.at(-1)?.[0]).toContain("Show");
  });

  it("embeds Ruby for control and output lines and pops at end of line", () => {
    const [ctl, out, next] = tokens("- @posts.each do |post|\n  = link_to post.title, post\n  p done", "slim");
    expect(ctl[0][1]).toBe("metatag.slim");
    expect(ctl.some(([, , l]) => l === "ruby")).toBe(true);
    expect(out.some(([t, ty]) => t === "=" && ty === "metatag.slim")).toBe(true);
    expect(next.find(([t]) => t === "p")).toEqual(["p", "tag.slim", "slim"]);
  });

  it("recognises comments, doctype, text blocks and wrapped attributes", () => {
    const [c, doc, pipe, wrapped] = tokens('/ note\ndoctype html\n| plain #{x}\nimg(src="a" alt=@b)', "slim");
    expect(c.at(-1)?.[1]).toBe("comment.slim");
    expect(doc[0][1]).toBe("metatag.doctype.slim");
    expect(typeOf(pipe, "|")).toBe("delimiter.slim");
    expect(typeOf(pipe, "#{")).toBe("delimiter.interpolation.slim");
    expect(typeOf(wrapped, "alt")).toBe("attribute.name.slim");
    expect(typeOf(wrapped, "@b")).toBe("variable.instance.slim");
  });
});

describe("snippets", () => {
  const prefixes = (lang: string, path: string) => snippetsFor(lang, path).map((s) => s.prefix);
  it("offers RSpec templates only in spec files", () => {
    expect(prefixes("ruby", "spec/models/post_spec.rb")).toEqual(expect.arrayContaining(["def", "class", "describe", "it", "let", "before", "each", "do"]));
    expect(prefixes("ruby", "app/models/post.rb")).not.toContain("describe");
    expect(prefixes("ruby", "app/models/post.rb")).toEqual(expect.arrayContaining(["def", "class", "each", "do"]));
  });
  it("offers ERB tags in ERB and nothing elsewhere", () => {
    expect(snippetsFor("erb", "a.html.erb").map((s) => s.body)).toEqual(expect.arrayContaining(["<%= $0 %>", "<% $0 %>", "<%# $0 %>"]));
    expect(snippetsFor("yaml", "a.yml")).toEqual([]);
  });
  it("uses unique prefixes and ends block templates inside the block", () => {
    for (const lang of ["ruby", "erb"]) {
      const list = snippetsFor(lang, "x_spec.rb");
      expect(new Set(list.map((s) => s.prefix)).size).toBe(list.length);
      for (const s of list.filter((s) => s.body.includes("\nend"))) expect(s.body).toMatch(/\n\t\$0\n/);
    }
  });
});
