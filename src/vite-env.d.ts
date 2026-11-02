/// <reference types="vite/client" />

declare module "monaco-editor/languages/definitions/html/html" {
  import type { languages } from "monaco-editor";
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage;
}

declare module "monaco-editor/languages/definitions/ruby/ruby" {
  import type { languages } from "monaco-editor";
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage;
}
