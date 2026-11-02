import { monacoTheme, type Theme } from "./theme";

export interface TokenRule {
  token: string;
  foreground?: string;
  fontStyle?: string;
}

export type ThemeKind = Theme;

/// Token types and modifiers in the LSP semantic token legend (ruby-lsp emits namespace, type, class,
/// parameter, variable[.defaultLibrary] and method).
const SEMANTIC_TYPES = new Set(["namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property", "enumMember", "event", "function", "method", "macro", "decorator"]);

/// Semantic token rules per theme, taken from the theme palette (src/theme.ts) so they share its contrast checks.
export const SEMANTIC_RULES: Record<ThemeKind, TokenRule[]> = {
  dark: semanticRules("dark"),
  light: semanticRules("light"),
};

function semanticRules(t: Theme): TokenRule[] {
  return monacoTheme(t).rules.filter((r) => SEMANTIC_TYPES.has(r.token.split(".")[0]));
}

export interface Legend {
  tokenTypes: string[];
  tokenModifiers: string[];
}

export interface DecodedToken {
  line: number;
  character: number;
  length: number;
  type: string;
  modifiers: string[];
}

/// Decodes the LSP relative token encoding (5 integers per token) into absolute positions.
export function decodeTokens(data: ArrayLike<number>, legend: Legend): DecodedToken[] {
  const out: DecodedToken[] = [];
  let line = 0;
  let character = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    line += data[i];
    character = data[i] === 0 ? character + data[i + 1] : data[i + 1];
    const mods = data[i + 4];
    out.push({
      line,
      character,
      length: data[i + 2],
      type: legend.tokenTypes[data[i + 3]] ?? "",
      modifiers: legend.tokenModifiers.filter((_, bit) => mods & (1 << bit)),
    });
  }
  return out;
}

/// The rule Monaco picks for a token: the longest `type.modifier…` prefix with a rule.
export function ruleFor(type: string, modifiers: string[], rules: TokenRule[]): TokenRule | undefined {
  const parts = [type, ...modifiers];
  for (let n = parts.length; n > 0; n--) {
    const key = parts.slice(0, n).join(".");
    const hit = rules.find((r) => r.token === key);
    if (hit) return hit;
  }
  return undefined;
}

/// Applies LSP `semanticTokens/full/delta` edits to the previous data array.
export function applyTokenEdits(prev: number[], edits: { start: number; deleteCount: number; data?: number[] }[]): number[] {
  const next = [...prev];
  for (const e of [...edits].sort((a, b) => b.start - a.start)) next.splice(e.start, e.deleteCount, ...(e.data ?? []));
  return next;
}
