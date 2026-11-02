import { ask } from "@tauri-apps/plugin-dialog";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fake } from "./fakeIpc";

vi.mock("../editor", () => import("./fakeEditor"));
const { mergeConnections, overrideFrom, runBatch, completions, unresolvedFields, exportResult, dbSmokeHooks } = await import("../db");
type Detected = import("../db").Detected;
type Conn = import("../db").Conn;

const det = (over: Partial<Detected> = {}): Detected => ({
  environment: "development",
  engine: "postgres",
  adapter: "postgresql",
  host: "localhost",
  port: null,
  database: "app_dev",
  username: "app",
  password: null,
  unresolved: [],
  ...over,
});

describe("connection merge", () => {
  it("applies defaults for detected environments", () => {
    const [dev, prod] = mergeConnections("/r", [det(), det({ environment: "production", host: "db.example.com", password: "s3cret" })], { manual: [], overrides: {} });
    expect(dev).toMatchObject({ id: "/r::env::development", name: "development", source: "detected", readOnly: false, color: "none" });
    expect(prod).toMatchObject({ readOnly: true, color: "red", ymlPassword: "s3cret" });
  });

  it("keeps user overrides by environment and appends manual connections", () => {
    const manual = { id: "/r::m1", name: "Analytics", engine: "mysql" as const, host: "10.0.0.2", port: 3306, database: "a", username: "u", sslmode: "require" as const, readOnly: true, color: "blue" as const };
    const conns = mergeConnections("/r", [det({ environment: "production", host: "db" })], {
      manual: [manual],
      overrides: { production: { readOnly: false, color: "green", fields: { database: "other" } }, gone: { color: "red" } },
    });
    expect(conns).toHaveLength(2);
    expect(conns[0]).toMatchObject({ readOnly: false, color: "green", database: "other", host: "db" });
    expect(conns[1]).toMatchObject({ ...manual, source: "manual", unresolved: [] });
  });

  it("tracks unresolved ERB fields until they are filled in", () => {
    const d = det({ unresolved: ["host", "password", "user"] });
    const [c] = mergeConnections("/r", [d], { manual: [], overrides: {} });
    expect(c.unresolved.sort()).toEqual(["host", "password", "username"]);
    expect(c.readOnly).toBe(true);
    expect(c.ymlPassword).toBeUndefined();
    const o = overrideFrom(d, { ...c, host: "localhost", username: "me", readOnly: false });
    expect(o.fields).toEqual({ host: "localhost", username: "me" });
    const [filled] = mergeConnections("/r", [d], { manual: [], overrides: { development: o } });
    expect(filled.unresolved).toEqual(["password"]);
    expect(filled).toMatchObject({ host: "localhost", username: "me", readOnly: false });
    expect(unresolvedFields(["url", "adapter"]).sort()).toEqual(["database", "engine", "host", "password", "port", "username"]);
  });

  it("stores only what differs from database.yml", () => {
    const d = det({ environment: "production" });
    const [c] = mergeConnections("/r", [d], { manual: [], overrides: {} });
    expect(overrideFrom(d, c)).toEqual({ fields: {} });
    expect(overrideFrom(d, { ...c, readOnly: false, color: "none", name: "Prod" })).toEqual({ name: "Prod", readOnly: false, color: "none", fields: {} });
  });
});

describe("runBatch safety", () => {
  const conn = (readOnly: boolean): Conn => ({ ...mergeConnections("/r", [det()], { manual: [], overrides: {} })[0], readOnly });
  const result = { columns: ["n"], rows: [["1"]], rowsAffected: null, truncated: false, elapsedMs: 1 };
  const sent: string[] = [];
  beforeEach(() => {
    fake.reset();
    sent.length = 0;
    vi.mocked(ask).mockClear();
    fake.invokeResult = (cmd, args) => (cmd === "db_query" ? (sent.push(args.sql), result) : null);
  });

  it("blocks non-reads on read-only connections before any db_query", async () => {
    const res = await runBatch(conn(true), ["select 1", "delete from t where id = 1"]);
    expect(res.blocked).toContain("read-only");
    expect(res.outcomes).toEqual([]);
    expect(fake.calls).not.toContain("db_query");
    expect(ask).not.toHaveBeenCalled();
  });

  it("runs reads on read-only connections with the auto limit", async () => {
    const res = await runBatch(conn(true), ["select * from t", "show tables"], { autoLimit: 500 });
    expect(res.blocked).toBeUndefined();
    expect(sent).toEqual(["select * from t LIMIT 500", "show tables"]);
    expect(res.outcomes[0].result).toEqual(result);
  });

  it("asks before dangerous statements and runs nothing when declined", async () => {
    const res = await runBatch(conn(false), ["select 1", "delete from t"]);
    expect(ask).toHaveBeenCalledOnce();
    expect(String(vi.mocked(ask).mock.calls[0][0])).toContain("delete from t");
    expect(res.outcomes).toEqual([]);
    expect(fake.calls).not.toContain("db_query");
  });

  it("smoke hook answers the confirmation instead of the native dialog", async () => {
    const seen: string[] = [];
    dbSmokeHooks.ask = async (message) => (seen.push(String(message)), false);
    try {
      const res = await runBatch(conn(false), ["drop table t"]);
      expect(seen[0]).toContain("DROP statement");
      expect(ask).not.toHaveBeenCalled();
      expect(res.blocked).toBe("Cancelled; nothing was run.");
      expect(fake.calls).not.toContain("db_query");
    } finally {
      dbSmokeHooks.ask = undefined;
    }
  });

  it("runs dangerous statements once confirmed and stops at the first error", async () => {
    vi.mocked(ask).mockResolvedValueOnce(true);
    fake.invokeResult = (cmd, args) => {
      if (cmd !== "db_query") return null;
      sent.push(args.sql);
      if (args.sql.startsWith("update")) throw new Error("boom");
      return result;
    };
    const res = await runBatch(conn(false), ["update t set a = 1", "select 1"]);
    expect(sent).toEqual(["update t set a = 1"]);
    expect(res.outcomes).toEqual([{ sql: "update t set a = 1", error: "Error: boom" }]);
  });
});

describe("completions", () => {
  const schema = {
    schemas: [
      {
        name: "public",
        tables: [
          { name: "users", kind: "table" as const, columns: [{ name: "id", dataType: "int", nullable: false, default: null, primaryKey: true }, { name: "email", dataType: "text", nullable: true, default: null, primaryKey: false }], indexes: [], foreignKeys: [] },
          { name: "posts", kind: "table" as const, columns: [{ name: "id", dataType: "int", nullable: false, default: null, primaryKey: true }], indexes: [], foreignKeys: [] },
        ],
      },
    ],
  };
  it("offers tables and unique columns, or a qualified table's columns", () => {
    expect(completions(schema).map((c) => c.label)).toEqual(["users", "posts", "id", "email"]);
    expect(completions(schema, "Users").map((c) => c.label)).toEqual(["id", "email"]);
    expect(completions(schema, "public").map((c) => c.label)).toEqual(["users", "posts"]);
  });
});

describe("export", () => {
  beforeEach(() => fake.reset());

  it("lets the backend pick the path in its own save dialog; the webview never sends one", async () => {
    const seen: any[] = [];
    fake.invokeResult = (cmd, args) => (cmd === "export_file" ? (seen.push(args), "/Users/x/result.csv") : null);
    await exportResult({ columns: ["id", "name"], rows: [["1", "a,b"], ["2", null]], rowsAffected: null, truncated: false, elapsedMs: 1 }, "csv");
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]).sort()).toEqual(["content", "defaultName", "format"]);
    expect(seen[0]).toMatchObject({ format: "csv", defaultName: "result.csv" });
    expect(seen[0].content).toContain('"a,b"');
  });
});

describe("read-only explanation, DDL and explain plan", async () => {
  const { readOnlyReason, tableDdl, explainSql } = await import("../db");
  const conn = (over: Partial<Conn>): Conn => ({ ...mergeConnections("/r", [det()], { manual: [], overrides: {} })[0], ...over });

  it("development on this machine is writable; ERB/ENV hosts stay read-only with a reason and the way out", () => {
    const [local, socket, erb] = mergeConnections("/r", [det({ host: "127.0.0.1" }), det({ environment: "development/primary", host: "/tmp/.s.PGSQL.5432" }), det({ environment: "development/cache", host: "", unresolved: ["host"] })], { manual: [], overrides: {} });
    expect(local.readOnly).toBe(false);
    expect(socket.readOnly).toBe(false);
    expect(erb.readOnly).toBe(true);
    expect(readOnlyReason(erb)).toMatch(/ERB\/ENV.*couldn't be resolved/);
    expect(readOnlyReason(erb)).toMatch(/Edit Data Source… and uncheck Read-only/);
    expect(readOnlyReason(conn({ environment: "test", readOnly: true }))).toMatch(/"test" isn't a development environment/);
    expect(readOnlyReason(conn({ host: "db.internal", readOnly: true }))).toMatch(/points at db.internal/);
    // It doesn't promise more than a read-only session gives (review 8).
    expect(readOnlyReason(erb)).toMatch(/pg_terminate_backend, dblink/);
    expect(readOnlyReason(erb)).toMatch(/role without those privileges/);
  });

  const posts = {
    name: "posts",
    kind: "table" as const,
    columns: [
      { name: "id", dataType: "bigint", nullable: false, default: null, primaryKey: true },
      { name: "user_id", dataType: "bigint", nullable: true, default: null, primaryKey: false },
      { name: "title", dataType: "character varying", nullable: false, default: "''::character varying", primaryKey: false },
    ],
    indexes: [{ name: "index_posts_on_user_id", columns: ["user_id"], unique: false }],
    foreignKeys: [{ name: "fk_rails_1", columns: ["user_id"], refSchema: "public", refTable: "users", refColumns: ["id"] }],
  };

  it("rebuilds DDL from the introspected schema", () => {
    expect(tableDdl("postgres", "public", posts)).toBe(
      [
        'CREATE TABLE "public"."posts" (',
        '  "id" bigint NOT NULL,',
        '  "user_id" bigint,',
        `  "title" character varying NOT NULL DEFAULT ''::character varying,`,
        '  PRIMARY KEY ("id"),',
        '  CONSTRAINT "fk_rails_1" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id")',
        ");",
        "",
        'CREATE INDEX "index_posts_on_user_id" ON "public"."posts" ("user_id");',
        "",
      ].join("\n"),
    );
    expect(tableDdl("mysql", "app", { ...posts, foreignKeys: [], indexes: [] })).toMatch(/^CREATE TABLE `app`.`posts` \(/);
    expect(tableDdl("sqlite", "main", { ...posts, foreignKeys: [], indexes: [] })).toMatch(/^CREATE TABLE "posts" \(/);
  });

  it("explains only single read statements, never with ANALYZE", () => {
    expect(explainSql("SELECT * FROM posts;", "postgres")).toBe("EXPLAIN SELECT * FROM posts");
    expect(explainSql("select 1", "sqlite")).toBe("EXPLAIN QUERY PLAN select 1");
    expect(explainSql("DELETE FROM posts", "postgres")).toBeNull();
    expect(explainSql("EXPLAIN ANALYZE SELECT 1", "postgres")).toBeNull();
    expect(explainSql("  ", "postgres")).toBeNull();
  });
});

describe("database editor tabs", async () => {
  const { dbTesting, resizeHandle } = await import("../db");
  const { state } = await import("../state");
  const { viewTabs } = await import("./fakeEditor");

  it("recolour and retitle open tabs when the data source is edited", async () => {
    fake.reset();
    state.project = { root: "/r", name: "r" } as typeof state.project;
    fake.handlers.set("db_detect", () => [det()]);
    fake.handlers.set("db_password_exists", () => false);
    await dbTesting.ensureLoaded();
    dbTesting.openConsole("/r::env::development");
    const [el] = dbTesting.tabEls();
    expect(el.classList.contains("db-head-none")).toBe(true);
    await dbTesting.updateConn("/r::env::development", { color: "green" });
    expect(el.classList.contains("db-head-green")).toBe(true);
    expect(el.classList.contains("db-head-none")).toBe(false);
    expect(viewTabs.find((t) => t.key === "console:/r::env::development")?.title).toBe("console [development]");
    state.project = null;
  });

  it.each(["pointerup", "pointercancel", "lostpointercapture"])("column resize ends cleanly on %s", (end) => {
    const th = document.createElement("th");
    const handle = resizeHandle(th);
    th.append(handle);
    handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 100 }));
    expect(document.body.classList.contains("resizing")).toBe(true);
    handle.dispatchEvent(new MouseEvent("pointermove", { clientX: 160 }));
    const width = th.style.width;
    handle.dispatchEvent(new MouseEvent(end));
    expect(document.body.classList.contains("resizing")).toBe(false);
    handle.dispatchEvent(new MouseEvent("pointermove", { clientX: 400 }));
    expect(th.style.width).toBe(width);
  });
});

describe("multi-statement strings never run as one read", async () => {
  const { runBatch, explainSql } = await import("../db");
  const { classify } = await import("../sqlsafety");
  const conn = (readOnly: boolean): Conn => ({ ...mergeConnections("/r", [det()], { manual: [], overrides: {} })[0], readOnly });
  const sneaky = ["SELECT 1; DROP TABLE x", "EXPLAIN SELECT 1; DELETE FROM users", "SELECT 1; SELECT 2"];

  it("classify treats several statements in one string as dangerous, with the worst kind", () => {
    expect(classify("EXPLAIN SELECT 1; DELETE FROM users")).toMatchObject({ kind: "write", dangerous: true });
    expect(classify("SELECT 1; DROP TABLE x", "mysql")).toMatchObject({ kind: "ddl", dangerous: true });
    expect(classify("SELECT 1;")).toEqual({ kind: "read", dangerous: false });
  });

  it("explain only accepts a single statement", () => {
    expect(explainSql("SELECT 1; DELETE FROM users", "postgres")).toBeNull();
    expect(explainSql("EXPLAIN SELECT 1; DELETE FROM users", "postgres")).toBeNull();
    expect(explainSql("SELECT 1;", "postgres")).toBe("EXPLAIN SELECT 1");
  });

  it.each(sneaky.flatMap((sql) => [[sql, true], [sql, false]] as [string, boolean][]))("runBatch refuses %j (read-only: %s) before anything reaches db_query", async (sql, readOnly) => {
    fake.reset();
    vi.mocked(ask).mockClear();
    const res = await runBatch(conn(readOnly), [sql], { autoLimit: 100 });
    expect(res.blocked).toMatch(/one statement at a time/);
    expect(fake.calls).not.toContain("db_query");
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("backend confirmation tokens and query ids", async () => {
  const { runBatch } = await import("../db");
  const conn = (): Conn => ({ ...mergeConnections("/r", [det()], { manual: [], overrides: {} })[0], readOnly: false });
  const ok = { columns: [], rows: [], rowsAffected: 3, truncated: false, elapsedMs: 1 };
  let sent: { sql: string; confirm?: string; queryId: string }[] = [];
  beforeEach(() => {
    fake.reset();
    sent = [];
    vi.mocked(ask).mockReset();
    fake.handlers.set("db_query", (a) => {
      sent.push(a);
      if (/drop|risky_fn/i.test(a.sql) && a.confirm !== "abc123abc123abc1") throw `CONFIRM:abc123abc123abc1:DELETE without a WHERE clause`;
      return ok;
    });
  });

  it("asks when only the backend sees danger, and resends with its token once confirmed", async () => {
    // Pretend the frontend classifier missed it: the statement reaches db_query unconfirmed.
    vi.mocked(ask).mockResolvedValueOnce(true);
    const res = await runBatch(conn(), ["select risky_fn()"]);
    expect(ask).toHaveBeenCalledOnce();
    expect(String(vi.mocked(ask).mock.calls[0][0])).toContain("DELETE without a WHERE clause");
    expect(sent.map((x) => x.confirm)).toEqual([undefined, "abc123abc123abc1"]);
    expect(res.outcomes[0].result).toEqual(ok);
  });

  it("runs nothing more when the backend's confirmation is declined", async () => {
    vi.mocked(ask).mockResolvedValueOnce(false);
    const res = await runBatch(conn(), ["select risky_fn()"]);
    expect(sent).toHaveLength(1);
    expect(res.outcomes[0].error).toContain("Cancelled");
  });

  it("does not ask twice for a statement the user already confirmed", async () => {
    vi.mocked(ask).mockResolvedValueOnce(true);
    const res = await runBatch(conn(), ["drop table t"]);
    expect(ask).toHaveBeenCalledOnce();
    expect(sent.map((x) => x.confirm)).toEqual([undefined, "abc123abc123abc1"]);
    expect(res.outcomes[0].result).toEqual(ok);
  });

  it("only an exact CONFIRM error starts the handshake, and the resend keeps its query id (review 9, 10)", async () => {
    vi.mocked(ask).mockResolvedValue(true);
    fake.handlers.set("db_query", (a) => {
      sent.push(a);
      if (a.sql.includes("risky_fn") && a.confirm !== "0123456789abcdef") throw "CONFIRM:0123456789abcdef:DELETE without a WHERE clause";
      if (a.sql.includes("echo")) throw "ERROR: relation \"CONFIRM:0123456789abcdef:x\" does not exist";
      return ok;
    });
    await runBatch(conn(), ["select risky_fn()"]);
    expect(sent.map((x) => x.confirm)).toEqual([undefined, "0123456789abcdef"]);
    expect(sent[0].queryId).toBe(sent[1].queryId);
    sent.length = 0;
    const res = await runBatch(conn(), ["select echo"]);
    expect(sent).toHaveLength(1);
    expect(res.outcomes[0].error).toContain("does not exist");
    vi.mocked(ask).mockReset();
  });

  it("gives every db_query its own query id for cancel (B49)", async () => {
    const ids: string[] = [];
    await runBatch(conn(), ["select 1", "select 2"], { onQuery: (q) => ids.push(q) });
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(sent.map((x) => x.queryId)).toEqual(ids);
  });
});

describe("rejected saved password (B48)", async () => {
  const { dbTesting } = await import("../db");
  const { state } = await import("../state");

  it("asks again and offers to replace the Keychain entry", async () => {
    fake.reset();
    state.project = { root: "/b48", name: "b48" } as typeof state.project;
    fake.handlers.set("db_detect", () => [det()]);
    fake.handlers.set("db_password_exists", () => true);
    let tries = 0;
    fake.handlers.set("db_connect", (a) => {
      tries++;
      if (tries === 1) throw 'FATAL: password authentication failed for user "app"';
      expect(a.password).toBeUndefined();
      return { version: "16" };
    });
    fake.handlers.set("db_schema", () => ({ schemas: [] }));
    await dbTesting.ensureLoaded();
    const done = dbTesting.connect("/b48::env::development");
    await vi.waitFor(() => expect(document.querySelector(".db-dialog input[type=password]")).toBeTruthy());
    const dialog = document.querySelector(".db-dialog")!;
    expect(dialog.textContent).toContain("password authentication failed");
    expect(dialog.textContent).toContain("replaces the saved password");
    (dialog.querySelector("input[type=password]") as HTMLInputElement).value = "right";
    [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Connect")!.click();
    await done;
    expect(fake.invocations.find((i) => i.cmd === "db_password_set")?.args).toMatchObject({ id: "/b48::env::development", password: "right", config: { host: "localhost", username: "app" } });
    expect(tries).toBe(2);
    expect(dbTesting.isLive("/b48::env::development")).toBe(true);
    state.project = null;
  });
});

describe("results grid and cell editing", async () => {
  const { grid, sortedOrder, editBlocked, submitEdits, tableForModel, tableDoc, dbProjectOpened, dbSmokeHooks } = await import("../db");
  type TableInfo = import("../db").TableInfo;
  const users: TableInfo = {
    name: "users",
    kind: "table",
    columns: [
      { name: "id", dataType: "integer", nullable: false, default: null, primaryKey: true },
      { name: "name", dataType: "text", nullable: true, default: null, primaryKey: false },
      { name: "avatar", dataType: "bytea", nullable: true, default: null, primaryKey: false },
    ],
    indexes: [],
    foreignKeys: [],
  };
  const conn = (readOnly = false): Conn => ({ ...mergeConnections("/r", [det()], { manual: [], overrides: {} })[0], readOnly });

  it("shows NULL and empty strings differently and sorts loaded rows by header", () => {
    const g = grid(["n", "s"], [["10", "b"], ["9", null], ["100", ""]]);
    const cells = () => [...g.querySelectorAll("tbody tr")].map((tr) => tr.children[0].textContent);
    expect(g.querySelectorAll(".db-null")).toHaveLength(1);
    expect(g.querySelectorAll(".db-empty")).toHaveLength(1);
    (g.querySelector("th") as HTMLElement).click();
    expect(cells()).toEqual(["9", "10", "100"]);
    (g.querySelector("th") as HTMLElement).click();
    expect(cells()).toEqual(["100", "10", "9"]);
    expect(sortedOrder([["b"], [null], ["a"]], 0, false)).toEqual([1, 2, 0]);
  });

  it("edits only writable tables with a usable primary key", () => {
    expect(editBlocked(conn(), users)).toBeNull();
    expect(editBlocked(conn(true), users)).toContain("read-only");
    expect(editBlocked(conn(), { ...users, columns: users.columns.map((c) => ({ ...c, primaryKey: false })) })).toContain("no primary key");
    expect(editBlocked(conn(), { ...users, kind: "view" })).toContain("view");
    expect(editBlocked(conn(), undefined)).toContain("primary key");
  });

  it("stages edits in the grid and submits them as confirmed UPDATEs keyed by the primary key", async () => {
    const staged = new Map<number, Map<number, string | null>>();
    let changes = 0;
    const g = grid(["id", "name", "avatar"], [["1", "ann", null], ["2", "bob", null]], { edit: { staged, onChange: () => changes++, blocked: (c) => (c === 2 ? "binary" : null) } });
    document.body.append(g);
    const td = g.querySelectorAll("tbody tr")[1].children[1] as HTMLElement;
    td.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = td.querySelector("input")!;
    input.value = "it's me";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(staged.get(1)?.get(1)).toBe("it's me");
    expect(changes).toBe(1);
    expect(g.querySelector(".db-staged")!.textContent).toBe("it's me");
    g.remove();

    const seen: string[] = [];
    dbSmokeHooks.ask = async (m) => (seen.push(String(m)), true);
    fake.reset();
    const sent: any[] = [];
    fake.handlers.set("db_update_rows", (a) => (sent.push(a), 1));
    try {
      const res = await submitEdits(conn(), "public", users, ["id", "name", "avatar"], [["1", "ann", null], ["2", "bob", null]], staged);
      expect(res).toEqual({ error: "", done: 1 });
      // The webview sends values, never SQL: the backend checks the schema and binds them as parameters.
      expect(sent).toEqual([{ id: conn().id, schema: "public", table: "users", rows: [{ pk: { id: "2" }, changes: { name: "it's me" }, originals: { name: "bob" } }] }]);
      expect(fake.calls).not.toContain("db_query");
      expect(seen[0]).toContain("UPDATE users SET name = 'it's me' WHERE id = '2' (only if name is still 'bob')");
      dbSmokeHooks.ask = async () => false;
      sent.length = 0;
      expect((await submitEdits(conn(), "public", users, ["id", "name", "avatar"], [["1", "ann", null], ["2", "bob", null]], staged)).error).toContain("Cancelled");
      expect(sent).toEqual([]);
      dbSmokeHooks.ask = async () => true;
      fake.handlers.set("db_update_rows", () => Promise.reject("Row 1: matched 0 rows (it changed or was deleted since it was loaded); nothing was saved"));
      expect((await submitEdits(conn(), "public", users, ["id", "name", "avatar"], [["1", "ann", null], ["2", "bob", null]], staged)).error).toContain("nothing was saved");
    } finally {
      dbSmokeHooks.ask = undefined;
    }
  });

  it("clicking into a NULL cell and away stages nothing; Set NULL stages NULL (review 13)", () => {
    const staged = new Map<number, Map<number, string | null>>();
    const edit = { staged, onChange: () => {}, blocked: () => null } as import("../db").GridEdit;
    const g = grid(["id", "bio"], [["1", null], ["2", "x"]], { edit });
    document.body.append(g);
    const td = () => g.querySelectorAll("tbody tr")[0].children[1] as HTMLElement;
    td().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    td().querySelector("input")!.dispatchEvent(new FocusEvent("blur"));
    expect(staged.size).toBe(0);
    td().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    td().querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(staged.size).toBe(0);
    const cell = g.querySelectorAll("tbody tr")[1].children[1] as HTMLElement;
    cell.click();
    edit.setNull!();
    expect(staged.get(1)?.get(1)).toBeNull();
    g.remove();
  });

  it("maps a model file to its table and documents it", () => {
    expect(tableForModel("/app/app/models/blog_post.rb")).toBe("blog_posts");
    expect(tableForModel("/app/app/models/admin/person.rb")).toBe("people");
    expect(tableForModel("/app/app/controllers/x.rb")).toBeNull();
    expect(tableDoc(users)).toContain("| id (PK) | integer not null |");
  });

  it("offers config/database.yml once per Rails project", async () => {
    const { state } = await import("../state");
    fake.reset();
    state.project = { root: "/rails", name: "rails", rails: true } as typeof state.project;
    await dbProjectOpened();
    const t = [...document.querySelectorAll(".toast")].pop()!;
    expect(t.textContent).toContain("Database detected");
    [...t.querySelectorAll("button")].find((b) => b.textContent === "Ignore")!.click();
    await vi.waitFor(() => expect(JSON.parse(fake.config.get("db-connections.json") ?? "{}")["/rails"]?.noticed).toBe(true));
    const before = document.querySelectorAll(".toast").length;
    await dbProjectOpened();
    expect(document.querySelectorAll(".toast").length).toBe(before);
    state.project = null;
  });
});
