import { describe, expect, it } from "vitest";
import { classify, defaultReadOnly, isLocalHost, splitStatements, sqlLiteral, statementAt, toCsv, toJson, toMarkdown, toSqlInsert, tokenize, updateSql, withAutoLimit } from "../sqlsafety";

const texts = (sql: string, d?: "postgres" | "mysql" | "sqlite") => splitStatements(sql, d).map((s) => s.text);

describe("tokenizer and statement splitting", () => {
  it("splits on top-level semicolons only", () => {
    expect(texts("select 1; select 2;")).toEqual(["select 1", "select 2"]);
    expect(texts("select ';' ; select \"a;b\" from t")).toEqual(["select ';'", 'select "a;b" from t']);
    expect(texts("select 1 -- ; not here\n; select 2 /* ; */")).toEqual(["select 1 -- ; not here", "select 2 /* ; */"]);
    expect(texts("select 'it''s;'; select 2")).toEqual(["select 'it''s;'", "select 2"]);
  });

  it("handles dollar quotes, nested comments and E-strings in Postgres", () => {
    expect(texts("do $$ begin; end $$; select 1")).toEqual(["do $$ begin; end $$", "select 1"]);
    expect(texts("select $fn$ a;b $fn$; select $1")).toEqual(["select $fn$ a;b $fn$", "select $1"]);
    expect(texts("/* a /* b; */ c; */ select 1; select 2")).toEqual(["/* a /* b; */ c; */ select 1", "select 2"]);
    expect(texts("select E'a\\';b'; select 2")).toEqual(["select E'a\\';b'", "select 2"]);
  });

  it("uses MySQL quoting rules", () => {
    expect(texts("select 'a\\';b'; select `x;y` # c;\n; select 3", "mysql")).toEqual(["select 'a\\';b'", "select `x;y` # c;", "select 3"]);
    expect(tokenize('"x;y"', "mysql")[0].type).toBe("string");
    expect(tokenize('"x;y"', "postgres")[0].type).toBe("ident");
  });

  it("drops comment-only pieces", () => {
    expect(texts("select 1; -- trailing\n")).toEqual(["select 1"]);
    expect(texts(";;  ;")).toEqual([]);
  });

  it("finds the statement at the caret", () => {
    const sql = "select 1;\nselect 2;\n\nselect 3";
    expect(statementAt(sql, 0)?.text).toBe("select 1");
    expect(statementAt(sql, 9)?.text).toBe("select 1");
    expect(statementAt(sql, 12)?.text).toBe("select 2");
    expect(statementAt(sql, sql.length)?.text).toBe("select 3");
    const s = statementAt(sql, 13)!;
    expect(sql.slice(s.start, s.end)).toBe("select 2");
    expect(statementAt("select 1; -- note", 16)?.text).toBe("select 1");
    expect(statementAt("", 0)).toBeNull();
  });
});

describe("classify", () => {
  const kind = (sql: string, d?: "postgres" | "mysql" | "sqlite") => classify(sql, d).kind;

  it("reads", () => {
    for (const sql of ["SELECT 1", "select * from users", "  -- c\n/* x */ select 1", "(select 1)", "show tables", "describe users", "desc users", "explain select 1", "values (1)", "table users", "pragma table_info(users)", "with a as (select 1) select * from a"])
      expect(kind(sql), sql).toBe("read");
  });

  it("writes", () => {
    for (const sql of ["insert into t values (1)", "UPDATE t SET a = 1 WHERE id = 1", "delete from t where id = 1", "-- x\ninsert into t default values", "with a as (delete from t where x returning *) select * from a", "with a as (select 1) delete from t where id in (select * from a)", "explain analyze delete from t where id = 1", "explain (analyze, buffers) update t set a = 1 where b = 2", "select * into t2 from t", "select * from t for update", "select * from t for no key update", "select * from t lock in share mode", "pragma foreign_keys = on", "replace into t values (1)"])
      expect(kind(sql, sql.includes("lock in share") || sql.startsWith("replace") ? "mysql" : sql.startsWith("pragma") ? "sqlite" : "postgres"), sql).toBe("write");
  });

  it("explain without analyze is a read", () => {
    expect(kind("explain delete from t")).toBe("read");
    expect(kind("explain analyze select 1")).toBe("read");
  });

  it("ddl, tx and other", () => {
    expect(kind("create table t (id int)")).toBe("ddl");
    expect(kind("drop table t")).toBe("ddl");
    expect(kind("alter table t add c int")).toBe("ddl");
    expect(kind("truncate t")).toBe("ddl");
    expect(kind("begin")).toBe("tx");
    expect(kind("commit")).toBe("tx");
    expect(kind("set search_path = x")).toBe("other");
    expect(kind("vacuum")).toBe("other");
    expect(kind("-- only a comment")).toBe("other");
  });

  it("flags dangerous statements", () => {
    const danger = (sql: string) => classify(sql).dangerous;
    expect(danger("update t set a = 1")).toBe(true);
    expect(danger("delete from t")).toBe(true);
    expect(danger("delete from t where id = 1")).toBe(false);
    expect(danger("update t set a = 1 where id = 1")).toBe(false);
    expect(danger("delete from t -- where id = 1")).toBe(true);
    expect(danger("delete from t /* where */")).toBe(true);
    expect(danger("update t set a = 'where'")).toBe(true);
    expect(danger("update t set a = (select b from u where u.id = 1)")).toBe(true);
    expect(danger("with x as (delete from t returning *) select * from x where 1 = 1")).toBe(true);
    expect(danger("insert into t values (1) on conflict (id) do update set a = 1")).toBe(false);
    expect(danger("select * from t for update")).toBe(false);
    expect(danger("drop table t")).toBe(true);
    expect(danger("truncate t")).toBe(true);
    expect(danger("alter table t drop column c")).toBe(true);
    expect(danger("create table t (id int references u on delete cascade)")).toBe(false);
    expect(classify("delete from t").reason).toBe("DELETE without a WHERE clause");
  });
});

describe("auto LIMIT", () => {
  const lim = (sql: string, d?: "postgres" | "mysql" | "sqlite") => withAutoLimit(sql, 500, d);
  it("appends to selects without a top-level limit", () => {
    expect(lim("select * from t")).toBe("select * from t LIMIT 500");
    expect(lim("with a as (select 1) select * from a")).toBe("with a as (select 1) select * from a LIMIT 500");
    expect(lim("select * from (select * from t limit 5) s")).toBe("select * from (select * from t limit 5) s LIMIT 500");
    expect(lim("select * from t;")).toBe("select * from t LIMIT 500;");
    expect(lim("select * from t -- note")).toBe("select * from t LIMIT 500 -- note");
    expect(lim("select * from t /* a */ ; -- b")).toBe("select * from t LIMIT 500 /* a */ ; -- b");
  });
  it("leaves limited and non-select statements alone", () => {
    for (const sql of ["select * from t limit 10", "SELECT * FROM t LIMIT ALL", "select * from t fetch first 5 rows only", "select top 5 * from t", "update t set a = 1", "show tables", "explain select 1", "select * from t for update", "values (1)", "-- nothing"])
      expect(lim(sql), sql).toBe(sql);
  });
});

describe("read-only defaults", () => {
  it("is read-only outside development", () => {
    expect(defaultReadOnly("development", "postgres", "localhost")).toBe(false);
    expect(defaultReadOnly("development/primary", "postgres", "127.0.0.1")).toBe(false);
    expect(defaultReadOnly("production", "postgres", "localhost")).toBe(true);
    expect(defaultReadOnly("test", "sqlite", "")).toBe(true);
    expect(defaultReadOnly("staging/replica", "mysql", "localhost")).toBe(true);
  });
  it("is read-only for remote or unknown hosts", () => {
    expect(defaultReadOnly("development", "postgres", "db.internal")).toBe(true);
    expect(defaultReadOnly("development", "postgres", null)).toBe(true);
    expect(defaultReadOnly(undefined, "postgres", "10.0.0.5")).toBe(true);
    expect(defaultReadOnly(undefined, "postgres", "::1")).toBe(false);
    expect(defaultReadOnly(undefined, "sqlite", "")).toBe(false);
    expect(defaultReadOnly(undefined, "sqlite", "remote")).toBe(false);
  });
  it("knows local hosts", () => {
    for (const h of ["", "localhost", "LOCALHOST", "127.0.0.1", "::1", "[::1]", "/var/run/postgresql"]) expect(isLocalHost(h), h).toBe(true);
    for (const h of ["db", "127.0.0.2", "example.com"]) expect(isLocalHost(h), h).toBe(false);
  });
});

describe("export formatting", () => {
  it("escapes CSV per RFC 4180", () => {
    expect(toCsv(["a", "b"], [["1", null], ['x "y"', "c,d"], ["line\nbreak", ""]])).toBe('a,b\r\n1,\r\n"x ""y""","c,d"\r\n"line\nbreak",""\r\n');
  });
  it("writes JSON arrays of objects", () => {
    expect(JSON.parse(toJson(["id", "name", "id"], [["1", null, "2"]]))).toEqual([{ id: "1", name: null, id_2: "2" }]);
    expect(JSON.parse(toJson(["a"], []))).toEqual([]);
  });
});

describe("MySQL -- comments (B10)", () => {
  it("needs whitespace after -- so 1--1 cannot hide a second statement", () => {
    const attack = "SELECT 1--1; COMMIT; SET SESSION TRANSACTION READ WRITE; DELETE FROM t";
    expect(splitStatements(attack, "mysql")).toHaveLength(4);
    expect(classify(attack, "mysql")).toMatchObject({ dangerous: true, kind: "write" });
    expect(texts("SELECT 1 -- ; x\nSELECT 2", "mysql")).toEqual(["SELECT 1 -- ; x\nSELECT 2"]);
    expect(texts("SELECT 1 --\t; x", "mysql")).toEqual(["SELECT 1 --\t; x"]);
    expect(texts("SELECT 1--1; SELECT 2", "postgres")).toEqual(["SELECT 1--1; SELECT 2"]);
  });
});

describe("exports (B74)", () => {
  it("CSV tells NULL from an empty string and defuses spreadsheet formulas", () => {
    expect(toCsv(["v"], [[null], [""], ["=HYPERLINK(1)"], ["+1+1"], ["@SUM(A1)"], ["-5"], ["1e3"], ["-x"]])).toBe('v\r\n\r\n""\r\n\'=HYPERLINK(1)\r\n\'+1+1\r\n\'@SUM(A1)\r\n-5\r\n1e3\r\n\'-x\r\n');
    expect(toCsv(["v"], [["=1,2"]])).toBe('v\r\n"\'=1,2"\r\n');
  });

  it("JSON renames duplicate columns without colliding with a real column", () => {
    expect(JSON.parse(toJson(["a", "a", "a_2"], [["1", "2", "3"]]))).toEqual([{ a: "1", a_2: "2", a_2_2: "3" }]);
    expect(Object.keys(JSON.parse(toJson(["a_2", "a", "a"], [["1", "2", "3"]]))[0])).toEqual(["a_2", "a", "a_3"]);
  });

  it("SQL INSERT and Markdown", () => {
    expect(toSqlInsert("t", ["id", "name"], [["1", "it's"], ["2", null]], "sqlite")).toBe(`INSERT INTO "t" ("id", "name") VALUES ('1', 'it''s');\nINSERT INTO "t" ("id", "name") VALUES ('2', NULL);\n`);
    expect(toMarkdown(["a", "b"], [["x|y", null], ["1\n2", ""]])).toBe("| a | b |\n| --- | --- |\n| x\\|y | NULL |\n| 1<br>2 |  |\n");
  });
});

describe("cell edit UPDATEs", () => {
  it("quotes values so no server setting can misread them", () => {
    expect(sqlLiteral("it's \\ $g$", "postgres")).toBe("$g0$it's \\ $g$$g0$");
    expect(sqlLiteral("a$g", "postgres")).toBe("$g0$a$g$g0$");
    expect(sqlLiteral("x", "postgres")).toBe("$g$x$g$");
    expect(sqlLiteral("é'\\", "mysql")).toBe("_utf8mb4 X'c3a9275c'");
    expect(sqlLiteral("", "mysql")).toBe("''");
    expect(sqlLiteral(null, "sqlite")).toBe("NULL");
    for (const v of ["it's", "a$g", "$g$", "x\\'; DROP TABLE t; --"]) {
      const sql = `SELECT ${sqlLiteral(v, "postgres")}`;
      expect(splitStatements(sql, "postgres")).toHaveLength(1);
      expect(tokenize(sql, "postgres").filter((t) => t.type === "string")).toHaveLength(1);
    }
  });

  it("keys each UPDATE by the primary key and refuses without one", () => {
    const cols = ["id", "name", "bio"];
    expect(updateSql("postgres", "public", "users", ["id"], cols, ["7", "ann", null], new Map([[1, "bo"], [2, null]]))).toBe(
      'UPDATE "public"."users" SET "name" = $g$bo$g$, "bio" = NULL WHERE "id" = $g$7$g$',
    );
    expect(updateSql("sqlite", "main", "t", ["a", "b"], ["a", "b", "c"], ["1", "2", "x"], new Map([[2, "y"]]))).toBe(`UPDATE "t" SET "c" = 'y' WHERE "a" = '1' AND "b" = '2'`);
    expect(updateSql("postgres", "public", "t", [], cols, ["1", "a", "b"], new Map([[1, "x"]]))).toBeNull();
    expect(updateSql("postgres", "public", "t", ["id"], ["name"], ["a"], new Map([[0, "x"]]))).toBeNull();
    expect(updateSql("postgres", "public", "t", ["id"], cols, [null, "a", "b"], new Map([[1, "x"]]))).toBeNull();
  });
});
