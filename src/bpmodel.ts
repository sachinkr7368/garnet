// Pure breakpoint model: persistence format, line tracking and pass counts.

export interface Breakpoint {
  line: number;
  enabled: boolean;
  /// Ruby expression; rdbg pauses only when it is truthy.
  condition?: string;
  /// Logpoint template (`{expr}` interpolated); Garnet logs and resumes instead of pausing.
  logMessage?: string;
  /// Pass count: pause only from the Nth hit on (JetBrains "Pass count"); counted per debug session.
  hitCount?: number;
  /// Monaco decoration that tracks this line while the file is open (runtime only).
  decorationId?: string;
  /// Stable identity across line shifts (runtime only): pass counts are kept per id.
  id?: number;
}

let lastId = 0;
export const newBreakpointId = () => ++lastId;

export type BreakpointMap = Map<string, Breakpoint[]>;

type Stored = Pick<Breakpoint, "line" | "enabled" | "condition" | "logMessage" | "hitCount">;

/// Persisted shape: project-relative path → breakpoints, sorted by line.
export function serialize(map: BreakpointMap, rel: (p: string) => string): Record<string, Stored[]> {
  const out: Record<string, Stored[]> = {};
  for (const [path, bps] of [...map].sort(([a], [b]) => a.localeCompare(b))) {
    if (!bps.length) continue;
    out[rel(path)] = [...bps]
      .sort((a, b) => a.line - b.line)
      .map(({ line, enabled, condition, logMessage, hitCount }) => ({ line, enabled, ...(condition ? { condition } : {}), ...(logMessage ? { logMessage } : {}), ...(hitCount ? { hitCount } : {}) }));
  }
  return out;
}

/// Reads the persisted shape back, skipping anything malformed.
export function deserialize(raw: unknown, abs: (p: string) => string): BreakpointMap {
  const map: BreakpointMap = new Map();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return map;
  for (const [path, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const bps: Breakpoint[] = [];
    for (const b of list) {
      if (!b || typeof b !== "object") continue;
      const { line, enabled, condition, logMessage, hitCount } = b as Record<string, unknown>;
      if (typeof line !== "number" || !Number.isInteger(line) || line < 1 || bps.some((x) => x.line === line)) continue;
      bps.push({
        id: newBreakpointId(),
        line,
        enabled: enabled !== false,
        ...(typeof condition === "string" && condition ? { condition } : {}),
        ...(typeof logMessage === "string" && logMessage ? { logMessage } : {}),
        ...(typeof hitCount === "number" && Number.isInteger(hitCount) && hitCount > 1 ? { hitCount } : {}),
      });
    }
    if (bps.length) map.set(abs(path), bps);
  }
  return map;
}

/// Applies tracked line numbers (null = the line was deleted) and drops breakpoints that collapsed onto
/// a line that already has one. Returns whether anything changed.
export function trackLines(bps: Breakpoint[], lines: (number | null)[]): { bps: Breakpoint[]; changed: boolean } {
  const seen = new Set<number>();
  const out: Breakpoint[] = [];
  let changed = false;
  bps.forEach((bp, i) => {
    const line = lines[i] ?? null;
    if (line === null || seen.has(line)) {
      changed = true;
      return;
    }
    seen.add(line);
    if (line !== bp.line) changed = true;
    out.push(line === bp.line ? bp : { ...bp, line });
  });
  return { bps: out, changed };
}

/// DAP `setBreakpoints` entries for a file: enabled breakpoints only.
export const dapBreakpoints = (bps: Breakpoint[]) => bps.filter((b) => b.enabled).map((b) => ({ line: b.line, ...(b.condition ? { condition: b.condition } : {}) }));

/// Whether a stop at a breakpoint that has now been hit `hits` times (including this one) should pause.
export const passCountReached = (bp: Breakpoint, hits: number) => !bp.hitCount || hits >= bp.hitCount;

/// Fills `{expr}` placeholders of a logpoint template with evaluated values.
export async function interpolate(template: string, evaluate: (expr: string) => Promise<string>): Promise<string> {
  let text = template;
  for (const m of [...template.matchAll(/\{([^}]+)\}/g)]) {
    const value = await evaluate(m[1]).catch(() => "?");
    text = text.replace(m[0], () => value);
  }
  return text;
}

export const describe = (bp: Breakpoint) =>
  [bp.logMessage ? `log: ${bp.logMessage}` : "", bp.condition ? `if ${bp.condition}` : "", bp.hitCount ? `pass count ${bp.hitCount}` : "", bp.enabled ? "" : "disabled"].filter(Boolean).join(" · ");

export interface GutterPress {
  line: number;
  x: number;
  y: number;
  left: boolean;
  modifiers: boolean;
  clicks: number;
}

/// A line-number click toggles a breakpoint only as a plain single left click that ends on the same line without dragging.
export const isBreakpointClick = (down: GutterPress | null, up: { line?: number; x: number; y: number }) =>
  !!down && down.left && !down.modifiers && down.clicks === 1 && up.line === down.line && Math.abs(up.x - down.x) < 4 && Math.abs(up.y - down.y) < 4;
