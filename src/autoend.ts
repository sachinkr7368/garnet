const OPENER = /^\s*(?:[\w@$.[\]:]+\s*(?:\|\||&&|\+|-)?=\s*)?(def|class|module|if|unless|case|while|until|for|begin)\b/;
const DO_BLOCK = /\bdo(\s*\|[^|]*\|)?\s*$/;
const ENDLESS_DEF = /^\s*def\s+[\w.?!]+(\([^)]*\))?\s*=[^=~]/;
const CONTINUES = /^(end|else|elsif|when|in|rescue|ensure)\b/;
const indentOf = (line: string) => line.match(/^\s*/)![0];

/// RubyMine's automatic `end`: after Enter on a line opening a block (def, class, module, if, unless, case, while,
/// until, for, begin, do), the `end` line to add below the new line, or null when the block is already closed or has
/// a body. `lines` is the buffer after the Enter; `line` is the new (1-based) line the caret is on.
export function autoEndText(lines: string[], line: number): string | null {
  const prev = lines[line - 2];
  if (prev === undefined || /^\s*#/.test(prev) || insideHeredoc(lines, line)) return null;
  const code = prev.replace(/\s+#[^{]*$/, "");
  const opens = (OPENER.test(code) && !ENDLESS_DEF.test(code)) || DO_BLOCK.test(code);
  if (!opens || /(^|;|\s)end\s*$/.test(code)) return null;
  const indent = indentOf(prev);
  const next = lines.slice(line).find((l) => l.trim());
  if (next !== undefined) {
    const nextIndent = indentOf(next).length;
    if (nextIndent > indent.length) return null;
    if (nextIndent === indent.length && CONTINUES.test(next.trim())) return null;
  }
  return `\n${indent}end`;
}

const HEREDOC = /<<([~-]?)(["'`]?)([A-Za-z_]\w*)\2/g;

/// Whether (1-based) `line` is in the body of a heredoc opened on an earlier line and not yet terminated.
export function insideHeredoc(lines: string[], line: number): boolean {
  let open: { id: string; squiggly: boolean }[] = [];
  for (let i = 0; i < line - 1; i++) {
    const l = lines[i];
    if (open.length) {
      if ((open[0].squiggly ? l.trim() : l) === open[0].id) open.shift();
      continue;
    }
    if (/^\s*#/.test(l)) continue;
    open = [...l.matchAll(HEREDOC)].map((m) => ({ id: m[3], squiggly: !!m[1] }));
  }
  return open.length > 0;
}
