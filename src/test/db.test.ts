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
