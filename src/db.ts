import "./db.css";
import { ask, save } from "@tauri-apps/plugin-dialog";
import { commands } from "./commands";
import { monaco } from "./editor";
import { api, invoke } from "./ipc";
import { setting } from "./settings";
import { classify, defaultReadOnly, envSegment, isLocalHost, csvLine, splitStatements, statementAt, toCsv, toJson, withAutoLimit, type Dialect, type Kind } from "./sqlsafety";
import { state } from "./state";
import { bottom, contextMenu, h, icon, iconButton, quickPick, toast } from "./ui";

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
interface TableInfo {
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
const dialect = (c: Conn): Dialect => c.engine ?? "postgres";
const KIND_LABEL: Record<Kind, string> = { read: "read", write: "data-modifying", ddl: "schema-changing (DDL)", tx: "transaction control", other: "non-read" };

export interface Outcome {
  sql: string;
  result?: QueryResult;
  error?: string;
}

/// Runs statements one by one after the safety checks; nothing reaches db_query if any statement is blocked or declined.
export async function runBatch(
  conn: Conn,
  sqls: string[],
  opts: { autoLimit?: number; onResult?: (o: Outcome) => void; cancelled?: () => boolean } = {},
): Promise<{ outcomes: Outcome[]; blocked?: string }> {
  const checks = sqls.map((sql) => ({ sql, c: classify(sql, dialect(conn)) }));
  if (conn.readOnly) {
    const bad = checks.find((x) => x.c.kind !== "read");
    if (bad) return { outcomes: [], blocked: `"${conn.name}" is read-only, so this ${KIND_LABEL[bad.c.kind]} statement was not run:\n\n${bad.sql}` };
  } else {
    const risky = checks.filter((x) => x.c.dangerous);
    if (risky.length) {
      const ok = await ask(`Run on "${conn.name}"?\n\n${risky.map((x) => `${x.c.reason}:\n${x.sql}`).join("\n\n")}`, {
        title: "Dangerous Statement",
        kind: "warning",
        okLabel: "Run",
        cancelLabel: "Cancel",
      });
      if (!ok) return { outcomes: [], blocked: "Cancelled; nothing was run." };
    }
  }
  const outcomes: Outcome[] = [];
  for (const { sql, c } of checks) {
    if (opts.cancelled?.()) break;
    const text = opts.autoLimit && c.kind === "read" ? withAutoLimit(sql, opts.autoLimit, dialect(conn)) : sql;
    let o: Outcome;
    try {
      o = { sql: text, result: await invoke<QueryResult>("db_query", { id: conn.id, sql: text, maxRows: MAX_ROWS }) };
    } catch (e) {
      o = { sql: text, error: String(e) };
    }
    outcomes.push(o);
    opts.onResult?.(o);
    if (o.error) break;
  }
  return { outcomes };
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
    if (password === undefined && !(await invoke<boolean>("db_password_exists", { id: c.id }).catch(() => false))) {
      const p = await promptPassword(c);
      if (!p) return;
      password = p.password;
      if (p.keep) await invoke("db_password_set", { id: c.id, password }).catch((e) => toast(`Keychain: ${e}`, "error"));
      else sessionPasswords.set(c.id, password);
    }
  }
  connecting.add(c.id);
  renderTree();
  try {
    const info = await invoke<{ version: string }>("db_connect", { id: c.id, config: configOf(c), password });
    live.set(c.id, { version: info.version, schema: null });
    expanded.add(c.id);
    loadSchema(c.id);
  } catch (e) {
    sessionPasswords.delete(c.id);
    toast(`${c.name}: ${e}`, "error");
  } finally {
    connecting.delete(c.id);
    renderTree();
    tabs.forEach((t) => t.refresh());
  }
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
  const backdrop = h("div", { class: "qp-backdrop", onmousedown: (e: MouseEvent) => e.target === backdrop && onClose() }, box);
  backdrop.addEventListener("keydown", (e) => e.key === "Escape" && onClose());
  document.getElementById("overlay-root")!.append(backdrop);
  return backdrop;
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

function promptPassword(c: Conn): Promise<{ password: string; keep: boolean } | null> {
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
        field(`${c.username || "user"}@${c.host || "localhost"}${c.database ? `/${c.database}` : ""}`, input),
        h("label", { class: "rc-check" }, keep, " Save password in Keychain"),
      ],
      [h("button", { class: "btn", onclick: () => done(null) }, "Cancel"), h("button", { class: "btn primary", onclick: ok }, "Connect")],
      () => done(null),
    );
    input.focus();
  });
}

function editConnection(existing?: Conn) {
  if (!loadedRoot) return;
  const d = existing?.source === "detected" ? detected.find((x) => x.environment === existing.environment) : undefined;
  const draft: ConnFields & { name: string; readOnly: boolean; color: Color } = existing
    ? { ...existing }
    : { name: "", engine: "postgres", host: "localhost", port: null, database: "", username: "", sslmode: "prefer", readOnly: false, color: "none" };
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
  invoke<boolean>("db_password_exists", { id }).then((has) => {
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
      h("label", { class: "rc-check" }, readOnly, " Read-only (Garnet blocks writes; the database session is read-only too)"),
      field("Colour", select(COLORS, draft.color, (v) => (draft.color = v))),
    );
  };
  render();

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
      if (password.value && keep.checked) await invoke("db_password_set", { id, password: password.value }).catch((e) => toast(`Keychain: ${e}`, "error"));
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
    [h("button", { class: "btn", onclick: close }, "Cancel"), h("button", { class: "btn primary", onclick: submit }, "Save")],
    close,
  );
  (body.querySelector<HTMLElement>(".db-unresolved input, .db-unresolved select") ?? body.querySelector("input"))?.focus();
}

/// Tree

const treeEl = h("div", { class: "tree db-tree", tabIndex: 0 });

const tag = (color: Color) => h("span", { class: `db-tag db-tag-${color}` });
const roBadge = () => h("span", { class: "db-ro" }, "READ-ONLY");
const describe = (c: Conn) =>
  c.engine === "sqlite" ? `sqlite ${c.database}` : `${c.engine ?? "?"} ${c.host || "localhost"}${c.port ? `:${c.port}` : ""}${c.database ? `/${c.database}` : ""}`;

function row(depth: number, key: string | null, iconName: string, label: (Node | string | null)[], opts: { onOpen?: () => void; onMenu?: (e: MouseEvent) => void; connId?: string; title?: string } = {}) {
  const open = key !== null && expanded.has(key);
  const el = h(
    "div",
    {
      class: `tree-row${opts.connId && opts.connId === selectedId && depth === 0 ? " selected" : ""}`,
      style: `padding-left:${depth * 14 + 4}px`,
      title: opts.title,
      onclick: (e: MouseEvent) => {
        if (e.detail === 2 && opts.onOpen) return opts.onOpen();
        if (opts.connId) selectedId = opts.connId;
        if (key !== null) open ? expanded.delete(key) : expanded.add(key);
        renderTree();
      },
      oncontextmenu: opts.onMenu,
    },
    h("span", { class: `twisty codicon ${key === null ? "" : open ? "codicon-chevron-down" : "codicon-chevron-right"}` }),
    icon(iconName, "file-icon"),
    ...label,
  );
  return el;
}

function connMenu(e: MouseEvent, c: Conn) {
  const on = live.has(c.id);
  contextMenu(e, [
    on ? { label: "Disconnect", run: () => disconnect(c.id) } : { label: "Connect", run: () => connect(c) },
    { label: "Open SQL Console", run: () => openConsole(c.id) },
    on ? { label: "Refresh Schema", run: () => loadSchema(c.id) } : null,
    null,
    { label: "Edit…", run: () => editConnection(c) },
    { label: c.readOnly ? "Make Writable…" : "Make Read-only", run: () => toggleReadOnly(c) },
    { label: "Colour…", run: () => pickColor(c) },
    c.source === "manual" ? { label: "Remove", run: () => removeConn(c) } : null,
  ]);
}

function renderTree() {
  const rows: HTMLElement[] = [];
  if (detecting) rows.push(h("div", { class: "db-note" }, icon("loading", "codicon-modifier-spin"), " Reading config/database.yml…"));
  else if (detectError) rows.push(h("div", { class: "db-note db-warn", title: detectError }, icon("warning"), ` ${detectError}`));
  for (const c of conns) {
    const l = live.get(c.id);
    const busy = connecting.has(c.id);
    rows.push(
      row(
        0,
        l ? c.id : null,
        busy ? "loading codicon-modifier-spin" : "database",
        [
          tag(c.color),
          h("span", { class: "tree-label" }, c.name),
          c.readOnly ? roBadge() : null,
          c.unresolved.some((f) => f !== "password") || !c.engine ? h("span", { class: "db-warn", title: `Unresolved in config/database.yml: ${c.unresolved.join(", ")}` }, icon("warning")) : null,
          h("span", { class: "dim db-detail" }, describe(c)),
          l ? h("span", { class: "db-live", title: l.version }) : null,
        ],
        { connId: c.id, onOpen: () => (l ? undefined : connect(c)), onMenu: (e) => ((selectedId = c.id), renderTree(), connMenu(e, c)), title: c.source === "detected" ? `config/database.yml › ${c.environment}` : "" },
      ),
    );
    if (!l || !expanded.has(c.id)) continue;
    if (l.schemaError) rows.push(h("div", { class: "db-note db-warn", style: "padding-left:32px" }, l.schemaError));
    else if (!l.schema) rows.push(h("div", { class: "db-note", style: "padding-left:32px" }, "Loading schema…"));
    else
      for (const s of l.schema.schemas) {
        const sk = `${c.id}|${s.name}`;
        rows.push(row(1, sk, "symbol-namespace", [h("span", { class: "tree-label" }, s.name), h("span", { class: "dim db-detail" }, String(s.tables.length))], { connId: c.id }));
        if (!expanded.has(sk)) continue;
        for (const t of s.tables) {
          const tk = `${sk}|${t.name}`;
          const openData = () => openTable(c.id, s.name, t.name);
          rows.push(
            row(2, tk, t.kind === "view" ? "eye" : "table", [h("span", { class: "tree-label" }, t.name)], {
              connId: c.id,
              onOpen: openData,
              onMenu: (e) =>
                contextMenu(e, [
                  { label: "Open Data", run: openData },
                  { label: "Open SQL Console", run: () => openConsole(c.id) },
                  { label: "Copy Name", run: () => navigator.clipboard.writeText(t.name) },
                ]),
            }),
          );
          if (!expanded.has(tk)) continue;
          for (const col of t.columns)
            rows.push(
              row(3, null, col.primaryKey ? "key" : "symbol-field", [
                h("span", { class: "tree-label" }, col.name),
                h("span", { class: "dim db-detail" }, `${col.dataType}${col.nullable ? "" : " not null"}${col.default !== null ? ` = ${col.default}` : ""}`),
              ]),
            );
          if (t.indexes.length) {
            const ik = `${tk}|idx`;
            rows.push(row(3, ik, "list-tree", [h("span", { class: "tree-label" }, "indexes"), h("span", { class: "dim db-detail" }, String(t.indexes.length))]));
            if (expanded.has(ik))
              for (const i of t.indexes)
                rows.push(row(4, null, "symbol-key", [h("span", { class: "tree-label" }, i.name), h("span", { class: "dim db-detail" }, `(${i.columns.join(", ")})${i.unique ? " unique" : ""}`)]));
          }
          if (t.foreignKeys.length) {
            const fk = `${tk}|fk`;
            rows.push(row(3, fk, "references", [h("span", { class: "tree-label" }, "foreign keys"), h("span", { class: "dim db-detail" }, String(t.foreignKeys.length))]));
            if (expanded.has(fk))
              for (const f of t.foreignKeys)
                rows.push(
                  row(4, null, "arrow-right", [
                    h("span", { class: "tree-label" }, f.name),
                    h("span", { class: "dim db-detail" }, `(${f.columns.join(", ")}) → ${f.refSchema && f.refSchema !== s.name ? `${f.refSchema}.` : ""}${f.refTable}(${f.refColumns.join(", ")})`),
                  ]),
                );
          }
        }
      }
  }
  if (!conns.length && !detecting) rows.push(h("div", { class: "empty" }, "No config/database.yml connections. Add one with +."));
  treeEl.replaceChildren(...rows);
}

const selected = () => (selectedId ? connById(selectedId) : undefined) ?? (conns.length === 1 ? conns[0] : undefined);
const withSelected = (fn: (c: Conn) => unknown) => () => {
  const c = selected();
  if (c) fn(c);
  else toast("Select a connection first.");
};

/// Grid

function grid(columns: string[], rows: (string | null)[][], sort?: { col?: string; desc: boolean; onSort: (col: string) => void }) {
  const body = h("tbody", {});
  body.append(...rows.map((r) => h("tr", {}, ...r.map((v) => h("td", {}, v === null ? h("span", { class: "db-null" }, "NULL") : v)))));
  body.oncontextmenu = (e) => {
    const td = (e.target as HTMLElement).closest("td");
    const tr = td?.parentElement as HTMLTableRowElement | null;
    if (!td || !tr) return;
    const r = rows[tr.sectionRowIndex];
    const v = r[td.cellIndex];
    contextMenu(e, [
      { label: "Copy Value", run: () => navigator.clipboard.writeText(v ?? "NULL") },
      { label: "Copy Row as CSV", run: () => navigator.clipboard.writeText(csvLine(r)) },
    ]);
  };
  const head = h(
    "tr",
    {},
    ...columns.map((c) =>
      h("th", { class: sort ? "db-sortable" : "", onclick: sort ? () => sort.onSort(c) : undefined }, c, sort?.col === c ? icon(sort.desc ? "arrow-down" : "arrow-up") : null),
    ),
  );
  return h("div", { class: "db-grid-wrap" }, h("table", { class: "db-grid" }, h("thead", {}, head), body));
}

/// Tabs

interface DbTab {
  key: string;
  connId: string;
  iconName: string;
  title: () => string;
  el: HTMLElement;
  refresh: () => void;
  dispose?: () => void;
}

const tabs: DbTab[] = [];
let activeKey: string | null = null;
const tabStrip = h("div", { class: "db-tabs" });
const tabBody = h("div", { class: "db-tab-body" });
const emptyMain = h("div", { class: "empty" }, "Connect to a database, then double-click a table or open a SQL console.");

function renderTabs() {
  tabStrip.hidden = !tabs.length;
  emptyMain.hidden = !!tabs.length;
  tabStrip.replaceChildren(
    ...tabs.map((t) =>
      h(
        "div",
        { class: `db-tab${t.key === activeKey ? " active" : ""}`, onclick: () => activate(t.key), onauxclick: (e: MouseEvent) => e.button === 1 && closeTab(t) },
        tag(connById(t.connId)?.color ?? "none"),
        icon(t.iconName),
        h("span", {}, t.title()),
        iconButton("close", "Close", (e) => (e.stopPropagation(), closeTab(t))),
      ),
    ),
  );
  for (const t of tabs) t.el.hidden = t.key !== activeKey;
}

function activate(key: string) {
  activeKey = key;
  renderTabs();
}

function addTab(t: DbTab) {
  tabs.push(t);
  tabBody.append(t.el);
  activate(t.key);
}

function closeTab(t: DbTab) {
  const i = tabs.indexOf(t);
  if (i < 0) return;
  tabs.splice(i, 1);
  t.el.remove();
  t.dispose?.();
  if (activeKey === t.key) activeKey = tabs[Math.min(i, tabs.length - 1)]?.key ?? null;
  renderTabs();
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
      c.readOnly ? roBadge() : null,
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

async function exportResult(r: QueryResult, format: "csv" | "json") {
  const path = await save({ defaultPath: `result.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
  if (!path) return;
  try {
    await invoke("export_file", { path, content: format === "csv" ? toCsv(r.columns, r.rows) : toJson(r.columns, r.rows) });
    toast(`Exported ${r.rows.length} rows to ${path}`);
  } catch (e) {
    toast(`Export failed: ${e}`, "error");
  }
}

/// Table data viewer

function openTable(id: string, schema: string, table: string) {
  const key = `table:${id}:${schema}.${table}`;
  if (tabs.some((t) => t.key === key)) return activate(key);
  let offset = 0;
  let orderBy: string | undefined;
  let desc = false;
  let filter = "";
  let seq = 0;
  const header = connHeader(id);
  const filterInput = h("input", { class: "search-input", placeholder: "WHERE …  (Enter to apply)", spellcheck: false });
  const range = h("span", { class: "dim db-range" });
  const prev = iconButton("chevron-left", "Previous page", () => ((offset = Math.max(0, offset - PAGE)), load()));
  const next = iconButton("chevron-right", "Next page", () => ((offset += PAGE), load()));
  const content = h("div", { class: "db-result" });
  filterInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    filter = filterInput.value.trim();
    offset = 0;
    load();
  });
  const load = async () => {
    if (!needLive(id)) return;
    const mine = ++seq;
    range.textContent = "Loading…";
    try {
      const page = await invoke<QueryResult & { total: number | null }>("db_table_page", { id, schema, table, offset, limit: PAGE, orderBy, desc, filter: filter || undefined });
      if (mine !== seq) return;
      const end = offset + page.rows.length;
      range.textContent = page.rows.length ? `rows ${offset + 1}–${end}${page.total !== null ? ` of ${page.total}` : ""}` : page.total ? `no rows past ${page.total}` : "no rows";
      prev.disabled = offset === 0;
      next.disabled = page.total !== null ? end >= page.total : page.rows.length < PAGE;
      content.replaceChildren(
        grid(page.columns, page.rows, {
          col: orderBy,
          desc,
          onSort: (col) => {
            desc = orderBy === col ? !desc : false;
            orderBy = col;
            load();
          },
        }),
      );
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
    h("div", { class: "view-toolbar" }, iconButton("refresh", "Reload", () => load()), filterInput, prev, range, next),
    content,
  );
  addTab({ key, connId: id, iconName: "table", title: () => table, el, refresh: header.refresh });
  header.refresh();
  load();
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
  let message = "";

  const limitBox = h("input", { type: "checkbox", checked: setting<boolean>("database.autoLimit") });
  const runBtn = iconButton("play", "Run statement at caret or selection (⌘↩)", () => run());
  const cancelBtn = iconButton("debug-stop", "Cancel", () => {
    cancelled = true;
    invoke("db_cancel", { id }).catch((e) => toast(String(e), "error"));
  });
  const csvBtn = h("button", { class: "btn small", onclick: () => current()?.result && exportResult(current()!.result!, "csv") }, "Export CSV");
  const jsonBtn = h("button", { class: "btn small", onclick: () => current()?.result && exportResult(current()!.result!, "json") }, "Export JSON");
  const current = () => outcomes[shown];

  const sync = () => {
    runBtn.disabled = running;
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
    h(
      "div",
      { class: "view-toolbar" },
      runBtn,
      cancelBtn,
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
    title: () => connById(id)?.name ?? "console",
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

/// View

export const dbView = h(
  "div",
  { class: "db-view" },
  h(
    "div",
    { class: "db-side" },
    h(
      "div",
      { class: "view-toolbar" },
      iconButton("refresh", "Re-read config/database.yml", () => detect()),
      iconButton("add", "New Connection…", () => editConnection()),
      iconButton("plug", "Connect", withSelected(connect)),
      iconButton("debug-disconnect", "Disconnect", withSelected((c) => disconnect(c.id))),
      iconButton("terminal", "Open SQL Console", withSelected((c) => openConsole(c.id))),
      iconButton("edit", "Edit Connection…", withSelected(editConnection)),
    ),
    treeEl,
  ),
  h("div", { class: "db-main" }, tabStrip, tabBody, emptyMain),
);
renderTabs();

bottom.add({ id: "database", title: "Database", icon: "database", el: dbView, onShow: () => void ensureLoaded() });

const needProject = (fn: () => unknown) => () => (state.project ? fn() : toast("Open a folder first."));
const showPanel = async () => {
  bottom.show("database");
  await ensureLoaded();
};

commands(
  { id: "databaseView", title: "View: Database", run: needProject(() => bottom.toggle("database")) },
  { id: "dbNewConnection", title: "Database: New Connection…", run: needProject(async () => (await showPanel(), editConnection())) },
  { id: "dbRedetect", title: "Database: Re-read config/database.yml", run: needProject(async () => (await showPanel(), detect())) },
  {
    id: "dbConsole",
    title: "Database: Open SQL Console…",
    run: needProject(async () => {
      await showPanel();
      quickPick({
        placeholder: "Open a SQL console for",
        items: conns.map((c) => ({ label: c.name, description: describe(c), detail: live.has(c.id) ? "connected" : "", icon: "database", data: c.id })),
        onAccept: (item) => item && openConsole(item.data as string),
      });
    }),
  },
);
