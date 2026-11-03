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
  if (prev === undefined || /^\s*#/.test(prev)) return null;
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
