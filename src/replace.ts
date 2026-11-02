export interface LineMatch {
  line: number;
  text: string;
  ranges: [number, number][];
  replacements?: string[];
}

export interface ReplaceEdit {
  line: number;
  start: number;
  end: number;
  old: string;
  new: string;
}

export type Segment = { kind: "plain"; text: string } | { kind: "match"; index: number; old: string; new: string | null };

export const matchKey = (line: number, index: number) => `${line}:${index}`;

/// Splits a result line into plain text and matches (with their replacement when replacing).
export function segments(m: LineMatch): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  m.ranges.forEach(([s, e], index) => {
    if (s > last) out.push({ kind: "plain", text: m.text.slice(last, s) });
    out.push({ kind: "match", index, old: m.text.slice(s, e), new: m.replacements?.[index] ?? null });
    last = Math.max(last, e);
  });
  if (last < m.text.length) out.push({ kind: "plain", text: m.text.slice(last) });
  return out;
}

/// The line as it reads after replacing every match not in `excluded`.
export function previewLine(m: LineMatch, excluded: ReadonlySet<string> = new Set()): string {
  return segments(m)
    .map((s) => (s.kind === "plain" ? s.text : s.new === null || excluded.has(matchKey(m.line, s.index)) ? s.old : s.new))
    .join("");
}

/// Edits for one file; `excluded` null means every match.
export function editsFor(matches: LineMatch[], excluded: ReadonlySet<string> | null): ReplaceEdit[] {
  return matches.flatMap((m) =>
    m.ranges.flatMap(([start, end], i) => {
      const replacement = m.replacements?.[i];
      if (replacement === undefined || excluded?.has(matchKey(m.line, i))) return [];
      return [{ line: m.line, start, end, old: m.text.slice(start, end), new: replacement }];
    }),
  );
}
