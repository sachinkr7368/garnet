import { ask } from "@tauri-apps/plugin-dialog";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fake } from "./fakeIpc";

vi.mock("../editor", () => import("./fakeEditor"));
const { mergeConnections, overrideFrom, runBatch, completions, unresolvedFields } = await import("../db");
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
