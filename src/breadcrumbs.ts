export interface Range {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface SymbolNode {
  name: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: SymbolNode[];
}

const contains = (r: Range, line: number, column: number) =>
  (line > r.startLineNumber || (line === r.startLineNumber && column >= r.startColumn)) &&
  (line < r.endLineNumber || (line === r.endLineNumber && column <= r.endColumn));

/// Chain of symbols enclosing a position, outermost first (innermost wins when siblings overlap).
export function symbolPath<T extends SymbolNode>(symbols: T[], line: number, column: number): T[] {
  const path: T[] = [];
  let level: T[] = symbols;
  for (;;) {
    const hits = level.filter((s) => contains(s.range, line, column));
    if (!hits.length) return path;
    const inner = hits.reduce((a, b) => (b.range.startLineNumber >= a.range.startLineNumber ? b : a));
    path.push(inner);
    level = (inner.children ?? []) as T[];
  }
}
