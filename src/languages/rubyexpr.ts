import type { languages } from "monaco-editor";

/// Ruby expression rules shared by the HAML and Slim grammars for attribute hashes and `#{}` interpolation.
/// Braces nest through @push/@pop, so `{ data: { id: 1 } }` and `"#{a}"` close at the right brace.
export function rubyExprStates(prefix: string): Record<string, languages.IMonarchLanguageRule[]> {
  return {
    [`${prefix}Expr`]: [
      [/\{/, { token: "delimiter.curly", next: `@${prefix}Expr` }],
      [/\}/, { token: "delimiter.curly", next: "@pop" }],
      [/"/, { token: "string.quote", next: `@${prefix}Dq` }],
      [/'[^']*'/, "string"],
      [/[a-zA-Z_]\w*:(?!:)/, "key"],
      [/:[a-zA-Z_]\w*[?!]?/, "string.symbol"],
      [/[@]{1,2}[a-zA-Z_]\w*/, "variable.instance"],
      [/\$[a-zA-Z_]\w*/, "variable.global"],
      [/\b(?:true|false|nil|self|if|unless|else|elsif|end|do|and|or|not|then|yield|return|new)\b/, "keyword"],
      [/[A-Z]\w*/, "constant"],
      [/\d+(?:\.\d+)?/, "number"],
      [/[a-z_]\w*[?!]?/, "identifier"],
      [/=>|[-+*\/%=<>!&|.,?:]+/, "operator"],
      [/[()[\]]/, "delimiter"],
      [/\s+/, ""],
    ],
    [`${prefix}Dq`]: [
      [/#\{/, { token: "delimiter.interpolation", next: `@${prefix}Expr` }],
      [/\\./, "string.escape"],
      [/"/, { token: "string.quote", next: "@pop" }],
      [/[^"\\#]+/, "string"],
      [/#/, "string"],
    ],
  };
}
