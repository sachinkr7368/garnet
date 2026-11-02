import { api } from "./ipc";
import { globToRegExp, setting } from "./settings";
import { basename } from "./state";

export interface CodeStyle {
  tabSize: number;
  insertSpaces: boolean;
  trimTrailingWhitespace: boolean;
  insertFinalNewline: boolean;
}

let editorconfig: { re: RegExp; path: boolean; props: Record<string, string> }[] = [];
let rubocopWidth: number | null = null;
let root = "";

/// Parses the project's root .editorconfig and .rubocop.yml (indent width only).
export async function loadCodeStyle(projectRoot: string) {
  root = projectRoot;
  const ec = await api.readFile(`${root}/.editorconfig`).catch(() => "");
  editorconfig = [];
  let current: (typeof editorconfig)[number] | null = null;
  for (const raw of ec.split("\n")) {
    const line = raw.replace(/[#;].*$/, "").trim();
    const section = line.match(/^\[(.+)\]$/);
    if (section) {
      const glob = section[1].replace(/^\//, "");
      current = { re: globToRegExp(glob.includes("/") ? glob : glob), path: glob.includes("/"), props: {} };
      editorconfig.push(current);
      continue;
    }
    const kv = line.match(/^([\w_]+)\s*=\s*(.+)$/);
    if (kv && current) current.props[kv[1].toLowerCase()] = kv[2].trim().toLowerCase();
  }
  const rubocop = await api.readFile(`${root}/.rubocop.yml`).catch(() => "");
  const m = rubocop.match(/^Layout\/IndentationWidth:\s*\n(?:\s+#.*\n)*\s+Width:\s*(\d+)/m);
  rubocopWidth = m ? Number(m[1]) : null;
}

export function styleFor(path: string, language: string): CodeStyle {
  const lang = setting(`codeStyle.${language}.tabSize`) === undefined ? null : language;
  const style: CodeStyle = {
    tabSize: lang ? setting(`codeStyle.${lang}.tabSize`) : 2,
    insertSpaces: lang ? setting(`codeStyle.${lang}.insertSpaces`) : true,
    trimTrailingWhitespace: setting("editor.trimTrailingWhitespace") && language !== "markdown",
    insertFinalNewline: setting("editor.insertFinalNewline"),
  };
  if (setting("codeStyle.respectEditorConfig")) {
    const relPath = path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
    for (const s of editorconfig) {
      if (!s.re.test(s.path ? relPath : basename(path))) continue;
      const p = s.props;
      if (p.indent_style) style.insertSpaces = p.indent_style !== "tab";
      const size = Number(p.indent_size === "tab" ? p.tab_width : p.indent_size);
      if (size > 0) style.tabSize = size;
      if (p.trim_trailing_whitespace) style.trimTrailingWhitespace = p.trim_trailing_whitespace === "true";
      if (p.insert_final_newline) style.insertFinalNewline = p.insert_final_newline === "true";
    }
  }
  if (language === "ruby" && rubocopWidth && setting("codeStyle.respectRubocop")) style.tabSize = rubocopWidth;
  return style;
}
