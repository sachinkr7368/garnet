import "./db.css";
import { ask } from "@tauri-apps/plugin-dialog";
import { commands } from "./commands";
import { activate as activateEditorTab, activeTab as activeFileTab, activeViewTab, closeTab as closeEditorTab, findViewTab, monaco, openViewTab, retitleViewTab } from "./editor";
import { api, invoke } from "./ipc";
import { setting } from "./settings";
import { classify, defaultReadOnly, envSegment, isLocalHost, csvLine, splitStatements, statementAt, statementCount, toCsv, toJson, toMarkdown, toSqlInsert, withAutoLimit, type Dialect, type Kind } from "./sqlsafety";
import { pluralize, underscore } from "./inflect";
import { state } from "./state";
import { contextMenu, h, icon, iconButton, modal, quickPick, rightbar, toast, trackDrag, withOverflow, type MenuItem } from "./ui";

export type Color = "none" | "red" | "orange" | "yellow" | "green" | "blue" | "purple";
export const COLORS: Color[] = ["none", "red", "orange", "yellow", "green", "blue", "purple"];
type SslMode = "prefer" | "disable" | "require";

export interface Detected {
  environment: string;
  engine: Dialect | null;
  adapter: string;
  host: string;
  port: number | null;
  database: string;
  username: string;
  password: string | null;
  unresolved: string[];
}

export interface ConnFields {
  engine: Dialect | null;
  host: string;
  port: number | null;
  database: string;
  username: string;
  sslmode: SslMode;
}
const FIELDS = ["engine", "host", "port", "database", "username", "sslmode"] as const;

export interface ManualConn extends ConnFields {
  id: string;
  name: string;
  readOnly: boolean;
  color: Color;
}

export interface Override {
  name?: string;
  readOnly?: boolean;
  color?: Color;
  fields?: Partial<ConnFields>;
}

export interface ProjectStore {
  manual: ManualConn[];
  overrides: Record<string, Override>;
  /// The "Database detected" notification was answered (Add or Ignore).
  noticed?: boolean;
}

export interface Conn extends ConnFields {
  id: string;
  name: string;
  source: "detected" | "manual";
  environment?: string;
  readOnly: boolean;
  color: Color;
  unresolved: string[];
  ymlPassword?: string;
}

export interface QueryResult {
  columns: string[];
  rows: (string | null)[][];
  rowsAffected: number | null;
  truncated: boolean;
  elapsedMs: number;
}

interface Column {
  name: string;
  dataType: string;
  nullable: boolean;
  default: string | null;
  primaryKey: boolean;
}
export interface TableInfo {
  name: string;
  kind: "table" | "view";
  columns: Column[];
  indexes: { name: string; columns: string[]; unique: boolean }[];
  foreignKeys: { name: string; columns: string[]; refSchema: string; refTable: string; refColumns: string[] }[];
}
export interface Schema {
  schemas: { name: string; tables: TableInfo[] }[];
}

const STORE = "db-connections.json";
const HISTORY = "db-history.json";
const PAGE = 100;
const MAX_ROWS = 5000;
const SQL_SCHEME = "garnet-sql";

/// database.yml keys → editable fields; an unresolved url hides every part of it.
const UNRESOLVED_MAP: Record<string, string[]> = { adapter: ["engine"], user: ["username"], url: ["host", "port", "database", "username", "password"] };
export const unresolvedFields = (list: string[]) =>
  [...new Set(list.flatMap((f) => UNRESOLVED_MAP[f] ?? [f]))].filter((f) => f === "password" || (FIELDS as readonly string[]).includes(f));

const detectedFields = (d: Detected): ConnFields => ({ engine: d.engine, host: d.host, port: d.port, database: d.database, username: d.username, sslmode: "prefer" });
const defaultColor = (env: string): Color => (envSegment(env) === "production" ? "red" : "none");

export function mergeConnections(root: string, detected: Detected[], store: ProjectStore): Conn[] {
  const fromYml = detected.map((d): Conn => {
    const o = store.overrides[d.environment] ?? {};
    const f: ConnFields = { ...detectedFields(d), ...o.fields };
    const unresolved = unresolvedFields(d.unresolved).filter((k) => !(k in (o.fields ?? {})));
    return {
      ...f,
      id: `${root}::env::${d.environment}`,
      name: o.name ?? d.environment,
      source: "detected",
      environment: d.environment,
      readOnly: o.readOnly ?? defaultReadOnly(d.environment, f.engine, unresolved.includes("host") ? null : f.host),
      color: o.color ?? defaultColor(d.environment),
      unresolved,
      ymlPassword: unresolved.includes("password") ? undefined : (d.password ?? undefined),
    };
  });
  return [...fromYml, ...store.manual.map((m): Conn => ({ ...m, source: "manual", unresolved: [] }))];
}

/// What the edit dialog changed relative to database.yml; unresolved fields are always kept once filled in.
export function overrideFrom(d: Detected, e: ConnFields & { name: string; readOnly: boolean; color: Color }): Override {
  const base = detectedFields(d);
  const unresolved = unresolvedFields(d.unresolved);
  const fields: Partial<ConnFields> = {};
  for (const k of FIELDS) if (e[k] !== base[k] || unresolved.includes(k)) Object.assign(fields, { [k]: e[k] });
  return {
    name: e.name.trim() && e.name !== d.environment ? e.name.trim() : undefined,
    readOnly: e.readOnly !== defaultReadOnly(d.environment, e.engine, e.host) ? e.readOnly : undefined,
    color: e.color !== defaultColor(d.environment) ? e.color : undefined,
    fields,
  };
}

const isLocal = (c: ConnFields) => c.engine === "sqlite" || isLocalHost(c.host);

/// Tooltip for the READ-ONLY badge: why the connection is read-only and how to change it.
export function readOnlyReason(c: Conn): string {
  const how = "To change it: right-click › Edit Data Source… and uncheck Read-only.";
  let why: string;
  if (c.source === "manual") why = "Marked read-only when the connection was added.";
  else if (c.environment !== undefined && envSegment(c.environment) !== "development") why = `"${c.environment}" isn't a development environment, so it starts read-only.`;
  else if (c.unresolved.includes("host")) why = "The host comes from ERB/ENV in config/database.yml and couldn't be resolved, so Garnet can't tell whether it's this machine.";
  else if (c.engine !== "sqlite" && !isLocalHost(c.host)) why = `It points at ${c.host}, not this machine.`;
  else why = "You marked it read-only.";
  return `Read-only: Garnet refuses statements that write and opens the session read-only, which stops ordinary INSERT/UPDATE/DELETE/DDL. It can't stop functions with side effects that a read-only session still allows (pg_terminate_backend, dblink, advisory locks); for a shared or production database, connect as a role without those privileges.\nServer-side functions and procedures run with the connecting role's privileges, and Garnet can't see what they do: DO blocks, CALL, EXECUTE and COPY … PROGRAM always ask first, and are refused here.\n${why}\n${how}`;
}

const q = (d: Dialect, name: string) => (d === "mysql" ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`);

/// Approximate DDL rebuilt from the introspected schema (columns, primary key, indexes, foreign keys).
export function tableDdl(d: Dialect, schema: string, t: TableInfo): string {
  const name = d === "sqlite" ? q(d, t.name) : `${q(d, schema)}.${q(d, t.name)}`;
  if (t.kind === "view") return `-- ${t.name} is a view; its definition isn't introspected.\n-- Columns: ${t.columns.map((c) => `${c.name} ${c.dataType}`).join(", ")}\n`;
  const pk = t.columns.filter((c) => c.primaryKey).map((c) => q(d, c.name));
  const lines = [
    ...t.columns.map((c) => `  ${q(d, c.name)} ${c.dataType}${c.nullable ? "" : " NOT NULL"}${c.default !== null ? ` DEFAULT ${c.default}` : ""}`),
    ...(pk.length ? [`  PRIMARY KEY (${pk.join(", ")})`] : []),
    ...t.foreignKeys.map(
      (f) =>
        `  CONSTRAINT ${q(d, f.name)} FOREIGN KEY (${f.columns.map((c) => q(d, c)).join(", ")}) REFERENCES ${f.refSchema && d !== "sqlite" ? `${q(d, f.refSchema)}.` : ""}${q(d, f.refTable)} (${f.refColumns.map((c) => q(d, c)).join(", ")})`,
    ),
  ];
  const indexes = t.indexes.map((i) => `CREATE ${i.unique ? "UNIQUE " : ""}INDEX ${q(d, i.name)} ON ${name} (${i.columns.map((c) => q(d, c)).join(", ")});`);
  return [`CREATE TABLE ${name} (`, lines.join(",\n"), ");", ...(indexes.length ? ["", ...indexes] : [])].join("\n") + "\n";
}

/// Plain EXPLAIN (never ANALYZE, so nothing executes) for a single read statement; null when not cheap or not a read.
export function explainSql(sql: string, d: Dialect): string | null {
  const parts = splitStatements(sql, d);
  if (parts.length !== 1) return null;
  const text = parts[0].text;
  if (classify(text, d).kind !== "read" || /^\s*explain\b/i.test(text)) return null;
  return d === "sqlite" ? `EXPLAIN QUERY PLAN ${text}` : `EXPLAIN ${text}`;
}
const dialect = (c: Conn): Dialect => c.engine ?? "postgres";
const KIND_LABEL: Record<Kind, string> = { read: "read", write: "data-modifying", ddl: "schema-changing (DDL)", tx: "transaction control", other: "non-read" };

/// For the smoke script (src/smoke.ts): answers the dangerous-statement confirmation instead of the native dialog.
export const dbSmokeHooks: { ask?: typeof ask } = {};

/// For vitest only: drive the module's internals without the tree UI.
export const dbTesting = {
  ensureLoaded: () => ensureLoaded(),
  openConsole: (id: string) => openConsole(id),
  updateConn: (id: string, patch: { readOnly?: boolean; color?: Color }) => updateConn(connById(id)!, patch),
  tabEls: () => tabs.map((t) => t.el),
  connect: (id: string) => connect(connById(id)!),
  isLive: (id: string) => live.has(id),
  setSchema: (id: string, schema: Schema) => live.set(id, { version: "test", schema }),
  openTable: (id: string, schema: string, table: string) => openTable(id, schema, table),
};

export interface Outcome {
  sql: string;
  result?: QueryResult;
  error?: string;
}

/// Runs statements one by one after the safety checks; nothing reaches db_query if any statement is blocked or declined.
export async function runBatch(
  conn: Conn,
  sqls: string[],
  opts: { autoLimit?: number; onResult?: (o: Outcome) => void; cancelled?: () => boolean; onQuery?: (queryId: string) => void } = {},
): Promise<{ outcomes: Outcome[]; blocked?: string }> {
  const multi = sqls.find((sql) => statementCount(sql, dialect(conn)) !== 1);
  if (multi !== undefined) return { outcomes: [], blocked: `Run one statement at a time; nothing was run. This text holds ${statementCount(multi, dialect(conn)) || "no"} statements:\n\n${multi}` };
  const checks = sqls.map((sql) => ({ sql, c: classify(sql, dialect(conn)) }));
  const confirmRun = (items: { reason?: string; sql: string }[]) =>
    (dbSmokeHooks.ask ?? ask)(`Run on "${conn.name}"?\n\n${items.map((x) => `${x.reason}:\n${x.sql}`).join("\n\n")}`, {
      title: "Dangerous Statement",
      kind: "warning",
      okLabel: "Run",
      cancelLabel: "Cancel",
    });
  const confirmed = new Set<string>();
  if (conn.readOnly) {
    const bad = checks.find((x) => x.c.kind !== "read");
    if (bad) return { outcomes: [], blocked: `"${conn.name}" is read-only, so this ${KIND_LABEL[bad.c.kind]} statement was not run:\n\n${bad.sql}` };
  } else {
    const risky = checks.filter((x) => x.c.dangerous);
    if (risky.length) {
      if (!(await confirmRun(risky.map((x) => ({ reason: x.c.reason, sql: x.sql }))))) return { outcomes: [], blocked: "Cancelled; nothing was run." };
      risky.forEach((x) => confirmed.add(x.sql));
    }
  }
  const outcomes: Outcome[] = [];
  for (const { sql, c } of checks) {
    if (opts.cancelled?.()) break;
    const text = opts.autoLimit && c.kind === "read" ? withAutoLimit(sql, opts.autoLimit, dialect(conn)) : sql;
    let o: Outcome;
    try {
      o = { sql: text, result: await dbQuery(conn, text, opts.onQuery, async (reason) => confirmed.has(sql) || (await confirmRun([{ reason, sql: text }]))) };
    } catch (e) {
      o = { sql: text, error: String(e) };
    }
    outcomes.push(o);
    opts.onResult?.(o);
    if (o.error) break;
  }
  return { outcomes };
}

/// The backend refuses a destructive statement with `CONFIRM:<token>:<reason>` (its own check, independent of
/// `classify`); it runs only when sent again with that token, which happens only after `confirm` says yes.
export const CONFIRM_ERROR = /^CONFIRM:([0-9a-f]{16}):([^\n]+)$/;

async function dbQuery(conn: Conn, sql: string, onQuery: ((id: string) => void) | undefined, confirm: (reason: string) => Promise<boolean>): Promise<QueryResult> {
  // The backend keeps one pending confirmation per query id, so the confirmed resend reuses the id.
  const queryId = crypto.randomUUID();
  const send = (token?: string) => {
    onQuery?.(queryId);
    return invoke<QueryResult>("db_query", { id: conn.id, sql, maxRows: MAX_ROWS, queryId, confirm: token });
  };
  try {
    return await send();
  } catch (e) {
    const m = typeof e === "string" ? CONFIRM_ERROR.exec(e) : null;
    if (!m) throw e;
    if (!(await confirm(m[2]))) throw new Error(`Cancelled: ${m[2]}`);
    return send(m[1]);
  }
}

export function completions(schema: Schema, qualifier?: string): { label: string; kind: "table" | "column"; detail: string }[] {
  const q = qualifier?.toLowerCase();
  const tables = schema.schemas.flatMap((s) => s.tables.map((t) => ({ s, t })));
  if (q) {
    const inSchema = schema.schemas.find((s) => s.name.toLowerCase() === q);
    if (inSchema) return inSchema.tables.map((t) => ({ label: t.name, kind: "table", detail: `${inSchema.name} ${t.kind}` }));
    const table = tables.find((x) => x.t.name.toLowerCase() === q);
    const cols = table ? [table] : tables;
    return cols.flatMap(({ t }) => t.columns.map((c) => ({ label: c.name, kind: "column" as const, detail: `${t.name}.${c.name} ${c.dataType}` })));
  }
  const seen = new Set<string>();
  return [
    ...tables.map(({ s, t }) => ({ label: t.name, kind: "table" as const, detail: `${s.name} ${t.kind}` })),
    ...tables.flatMap(({ t }) => t.columns.filter((c) => !seen.has(c.name) && seen.add(c.name)).map((c) => ({ label: c.name, kind: "column" as const, detail: `${t.name}.${c.name} ${c.dataType}` }))),
  ];
}

/// State

let loadedRoot: string | null = null;
let store: ProjectStore = { manual: [], overrides: {} };
let detected: Detected[] = [];
let detectError = "";
let detecting = false;
let conns: Conn[] = [];
let selectedId: string | null = null;
const live = new Map<string, { version: string; schema: Schema | null; schemaError?: string }>();
const connecting = new Set<string>();
const sessionPasswords = new Map<string, string>();
const expanded = new Set<string>();
const consoleModels = new Map<string, string>();
let history: Record<string, string[]> | null = null;

async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse((await api.configRead(name)) ?? "") ?? fallback;
  } catch {
    return fallback;
  }
}

async function saveStore() {
  const all = await readJson<Record<string, ProjectStore>>(STORE, {});
  all[loadedRoot!] = store;
  await api.configWrite(STORE, JSON.stringify(all, null, 2));
}

const connById = (id: string) => conns.find((c) => c.id === id);

function remerge() {
  conns = mergeConnections(loadedRoot!, detected, store);
  renderTree();
  renderTabs();
  tabs.forEach((t) => t.refresh());
}

async function ensureLoaded() {
  const root = state.project?.root;
  if (!root || root === loadedRoot) return;
  loadedRoot = root;
  const all = await readJson<Record<string, ProjectStore>>(STORE, {});
  store = { manual: [], overrides: {}, ...(all[root] as Partial<ProjectStore> | undefined) };
  await detect();
}

async function detect() {
  if (!loadedRoot) return;
  detecting = true;
  renderTree();
  try {
    detected = await invoke<Detected[]>("db_detect", { root: loadedRoot });
    detectError = "";
  } catch (e) {
    detected = [];
    detectError = String(e);
  }
  detecting = false;
  remerge();
}

/// Connections

const configOf = (c: Conn) => ({
  engine: c.engine,
  host: c.host,
  port: c.port ?? undefined,
  database: c.database,
  username: c.username,
  sslmode: c.engine === "sqlite" ? undefined : c.sslmode,
  readOnly: c.readOnly,
  root: loadedRoot ?? undefined,
});

export const isAuthFailure = (e: unknown) => /password authentication failed|Access denied for user|authentication failed|no password supplied|password is required/i.test(String(e));

async function connect(c: Conn) {
  if (live.has(c.id) || connecting.has(c.id)) return;
  const missing = c.unresolved.filter((f) => f !== "password");
  if (!c.engine || missing.length) {
    toast(`Fill in what couldn't be resolved from config/database.yml: ${(missing.length ? missing : ["engine"]).join(", ")}.`);
    return editConnection(c);
  }
  let password: string | undefined;
  if (c.engine !== "sqlite") {
    password = c.ymlPassword ?? sessionPasswords.get(c.id);
    if (password === undefined && !(await invoke<boolean>("db_password_exists", { id: c.id, config: configOf(c) }).catch(() => false))) {
      const p = await promptPassword(c);
      if (!p) return;
      password = p.password;
      if (p.keep) await invoke("db_password_set", { id: c.id, password, config: configOf(c) }).catch((e) => toast(`Keychain: ${e}`, "error"));
      else sessionPasswords.set(c.id, password);
    }
  }
  connecting.add(c.id);
  renderTree();
  let retry = false;
  try {
    const info = await invoke<{ version: string }>("db_connect", { id: c.id, config: configOf(c), password });
    live.set(c.id, { version: info.version, schema: null });
    expanded.add(c.id);
    loadSchema(c.id);
  } catch (e) {
    sessionPasswords.delete(c.id);
    // A saved (Keychain or session) password that the server rejects is asked for again; database.yml's isn't ours to replace.
    if (c.engine !== "sqlite" && c.ymlPassword === undefined && isAuthFailure(e)) {
      const p = await promptPassword(c, `${e}`.split("\n")[0], true);
      if (p) {
        if (p.keep) await invoke("db_password_set", { id: c.id, password: p.password, config: configOf(c) }).catch((err) => toast(`Keychain: ${err}`, "error"));
        else sessionPasswords.set(c.id, p.password);
        retry = true;
      }
    } else toast(`${c.name}: ${e}`, "error");
  } finally {
    connecting.delete(c.id);
    renderTree();
    tabs.forEach((t) => t.refresh());
  }
  if (retry) return connect(c);
}

async function disconnect(id: string) {
  if (!live.has(id)) return;
  live.delete(id);
  await invoke("db_disconnect", { id }).catch(() => {});
  renderTree();
  tabs.forEach((t) => t.refresh());
}

async function loadSchema(id: string) {
  const l = live.get(id);
  if (!l) return;
  l.schema = null;
  l.schemaError = undefined;
  renderTree();
  try {
    l.schema = await invoke<Schema>("db_schema", { id });
    if (l.schema.schemas.length === 1) expanded.add(`${id}|${l.schema.schemas[0].name}`);
  } catch (e) {
    l.schemaError = String(e);
  }
  renderTree();
}

async function confirmWritable(c: ConnFields & { name: string }) {
  return ask(`Make "${c.name}" writable?\n\nIt points at ${c.host || "a remote host"}, not this machine. Statements that change data or schema will run there.`, {
    title: "Writable Connection",
    kind: "warning",
    okLabel: "Make Writable",
    cancelLabel: "Keep Read-only",
  });
}

async function updateConn(c: Conn, patch: { readOnly?: boolean; color?: Color }) {
  if (c.source === "manual") Object.assign(store.manual.find((m) => m.id === c.id)!, patch);
  else Object.assign((store.overrides[c.environment!] ??= {}), patch);
  await saveStore();
  remerge();
}

async function toggleReadOnly(c: Conn) {
  if (c.readOnly && !isLocal(c) && !(await confirmWritable(c))) return;
  await updateConn(c, { readOnly: !c.readOnly });
  if (live.has(c.id)) {
    await disconnect(c.id);
    toast(`Disconnected "${c.name}"; connect again to apply the read-only change.`);
  }
}

function pickColor(c: Conn) {
  quickPick({
    placeholder: `Colour for ${c.name}`,
    items: COLORS.map((col) => ({ label: col, data: col, icon: col === c.color ? "check" : "circle-filled" })),
    onAccept: (item) => item && updateConn(c, { color: item.data as Color }),
  });
}

async function removeConn(c: Conn) {
  if (c.source !== "manual") return;
  if (!(await ask(`Remove the connection "${c.name}"?`, { title: "Remove Connection", kind: "warning", okLabel: "Remove" }))) return;
  await disconnect(c.id);
  await invoke("db_password_delete", { id: c.id }).catch(() => {});
  sessionPasswords.delete(c.id);
  store.manual = store.manual.filter((m) => m.id !== c.id);
  for (const t of tabs.filter((t) => t.connId === c.id)) closeTab(t);
  await saveStore();
  remerge();
}

const fill = (el: HTMLElement, ...children: (Node | string | null | undefined | false)[]) => el.replaceChildren(...children.filter((c): c is Node | string => !!c));

/// Dialogs

function dialog(title: string, iconName: string, body: HTMLElement[], actions: HTMLElement[], onClose: () => void) {
  const box = h(
    "div",
    { class: "rc-dialog db-dialog" },
    h("div", { class: "rc-title" }, icon(iconName), ` ${title}`),
    h("div", { class: "rc-form" }, ...body),
    h("div", { class: "rc-actions" }, ...actions),
  );
  return modal(box, onClose);
}

const field = (label: string, input: HTMLElement, hint = "", unresolved = false) =>
  h(
    "label",
    { class: `rc-field${unresolved ? " db-unresolved" : ""}` },
    h("span", {}, label),
    input,
    unresolved ? h("small", { class: "db-warn" }, icon("warning"), " Couldn't be resolved from config/database.yml (ERB); fill it in.") : null,
    hint ? h("small", { class: "dim" }, hint) : null,
  );

function promptPassword(c: Conn, error = "", replacing = false): Promise<{ password: string; keep: boolean } | null> {
  return new Promise((resolve) => {
    const input = h("input", { class: "search-input", type: "password", spellcheck: false, autocomplete: "off" });
    const keep = h("input", { type: "checkbox", checked: true });
    const done = (v: { password: string; keep: boolean } | null) => {
      backdrop.remove();
      resolve(v);
    };
    const ok = () => done({ password: input.value, keep: keep.checked });
    input.addEventListener("keydown", (e) => e.key === "Enter" && ok());
    const backdrop = dialog(
      `Password for ${c.name}`,
      "key",
      [
        error ? h("small", { class: "db-warn" }, icon("warning"), ` ${error}`) : h("span"),
        field(`${c.username || "user"}@${c.host || "localhost"}${c.database ? `/${c.database}` : ""}`, input),
        h("label", { class: "rc-check" }, keep, replacing ? " Save in Keychain (replaces the saved password)" : " Save password in Keychain"),
      ],
      [h("button", { class: "btn", onclick: () => done(null) }, "Cancel"), h("button", { class: "btn primary", onclick: ok }, "Connect")],
      () => done(null),
    );
    input.focus();
  });
}

function editConnection(existing?: Conn, engine: Dialect = "postgres") {
  if (!loadedRoot) return;
  const d = existing?.source === "detected" ? detected.find((x) => x.environment === existing.environment) : undefined;
  const draft: ConnFields & { name: string; readOnly: boolean; color: Color } = existing
    ? { ...existing }
    : { name: "", engine, host: "localhost", port: null, database: "", username: "", sslmode: "prefer", readOnly: false, color: "none" };
  const missing = new Set(existing?.unresolved ?? []);
  const id = existing?.id ?? `${loadedRoot}::${crypto.randomUUID()}`;
  const ymlPassword = existing?.ymlPassword !== undefined;
  let roTouched = !!existing;
  let hadSaved = false;

  const text = (key: "name" | "host" | "database" | "username", placeholder = "") => {
    const el = h("input", { class: "search-input", value: draft[key], placeholder, spellcheck: false });
    el.oninput = () => {
      draft[key] = el.value.trim();
      if (key === "host") syncReadOnly();
    };
    return el;
  };
  const select = <T extends string>(values: T[], value: T | null, onchange: (v: T) => void, disabled = false) => {
    const el = h("select", { class: "run-select", disabled }, ...(value ? [] : [h("option", { value: "", selected: true }, "choose…")]), ...values.map((v) => h("option", { value: v, selected: v === value }, v)));
    el.onchange = () => onchange(el.value as T);
    return el;
  };
  const port = h("input", { class: "search-input", type: "number", min: 1, max: 65535, value: draft.port ?? "", placeholder: "default" });
  port.oninput = () => (draft.port = port.value ? Number(port.value) : null);
  const password = h("input", { class: "search-input", type: "password", spellcheck: false, autocomplete: "off" });
  const keep = h("input", { type: "checkbox", checked: true });
  const readOnly = h("input", { type: "checkbox", checked: draft.readOnly });
  readOnly.onchange = () => ((roTouched = true), (draft.readOnly = readOnly.checked));
  const syncReadOnly = () => {
    if (roTouched) return;
    readOnly.checked = draft.readOnly = defaultReadOnly(d?.environment, draft.engine, draft.host);
  };
  syncReadOnly();
  invoke<boolean>("db_password_exists", { id, config: configOf({ ...draft, id, source: "manual", unresolved: [] } as Conn) }).then((has) => {
    hadSaved = !!has;
    keep.checked = hadSaved || !existing;
    password.placeholder = hadSaved ? "saved in Keychain (type to replace)" : "";
  });

  const body = h("div", { class: "db-form-fields" });
  const render = () => {
    const sqlite = draft.engine === "sqlite";
    fill(
      body,
      field("Name", text("name", d?.environment ?? "my database")),
      field("Engine", select(["postgres", "mysql", "sqlite"] as Dialect[], draft.engine, (v) => ((draft.engine = v), syncReadOnly(), render()), !!d && !missing.has("engine")), "", missing.has("engine")),
      ...(sqlite
        ? [field("Database file", text("database", "db/development.sqlite3"), "relative to the project root", missing.has("database"))]
        : [
            field("Host", text("host", "localhost"), "", missing.has("host")),
            field("Port", port, "", missing.has("port")),
            field("Database", text("database"), "", missing.has("database")),
            field("User", text("username"), "", missing.has("username")),
            field("SSL mode", select(["prefer", "disable", "require"] as SslMode[], draft.sslmode, (v) => (draft.sslmode = v))),
            ymlPassword
              ? h("small", { class: "dim" }, "The password from config/database.yml is used in memory for this session; Garnet doesn't store it.")
              : field("Password", password, missing.has("password") ? "couldn't be resolved from config/database.yml; enter it here or when connecting" : ""),
            ymlPassword ? null : h("label", { class: "rc-check" }, keep, " Save password in Keychain"),
          ]),
      h("label", { class: "rc-check", title: "A read-only session can still call functions with side effects (pg_terminate_backend, dblink). For production, use a database role without those privileges." }, readOnly, " Read-only (Garnet refuses writes and opens a read-only session; use a limited role for production)"),
      field("Colour", select(COLORS, draft.color, (v) => (draft.color = v))),
    );
  };
  render();

  const testResult = h("small", { class: "dim db-test-result" });
  const test = async () => {
    if (!draft.engine) return toast("Choose an engine.", "error");
    testResult.textContent = "Connecting…";
    testResult.className = "dim db-test-result";
    const config = { ...configOf({ ...draft, id, source: "manual", unresolved: [] } as Conn), readOnly: true };
    try {
      const r = await invoke<{ version: string; ms: number }>("db_test", { id, config, password: ymlPassword ? existing?.ymlPassword : password.value || sessionPasswords.get(id) });
      testResult.textContent = `Succeeded · ${r.version} · ${r.ms} ms`;
      testResult.classList.add("db-ok");
    } catch (e) {
      testResult.textContent = String(e).split("\n")[0];
      testResult.classList.add("db-warn");
    }
  };
  const close = () => backdrop.remove();
  const submit = async () => {
    if (!draft.engine) return toast("Choose an engine.", "error");
    if (!existing && !draft.name) return toast("Enter a name.", "error");
    if (draft.engine === "sqlite" && !draft.database) return toast("Enter the database file.", "error");
    if (draft.port !== null && !(Number.isInteger(draft.port) && draft.port > 0 && draft.port < 65536)) return toast("Port must be 1–65535.", "error");
    if (!draft.readOnly && !isLocal(draft) && (existing?.readOnly ?? true) && !(await confirmWritable({ ...draft, name: draft.name || d?.environment || "" }))) return;
    if (d) store.overrides[d.environment] = overrideFrom(d, draft);
    else {
      const m: ManualConn = { id, name: draft.name, engine: draft.engine, host: draft.host, port: draft.port, database: draft.database, username: draft.username, sslmode: draft.sslmode, readOnly: draft.readOnly, color: draft.color };
      const i = store.manual.findIndex((x) => x.id === id);
      if (i >= 0) store.manual[i] = m;
      else store.manual.push(m);
    }
    if (draft.engine !== "sqlite" && !ymlPassword) {
      if (password.value && keep.checked) await invoke("db_password_set", { id, password: password.value, config: configOf({ ...draft, id, source: "manual", unresolved: [] } as Conn) }).catch((e) => toast(`Keychain: ${e}`, "error"));
      else if (password.value) sessionPasswords.set(id, password.value);
      if (!keep.checked && hadSaved) await invoke("db_password_delete", { id }).catch(() => {});
      if (password.value && keep.checked) sessionPasswords.delete(id);
    }
    await saveStore();
    close();
    selectedId = id;
    if (live.has(id)) {
      await disconnect(id);
      toast(`Disconnected "${draft.name || d?.environment}"; connect again to use the new settings.`);
    }
    remerge();
  };
  const backdrop = dialog(
    existing ? `Edit ${existing.name}` : "New Connection",
    "database",
    [body],
    [h("button", { class: "btn", title: "Connect read-only with these settings and report the server version", onclick: test }, "Test Connection"), testResult, h("span", { class: "spacer" }), h("button", { class: "btn", onclick: close }, "Cancel"), h("button", { class: "btn primary", onclick: submit }, "Save")],
    close,
  );
  (body.querySelector<HTMLElement>(".db-unresolved input, .db-unresolved select") ?? body.querySelector("input"))?.focus();
}

/// Tree

const treeEl = h("div", { class: "tree db-tree", tabIndex: 0 });

const tag = (color: Color) => h("span", { class: `db-tag db-tag-${color}` });
const roBadge = (c: Conn) => h("span", { class: "db-ro", title: readOnlyReason(c) }, "READ-ONLY");
const describe = (c: Conn) =>
  c.engine === "sqlite" ? `sqlite ${c.database}` : `${c.engine ?? "?"} ${c.host || "localhost"}${c.port ? `:${c.port}` : ""}${c.database ? `/${c.database}` : ""}`;

interface RowOpts {
  onOpen?: () => void;
  /// F4 when it differs from double-click/Enter: on a data source it opens (or jumps to) its query console.
  onF4?: () => void;
  onDdl?: () => void;
  menu?: () => (MenuItem | null)[];
  connId?: string;
  title?: string;
}
/// Rows of the last render, in order, for keyboard navigation; `cursor` is the focused row's id.
let rowList: { id: string; el: HTMLElement; key: string | null; opts: RowOpts }[] = [];
let cursor: string | null = null;

function row(depth: number, id: string, key: string | null, iconName: string, label: (Node | string | null)[], opts: RowOpts = {}) {
  const open = key !== null && expanded.has(key);
  const el = h(
    "div",
    {
      class: `tree-row${id === cursor ? " selected" : ""}`,
      style: `padding-left:${depth * 14 + 4}px`,
      title: opts.title,
      onclick: (e: MouseEvent) => {
        if (e.detail > 1) return;
        cursor = id;
        if (opts.connId) selectedId = opts.connId;
        treeEl.focus();
        if (key !== null && (e.target as HTMLElement).classList.contains("twisty")) {
          open ? expanded.delete(key) : expanded.add(key);
          return renderTree();
        }
        // Select in place: re-rendering here would swap the row out from under a double-click.
        for (const r of rowList) r.el.classList.toggle("selected", r.id === id);
      },
      ondblclick: (e: MouseEvent) => {
        e.preventDefault();
        cursor = id;
        if (opts.onOpen) opts.onOpen();
        else if (key !== null) {
          open ? expanded.delete(key) : expanded.add(key);
          renderTree();
        }
      },
      oncontextmenu: (e: MouseEvent) => {
        cursor = id;
        if (opts.connId) selectedId = opts.connId;
        renderTree();
        const items = opts.menu?.();
        if (items) contextMenu(e, items);
      },
    },
    h("span", { class: `twisty codicon ${key === null ? "" : open ? "codicon-chevron-down" : "codicon-chevron-right"}` }),
    icon(iconName, "file-icon"),
    ...label,
  );
  rowList.push({ id, el, key, opts });
  return el;
}

treeEl.addEventListener("keydown", (e) => {
  const i = rowList.findIndex((r) => r.id === cursor);
  const cur = rowList[i];
  const move = (j: number) => {
    const next = rowList[Math.max(0, Math.min(rowList.length - 1, j))];
    if (!next) return;
    cursor = next.id;
    if (next.opts.connId) selectedId = next.opts.connId;
    renderTree();
  };
  const toggle = (on: boolean) => {
    if (!cur?.key) return;
    on ? expanded.add(cur.key) : expanded.delete(cur.key);
    renderTree();
  };
  if (e.key === "ArrowDown" && e.metaKey) cur?.opts.onDdl?.();
  else if (e.key === "ArrowDown") move(i + 1);
  else if (e.key === "ArrowUp") move(i - 1);
  else if (e.key === "ArrowRight") cur?.key && !expanded.has(cur.key) ? toggle(true) : move(i + 1);
  else if (e.key === "ArrowLeft") cur?.key && expanded.has(cur.key) ? toggle(false) : undefined;
  else if (e.key === "F4" && cur?.opts.onF4) cur.opts.onF4();
  else if (e.key === "Enter" || e.key === "F4") cur?.opts.onOpen ? cur.opts.onOpen() : toggle(!expanded.has(cur?.key ?? ""));
  else return;
  e.preventDefault();
  e.stopPropagation();
});

function connMenu(c: Conn): (MenuItem | null)[] {
  const on = live.has(c.id);
  return [
    on ? { label: "Disconnect", icon: "debug-disconnect", run: () => disconnect(c.id) } : { label: "Connect", icon: "plug", run: () => connect(c) },
    { label: "Open Query Console", icon: "terminal", shortcut: "F4", run: () => openConsole(c.id) },
    on ? { label: "Refresh", icon: "refresh", run: () => loadSchema(c.id) } : null,
    { label: "Copy Name", icon: "copy", run: () => navigator.clipboard.writeText(c.name) },
    null,
    { label: "Edit Data Source…", icon: "edit", run: () => editConnection(c) },
    { label: c.readOnly ? "Make Writable…" : "Make Read-only", icon: c.readOnly ? "unlock" : "lock", run: () => toggleReadOnly(c) },
    { label: "Colour…", icon: "symbol-color", run: () => pickColor(c) },
    c.source === "manual" ? { label: "Remove", icon: "trash", run: () => removeConn(c) } : null,
  ];
}

function columnIcon(t: TableInfo, col: Column) {
  if (col.primaryKey) return "key";
  if (t.foreignKeys.some((f) => f.columns.includes(col.name))) return "references";
  if (t.indexes.some((i) => i.columns.includes(col.name))) return "list-ordered";
  return "symbol-field";
}

function renderTree() {
  const rows: HTMLElement[] = [];
  rowList = [];
  if (detecting) rows.push(h("div", { class: "db-note" }, icon("loading", "codicon-modifier-spin"), " Reading config/database.yml…"));
  else if (detectError) rows.push(h("div", { class: "db-note db-warn", title: detectError }, icon("warning"), ` ${detectError}`));
  for (const c of conns) {
    const l = live.get(c.id);
    const busy = connecting.has(c.id);
    rows.push(
      row(
        0,
        c.id,
        l ? c.id : null,
        busy ? "loading codicon-modifier-spin" : "database",
        [
          tag(c.color),
          h("span", { class: "tree-label" }, c.name),
          c.readOnly ? roBadge(c) : null,
          c.unresolved.some((f) => f !== "password") || !c.engine ? h("span", { class: "db-warn", title: `Unresolved in config/database.yml: ${c.unresolved.join(", ")}` }, icon("warning")) : null,
          h("span", { class: "dim db-detail" }, describe(c)),
          l ? h("span", { class: "db-live", title: l.version }) : null,
        ],
        { connId: c.id, onOpen: l ? undefined : () => connect(c), onF4: () => openConsole(c.id), menu: () => connMenu(c), title: c.source === "detected" ? `config/database.yml › ${c.environment}` : "" },
      ),
    );
    if (!l || !expanded.has(c.id)) continue;
    if (l.schemaError) rows.push(h("div", { class: "db-note db-warn", style: "padding-left:32px" }, l.schemaError));
    else if (!l.schema) rows.push(h("div", { class: "db-note", style: "padding-left:32px" }, "Loading schema…"));
    else
      for (const s of l.schema.schemas) {
        const sk = `${c.id}|${s.name}`;
        rows.push(
          row(1, sk, sk, "symbol-namespace", [h("span", { class: "tree-label" }, s.name), h("span", { class: "dim db-detail" }, String(s.tables.length))], {
            connId: c.id,
            menu: () => [
              { label: "Open Query Console", icon: "terminal", run: () => openConsole(c.id) },
              { label: "Refresh", icon: "refresh", run: () => loadSchema(c.id) },
              { label: "Copy Name", icon: "copy", run: () => navigator.clipboard.writeText(s.name) },
            ],
          }),
        );
        if (!expanded.has(sk)) continue;
        for (const t of s.tables) {
          const tk = `${sk}|${t.name}`;
          const openData = () => openTable(c.id, s.name, t.name);
          const openDdl = () => showDdl(c.id, s.name, t);
          rows.push(
            row(2, tk, tk, t.kind === "view" ? "eye" : "table", [h("span", { class: "tree-label" }, t.name), h("span", { class: "dim db-detail" }, `${t.columns.length} columns`)], {
              connId: c.id,
              onOpen: openData,
              onDdl: openDdl,
              menu: () => [
                { label: "Edit Data", icon: "table", shortcut: "F4", run: openData },
                { label: "Jump to DDL", icon: "go-to-file", shortcut: "⌘↓", run: openDdl },
                { label: "Open Query Console", icon: "terminal", run: () => openConsole(c.id) },
                null,
                { label: "Refresh", icon: "refresh", run: () => loadSchema(c.id) },
                { label: "Copy Name", icon: "copy", run: () => navigator.clipboard.writeText(t.name) },
                { label: "Edit Data Source…", icon: "edit", run: () => editConnection(c) },
                { label: "Disconnect", icon: "debug-disconnect", run: () => disconnect(c.id) },
              ],
            }),
          );
          if (!expanded.has(tk)) continue;
          for (const col of t.columns)
            rows.push(
              row(3, `${tk}|c|${col.name}`, null, columnIcon(t, col), [
                h("span", { class: "tree-label" }, col.name),
                h("span", { class: "dim db-detail" }, `${col.dataType}${col.nullable ? "" : " not null"}${col.default !== null ? ` = ${col.default}` : ""}`),
              ], { connId: c.id, menu: () => [{ label: "Copy Name", icon: "copy", run: () => navigator.clipboard.writeText(col.name) }] }),
            );
          const pk = t.columns.filter((x) => x.primaryKey);
          if (pk.length || t.foreignKeys.length) {
            const kk = `${tk}|keys`;
            rows.push(row(3, kk, kk, "key", [h("span", { class: "tree-label" }, "keys"), h("span", { class: "dim db-detail" }, String((pk.length ? 1 : 0) + t.foreignKeys.length))]));
            if (expanded.has(kk)) {
              if (pk.length) rows.push(row(4, `${kk}|pk`, null, "key", [h("span", { class: "tree-label" }, "primary key"), h("span", { class: "dim db-detail" }, `(${pk.map((x) => x.name).join(", ")})`)]));
              for (const f of t.foreignKeys)
                rows.push(
                  row(4, `${kk}|${f.name}`, null, "references", [
                    h("span", { class: "tree-label" }, f.name),
                    h("span", { class: "dim db-detail" }, `(${f.columns.join(", ")}) → ${f.refSchema && f.refSchema !== s.name ? `${f.refSchema}.` : ""}${f.refTable}(${f.refColumns.join(", ")})`),
                  ]),
                );
            }
          }
          if (t.indexes.length) {
            const ik = `${tk}|idx`;
            rows.push(row(3, ik, ik, "list-ordered", [h("span", { class: "tree-label" }, "indexes"), h("span", { class: "dim db-detail" }, String(t.indexes.length))]));
            if (expanded.has(ik))
              for (const i of t.indexes)
                rows.push(row(4, `${ik}|${i.name}`, null, "list-ordered", [h("span", { class: "tree-label" }, i.name), h("span", { class: "dim db-detail" }, `(${i.columns.join(", ")})${i.unique ? " unique" : ""}`)]));
          }
        }
      }
  }
  if (!conns.length && !detecting) rows.push(h("div", { class: "empty" }, "No config/database.yml connections. Add one with +."));
  const top = treeEl.scrollTop;
  treeEl.replaceChildren(...rows);
  treeEl.scrollTop = top;
  rowList.find((x) => x.id === cursor)?.el.scrollIntoView({ block: "nearest" });
}

const selected = () => (selectedId ? connById(selectedId) : undefined) ?? (conns.length === 1 ? conns[0] : undefined);
const withSelected = (fn: (c: Conn) => unknown) => () => {
  const c = selected();
  if (c) fn(c);
  else toast("Select a connection first.");
};

/// Grid

export interface GridEdit {
  /// Why a column can't be edited, or null when it can.
  blocked: (col: number) => string | null;
  /// Staged values by row then column; the grid fills it, the table viewer submits it.
  staged: Map<number, Map<number, string | null>>;
  onChange: () => void;
  /// Filled in by the grid: stages NULL for the selected cell (the Set NULL action).
  setNull?: () => void;
}

export interface GridOpts {
  /// Server-side sort (table viewer); without it, header clicks sort the loaded rows in place.
  sort?: { col?: string; desc: boolean; onSort: (col: string) => void };
  edit?: GridEdit;
  copyAs?: { table: string; dialect: Dialect };
  onSelect?: (value: string | null, column: string) => void;
}

const compareCells = (a: string | null, b: string | null) => {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  const x = Number(a);
  const y = Number(b);
  return a.trim() !== "" && b.trim() !== "" && !isNaN(x) && !isNaN(y) ? x - y : a.localeCompare(b);
};

/// Row order for a client-side sort; NULLs first ascending, numbers compared as numbers.
export const sortedOrder = (rows: (string | null)[][], col: number, desc: boolean) =>
  rows.map((_, i) => i).sort((i, j) => (desc ? -1 : 1) * compareCells(rows[i][col], rows[j][col]) || i - j);

function cellContent(v: string | null) {
  if (v === null) return h("span", { class: "db-null" }, "NULL");
  if (v === "") return h("span", { class: "db-empty", title: "Empty string" });
  return v;
}

export function grid(columns: string[], rows: (string | null)[][], opts: GridOpts = {}) {
  const { sort, edit } = opts;
  let local: { col: number; desc: boolean } | null = null;
  let order = rows.map((_, i) => i);
  const body = h("tbody", {});
  const value = (r: number, c: number) => (edit?.staged.get(r)?.has(c) ? edit.staged.get(r)!.get(c)! : rows[r][c]);
  const rowOf = (tr: Element) => Number((tr as HTMLElement).dataset.row);
  const renderBody = () =>
    body.replaceChildren(
      ...order.map((r) =>
        h(
          "tr",
          { "data-row": r },
          ...columns.map((_, c) => h("td", { class: edit?.staged.get(r)?.has(c) ? "db-staged" : "" }, cellContent(value(r, c)))),
        ),
      ),
    );
  renderBody();
  const stage = (r: number, c: number, v: string | null) => {
    const row = edit!.staged.get(r) ?? new Map<number, string | null>();
    if (v === rows[r][c]) row.delete(c);
    else row.set(c, v);
    if (row.size) edit!.staged.set(r, row);
    else edit!.staged.delete(r);
    renderBody();
    edit!.onChange();
  };
  const startEdit = (td: HTMLTableCellElement) => {
    const r = rowOf(td.parentElement!);
    const c = td.cellIndex;
    const why = edit?.blocked(c);
    if (!edit || why) return why && toast(why);
    const input = h("input", { class: "db-cell-input", value: value(r, c) ?? "", spellcheck: false });
    td.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    // Only typing stages a value: clicking into a NULL cell and away must not turn it into ''.
    let typed = false;
    input.addEventListener("input", () => (typed = true));
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      if (save && typed) stage(r, c, input.value);
      else renderBody();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  };
  body.ondblclick = (e) => {
    const td = (e.target as HTMLElement).closest("td");
    if (td && !td.querySelector("input")) startEdit(td);
  };
  const all = () => order.map((r) => columns.map((_, c) => value(r, c)));
  const copy = (text: string) => navigator.clipboard.writeText(text);
  body.oncontextmenu = (e) => {
    const td = (e.target as HTMLElement).closest("td");
    const tr = td?.parentElement;
    if (!td || !tr) return;
    const r = rowOf(tr);
    const c = td.cellIndex;
    const v = value(r, c);
    const line = columns.map((_, i) => value(r, i));
    const ca = opts.copyAs;
    contextMenu(e, [
      { label: "Copy Value", run: () => copy(v ?? "NULL") },
      { label: "Copy Row as CSV", run: () => copy(csvLine(line)) },
      null,
      { label: "Copy All as CSV", run: () => copy(toCsv(columns, all())) },
      { label: "Copy All as JSON", run: () => copy(toJson(columns, all())) },
      { label: "Copy All as Markdown", run: () => copy(toMarkdown(columns, all())) },
      ca ? { label: "Copy All as SQL INSERT", run: () => copy(toSqlInsert(ca.table, columns, all(), ca.dialect)) } : null,
      ...(edit
        ? [
            null,
            { label: "Edit Value", run: () => startEdit(td) },
            { label: "Set NULL", run: () => (edit.blocked(c) ? toast(edit.blocked(c)!) : stage(r, c, null)) },
            edit.staged.get(r)?.has(c) ? { label: "Revert Value", run: () => stage(r, c, rows[r][c]) } : null,
          ]
        : []),
    ]);
  };
  const onSort = (name: string) => {
    if (sort) return sort.onSort(name);
    const col = columns.indexOf(name);
    local = { col, desc: local?.col === col ? !local.desc : false };
    order = sortedOrder(rows, col, local.desc);
    renderBody();
    renderHead();
  };
  const head = h("tr", {});
  const renderHead = () =>
    head.replaceChildren(
      ...columns.map((c, i) => {
        const on = sort ? sort.col === c : local?.col === i;
        const desc = sort ? sort.desc : local?.desc;
        const th = h("th", { class: "db-sortable", title: `Sort by ${c}`, onclick: () => onSort(c) }, c, on ? icon(desc ? "arrow-down" : "arrow-up") : null);
        th.append(resizeHandle(th));
        return th;
      }),
    );
  renderHead();
  let cell: HTMLTableCellElement | null = null;
  if (edit)
    edit.setNull = () => {
      if (!cell?.isConnected) return toast("Select a cell first.");
      const c = cell.cellIndex;
      const why = edit.blocked(c);
      if (why) return toast(why);
      stage(rowOf(cell.parentElement!), c, null);
    };
  body.onclick = (e) => {
    const td = (e.target as HTMLElement).closest("td");
    if (!td || td.querySelector("input")) return;
    cell?.classList.remove("db-cell-selected");
    cell = td;
    td.classList.add("db-cell-selected");
    opts.onSelect?.(value(rowOf(td.parentElement!), td.cellIndex), columns[td.cellIndex]);
  };
  const wrap = h("div", { class: "db-grid-wrap", tabIndex: 0 }, h("table", { class: "db-grid" }, h("thead", {}, head), body));
  wrap.addEventListener("keydown", (e) => {
    if (cell?.isConnected && e.key === "F2" && edit) return startEdit(cell);
    if (!(e.metaKey && e.key.toLowerCase() === "c") || !cell?.isConnected || window.getSelection()?.toString()) return;
    copy(value(rowOf(cell.parentElement!), cell.cellIndex) ?? "NULL");
    e.preventDefault();
  });
  return wrap;
}

/// Value viewer: the selected cell in full, JSON pretty-printed.
export function valueViewer() {
  const pre = h("pre", { class: "db-value-text" });
  const label = h("span", { class: "dim" });
  const el = h("div", { class: "db-value-viewer" }, h("div", { class: "db-value-head" }, label), pre);
  el.hidden = true;
  const show = (v: string | null, column: string) => {
    label.textContent = column;
    pre.classList.toggle("db-null", v === null);
    let text = v ?? "NULL";
    if (v && /^\s*[[{]/.test(v)) {
      try {
        text = JSON.stringify(JSON.parse(v), null, 2);
      } catch {
        /* not JSON */
      }
    }
    pre.textContent = text;
  };
  return { el, show };
}

/// Drag handle on a header cell's right edge; the column keeps the width it's dragged to.
export function resizeHandle(th: HTMLElement) {
  const handle = h("span", { class: "db-col-resize", title: "Drag to resize" });
  handle.addEventListener("click", (e) => e.stopPropagation());
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const start = e.clientX;
    const width = th.getBoundingClientRect().width;
    trackDrag(handle, e, (ev) => {
      const w = `${Math.max(40, width + ev.clientX - start)}px`;
      th.style.width = th.style.minWidth = th.style.maxWidth = w;
    });
  });
  return handle;
}

/// Editor tabs (consoles, table data, DDL), shown in the main editor area like RubyMine

interface DbTab {
  key: string;
  connId: string;
  iconName: string;
  title: () => string;
  el: HTMLElement;
  refresh: () => void;
  dispose?: () => void;
  /// Toolbar actions the dbXxx commands run on the active tab.
  actions?: Partial<Record<"submit" | "revert" | "setNull" | "reload" | "prev" | "next" | "viewer", () => unknown>>;
}

const tabs: DbTab[] = [];

/// Keeps open editor tabs in step with their data source (name, colour, description) after an edit.
function renderTabs() {
  for (const t of tabs) {
    const c = connById(t.connId);
    for (const cls of [...t.el.classList]) if (cls.startsWith("db-head-")) t.el.classList.remove(cls);
    t.el.classList.add(`db-head-${c?.color ?? "none"}`);
    retitleViewTab(t.key, t.title(), tabTooltip(t));
  }
}

const tabTooltip = (t: DbTab) => {
  const c = connById(t.connId);
  return c ? `${t.title()} · ${c.name} (${describe(c)})` : t.title();
};

function activate(key: string) {
  const t = findViewTab(key);
  if (t) activateEditorTab(t);
}

function addTab(t: DbTab) {
  tabs.push(t);
  t.el.classList.add(`db-head-${connById(t.connId)?.color ?? "none"}`);
  openViewTab(t.key, t.title(), {
    el: t.el,
    icon: t.iconName,
    tooltip: tabTooltip(t),
    onClose: () => {
      const i = tabs.indexOf(t);
      if (i >= 0) tabs.splice(i, 1);
      t.dispose?.();
    },
  });
}

function closeTab(t: DbTab) {
  const tab = findViewTab(t.key);
  if (tab) closeEditorTab(tab, true);
}

function connHeader(id: string) {
  const el = h("div", { class: "db-conn-head" });
  const refresh = () => {
    const c = connById(id);
    if (!c) return;
    const l = live.get(id);
    el.className = `db-conn-head db-head-${c.color}`;
    fill(
      el,
      icon("database"),
      h("strong", {}, c.name),
      h("span", { class: "dim" }, describe(c)),
      c.readOnly ? roBadge(c) : null,
      h("span", { class: "spacer" }),
      l ? h("span", { class: "dim" }, l.version) : null,
      connecting.has(id)
        ? h("span", { class: "dim" }, "Connecting…")
        : l
          ? h("button", { class: "btn small", onclick: () => disconnect(id) }, "Disconnect")
          : h("button", { class: "btn small primary", onclick: () => connect(c) }, "Connect"),
    );
  };
  return { el, refresh };
}

function needLive(id: string): Conn | null {
  const c = connById(id);
  if (!c) return null;
  if (live.has(id)) return c;
  toast(`Connect to "${c.name}" first.`, "info", [{ label: "Connect", run: () => connect(c) }]);
  return null;
}

export async function exportResult(r: QueryResult, format: "csv" | "json") {
  try {
    const path = await invoke<string | null>("export_file", { format, defaultName: `result.${format}`, content: format === "csv" ? toCsv(r.columns, r.rows) : toJson(r.columns, r.rows) });
    if (path) toast(`Exported ${r.rows.length} rows to ${path}`);
  } catch (e) {
    toast(`Export failed: ${e}`, "error");
  }
}

/// Table data viewer

const PAGE_SIZES = [50, 100, 500, 1000];
const BINARY = /blob|bytea|binary/i;

/// Why the grid can't be edited at all (null when it can): writable connection, a table, a usable primary key.
export function editBlocked(c: Conn | undefined, t: TableInfo | undefined): string | null {
  if (!c) return "Unknown data source.";
  if (c.readOnly) return `"${c.name}" is read-only.`;
  if (!t) return "Refresh the schema first; the primary key isn't known yet.";
  if (t.kind !== "table") return `${t.name} is a view.`;
  const pk = t.columns.filter((x) => x.primaryKey);
  if (!pk.length) return `${t.name} has no primary key, so rows can't be addressed safely.`;
  if (pk.some((x) => BINARY.test(x.dataType))) return `${t.name}'s primary key is binary.`;
  return null;
}

const tableInfo = (id: string, schema: string, table: string) =>
  live.get(id)?.schema?.schemas.find((s) => s.name === schema)?.tables.find((t) => t.name === table);

const shown = (v: string | null) => (v === null ? "NULL" : `'${v}'`);

export interface RowEdit {
  pk: Record<string, string>;
  changes: Record<string, string | null>;
  originals: Record<string, string | null>;
}

/// Staged grid cells as `db_update_rows` input; null when a row has no usable primary key value.
export function rowEdits(t: TableInfo, columns: string[], rows: (string | null)[][], staged: Map<number, Map<number, string | null>>): RowEdit[] | null {
  const pk = t.columns.filter((x) => x.primaryKey).map((x) => x.name);
  const out: RowEdit[] = [];
  for (const [r, changes] of staged) {
    const key = pk.map((k) => [k, rows[r][columns.indexOf(k)]] as const);
    if (!pk.length || key.some(([k, v]) => !columns.includes(k) || v === null)) return null;
    out.push({
      pk: Object.fromEntries(key) as Record<string, string>,
      changes: Object.fromEntries([...changes].map(([c, v]) => [columns[c], v])),
      originals: Object.fromEntries([...changes].map(([c]) => [columns[c], rows[r][c]])),
    });
  }
  return out;
}

/// Submits staged cell edits after listing them: the backend checks them against the schema and runs them as
/// parameterized UPDATEs in one transaction, rolled back unless each matches exactly its row.
export async function submitEdits(c: Conn, schema: string, t: TableInfo, columns: string[], rows: (string | null)[][], staged: Map<number, Map<number, string | null>>) {
  const edits = rowEdits(t, columns, rows, staged);
  if (!edits) return { error: "A row has no usable primary key value; nothing was submitted." };
  if (!edits.length) return { error: "" };
  const lines = edits.map(
    (e) =>
      `UPDATE ${t.name} SET ${Object.entries(e.changes).map(([k, v]) => `${k} = ${shown(v)}`).join(", ")} WHERE ${Object.entries(e.pk).map(([k, v]) => `${k} = ${shown(v)}`).join(" AND ")} (only if ${Object.entries(e.originals).map(([k, v]) => `${k} is still ${shown(v)}`).join(", ")})`,
  );
  const ok = await (dbSmokeHooks.ask ?? ask)(`Run ${edits.length} UPDATE statement${edits.length === 1 ? "" : "s"} on "${c.name}" in one transaction?\n\n${lines.join("\n")}`, {
    title: "Submit Changes",
    kind: "warning",
    okLabel: "Submit",
    cancelLabel: "Cancel",
  });
  if (!ok) return { error: "Cancelled; nothing was submitted." };
  try {
    const done = await invoke<number>("db_update_rows", { id: c.id, schema, table: t.name, rows: edits });
    return { error: "", done };
  } catch (e) {
    return { error: String(e) };
  }
}

function openTable(id: string, schema: string, table: string) {
  const key = `table:${id}:${schema}.${table}`;
  if (tabs.some((t) => t.key === key)) return activate(key);
  let offset = 0;
  let pageSize = PAGE;
  let orderBy: string | undefined;
  let desc = false;
  let filter = "";
  let seq = 0;
  let page: (QueryResult & { total: number | null }) | null = null;
  const staged = new Map<number, Map<number, string | null>>();
  const header = connHeader(id);
  const filterInput = h("input", { class: "search-input", placeholder: "WHERE …  (Enter to apply)", spellcheck: false });
  const range = h("span", { class: "dim db-range" });
  const prev = iconButton("chevron-left", "Previous page", () => ((offset = Math.max(0, offset - pageSize)), load()), "dbPrevPage");
  const next = iconButton("chevron-right", "Next page", () => ((offset += pageSize), load()), "dbNextPage");
  const sizeSel = h("select", { class: "run-select", title: "Page size" }, ...PAGE_SIZES.map((n) => h("option", { value: n, selected: n === pageSize }, String(n))));
  sizeSel.onchange = () => ((pageSize = Number(sizeSel.value)), (offset = 0), load());
  const submitBtn = iconButton("check", "Submit changes (⌘↩)", () => submit(), "dbSubmitEdits");
  const revertBtn = iconButton("discard", "Revert changes", () => revert(), "dbRevertEdits");
  const nullBtn = iconButton("circle-slash", "Set NULL (selected cell)", () => gridEdit?.setNull?.(), "dbSetNull");
  let gridEdit: GridEdit | undefined;
  const viewer = valueViewer();
  const viewerBtn = iconButton("open-preview", "Value viewer", () => ((viewer.el.hidden = !viewer.el.hidden), viewerBtn.classList.toggle("on", !viewer.el.hidden)), "dbValueViewer");
  const exportBtn = (fmt: "csv" | "json") => h("button", { class: "btn small", title: `Export this page as ${fmt.toUpperCase()}`, onclick: () => page && exportResult(page, fmt) }, fmt.toUpperCase());
  const content = h("div", { class: "db-result" });
  const syncEdit = () => {
    const n = [...staged.values()].reduce((a, m) => a + m.size, 0);
    submitBtn.disabled = revertBtn.disabled = n === 0;
    submitBtn.title = n ? `Submit ${n} change${n === 1 ? "" : "s"} (⌘↩)` : "Submit changes (⌘↩)";
  };
  const discardChanges = async () => !staged.size || (await (dbSmokeHooks.ask ?? ask)(`Discard ${staged.size} edited row(s)?`, { title: "Unsubmitted Changes", kind: "warning", okLabel: "Discard", cancelLabel: "Keep Editing" }));
  filterInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" || !(await discardChanges())) return;
    filter = filterInput.value.trim();
    offset = 0;
    load();
  });
  const revert = () => {
    staged.clear();
    render();
  };
  const submit = async () => {
    const c = needLive(id);
    const t = tableInfo(id, schema, table);
    if (!c || !t || !page || !staged.size) return;
    const res = await submitEdits(c, schema, t, page.columns, page.rows, staged);
    if (res.error) toast(res.error, "error");
    if (res.done) {
      toast(`Submitted ${res.done} UPDATE${res.done === 1 ? "" : "s"}.`);
      staged.clear();
      load();
    }
  };
  const render = () => {
    syncEdit();
    if (!page) return;
    const c = connById(id);
    const t = tableInfo(id, schema, table);
    const blocked = editBlocked(c, t);
    submitBtn.hidden = revertBtn.hidden = nullBtn.hidden = blocked !== null;
    const edit: GridEdit | undefined = blocked
      ? undefined
      : {
          staged,
          onChange: syncEdit,
          blocked: (col) => {
            const info = t!.columns.find((x) => x.name === page!.columns[col]);
            if (!info) return `${page!.columns[col]} isn't a column of ${table}.`;
            if (BINARY.test(info.dataType)) return `${info.name} is binary; edit it with an UPDATE in the console.`;
            return null;
          },
        };
    gridEdit = edit;
    content.replaceChildren(
      grid(page.columns, page.rows, {
        sort: {
          col: orderBy,
          desc,
          onSort: async (col) => {
            if (!(await discardChanges())) return;
            desc = orderBy === col ? !desc : false;
            orderBy = col;
            load();
          },
        },
        edit,
        copyAs: c ? { table, dialect: dialect(c) } : undefined,
        onSelect: viewer.show,
      }),
    );
  };
  const load = async () => {
    if (!needLive(id)) return;
    const mine = ++seq;
    range.textContent = "Loading…";
    try {
      const p = await invoke<QueryResult & { total: number | null }>("db_table_page", { id, schema, table, offset, limit: pageSize, orderBy, desc, filter: filter || undefined });
      if (mine !== seq) return;
      page = p;
      staged.clear();
      const end = offset + p.rows.length;
      range.textContent = p.rows.length ? `rows ${offset + 1}–${end}${p.total !== null ? ` of ${p.total}` : ""}` : p.total ? `no rows past ${p.total}` : "no rows";
      prev.disabled = offset === 0;
      next.disabled = p.total !== null ? end >= p.total : p.rows.length < pageSize;
      render();
    } catch (e) {
      if (mine !== seq) return;
      range.textContent = "";
      content.replaceChildren(h("pre", { class: "error-text" }, String(e)));
    }
  };
  const el = h(
    "div",
    { class: "db-pane" },
    header.el,
    withOverflow(
      "div",
      { class: "view-toolbar" },
      iconButton("refresh", "Reload", async () => (await discardChanges()) && load(), "dbReload"),
      filterInput,
      submitBtn,
      revertBtn,
      nullBtn,
      prev,
      range,
      next,
      sizeSel,
      viewerBtn,
      exportBtn("csv"),
      exportBtn("json"),
    ),
    h("div", { class: "db-split db-table-split" }, content, viewer.el),
  );
  el.addEventListener("keydown", (e) => {
    if (e.metaKey && e.key === "Enter" && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      submit();
    }
  });
  addTab({ key, connId: id, iconName: "table", title: () => table, el, refresh: () => (header.refresh(), render()), actions: { submit, revert, setNull: () => gridEdit?.setNull?.(), reload: load, prev: () => !prev.disabled && prev.click(), next: () => !next.disabled && next.click(), viewer: () => viewerBtn.click() } });
  header.refresh();
  syncEdit();
  load();
}

/// Jump to DDL (⌘↓): the table's definition in a read-only SQL editor tab.

function showDdl(id: string, schema: string, t: TableInfo) {
  const key = `ddl:${id}:${schema}.${t.name}`;
  if (tabs.some((x) => x.key === key)) return activate(key);
  const c = connById(id);
  const editorEl = h("div", { class: "db-editor db-ddl" });
  const el = h("div", { class: "db-pane" }, editorEl);
  const model = monaco.editor.createModel(tableDdl(c ? dialect(c) : "postgres", schema, t), "sql", monaco.Uri.from({ scheme: SQL_SCHEME, path: `/ddl-${++modelSeq}.sql` }));
  let ed: monaco.editor.IStandaloneCodeEditor | null = null;
  addTab({
    key,
    connId: id,
    iconName: "symbol-structure",
    title: () => `${t.name} [DDL]`,
    el,
    refresh: () => {},
    dispose: () => {
      ed?.dispose();
      model.dispose();
    },
  });
  ed = monaco.editor.create(editorEl, { model, readOnly: true, automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: setting<number>("editor.fontSize"), fontFamily: setting<string>("editor.fontFamily") });
}

/// SQL console

let modelSeq = 0;

function openConsole(id: string) {
  const key = `console:${id}`;
  if (tabs.some((t) => t.key === key)) return activate(key);
  const header = connHeader(id);
  const model = monaco.editor.createModel("", "sql", monaco.Uri.from({ scheme: SQL_SCHEME, path: `/console-${++modelSeq}.sql` }));
  consoleModels.set(model.uri.toString(), id);
  const editorEl = h("div", { class: "db-editor" });
  const results = h("div", { class: "db-results" });
  let outcomes: Outcome[] = [];
  let shown = 0;
  let running = false;
  let cancelled = false;
  let queryId = "";
  let message = "";

  const limitBox = h("input", { type: "checkbox", checked: setting<boolean>("database.autoLimit") });
  const runBtn = iconButton("play", "Run statement at caret or selection ⌘↩", () => run());
  const cancelBtn = iconButton("debug-stop", "Cancel", () => {
    cancelled = true;
    invoke("db_cancel", { id, queryId }).catch((e) => toast(String(e), "error"));
  });
  const explainBtn = iconButton("graph", "Explain Plan (EXPLAIN, nothing is executed)", () => explain());
  const csvBtn = h("button", { class: "btn small", onclick: () => current()?.result && exportResult(current()!.result!, "csv") }, "Export CSV");
  const jsonBtn = h("button", { class: "btn small", onclick: () => current()?.result && exportResult(current()!.result!, "json") }, "Export JSON");
  const current = () => outcomes[shown];

  const sync = () => {
    runBtn.disabled = explainBtn.disabled = running;
    cancelBtn.disabled = !running;
    const r = current()?.result;
    csvBtn.disabled = jsonBtn.disabled = running || !r?.columns.length;
  };

  const renderResults = () => {
    sync();
    if (message) return results.replaceChildren(h("pre", { class: "error-text" }, message));
    if (!outcomes.length) return results.replaceChildren(h("div", { class: "empty" }, running ? "Running…" : "⌘↩ runs the statement at the caret, or every statement in the selection."));
    const o = current();
    const strip =
      outcomes.length > 1
        ? h(
            "div",
            { class: "db-tabs db-result-tabs" },
            ...outcomes.map((x, i) =>
              h(
                "div",
                { class: `db-tab${i === shown ? " active" : ""}${x.error ? " db-failed" : ""}`, title: x.sql, onclick: () => ((shown = i), renderResults()) },
                h("span", {}, `${i + 1}. ${x.sql.replace(/\s+/g, " ").slice(0, 40)}`),
              ),
            ),
          )
        : null;
    const r = o.result;
    const status = r
      ? [
          r.columns.length ? `${r.rows.length} row${r.rows.length === 1 ? "" : "s"}` : `${r.rowsAffected ?? 0} row${r.rowsAffected === 1 ? "" : "s"} affected`,
          `${r.elapsedMs} ms`,
          r.truncated ? `truncated at ${MAX_ROWS} rows` : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : "";
    fill(
      results,
      strip,
      o.error ? h("pre", { class: "error-text" }, o.error) : r && r.columns.length ? grid(r.columns, r.rows) : h("div", { class: "db-note" }, "Statement executed."),
      h("div", { class: "db-status dim" }, running ? "Running…" : status),
    );
  };

  const run = async () => {
    if (running) return;
    const c = needLive(id);
    if (!c) return;
    const sel = ed.getSelection();
    const sqls =
      sel && !sel.isEmpty()
        ? splitStatements(model.getValueInRange(sel), dialect(c)).map((s) => s.text)
        : [statementAt(model.getValue(), model.getOffsetAt(ed.getPosition()!), dialect(c))?.text].filter((s): s is string => !!s);
    if (!sqls.length) return;
    running = true;
    cancelled = false;
    message = "";
    outcomes = [];
    shown = 0;
    renderResults();
    try {
      const res = await runBatch(c, sqls, {
        autoLimit: limitBox.checked ? setting<number>("database.autoLimitRows") : 0,
        cancelled: () => cancelled,
        onQuery: (q) => (queryId = q),
        onResult: (o) => {
          outcomes.push(o);
          shown = outcomes.length - 1;
          renderResults();
        },
      });
      message = res.blocked ?? "";
      if (!res.blocked) addHistory(id, sqls);
    } finally {
      running = false;
      renderResults();
    }
  };

  const explain = async () => {
    if (running) return;
    const c = needLive(id);
    if (!c) return;
    const sel = ed.getSelection();
    const stmt = sel && !sel.isEmpty() ? model.getValueInRange(sel) : statementAt(model.getValue(), model.getOffsetAt(ed.getPosition()!), dialect(c))?.text;
    const sql = stmt ? explainSql(stmt, dialect(c)) : null;
    if (!sql) return toast("Select a single read statement (SELECT/WITH) for Explain Plan.");
    running = true;
    message = "";
    outcomes = [];
    shown = 0;
    renderResults();
    try {
      const res = await runBatch(c, [sql], { onResult: (o) => (outcomes.push(o), renderResults()) });
      message = res.blocked ?? "";
    } finally {
      running = false;
      renderResults();
    }
  };

  const showHistory = async () => {
    const list = await historyFor(id);
    if (!list.length) return toast("No history for this connection yet.");
    quickPick({
      placeholder: "Query history",
      items: list.map((s) => ({ label: s.replace(/\s+/g, " ").slice(0, 200), data: s })),
      onAccept: (item) => {
        if (!item) return;
        ed.executeEdits("history", [{ range: ed.getSelection()!, text: item.data as string, forceMoveMarkers: true }]);
        ed.focus();
      },
    });
  };

  const el = h(
    "div",
    { class: "db-pane db-console" },
    header.el,
    withOverflow(
      "div",
      { class: "view-toolbar" },
      runBtn,
      cancelBtn,
      explainBtn,
      h("label", { class: "db-limit", title: "Append LIMIT to SELECTs that have none" }, limitBox, ` Limit ${setting<number>("database.autoLimitRows")}`),
      iconButton("history", "History", showHistory),
      h("span", { class: "spacer" }),
      csvBtn,
      jsonBtn,
    ),
    h("div", { class: "db-split" }, editorEl, results),
  );
  addTab({
    key,
    connId: id,
    iconName: "terminal",
    title: () => `console [${connById(id)?.name ?? id}]`,
    el,
    refresh: header.refresh,
    dispose: () => {
      consoleModels.delete(model.uri.toString());
      ed.dispose();
      model.dispose();
    },
  });
  const ed = monaco.editor.create(editorEl, {
    model,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    lineNumbersMinChars: 3,
    fixedOverflowWidgets: true,
    fontSize: setting<number>("editor.fontSize"),
    fontFamily: setting<string>("editor.fontFamily"),
  });
  ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => run());
  ed.addAction({
    id: "garnet.db.openTableAtCaret",
    label: "Database: Open Table at Caret",
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB],
    run: () => {
      const word = model.getWordAtPosition(ed.getPosition()!)?.word;
      const hit = word ? findTable(id, word) : undefined;
      if (hit) openTable(id, hit.schema, hit.table.name);
      else if (word) toast(`No table named ${word} in the loaded schema.`);
    },
  });
  header.refresh();
  renderResults();
  ed.focus();
}

async function historyFor(id: string) {
  history ??= await readJson<Record<string, string[]>>(HISTORY, {});
  return history[id] ?? [];
}

async function addHistory(id: string, sqls: string[]) {
  const rest = (await historyFor(id)).filter((s) => !sqls.includes(s));
  history![id] = [...sqls.slice().reverse(), ...rest].slice(0, 100);
  await api.configWrite(HISTORY, JSON.stringify(history));
}

/// A table by name in a live connection's schema (case-insensitive, the default schema first).
export function findTable(id: string, name: string): { schema: string; table: TableInfo } | undefined {
  const n = name.replace(/^["`[]|["`\]]$/g, "").toLowerCase();
  for (const s of live.get(id)?.schema?.schemas ?? []) {
    const table = s.tables.find((t) => t.name.toLowerCase() === n);
    if (table) return { schema: s.name, table };
  }
  return undefined;
}

/// Quick documentation for a table: its columns, types and keys.
export function tableDoc(t: TableInfo): string {
  const pk = t.columns.filter((c) => c.primaryKey).map((c) => c.name);
  const fk = (c: string) => t.foreignKeys.find((f) => f.columns.includes(c));
  const lines = t.columns.map((c) => {
    const ref = fk(c.name);
    return `| ${c.name}${c.primaryKey ? " (PK)" : ""} | ${c.dataType}${c.nullable ? "" : " not null"} | ${ref ? `→ ${ref.refTable}(${ref.refColumns.join(", ")})` : ""} |`;
  });
  return [`**${t.name}** (${t.kind})${pk.length ? ` · primary key (${pk.join(", ")})` : ""}`, "", "| column | type | references |", "| --- | --- | --- |", ...lines].join("\n");
}

monaco.languages.registerHoverProvider("sql", {
  provideHover(model, position) {
    const id = consoleModels.get(model.uri.toString());
    const word = model.getWordAtPosition(position);
    const hit = id && word ? findTable(id, word.word) : undefined;
    if (!hit || !word) return null;
    return { range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn), contents: [{ value: tableDoc(hit.table) }] };
  },
});

monaco.languages.registerCompletionItemProvider("sql", {
  triggerCharacters: ["."],
  provideCompletionItems(model, position) {
    const schema = live.get(consoleModels.get(model.uri.toString()) ?? "")?.schema;
    if (!schema) return { suggestions: [] };
    const word = model.getWordUntilPosition(position);
    const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
    const before = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1);
    const qualifier = /([\p{L}_][\p{L}\p{N}_$]*)["`]?\.$/u.exec(before)?.[1];
    return {
      suggestions: completions(schema, qualifier).map((s) => ({
        label: s.label,
        kind: s.kind === "table" ? monaco.languages.CompletionItemKind.Struct : monaco.languages.CompletionItemKind.Field,
        detail: s.detail,
        insertText: s.label,
        range,
      })),
    };
  },
});

/// Tool window: docked on the right with a Database stripe button, holding the data-source tree.

export const dbView = h(
  "div",
  { class: "db-view" },
  h(
    "div",
    { class: "view-toolbar" },
    iconButton("add", "New Data Source…", () => pickEngine(), "dbNewConnection"),
    iconButton("refresh", "Refresh (re-read config/database.yml)", () => detect(), "dbRedetect"),
    iconButton("plug", "Connect", withSelected(connect)),
    iconButton("debug-disconnect", "Disconnect", withSelected((c) => disconnect(c.id))),
    iconButton("terminal", "Open SQL Console", withSelected((c) => openConsole(c.id)), "dbConsole"),
    iconButton("edit", "Edit Data Source…", withSelected(editConnection)),
  ),
  treeEl,
);

rightbar.add({ id: "database", title: "Database", icon: "database", command: "databaseView", el: dbView, onShow: () => void ensureLoaded() });

/// "+" › Data Source › engine, as in RubyMine.
function pickEngine() {
  quickPick({
    placeholder: "New data source",
    items: (["postgres", "mysql", "sqlite"] as Dialect[]).map((e) => ({ label: { postgres: "PostgreSQL", mysql: "MySQL", sqlite: "SQLite" }[e], data: e, icon: "database" })),
    onAccept: (item) => item && editConnection(undefined, item.data as Dialect),
  });
}

/// Rails data source detection: offer to add config/database.yml's connections once per project.
export async function dbProjectOpened() {
  const root = state.project?.root;
  if (!root || !state.project?.rails) return;
  const all = await readJson<Record<string, ProjectStore>>(STORE, {});
  if (all[root]?.noticed) return;
  const answer = async (add: boolean) => {
    const latest = await readJson<Record<string, ProjectStore>>(STORE, {});
    latest[root] = Object.assign({ manual: [], overrides: {} }, latest[root], { noticed: true });
    await api.configWrite(STORE, JSON.stringify(latest, null, 2));
    if (loadedRoot === root) store.noticed = true;
    if (add) await showPanel();
  };
  toast("Database detected in config/database.yml. Add it as a data source?", "info", [
    { label: "Add Data Source", run: () => void answer(true) },
    { label: "Ignore", run: () => void answer(false) },
  ]);
}

const activeDbTab = () => {
  const key = activeViewTab()?.key;
  return tabs.find((t) => t.key === key);
};
const onTab = (action: keyof NonNullable<DbTab["actions"]>) => () => activeDbTab()?.actions?.[action]?.();

/// Model file → table: app/models/blog_post.rb → blog_posts, opened in the first connected data source that has it.
export function tableForModel(path: string): string | null {
  const m = /\/app\/models\/(?:.*\/)?([^/]+)\.rb$/.exec(path);
  return m ? pluralize(underscore(m[1])) : null;
}

async function goToTable() {
  const path = activeFileTab()?.path ?? "";
  const name = tableForModel(path);
  if (!name) return toast("Open a Rails model (app/models/*.rb) first.");
  for (const id of live.keys()) {
    const hit = findTable(id, name);
    if (hit) return openTable(id, hit.schema, hit.table.name);
  }
  toast(live.size ? `No table "${name}" in the connected data sources.` : `Connect a data source to find "${name}".`, "info", [{ label: "Database", run: () => void showPanel() }]);
}

const needProject = (fn: () => unknown) => () => (state.project ? fn() : toast("Open a folder first."));
const showPanel = async () => {
  rightbar.show("database");
  await ensureLoaded();
};
const fromTree = (fn: (r: RowOpts) => unknown) => () => {
  const r = rowList.find((x) => x.id === cursor);
  if (r) fn(r.opts);
};

commands(
  { id: "databaseView", title: "View: Database", run: needProject(() => rightbar.activate("database")) },
  { id: "dbEditData", title: "Database: Edit Data (selected table)", run: fromTree((r) => r.onOpen?.()) },
  { id: "dbJumpToDdl", title: "Database: Jump to DDL (selected table)", run: fromTree((r) => r.onDdl?.()) },
  { id: "dbNewConnection", title: "Database: New Data Source…", run: needProject(async () => (await showPanel(), pickEngine())) },
  { id: "dbGoToTable", title: "Database: Go to Table (from Rails model)", run: needProject(goToTable) },
  { id: "dbSubmitEdits", title: "Database: Submit Changes", run: onTab("submit") },
  { id: "dbRevertEdits", title: "Database: Revert Changes", run: onTab("revert") },
  { id: "dbSetNull", title: "Database: Set NULL", run: onTab("setNull") },
  { id: "dbReload", title: "Database: Reload Table", run: onTab("reload") },
  { id: "dbPrevPage", title: "Database: Previous Page", run: onTab("prev") },
  { id: "dbNextPage", title: "Database: Next Page", run: onTab("next") },
  { id: "dbValueViewer", title: "Database: Toggle Value Viewer", run: onTab("viewer") },
  { id: "dbRedetect", title: "Database: Re-read config/database.yml", run: needProject(async () => (await showPanel(), detect())) },
  {
    id: "dbConsole",
    title: "Database: Open Query Console…",
    run: needProject(async () => {
      await showPanel();
      const c = selected();
      if (c && treeEl.contains(document.activeElement)) return openConsole(c.id);
      quickPick({
        placeholder: "Open a SQL console for",
        items: conns.map((c) => ({ label: c.name, description: describe(c), detail: live.has(c.id) ? "connected" : "", icon: "database", data: c.id })),
        onAccept: (item) => item && openConsole(item.data as string),
      });
    }),
  },
);
