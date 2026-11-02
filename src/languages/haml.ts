import type { languages } from "monaco-editor";
import { rubyExprStates } from "./rubyexpr";

export const hamlConf: languages.LanguageConfiguration = {
  comments: { lineComment: "-#" },
  brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  indentationRules: { increaseIndentPattern: /^\s*(%|\.|#|-\s*.*\bdo\b|-\s*(if|unless|else|elsif|case|when|each)\b)/, decreaseIndentPattern: /^$/ },
};

/// HAML: tags (%p, .class, #id), attribute hashes and (html) attributes, Ruby lines (= - != &= ~) embedded as Ruby,
/// comments (-# and /), doctype (!!!), filters (:javascript) and #{} interpolation in text.
export const hamlLanguage: languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".haml",
  includeLF: true,
  tokenizer: {
    root: [
      [/^\s*!!!.*/, "metatag"],
      [/^(\s*)(-#.*)/, ["", "comment"]],
      [/^(\s*)(\/.*)/, ["", "comment"]],
      [/^(\s*)(:[\w-]+)/, ["", "keyword"]],
      [/^(\s*)(%[\w:-]+)/, ["", { token: "tag", next: "@tag" }]],
      [/^(\s*)([.#][\w-]+)/, ["", { token: "attribute.name", next: "@tag" }]],
      [/^(\s*)(!=|&=|==|=|~|-)/, ["", { token: "metatag.haml", next: "@ruby", nextEmbedded: "ruby" }]],
      [/^(\s*)(\\)/, ["", { token: "", next: "@text" }]],
      [/#\{/, { token: "delimiter.interpolation", next: "@rubyExpr" }],
      [/[^#\n]+/, ""],
      [/#/, ""],
      [/\n/, ""],
    ],
    tag: [
      [/[.#][\w-]+/, "attribute.name"],
      [/\{/, { token: "delimiter.curly", next: "@rubyExpr" }],
      [/\(/, { token: "delimiter.parenthesis", next: "@attrs" }],
      [/\[/, { token: "delimiter.square", next: "@objectRef" }],
      [/[<>]+/, "delimiter"],
      [/\/(?=\s*\n)/, "delimiter"],
      [/(!=|&=|=|~)/, { token: "metatag.haml", switchTo: "@ruby", nextEmbedded: "ruby" }],
      [/\n/, { token: "", next: "@pop" }],
      [/[ \t]+/, { token: "", switchTo: "@text" }],
    ],
    text: [
      [/#\{/, { token: "delimiter.interpolation", next: "@rubyExpr" }],
      [/\n/, { token: "", next: "@pop" }],
      [/[^#\n]+/, ""],
      [/#/, ""],
    ],
    attrs: [
      [/\)/, { token: "delimiter.parenthesis", next: "@pop" }],
      [/[\w:-]+(?==)/, "attribute.name"],
      [/=/, "delimiter"],
      [/"/, { token: "string.quote", next: "@rubyDq" }],
      [/'[^']*'/, "string"],
      [/@\w+/, "variable.instance"],
      [/[\w:-]+/, "attribute.name"],
      [/\s+/, ""],
    ],
    objectRef: [
      [/\]/, { token: "delimiter.square", next: "@pop" }],
      [/@\w+/, "variable.instance"],
      [/:\w+/, "string.symbol"],
      [/[^\]@:]+/, ""],
    ],
    ruby: [[/\n/, { token: "", next: "@pop", nextEmbedded: "@pop" }]],
    ...rubyExprStates("ruby"),
  },
};
