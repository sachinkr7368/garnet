export interface TokenRule {
  token: string;
  foreground?: string;
  fontStyle?: string;
}

export type ThemeKind = "dark" | "light";

/// Colors for ruby-lsp semantic token types (and modifiers as `type.modifier`), per theme kind.
/// Every type ruby-lsp emits has a rule so no token falls back to the plain foreground.
export const SEMANTIC_RULES: Record<ThemeKind, TokenRule[]> = {
  dark: [
    { token: "namespace", foreground: "c792ea" },
    { token: "class", foreground: "c792ea" },
    { token: "type", foreground: "6fb3d2" },
    { token: "method", foreground: "e3c98a" },
    { token: "function", foreground: "e3c98a" },
    { token: "parameter", foreground: "d9a46f" },
    { token: "variable", foreground: "d6d6dc" },
    { token: "variable.defaultLibrary", foreground: "e0876a" },
    { token: "property", foreground: "9cc3e6" },
    { token: "enumMember", foreground: "c792ea" },
  ],
  light: [
    { token: "namespace", foreground: "7a3e9d" },
    { token: "class", foreground: "7a3e9d" },
    { token: "type", foreground: "2f6fc4" },
    { token: "method", foreground: "795e26" },
    { token: "function", foreground: "795e26" },
    { token: "parameter", foreground: "9c5d27" },
    { token: "variable", foreground: "24242a" },
    { token: "variable.defaultLibrary", foreground: "a8323e" },
    { token: "property", foreground: "1f5f99" },
    { token: "enumMember", foreground: "7a3e9d" },
  ],
};

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
