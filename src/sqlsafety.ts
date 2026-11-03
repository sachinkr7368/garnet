export type Dialect = "postgres" | "mysql" | "sqlite";
export type TokenType = "word" | "number" | "string" | "ident" | "comment" | "ws" | "punct";

export interface Token {
  type: TokenType;
  text: string;
  start: number;
  end: number;
}

const DOLLAR = /\$([A-Za-z_]\w*)?\$/y;
const WORD_START = /[\p{L}_]/u;
const WORD_PART = /[\p{L}\p{N}_$]/u;

/// How the server might read the text: backslash escapes in strings (MySQL default; Postgres with
/// standard_conforming_strings off) and whether version-gated MySQL comments (`/*!50700 … */`, MariaDB `/*M! … */`) run.
export interface Reading {
  backslash: boolean;
  gated: boolean;
}

const defaultReading = (d: Dialect): Reading => ({ backslash: d === "mysql", gated: true });

/// Every reading the safety checks must pass under; mirrors `check_single` in src-tauri/src/db/sql.rs.
export const readings = (d: Dialect): Reading[] =>
  d === "sqlite" ? [defaultReading(d)] : d === "postgres" ? [false, true].map((backslash) => ({ backslash, gated: true })) : [true, false].flatMap((backslash) => [true, false].map((gated) => ({ backslash, gated })));

const EXEC_COMMENT = /\/\*(M!|!)(\d*)/y;

/// End of a MySQL executable-comment opener at `i`, or -1. `/*!` always runs; `/*!NNNNN` and `/*M!` only when `gated`.
function execOpener(sql: string, i: number, gated: boolean): number {
  EXEC_COMMENT.lastIndex = i;
  const m = EXEC_COMMENT.exec(sql);
  if (!m) return -1;
  return m[1] === "!" && !m[2] ? EXEC_COMMENT.lastIndex : gated ? EXEC_COMMENT.lastIndex : -1;
}

export function tokenize(sql: string, dialect: Dialect = "postgres", reading: Reading = defaultReading(dialect)): Token[] {
  const out: Token[] = [];
  const n = sql.length;
  let i = 0;
  let exec = false;
  const push = (type: TokenType, end: number) => {
    out.push({ type, text: sql.slice(i, end), start: i, end });
    i = end;
  };
  const quoted = (q: string, from: number, backslash: boolean) => {
    let j = from;
    while (j < n) {
      if (backslash && sql[j] === "\\") j += 2;
      else if (sql[j] === q) {
        if (sql[j + 1] !== q) return j + 1;
        j += 2;
      } else j++;
    }
    return n;
  };
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (/\s/.test(c)) {
      let j = i + 1;
      while (j < n && /\s/.test(sql[j])) j++;
      push("ws", j);
    } else if ((c === "-" && d === "-" && (dialect !== "mysql" || i + 2 >= n || /[\s\x00-\x1f]/.test(sql[i + 2]))) || (c === "#" && dialect === "mysql")) {
      // MySQL needs whitespace or a control character after `--`; `1--1` is 1 - -1.
      const j = sql.indexOf("\n", i);
      push("comment", j < 0 ? n : j);
    } else if (exec && c === "*" && d === "/") {
      exec = false;
      push("comment", i + 2);
    } else if (dialect === "mysql" && !exec && c === "/" && d === "*" && execOpener(sql, i, reading.gated) > 0) {
      // The server runs the body of an executable comment as SQL: only the opener and closer are comments.
      exec = true;
      push("comment", execOpener(sql, i, reading.gated));
    } else if (c === "/" && d === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth) {
        if (sql.startsWith("*/", j)) (depth--, (j += 2));
        else if (dialect !== "mysql" && sql.startsWith("/*", j)) (depth++, (j += 2));
        else j++;
      }
      push("comment", j);
    } else if (c === "'") push("string", quoted("'", i + 1, reading.backslash));
    else if (c === '"') push(dialect === "mysql" ? "string" : "ident", quoted('"', i + 1, dialect === "mysql" && reading.backslash));
    else if (c === "`") push("ident", quoted("`", i + 1, false));
    else if (c === "[" && dialect === "sqlite") {
      const j = sql.indexOf("]", i);
      push("ident", j < 0 ? n : j + 1);
    } else if (c === "$" && dialect !== "mysql" && ((DOLLAR.lastIndex = i), DOLLAR.test(sql))) {
      const tag = sql.slice(i, DOLLAR.lastIndex);
      const j = sql.indexOf(tag, DOLLAR.lastIndex);
      push("string", j < 0 ? n : j + tag.length);
    } else if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < n && WORD_PART.test(sql[j])) j++;
      if (dialect === "postgres" && j === i + 1 && (c === "e" || c === "E") && sql[j] === "'") push("string", quoted("'", j + 1, true));
      else push("word", j);
    } else if (/\d/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(sql[j])) j++;
      push("number", j);
    } else push("punct", i + 1);
  }
  return out;
}

export interface Statement {
  text: string;
  start: number;
  end: number;
  segStart: number;
  segEnd: number;
}

/// Statements separated by top-level semicolons; comment-only pieces are dropped.
export function splitStatements(sql: string, dialect: Dialect = "postgres", reading: Reading = defaultReading(dialect)): Statement[] {
  const out: Statement[] = [];
  let first = -1;
  let last = -1;
  let sig = false;
  let segStart = 0;
  const flush = (segEnd: number) => {
    if (sig) out.push({ text: sql.slice(first, last), start: first, end: last, segStart, segEnd });
    first = last = -1;
    sig = false;
    segStart = segEnd;
  };
  for (const t of tokenize(sql, dialect, reading)) {
    if (t.type === "punct" && t.text === ";") {
      flush(t.end);
      continue;
    }
    if (t.type === "ws") continue;
    if (t.type !== "comment") sig = true;
    if (first < 0) first = t.start;
    last = t.end;
  }
  flush(sql.length);
  return out;
}

/// The statement the caret is in; a caret right after `;` belongs to the statement it ends.
export function statementAt(sql: string, offset: number, dialect: Dialect = "postgres"): Statement | null {
  const all = splitStatements(sql, dialect);
  return all.find((s) => offset >= s.segStart && offset <= s.segEnd) ?? all.filter((s) => s.end <= offset).pop() ?? all[0] ?? null;
}

export type Kind = "read" | "write" | "ddl" | "tx" | "other";

export interface Classification {
  kind: Kind;
  dangerous: boolean;
  reason?: string;
}

interface Sig {
  t: Token;
  up: string;
  depth: number;
}

/// Statements in the text under the reading that sees the most; the safety checks need exactly one.
export const statementCount = (sql: string, dialect: Dialect = "postgres") => Math.max(...readings(dialect).map((r) => splitStatements(sql, dialect, r).length));

function significant(sql: string, dialect: Dialect, reading: Reading = defaultReading(dialect)): Sig[] {
  const out: Sig[] = [];
  let depth = 0;
  for (const t of tokenize(sql, dialect, reading)) {
    if (t.type === "ws" || t.type === "comment") continue;
    const up = t.type === "word" ? t.text.toUpperCase() : t.type === "punct" ? t.text : "";
    if (up === ")") depth = Math.max(0, depth - 1);
    out.push({ t, up, depth });
    if (up === "(") depth++;
  }
  return out;
}

const READ = new Set(["SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "VALUES", "TABLE", "WITH", "PRAGMA"]);
const WRITE = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE", "UPSERT", "COPY", "LOAD"]);
const DDL = new Set(["CREATE", "DROP", "ALTER", "TRUNCATE", "RENAME", "COMMENT", "GRANT", "REVOKE"]);
const TX = new Set(["BEGIN", "START", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "END", "ABORT"]);
const MAIN = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "VALUES", "TABLE"]);
const EXPLAINED = new Set([...MAIN, "WITH", "REPLACE", "CREATE", "EXECUTE"]);
/// Server-side code whose effect can't be read from the text. Mirrors `destructive` in src-tauri/src/db/sql.rs.
const OPAQUE = new Set(["DO", "CALL", "EXECUTE", "PREPARE"]);
const MODIFYING = new Set(["INSERT", "UPDATE", "DELETE", "MERGE"]);

/// First statement keyword after leading comments/parens, and for WITH the keyword of the main statement.
function head(toks: Sig[]): { first: number; main: number; base: number } | null {
  const first = toks.findIndex((x) => x.t.type === "word");
  if (first < 0) return null;
  const base = toks[first].depth;
  if (toks[first].up !== "WITH") return { first, main: first, base };
  const main = toks.findIndex((x, k) => k > first && x.depth === base && MAIN.has(x.up));
  return main < 0 ? null : { first, main, base };
}

function locks(toks: Sig[], from: number, base: number): boolean {
  for (let k = from; k < toks.length; k++) {
    const x = toks[k];
    if (x.depth !== base) continue;
    if (x.up === "INTO") return true;
    if (x.up === "FOR" && ["UPDATE", "SHARE", "NO", "KEY"].includes(toks[k + 1]?.up)) return true;
    if (x.up === "LOCK" && toks[k + 1]?.up === "IN") return true;
  }
  return false;
}

const worst = (kinds: Kind[]): Kind => (["ddl", "write", "tx", "other"] as Kind[]).find((k) => kinds.includes(k)) ?? "read";

/// Classified under every reading (see `readings`); the worst kind wins and any dangerous reading makes it dangerous.
export function classify(sql: string, dialect: Dialect = "postgres"): Classification {
  const all = readings(dialect).map((r) => classifyAs(sql, dialect, r));
  const danger = all.find((c) => c.dangerous);
  return { kind: worst(all.map((c) => c.kind)), dangerous: !!danger, ...(danger?.reason ? { reason: danger.reason } : {}) };
}

function classifyAs(sql: string, dialect: Dialect, reading: Reading): Classification {
  // Drivers run every statement in a multi-statement string (Postgres simple query, MySQL text protocol),
  // so one string with several statements is never treated as a single read.
  const parts = splitStatements(sql, dialect, reading);
  if (parts.length > 1) {
    const kind = worst(parts.map((p) => classifyAs(p.text, dialect, reading).kind));
    return { kind, dangerous: true, reason: `${parts.length} statements in one string` };
  }
  const toks = significant(sql, dialect, reading);
  const hd = head(toks);
  if (!hd) return { kind: "other", dangerous: false };
  const first = toks[hd.first].up;
  const kw = toks[hd.main].up;
  if (first === "EXPLAIN" || first === "DESCRIBE" || first === "DESC") {
    const i = toks.findIndex((x, k) => k > hd.first && x.depth === hd.base && EXPLAINED.has(x.up));
    if (i < 0) return { kind: "read", dangerous: false };
    const inner = classifyAs(sql.slice(toks[i].t.start), dialect, reading);
    const analyze = toks.slice(hd.first + 1, i).some((x) => x.up === "ANALYZE" || x.up === "ANALYSE");
    return analyze && inner.kind !== "read" ? inner : { kind: "read", dangerous: false };
  }
  let kind: Kind = READ.has(kw) ? "read" : WRITE.has(kw) ? "write" : DDL.has(kw) ? "ddl" : TX.has(kw) ? "tx" : "other";
  if (kw === "PRAGMA" && toks.some((x) => x.up === "=")) kind = "write";
  if (kw === "SELECT" && locks(toks, hd.main + 1, hd.base)) kind = "write";
  if (first === "WITH" && toks.some((x) => x.depth > hd.base && MODIFYING.has(x.up))) kind = "write";
  if (toks.some((x, k) => x.up === "LOAD_FILE" && toks[k + 1]?.up === "(")) kind = "write";
  if (kw === "DROP" || kw === "TRUNCATE" || kw === "ALTER") return { kind, dangerous: true, reason: `${kw} statement` };
  if (OPAQUE.has(kw)) return { kind, dangerous: true, reason: `${kw} statement` };
  if (kw === "COPY" && toks.some((x) => x.up === "PROGRAM")) return { kind, dangerous: true, reason: "COPY … PROGRAM runs a server-side command" };
  if (kind === "write") {
    for (let k = 0; k < toks.length; k++) {
      const x = toks[k];
      if ((x.up !== "UPDATE" && x.up !== "DELETE") || ["FOR", "ON", "KEY", "DO", "NO"].includes(toks[k - 1]?.up)) continue;
      let where = false;
      for (let j = k + 1; j < toks.length && toks[j].depth >= x.depth; j++) if (toks[j].depth === x.depth && toks[j].up === "WHERE") where = true;
      if (!where) return { kind, dangerous: true, reason: `${x.up} without a WHERE clause` };
    }
  }
  return { kind, dangerous: false };
}

/// Appends ` LIMIT rows` to a SELECT (or WITH … SELECT) that has no top-level LIMIT / FETCH / TOP.
export function withAutoLimit(sql: string, rows: number, dialect: Dialect = "postgres"): string {
  if (classify(sql, dialect).kind !== "read") return sql;
  const toks = significant(sql, dialect);
  const hd = head(toks);
  if (!hd || toks[hd.main].up !== "SELECT") return sql;
  if (toks.some((x) => x.depth <= hd.base && (x.up === "LIMIT" || x.up === "FETCH" || x.up === "TOP"))) return sql;
  let last = toks.length - 1;
  if (toks[last].up === ";") last--;
  const at = toks[last].t.end;
  return `${sql.slice(0, at)} LIMIT ${rows}${sql.slice(at)}`;
}

export function isLocalHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return ["", "localhost", "127.0.0.1", "::1", "[::1]"].includes(h) || h.startsWith("/");
}

export const envSegment = (env: string) => env.split("/")[0].trim().toLowerCase();

/// Read-only unless it is a development environment on this machine; `host` null means unknown.
export function defaultReadOnly(env: string | undefined, engine: Dialect | null, host: string | null): boolean {
  if (env !== undefined && envSegment(env) !== "development") return true;
  if (engine === "sqlite") return false;
  return host === null || !isLocalHost(host);
}

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/// NULL is an empty field and an empty string is `""`; text a spreadsheet would run as a formula gets a leading `'`.
function csvField(v: string | null): string {
  if (v === null) return "";
  const safe = /^[=+\-@\t\r]/.test(v) && !NUMBER.test(v) ? `'${v}` : v;
  return safe === "" || /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const csvLine = (row: (string | null)[]) => row.map(csvField).join(",");

export function toCsv(columns: string[], rows: (string | null)[][]): string {
  return [columns, ...rows].map(csvLine).join("\r\n") + "\r\n";
}

export function toJson(columns: string[], rows: (string | null)[][]): string {
  const used = new Set<string>();
  const keys = columns.map((c) => {
    let k = c;
    for (let n = 2; used.has(k); n++) k = `${c}_${n}`;
    used.add(k);
    return k;
  });
  return JSON.stringify(rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? null]))), null, 2);
}

const quoteIdent = (d: Dialect, name: string) => (d === "mysql" ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`);

/// A SQL string literal that reads the same whatever the server's escaping settings are: Postgres dollar quoting with
/// a tag not in the value; MySQL a hex string in utf8mb4 (no quote or backslash to misread); SQLite plain quotes.
export function sqlLiteral(v: string | null, d: Dialect): string {
  if (v === null) return "NULL";
  if (d === "sqlite") return `'${v.replace(/'/g, "''")}'`;
  if (d === "mysql") return v === "" ? "''" : `_utf8mb4 X'${[...new TextEncoder().encode(v)].map((b) => b.toString(16).padStart(2, "0")).join("")}'`;
  let tag = "$g$";
  for (let n = 0; (v + tag).indexOf(tag) !== v.length; n++) tag = `$g${n}$`;
  return `${tag}${v}${tag}`;
}

export function toSqlInsert(table: string, columns: string[], rows: (string | null)[][], d: Dialect): string {
  const cols = columns.map((c) => quoteIdent(d, c)).join(", ");
  return rows.map((r) => `INSERT INTO ${quoteIdent(d, table)} (${cols}) VALUES (${r.map((v) => sqlLiteral(v, d)).join(", ")});`).join("\n") + "\n";
}

export function toMarkdown(columns: string[], rows: (string | null)[][]): string {
  const cell = (v: string | null) => (v === null ? "NULL" : v.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>"));
  const line = (r: (string | null)[]) => `| ${r.map(cell).join(" | ")} |`;
  return [line(columns), `|${columns.map(() => " --- |").join("")}`, ...rows.map(line)].join("\n") + "\n";
}
