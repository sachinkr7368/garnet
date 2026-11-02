#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Dialect {
    Postgres,
    Mysql,
    Sqlite,
}

pub const ONE_STATEMENT: &str = "Run one statement at a time";
pub const READ_ONLY: &str = "Read-only connection: only queries are allowed";
/// Prefix of the error asking the frontend to confirm a destructive statement: `CONFIRM:<token>:<reason>`.
pub const CONFIRM: &str = "CONFIRM:";

#[derive(Debug, Default, PartialEq)]
pub struct Scan {
    pub first_keyword: Option<String>,
    pub has_eq: bool,
    pub depth: i32,
    pub min_depth: i32,
    /// Unquoted words (uppercased) with their paren depth, in order.
    pub words: Vec<(String, i32)>,
}

impl Scan {
    fn has(&self, w: &str) -> bool {
        self.words.iter().any(|(x, _)| x == w)
    }

    /// Why the statement needs an explicit confirmation: DROP/TRUNCATE/ALTER, or UPDATE/DELETE without a WHERE
    /// at its own level. Mirrors `classify` in src/sqlsafety.ts.
    pub fn destructive(&self) -> Option<String> {
        let first = self.first_keyword.as_deref().unwrap_or("");
        if matches!(first, "DROP" | "TRUNCATE" | "ALTER") {
            return Some(format!("{first} statement"));
        }
        for (k, (w, depth)) in self.words.iter().enumerate() {
            if w != "UPDATE" && w != "DELETE" {
                continue;
            }
            let prev = k.checked_sub(1).map(|p| self.words[p].0.as_str());
            if matches!(prev, Some("FOR" | "ON" | "KEY" | "DO" | "NO")) {
                continue;
            }
            let rest = self.words[k + 1..].iter().take_while(|(_, d)| d >= depth);
            if !rest.filter(|(_, d)| d == depth).any(|(x, _)| x == "WHERE") {
                return Some(format!("{w} without a WHERE clause"));
            }
        }
        None
    }
}

/// Checks `sql` is exactly one statement (trailing `;`, whitespace and comments allowed).
/// Postgres and MySQL are scanned with and without backslash escapes in strings, since the
/// server setting is unknown; both readings must agree there is one statement.
pub fn check_single(sql: &str, d: Dialect) -> Result<Scan, String> {
    let first = scan(sql, d, false)?;
    if d != Dialect::Sqlite {
        scan(sql, d, true)?;
    }
    Ok(first)
}

pub fn check_read_only(s: &Scan, d: Dialect) -> Result<(), String> {
    let ok = match s.first_keyword.as_deref().unwrap_or("") {
        "SELECT" | "WITH" | "EXPLAIN" | "SHOW" | "VALUES" | "TABLE" | "DESCRIBE" | "DESC" => true,
        "PRAGMA" => d == Dialect::Sqlite && !s.has_eq,
        _ => false,
    } && !s.has("INTO") && !s.has("OUTFILE") && !s.has("DUMPFILE");
    ok.then_some(()).ok_or_else(|| READ_ONLY.into())
}

fn is_ident(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c >= 0x80
}

fn skip_quoted(b: &[u8], start: usize, q: u8, backslash: bool) -> Result<usize, String> {
    let mut i = start + 1;
    while i < b.len() {
        if backslash && b[i] == b'\\' {
            i += 2;
        } else if b[i] == q {
            if b.get(i + 1) == Some(&q) {
                i += 2;
            } else {
                return Ok(i + 1);
            }
        } else {
            i += 1;
        }
    }
    Err("Unterminated quoted string or identifier".into())
}

/// End of a Postgres `$tag$` opener starting at `i`, if it is one (`$1` is a parameter).
fn dollar_tag(b: &[u8], i: usize) -> Option<usize> {
    let mut j = i + 1;
    if b.get(j).is_some_and(|c| c.is_ascii_digit()) {
        return None;
    }
    while j < b.len() && is_ident(b[j]) {
        j += 1;
    }
    (b.get(j) == Some(&b'$')).then_some(j + 1)
}

/// MySQL only treats `--` as a comment when whitespace or a control character follows (`1--1` is 1 - -1).
fn mysql_dash_comment(b: &[u8], i: usize) -> bool {
    b.get(i + 2).map_or(true, |c| c.is_ascii_whitespace() || c.is_ascii_control())
}

fn scan(sql: &str, d: Dialect, backslash: bool) -> Result<Scan, String> {
    let b = sql.as_bytes();
    let mut s = Scan::default();
    let (mut i, mut ended, mut exec_comment) = (0, false, false);
    while i < b.len() {
        let c = b[i];
        let next = b.get(i + 1).copied();
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if (c == b'-' && next == Some(b'-') && (d != Dialect::Mysql || mysql_dash_comment(b, i))) || (c == b'#' && d == Dialect::Mysql) {
            i = b[i..].iter().position(|&x| x == b'\n').map_or(b.len(), |p| i + p + 1);
            continue;
        }
        if c == b'/' && next == Some(b'*') {
            if d == Dialect::Mysql && b.get(i + 2) == Some(&b'!') {
                // MySQL runs the body of /*! ... */ as SQL, so scan it as code.
                i += 3;
                while i < b.len() && b[i].is_ascii_digit() {
                    i += 1;
                }
                exec_comment = true;
                continue;
            }
            let (mut depth, mut j) = (1, i + 2);
            while depth > 0 {
                match (b.get(j), b.get(j + 1)) {
                    (None, _) => return Err("Unterminated comment".into()),
                    (Some(b'*'), Some(b'/')) => {
                        depth -= 1;
                        j += 2;
                    }
                    (Some(b'/'), Some(b'*')) if d == Dialect::Postgres => {
                        depth += 1;
                        j += 2;
                    }
                    _ => j += 1,
                }
            }
            i = j;
            continue;
        }
        if exec_comment && c == b'*' && next == Some(b'/') {
            exec_comment = false;
            i += 2;
            continue;
        }
        if c == b';' {
            ended = true;
            i += 1;
            continue;
        }
        if ended {
            return Err(ONE_STATEMENT.into());
        }
        match c {
            b'\'' => i = skip_quoted(b, i, b'\'', backslash)?,
            b'"' => i = skip_quoted(b, i, b'"', d == Dialect::Mysql && backslash)?,
            b'`' if d != Dialect::Postgres => i = skip_quoted(b, i, b'`', false)?,
            b'[' if d == Dialect::Sqlite => {
                i = b[i..].iter().position(|&x| x == b']').map(|p| i + p + 1).ok_or("Unterminated identifier")?;
            }
            b'$' if d == Dialect::Postgres && dollar_tag(b, i).is_some() => {
                let end = dollar_tag(b, i).unwrap_or(i + 1);
                let tag = &b[i..end];
                let close = b[end..].windows(tag.len()).position(|w| w == tag).ok_or("Unterminated dollar-quoted string")?;
                i = end + close + tag.len();
            }
            c if c.is_ascii_alphabetic() || c == b'_' || c >= 0x80 => {
                let start = i;
                while i < b.len() && (is_ident(b[i]) || b[i] == b'$') {
                    i += 1;
                }
                let word = &sql[start..i];
                if d == Dialect::Postgres && word.eq_ignore_ascii_case("e") && b.get(i) == Some(&b'\'') {
                    i = skip_quoted(b, i, b'\'', true)?;
                } else {
                    let up = word.to_ascii_uppercase();
                    s.first_keyword.get_or_insert_with(|| up.clone());
                    s.words.push((up, s.depth));
                }
            }
            _ => {
                match c {
                    b'(' => s.depth += 1,
                    b')' => {
                        s.depth -= 1;
                        s.min_depth = s.min_depth.min(s.depth);
                    }
                    b'=' => s.has_eq = true,
                    _ => {}
                }
                i += 1;
            }
        }
    }
    if exec_comment {
        return Err("Unterminated comment".into());
    }
    Ok(s)
}

pub fn quote_ident(name: &str, d: Dialect) -> String {
    match d {
        Dialect::Mysql => format!("`{}`", name.replace('`', "``")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

/// `(page, count)` SQL for a table grid. The user's filter is wrapped as `WHERE (\n…\n)` so a
/// trailing `--` comment cannot swallow the rest, and both statements must pass the one-statement check.
#[allow(clippy::too_many_arguments)]
pub fn page_sql(
    d: Dialect,
    schema: &str,
    table: &str,
    filter: Option<&str>,
    order_by: Option<&str>,
    desc: bool,
    limit: u32,
    offset: u32,
) -> Result<(String, String), String> {
    let from = format!("{}.{}", quote_ident(schema, d), quote_ident(table, d));
    let filter = filter.map(str::trim).filter(|f| !f.is_empty());
    let mut cond = String::new();
    if let Some(f) = filter {
        let s = check_single(f, d)?;
        if s.depth != 0 || s.min_depth < 0 {
            return Err("Unbalanced parentheses in filter".into());
        }
        cond = format!(" WHERE (\n{}\n)", f.trim_end_matches(';'));
    }
    let order = order_by
        .filter(|c| !c.is_empty())
        .map(|c| format!(" ORDER BY {} {}", quote_ident(c, d), if desc { "DESC" } else { "ASC" }))
        .unwrap_or_default();
    let page = format!("SELECT * FROM {from}{cond}{order} LIMIT {limit} OFFSET {offset}");
    let count = format!("SELECT COUNT(*) FROM {from}{cond}");
    check_single(&page, d)?;
    check_single(&count, d)?;
    Ok((page, count))
}

const PG_NS: &str = "n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'";

/// Catalog queries returning rows of:
/// schemas `(schema)`; columns `(schema, table, kind, column, type, nullable, default, pk)`;
/// indexes `(schema, table, index, unique, column)`;
/// foreign keys `(schema, table, name, column, ref_schema, ref_table, ref_column, group_key)`.
pub fn schema_queries(d: Dialect) -> [String; 4] {
    match d {
        Dialect::Postgres => [
            format!("SELECT n.nspname FROM pg_namespace n WHERE {PG_NS} ORDER BY 1"),
            format!(
                "SELECT n.nspname, c.relname, c.relkind::text, a.attname, format_type(a.atttypid, a.atttypmod), \
                 NOT a.attnotnull, pg_get_expr(d.adbin, d.adrelid), COALESCE(a.attnum = ANY(i.indkey), false) \
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped \
                 LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum \
                 LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary \
                 WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND {PG_NS} ORDER BY 1, 2, a.attnum"
            ),
            format!(
                "SELECT n.nspname, t.relname, ic.relname, ix.indisunique, pg_get_indexdef(ix.indexrelid, k.n, true) \
                 FROM pg_index ix JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_class ic ON ic.oid = ix.indexrelid \
                 JOIN pg_namespace n ON n.oid = t.relnamespace \
                 CROSS JOIN LATERAL generate_series(1, ix.indnatts::int) AS k(n) \
                 WHERE {PG_NS} ORDER BY 1, 2, 3, k.n"
            ),
            format!(
                "SELECT n.nspname, t.relname, con.conname, a.attname, rn.nspname, rt.relname, ra.attname, con.oid::text \
                 FROM pg_constraint con JOIN pg_class t ON t.oid = con.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace \
                 JOIN pg_class rt ON rt.oid = con.confrelid JOIN pg_namespace rn ON rn.oid = rt.relnamespace \
                 CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(col, refcol, ord) \
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.col \
                 JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.refcol \
                 WHERE con.contype = 'f' AND {PG_NS} ORDER BY 1, 2, 8, k.ord"
            ),
        ],
        Dialect::Mysql => [
            "SELECT DATABASE()".into(),
            "SELECT t.TABLE_SCHEMA, t.TABLE_NAME, t.TABLE_TYPE, c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, \
             c.COLUMN_DEFAULT, c.COLUMN_KEY = 'PRI' FROM information_schema.TABLES t \
             LEFT JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME \
             WHERE t.TABLE_SCHEMA = DATABASE() ORDER BY t.TABLE_NAME, c.ORDINAL_POSITION"
                .into(),
            "SELECT TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, NON_UNIQUE = 0, COLUMN_NAME FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX"
                .into(),
            "SELECT TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, \
             REFERENCED_COLUMN_NAME, CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE \
             WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL \
             ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION"
                .into(),
        ],
        Dialect::Sqlite => [
            "SELECT 'main'".into(),
            r#"SELECT 'main', m.name, m.type, p.name, p.type, NOT p."notnull", p.dflt_value, p.pk > 0
               FROM sqlite_master m LEFT JOIN pragma_table_info(m.name) p
               WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite\_%' ESCAPE '\' ORDER BY m.name, p.cid"#
                .into(),
            r#"SELECT 'main', m.name, il.name, il."unique", ii.name
               FROM sqlite_master m JOIN pragma_index_list(m.name) il JOIN pragma_index_info(il.name) ii
               WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite\_%' ESCAPE '\' ORDER BY m.name, il.name, ii.seqno"#
                .into(),
            r#"SELECT 'main', m.name, NULL, f."from", 'main', f."table", f."to", f.id
               FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
               WHERE m.type = 'table' ORDER BY m.name, f.id, f.seq"#
                .into(),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Dialect::*;

    fn one(sql: &str, d: Dialect) -> bool {
        check_single(sql, d).is_ok()
    }

    #[test]
    fn single_statement_check_respects_strings_comments_and_quotes() {
        for d in [Postgres, Mysql, Sqlite] {
            assert!(one("SELECT 1", d));
            assert!(one("SELECT 1;", d));
            assert!(one("SELECT 1 ;; \n -- done\n /* bye */ ;", d));
            assert!(one("SELECT 'a;b', 'it''s;' FROM t", d));
            assert!(one("SELECT \"we;ird\"\"col\" FROM t", d));
            assert!(one("SELECT 1 -- ; DROP TABLE t\n", d));
            assert!(one("SELECT /* ; */ 1", d));
            assert!(!one("SELECT 1; SELECT 2", d));
            assert!(!one("SELECT 1; -- c\n DROP TABLE t", d));
            assert!(!one("SELECT 'a'; DELETE FROM t", d));
            assert!(check_single("SELECT 'oops", d).is_err());
            assert!(check_single("SELECT /* oops", d).is_err());
        }
        assert!(one("SELECT `a;b` FROM t", Mysql));
        assert!(one("SELECT [a;b] FROM t", Sqlite));
        assert!(one("SELECT 1 # ; DROP\n", Mysql));
        assert!(!one("SELECT 1 # x\n; DROP TABLE t", Mysql));
        assert!(!one("SELECT 1 /*!; DROP TABLE t */", Mysql));
        assert!(check_single("/*!50000 DELETE FROM t */", Mysql).unwrap().first_keyword.as_deref() == Some("DELETE"));
    }

    #[test]
    fn backslash_escapes_are_checked_both_ways() {
        // With backslash escapes the string ends at the second quote; without, at the first.
        assert!(!one(r"SELECT '\'; DROP TABLE t; --'", Mysql));
        assert!(!one(r"SELECT '\'; DROP TABLE t; --'", Postgres));
        assert!(one(r"SELECT 'a\\b;'", Mysql));
        assert!(one(r"SELECT E'it\'s;'", Postgres));
        assert!(one(r"SELECT 'C:\dir;'", Sqlite));
    }

    #[test]
    fn postgres_dollar_quotes_and_nested_comments() {
        assert!(one("SELECT $$a;b$$", Postgres));
        assert!(one("SELECT $fn$ x; $$ y; $fn$;", Postgres));
        assert!(one("SELECT $1 FROM t", Postgres));
        assert!(one("SELECT a$b FROM t", Postgres));
        assert!(!one("SELECT $$a$$; DROP TABLE t", Postgres));
        assert!(one("/* a /* b ; */ c ; */ SELECT 1", Postgres));
        assert!(check_single("SELECT $tag$ open", Postgres).is_err());
    }

    #[test]
    fn first_keyword_and_read_only_rules() {
        let kw = |s: &str| check_single(s, Postgres).unwrap().first_keyword;
        assert_eq!(kw("  -- c\n /* x */ ((select 1))").as_deref(), Some("SELECT"));
        assert_eq!(kw("with x as (select 1) select * from x").as_deref(), Some("WITH"));
        assert_eq!(kw("-- nothing"), None);
        let ro = |s: &str, d| check_read_only(&check_single(s, d).unwrap(), d).is_ok();
        for ok in ["SELECT 1", "with a as (select 1) select 1", "EXPLAIN SELECT 1", "SHOW search_path", "VALUES (1)", "TABLE t"] {
            assert!(ro(ok, Postgres), "{ok}");
        }
        for bad in ["INSERT INTO t VALUES (1)", "UPDATE t SET a = 1", "DROP TABLE t", "DELETE FROM t", "SET x = 1", "BEGIN", "-- only"] {
            assert!(!ro(bad, Postgres), "{bad}");
        }
        assert!(ro("DESCRIBE t", Mysql));
        assert!(ro("PRAGMA table_info(t)", Sqlite));
        assert!(!ro("PRAGMA query_only = OFF", Sqlite));
        assert!(!ro("PRAGMA table_info(t)", Postgres));
    }

    #[test]
    fn mysql_dash_needs_whitespace_to_start_a_comment() {
        let attack = "SELECT 1--1; COMMIT; SET SESSION TRANSACTION READ WRITE; DELETE FROM t";
        assert_eq!(check_single(attack, Mysql).unwrap_err(), ONE_STATEMENT);
        assert!(page_sql(Mysql, "app", "t", Some("1--1) OR (1"), None, false, 10, 0).is_err());
        assert!(page_sql(Mysql, "app", "t", Some("id = 1--1; DELETE FROM t"), None, false, 10, 0).is_err());
        assert!(one("SELECT 1 -- ; DROP\n", Mysql));
        assert!(one("SELECT 1 --\t; x\n", Mysql));
        assert!(one("SELECT 1 --", Mysql));
        assert!(one("SELECT 1--1; ", Postgres));
        assert!(!one("SELECT 1--1; DROP TABLE t", Mysql));
    }

    #[test]
    fn read_only_refuses_into_outfile_and_select_into() {
        let ro = |s: &str, d| check_read_only(&check_single(s, d).unwrap(), d).is_ok();
        assert!(!ro("SELECT * FROM t INTO OUTFILE '/tmp/x'", Mysql));
        assert!(!ro("SELECT 'x' INTO DUMPFILE '/tmp/x'", Mysql));
        assert!(!ro("SELECT * INTO t2 FROM t", Postgres));
        assert!(ro("SELECT 'into' AS \"into\" FROM t", Postgres));
    }

    #[test]
    fn destructive_statements_need_confirmation() {
        let why = |s: &str| check_single(s, Postgres).unwrap().destructive();
        for (sql, reason) in [
            ("DROP TABLE t", "DROP statement"),
            ("truncate t", "TRUNCATE statement"),
            ("ALTER TABLE t ADD c int", "ALTER statement"),
            ("DELETE FROM t", "DELETE without a WHERE clause"),
            ("update t set a = 1", "UPDATE without a WHERE clause"),
            ("UPDATE t SET a = (SELECT b FROM u WHERE u.id = 1)", "UPDATE without a WHERE clause"),
            ("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x", "DELETE without a WHERE clause"),
        ] {
            assert_eq!(why(sql).as_deref(), Some(reason), "{sql}");
        }
        for sql in ["DELETE FROM t WHERE id = 1", "UPDATE t SET a = 1 WHERE id = 2", "SELECT * FROM t FOR UPDATE", "INSERT INTO t VALUES (1) ON CONFLICT DO NOTHING", "SELECT 'drop table t'"] {
            assert_eq!(why(sql), None, "{sql}");
        }
    }

    #[test]
    fn quotes_identifiers_per_engine() {
        assert_eq!(quote_ident("users", Postgres), "\"users\"");
        assert_eq!(quote_ident("we\"ird", Postgres), "\"we\"\"ird\"");
        assert_eq!(quote_ident("we\"ird", Sqlite), "\"we\"\"ird\"");
        assert_eq!(quote_ident("we`ird", Mysql), "`we``ird`");
    }

    #[test]
    fn builds_page_sql_and_rejects_filter_injection() {
        let (page, count) = page_sql(Postgres, "public", "users", Some("age > 3"), Some("name"), true, 50, 100).unwrap();
        assert_eq!(page, "SELECT * FROM \"public\".\"users\" WHERE (\nage > 3\n) ORDER BY \"name\" DESC LIMIT 50 OFFSET 100");
        assert_eq!(count, "SELECT COUNT(*) FROM \"public\".\"users\" WHERE (\nage > 3\n)");
        let (page, _) = page_sql(Mysql, "app", "t", None, Some("x`y"), false, 10, 0).unwrap();
        assert_eq!(page, "SELECT * FROM `app`.`t` ORDER BY `x``y` ASC LIMIT 10 OFFSET 0");
        let (page, _) = page_sql(Sqlite, "main", "t", Some("  "), None, false, 10, 0).unwrap();
        assert_eq!(page, "SELECT * FROM \"main\".\"t\" LIMIT 10 OFFSET 0");
        assert!(page_sql(Sqlite, "main", "t", Some("a = 1 -- trailing"), None, false, 10, 0).is_ok());
        for bad in ["1=1; DROP TABLE t", "1=1) OR (1=1", "1=1) --", "(1=1", "1=1 /*", "'x"] {
            assert!(page_sql(Postgres, "public", "t", Some(bad), None, false, 10, 0).is_err(), "{bad}");
        }
    }

    #[test]
    fn schema_queries_cover_each_engine() {
        let pg = schema_queries(Postgres);
        assert!(pg[0].contains("pg_namespace") && pg[0].contains("pg\\_toast"));
        assert!(pg[1].contains("format_type") && pg[1].contains("indisprimary"));
        assert!(pg[2].contains("pg_get_indexdef"));
        assert!(pg[3].contains("contype = 'f'"));
        let my = schema_queries(Mysql);
        assert!(my.iter().skip(1).all(|q| q.contains("DATABASE()")));
        let lite = schema_queries(Sqlite);
        assert!(lite[1].contains("pragma_table_info") && lite[2].contains("pragma_index_info") && lite[3].contains("pragma_foreign_key_list"));
        for (d, qs) in [(Postgres, pg), (Mysql, my), (Sqlite, lite)] {
            for q in qs {
                assert!(one(&q, d), "{q}");
            }
        }
    }
}
