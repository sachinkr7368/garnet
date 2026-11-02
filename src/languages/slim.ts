import type { languages } from "monaco-editor";
import { rubyExprStates } from "./rubyexpr";

export const slimConf: languages.LanguageConfiguration = {
  comments: { lineComment: "/" },
  brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
};

/// Slim: tags with .class/#id shortcuts, name=value attributes (quoted or Ruby), attribute wrappers,
/// control (-) and output (=, ==, =>, =<) lines embedded as Ruby, text blocks (| '), comments (/ /!),
/// doctype, inline HTML, filters (javascript:) and #{} interpolation.
export const slimLanguage: languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".slim",
  includeLF: true,
  tokenizer: {
    root: [
      [/^\s*doctype\b.*/, "metatag.doctype"],
      [/^(\s*)(\/!.*)/, ["", "comment"]],
      [/^(\s*)(\/.*)/, ["", "comment"]],
      [/^(\s*)([\w-]+:)(?=\s*\n)/, ["", "keyword"]],
      [/^(\s*)(-|==?[<>']*|=[<>']*)/, ["", { token: "metatag", next: "@ruby", nextEmbedded: "ruby" }]],
      [/^(\s*)([|'])/, ["", { token: "delimiter", next: "@text" }]],
      [/^(\s*)(<.*)/, ["", "tag"]],
      [/^(\s*)([a-zA-Z][\w:-]*)/, ["", { token: "tag", next: "@tag" }]],
      [/^(\s*)([.#][\w-]+)/, ["", { token: "attribute.name", next: "@tag" }]],
      [/#\{/, { token: "delimiter.interpolation", next: "@rubyExpr" }],
      [/[^#\n]+/, ""],
      [/#/, ""],
      [/\n/, ""],
    ],
    tag: [
      [/[.#][\w-]+/, "attribute.name"],
      [/[<>]+(?=[\s=])/, "delimiter"],
      [/[([{]/, { token: "delimiter", next: "@wrapped" }],
      [/(==?[<>']*)/, { token: "metatag", switchTo: "@ruby", nextEmbedded: "ruby" }],
      [/:(?=\s)/, "delimiter"],
      [/\/(?=\s*\n)/, "delimiter"],
      [/\n/, { token: "", next: "@pop" }],
      [/[ \t]+(?=[\w:@-]+=)/, ""],
      [/([\w:@-]+)(=)/, ["attribute.name", { token: "delimiter", next: "@attrValue" }]],
      [/[ \t]+/, { token: "", switchTo: "@text" }],
    ],
    attrValue: [
      [/"/, { token: "string.quote", switchTo: "@rubyDq" }],
      [/'[^']*'/, { token: "string", next: "@pop" }],
      [/[^\s\n]+/, { token: "identifier", next: "@pop" }],
    ],
    wrapped: [
      [/[)\]}]/, { token: "delimiter", next: "@pop" }],
      [/[\w:@-]+(?==)/, "attribute.name"],
      [/=/, "delimiter"],
      [/"/, { token: "string.quote", next: "@rubyDq" }],
      [/'[^']*'/, "string"],
      [/@\w+/, "variable.instance"],
      [/[\w:-]+/, "attribute.name"],
      [/\s+/, ""],
    ],
    text: [
      [/#\{/, { token: "delimiter.interpolation", next: "@rubyExpr" }],
      [/\n/, { token: "", next: "@pop" }],
      [/[^#\n]+/, ""],
      [/#/, ""],
    ],
    ruby: [[/$|\n/, { token: "", next: "@pop", nextEmbedded: "@pop" }]],
    ...rubyExprStates("ruby"),
  },
};
