import type { languages } from "monaco-editor";
import { language as monacoRuby } from "monaco-editor/languages/definitions/ruby/ruby";

/// Monaco's Ruby grammar pops its state stack on every `end`. A stray `end` (an ERB `<% end %>`, whose embedded Ruby
/// starts from the root state, or an unbalanced one while typing) pops an empty stack, the tokenizer throws and the
/// line loses its highlighting. Here `end` only pops when a declaration is open (state `root.<decl>`).
export function guardEnd(lang: languages.IMonarchLanguage): languages.IMonarchLanguage {
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object" || node instanceof RegExp) return;
    if (Array.isArray(node)) return node.forEach(visit);
    const cases = (node as { cases?: Record<string, unknown> }).cases;
    const end = cases?.end as { next?: string } | undefined;
    if (end?.next === "@pop") cases!.end = { cases: { "$S2==": "keyword", "@default": end } };
    Object.values(node).forEach(visit);
  };
  const out = structuredClone(lang);
  visit(out.tokenizer);
  return out;
}

export const rubyLanguage = guardEnd(monacoRuby);

/// HTML with `<% %>` / `<%= %>` embedding Ruby.
export function erbLanguage(html: languages.IMonarchLanguage): languages.IMonarchLanguage {
  const lang = structuredClone(html) as any;
  const open = [/<%(?:=|-|#)?/, { token: "metatag.erb", next: "@erb", nextEmbedded: "ruby" }];
  const close = [/-?%>/, "metatag.erb"];
  for (const key of Object.keys(lang.tokenizer)) lang.tokenizer[key].unshift(open, close);
  lang.tokenizer.erb = [[/-?%>/, { token: "@rematch", next: "@pop", nextEmbedded: "@pop" }]];
  lang.tokenPostfix = ".erb";
  return lang;
}
