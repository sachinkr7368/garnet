mod detect;
mod sql;

use crate::fsops::e2s;
use detect::redact_url;
use futures_util::StreamExt;
use mysql_async::prelude::Queryable;
use serde::{Deserialize, Serialize};
use sql::Dialect;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::State;

const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_ROWS: u32 = 10_000;
const MAX_PAGE: u32 = 1_000;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConnConfig {
    engine: String,
    host: String,
    port: Option<u16>,
    database: String,
    username: String,
    sslmode: Option<String>,
    read_only: bool,
    root: Option<String>,
}

#[derive(Serialize)]
pub struct ServerInfo {
    version: String,
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    rows_affected: Option<u64>,
    truncated: bool,
    elapsed_ms: u64,
}

#[derive(Serialize, Debug)]
pub struct TablePage {
    #[serde(flatten)]
    result: QueryResult,
    total: Option<u64>,
}

#[derive(Serialize, Default, Debug)]
pub struct Schema {
    schemas: Vec<SchemaInfo>,
}

#[derive(Serialize, Debug)]
pub struct SchemaInfo {
    name: String,
    tables: Vec<TableInfo>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    name: String,
    kind: &'static str,
    columns: Vec<Column>,
    indexes: Vec<Index>,
    foreign_keys: Vec<ForeignKey>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    name: String,
    data_type: String,
    nullable: bool,
    default: Option<String>,
    primary_key: bool,
}

#[derive(Serialize, Debug)]
pub struct Index {
    name: String,
    columns: Vec<String>,
    unique: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKey {
    name: Option<String>,
    columns: Vec<String>,
    ref_schema: Option<String>,
    ref_table: String,
    ref_columns: Vec<String>,
}

enum Driver {
    Pg(tokio_postgres::Client),
    My(mysql_async::Conn),
    Lite(Arc<Mutex<rusqlite::Connection>>),
    Closed,
}

#[allow(clippy::large_enum_variant)] // one per connection
enum Cancel {
    Pg(tokio_postgres::CancelToken, Option<postgres_native_tls::MakeTlsConnector>),
    My(mysql_async::Opts, u32),
    Lite(rusqlite::InterruptHandle),
}

struct Conn {
    dialect: Dialect,
    read_only: bool,
    /// The user ran BEGIN/START TRANSACTION in the console; our own read-only wrapping would end it.
    in_txn: AtomicBool,
    driver: tokio::sync::Mutex<Driver>,
    cancel: Cancel,
}

#[derive(Default)]
pub struct Db(Mutex<HashMap<String, Arc<Conn>>>);

fn pg_err(e: tokio_postgres::Error) -> String {
    let Some(db) = e.as_db_error() else { return e.to_string() };
    let mut s = format!("{}: {}", db.severity(), db.message());
    for extra in [db.detail(), db.hint()].into_iter().flatten() {
        s.push('\n');
        s.push_str(extra);
    }
    s
}

fn blob_text(b: &[u8]) -> String {
    if b.len() > 256 {
        return format!("<{} bytes>", b.len());
    }
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("\\x{hex}")
}

fn lite_text(v: rusqlite::types::ValueRef) -> Option<String> {
    use rusqlite::types::ValueRef::*;
    match v {
        Null => None,
        Integer(i) => Some(i.to_string()),
        Real(f) => Some(format!("{f:?}")),
        Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
        Blob(b) => Some(blob_text(b)),
    }
}

fn my_text(v: mysql_async::Value) -> Option<String> {
    match v {
        mysql_async::Value::NULL => None,
        mysql_async::Value::Bytes(b) => Some(String::from_utf8(b).unwrap_or_else(|e| blob_text(e.as_bytes()))),
        v => Some(v.as_sql(true).trim_matches('\'').to_string()),
    }
}

fn lite_exec(c: &rusqlite::Connection, sql: &str, max: u32, require_ro: bool) -> Result<QueryResult, String> {
    let mut stmt = c.prepare(sql).map_err(e2s)?;
    if require_ro && !stmt.readonly() {
        return Err(sql::READ_ONLY.into());
    }
    let mut r = QueryResult { columns: stmt.column_names().map(String::from).collect(), ..Default::default() };
    if r.columns.is_empty() {
        r.rows_affected = Some(stmt.execute([]).map_err(e2s)? as u64);
        return Ok(r);
    }
    let n = r.columns.len();
    let mut rows = stmt.query([]).map_err(e2s)?;
    while let Some(row) = rows.next().map_err(e2s)? {
        if r.rows.len() >= max as usize {
            r.truncated = true;
            break;
        }
        r.rows.push((0..n).map(|i| row.get_ref(i).map(lite_text)).collect::<Result<_, _>>().map_err(e2s)?);
    }
    Ok(r)
}

impl Driver {
    /// Runs one statement. `require_ro` makes SQLite refuse statements that would write.
    async fn exec(&mut self, sql: &str, max: u32, require_ro: bool) -> Result<QueryResult, String> {
        let mut r = QueryResult::default();
        match self {
            Driver::Pg(c) => {
                let stream = c.simple_query_raw(sql).await.map_err(pg_err)?;
                let mut stream = std::pin::pin!(stream);
                while let Some(msg) = stream.next().await {
                    match msg.map_err(pg_err)? {
                        tokio_postgres::SimpleQueryMessage::RowDescription(cols) => {
                            r.columns = cols.iter().map(|c| c.name().to_string()).collect();
                        }
                        tokio_postgres::SimpleQueryMessage::Row(row) => {
                            if r.rows.len() >= max as usize {
                                // ponytail: the server keeps sending the rest, the connection discards it.
                                r.truncated = true;
                                break;
                            }
                            r.rows.push((0..row.len()).map(|i| row.get(i).map(str::to_string)).collect());
                        }
                        tokio_postgres::SimpleQueryMessage::CommandComplete(n) if r.columns.is_empty() => r.rows_affected = Some(n),
                        _ => {}
                    }
                }
            }
            Driver::My(c) => {
                let mut res = c.query_iter(sql).await.map_err(e2s)?;
                r.columns = res.columns_ref().iter().map(|c| c.name_str().into_owned()).collect();
                while let Some(row) = res.next().await.map_err(e2s)? {
                    if r.rows.len() >= max as usize {
                        // ponytail: drains the rest client-side; KILL QUERY would stop the server sooner.
                        r.truncated = true;
                        continue;
                    }
                    r.rows.push(row.unwrap().into_iter().map(my_text).collect());
                }
                if r.columns.is_empty() {
                    r.rows_affected = Some(res.affected_rows());
                }
                res.drop_result().await.map_err(e2s)?;
            }
            Driver::Lite(c) => {
                let (c, sql) = (c.clone(), sql.to_string());
                let lock = move || lite_exec(&c.lock().unwrap_or_else(|p| p.into_inner()), &sql, max, require_ro);
                r = tokio::task::spawn_blocking(lock).await.map_err(e2s)??;
            }
            Driver::Closed => return Err("Connection closed".into()),
        }
        Ok(r)
    }
}

fn resolve_sqlite(cfg: &ConnConfig) -> PathBuf {
    let p = Path::new(&cfg.database);
    match &cfg.root {
        Some(root) if p.is_relative() => Path::new(root).join(p),
        _ => p.to_path_buf(),
    }
}

fn nonempty(s: &str) -> Option<String> {
    (!s.trim().is_empty()).then(|| s.trim().to_string())
}

async fn pg_open(cfg: &ConnConfig, pw: Option<&str>) -> Result<(Driver, Cancel), String> {
    use tokio_postgres::config::SslMode;
    let mut c = tokio_postgres::Config::new();
    c.host(nonempty(&cfg.host).as_deref().unwrap_or("localhost"))
        .port(cfg.port.unwrap_or(5432))
        .user(nonempty(&cfg.username).or_else(|| std::env::var("USER").ok()).unwrap_or_default())
        .connect_timeout(TIMEOUT)
        .application_name("Garnet");
    if let Some(db) = nonempty(&cfg.database) {
        c.dbname(db);
    }
    if let Some(p) = pw {
        c.password(p);
    }
    let mode = cfg.sslmode.as_deref().unwrap_or("prefer");
    let (client, tls) = if mode == "disable" {
        c.ssl_mode(SslMode::Disable);
        let (client, conn) = c.connect(tokio_postgres::NoTls).await.map_err(pg_err)?;
        tokio::spawn(conn);
        (client, None)
    } else {
        c.ssl_mode(if mode == "require" { SslMode::Require } else { SslMode::Prefer });
        // libpq's require/prefer encrypt without verifying the certificate; match that.
        let tls = native_tls::TlsConnector::builder()
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true)
            .build()
            .map_err(e2s)?;
        let tls = postgres_native_tls::MakeTlsConnector::new(tls);
        let (client, conn) = c.connect(tls.clone()).await.map_err(pg_err)?;
        tokio::spawn(conn);
        (client, Some(tls))
    };
    if cfg.read_only {
        client.batch_execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY").await.map_err(pg_err)?;
    }
    let cancel = Cancel::Pg(client.cancel_token(), tls);
    Ok((Driver::Pg(client), cancel))
}

async fn my_open(cfg: &ConnConfig, pw: Option<&str>) -> Result<(Driver, Cancel), String> {
    use mysql_async::{Opts, OptsBuilder, SslOpts};
    let base = OptsBuilder::default()
        .ip_or_hostname(nonempty(&cfg.host).unwrap_or_else(|| "localhost".into()))
        .tcp_port(cfg.port.unwrap_or(3306))
        .db_name(nonempty(&cfg.database))
        .user(nonempty(&cfg.username))
        .pass(pw);
    let ssl = SslOpts::default().with_danger_accept_invalid_certs(true).with_danger_skip_domain_validation(true);
    let attempt = |o: OptsBuilder| async move {
        let opts = Opts::from(o);
        mysql_async::Conn::new(opts.clone()).await.map(|c| (c, opts))
    };
    let res = match cfg.sslmode.as_deref().unwrap_or("prefer") {
        "disable" => attempt(base).await,
        "require" => attempt(base.ssl_opts(ssl)).await,
        _ => match attempt(base.clone().ssl_opts(ssl)).await {
            Err(mysql_async::Error::Driver(mysql_async::DriverError::NoClientSslFlagFromServer)) => attempt(base).await,
            r => r,
        },
    };
    let (mut conn, opts) = res.map_err(e2s)?;
    if cfg.read_only {
        conn.query_drop("SET SESSION TRANSACTION READ ONLY").await.map_err(e2s)?;
    }
    let id = conn.id();
    Ok((Driver::My(conn), Cancel::My(opts, id)))
}

fn lite_open(cfg: &ConnConfig) -> Result<(Driver, Cancel), String> {
    use rusqlite::OpenFlags;
    let path = resolve_sqlite(cfg);
    if !path.is_file() {
        return Err(format!("SQLite database not found: {}", path.display()));
    }
    let mode = if cfg.read_only { OpenFlags::SQLITE_OPEN_READ_ONLY } else { OpenFlags::SQLITE_OPEN_READ_WRITE };
    let c = rusqlite::Connection::open_with_flags(&path, mode | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(e2s)?;
    c.busy_timeout(Duration::from_secs(5)).map_err(e2s)?;
    if cfg.read_only {
        c.execute_batch("PRAGMA query_only = ON").map_err(e2s)?;
    }
    let cancel = Cancel::Lite(c.get_interrupt_handle());
    Ok((Driver::Lite(Arc::new(Mutex::new(c))), cancel))
}

impl Conn {
    async fn open(cfg: &ConnConfig, pw: Option<&str>) -> Result<Conn, String> {
        let (dialect, (driver, cancel)) = match cfg.engine.as_str() {
            "postgres" => (Dialect::Postgres, pg_open(cfg, pw).await?),
            "mysql" => (Dialect::Mysql, my_open(cfg, pw).await?),
            "sqlite" => (Dialect::Sqlite, lite_open(cfg)?),
            other => return Err(format!("Unsupported database engine: {other}")),
        };
        Ok(Conn { dialect, read_only: cfg.read_only, in_txn: AtomicBool::new(false), driver: tokio::sync::Mutex::new(driver), cancel })
    }

    /// Runs statements in order. With `ro_txn` they run inside a read-only transaction that is
    /// always rolled back (SQLite: each statement must be read-only instead).
    async fn run(&self, stmts: &[&str], max: u32, ro_txn: bool) -> Result<Vec<QueryResult>, String> {
        let mut d = self.driver.lock().await;
        let begin = match self.dialect {
            Dialect::Postgres => "BEGIN READ ONLY",
            Dialect::Mysql => "START TRANSACTION READ ONLY",
            Dialect::Sqlite => "",
        };
        let wrap = ro_txn && !begin.is_empty();
        if wrap {
            if self.in_txn.load(Ordering::Relaxed) {
                return Err("Finish the open transaction (COMMIT or ROLLBACK) first".into());
            }
            d.exec(begin, 0, false).await?;
        }
        let mut out = vec![];
        let mut err = None;
        for s in stmts {
            let t = Instant::now();
            match d.exec(s, max, ro_txn).await {
                Ok(mut r) => {
                    r.elapsed_ms = t.elapsed().as_millis() as u64;
                    out.push(r);
                }
                Err(e) => {
                    err = Some(e);
                    break;
                }
            }
        }
        if wrap {
            let rb = d.exec("ROLLBACK", 0, false).await;
            if err.is_none() {
                rb?;
            }
        }
        err.map_or(Ok(out), Err)
    }

    async fn cancel(&self) -> Result<(), String> {
        match &self.cancel {
            Cancel::Pg(token, Some(tls)) => token.cancel_query(tls.clone()).await.map_err(pg_err),
            Cancel::Pg(token, None) => token.cancel_query(tokio_postgres::NoTls).await.map_err(pg_err),
            Cancel::My(opts, id) => {
                let mut c = mysql_async::Conn::new(opts.clone()).await.map_err(e2s)?;
                let r = c.query_drop(format!("KILL QUERY {id}")).await.map_err(e2s);
                let _ = c.disconnect().await;
                r
            }
            Cancel::Lite(h) => {
                h.interrupt();
                Ok(())
            }
        }
    }

    async fn close(&self) {
        let _ = tokio::time::timeout(Duration::from_secs(2), self.cancel()).await;
        let Ok(mut d) = tokio::time::timeout(Duration::from_secs(2), self.driver.lock()).await else { return };
        if let Driver::My(c) = std::mem::replace(&mut *d, Driver::Closed) {
            let _ = tokio::time::timeout(Duration::from_secs(2), c.disconnect()).await;
        }
    }
}

fn truthy(v: &Option<String>) -> bool {
    matches!(v.as_deref(), Some("t" | "true" | "1" | "YES" | "yes"))
}

fn cell(row: &[Option<String>], i: usize) -> String {
    row.get(i).cloned().flatten().unwrap_or_default()
}

fn build_schema(schemas: &QueryResult, cols: &QueryResult, idx: &QueryResult, fks: &QueryResult) -> Schema {
    let mut out: Vec<SchemaInfo> =
        schemas.rows.iter().filter_map(|r| r.first().cloned().flatten()).map(|name| SchemaInfo { name, tables: vec![] }).collect();
    let mut pos: HashMap<(String, String), (usize, usize)> = HashMap::new();
    for row in &cols.rows {
        let (s, t, kind) = (cell(row, 0), cell(row, 1), cell(row, 2));
        let key = (s.clone(), t.clone());
        let (si, ti) = match pos.get(&key) {
            Some(p) => *p,
            None => {
                let si = out.iter().position(|x| x.name == s).unwrap_or_else(|| {
                    out.push(SchemaInfo { name: s.clone(), tables: vec![] });
                    out.len() - 1
                });
                let k = kind.to_ascii_lowercase();
                let kind = if k == "v" || k == "m" || k.contains("view") { "view" } else { "table" };
                out[si].tables.push(TableInfo { name: t, kind, columns: vec![], indexes: vec![], foreign_keys: vec![] });
                let p = (si, out[si].tables.len() - 1);
                pos.insert(key, p);
                p
            }
        };
        if let Some(name) = row.get(3).cloned().flatten() {
            out[si].tables[ti].columns.push(Column {
                name,
                data_type: cell(row, 4),
                nullable: truthy(&row[5]),
                default: row[6].clone(),
                primary_key: truthy(&row[7]),
            });
        }
    }
    for row in &idx.rows {
        let (Some(&(si, ti)), Some(col)) = (pos.get(&(cell(row, 0), cell(row, 1))), row.get(4).cloned().flatten()) else { continue };
        let name = cell(row, 2);
        let indexes = &mut out[si].tables[ti].indexes;
        match indexes.last_mut() {
            Some(last) if last.name == name => last.columns.push(col),
            _ => indexes.push(Index { name, columns: vec![col], unique: truthy(&row[3]) }),
        }
    }
    let mut last_key = None;
    for row in &fks.rows {
        let Some(&(si, ti)) = pos.get(&(cell(row, 0), cell(row, 1))) else { continue };
        let key = (si, ti, cell(row, 7));
        let fk = &mut out[si].tables[ti].foreign_keys;
        if last_key.as_ref() != Some(&key) || fk.is_empty() {
            fk.push(ForeignKey { name: row[2].clone(), columns: vec![], ref_schema: row[4].clone(), ref_table: cell(row, 5), ref_columns: vec![] });
        }
        last_key = Some(key);
        let f = fk.last_mut().expect("pushed above");
        f.columns.push(cell(row, 3));
        f.ref_columns.extend(row[6].clone());
    }
    // SQLite: `REFERENCES t` without columns means t's primary key.
    let pks: HashMap<(String, String), Vec<String>> = out
        .iter()
        .flat_map(|s| s.tables.iter().map(move |t| ((s.name.clone(), t.name.clone()), t.columns.iter().filter(|c| c.primary_key).map(|c| c.name.clone()).collect())))
        .collect();
    for s in &mut out {
        let schema = s.name.clone();
        for f in s.tables.iter_mut().flat_map(|t| t.foreign_keys.iter_mut()).filter(|f| f.ref_columns.is_empty()) {
            let key = (f.ref_schema.clone().unwrap_or_else(|| schema.clone()), f.ref_table.clone());
            f.ref_columns = pks.get(&key).cloned().unwrap_or_default();
        }
    }
    Schema { schemas: out }
}

fn txn_effect(keyword: &str, sql: &str) -> Option<bool> {
    match keyword {
        "BEGIN" | "START" => Some(true),
        "COMMIT" | "END" | "ABORT" => Some(false),
        "ROLLBACK" if !sql.to_ascii_uppercase().contains(" TO ") => Some(false),
        _ => None,
    }
}

impl Db {
    fn get(&self, id: &str) -> Result<Arc<Conn>, String> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).get(id).cloned().ok_or_else(|| "Not connected".into())
    }

    async fn connect(&self, id: String, cfg: &ConnConfig, pw: Option<&str>) -> Result<ServerInfo, String> {
        let scrub = |e: String| match pw {
            Some(p) if p.len() >= 4 => e.replace(p, "***"),
            _ => e,
        };
        let conn = tokio::time::timeout(TIMEOUT + Duration::from_secs(1), Conn::open(cfg, pw))
            .await
            .map_err(|_| "Connection timed out".to_string())?
            .map_err(scrub)?;
        let q = match conn.dialect {
            Dialect::Postgres => "SHOW server_version",
            Dialect::Mysql => "SELECT VERSION()",
            Dialect::Sqlite => "SELECT sqlite_version()",
        };
        let r = conn.run(&[q], 1, false).await?;
        let version = r.first().and_then(|r| r.rows.first()).map(|row| cell(row, 0)).unwrap_or_default();
        let old = self.0.lock().unwrap_or_else(|p| p.into_inner()).insert(id, Arc::new(conn));
        if let Some(old) = old {
            old.close().await;
        }
        Ok(ServerInfo { version })
    }

    async fn disconnect(&self, id: &str) {
        let conn = self.0.lock().unwrap_or_else(|p| p.into_inner()).remove(id);
        if let Some(c) = conn {
            c.close().await;
        }
    }

    pub async fn close_all(&self) {
        let conns: Vec<_> = self.0.lock().unwrap_or_else(|p| p.into_inner()).drain().map(|(_, c)| c).collect();
        for c in conns {
            c.close().await;
        }
    }

    async fn query(&self, id: &str, sql: &str, max_rows: Option<u32>) -> Result<QueryResult, String> {
        let conn = self.get(id)?;
        let scan = sql::check_single(sql, conn.dialect)?;
        let keyword = scan.first_keyword.clone().ok_or("Nothing to run")?;
        if conn.read_only {
            sql::check_read_only(&scan, conn.dialect)?;
        }
        let max = max_rows.unwrap_or(MAX_ROWS).clamp(1, MAX_ROWS);
        let r = conn.run(&[sql], max, conn.read_only).await?.pop().unwrap_or_default();
        if let Some(open) = txn_effect(&keyword, sql) {
            conn.in_txn.store(open, Ordering::Relaxed);
        }
        Ok(r)
    }

    async fn schema(&self, id: &str) -> Result<Schema, String> {
        let conn = self.get(id)?;
        let q = sql::schema_queries(conn.dialect);
        let q: Vec<&str> = q.iter().map(String::as_str).collect();
        // Inside the user's own transaction the fixed catalog queries run as-is rather than ending it.
        let ro = !conn.in_txn.load(Ordering::Relaxed);
        let r = conn.run(&q, u32::MAX, ro).await?;
        Ok(build_schema(&r[0], &r[1], &r[2], &r[3]))
    }

    #[allow(clippy::too_many_arguments)]
    async fn table_page(
        &self,
        id: &str,
        schema: &str,
        table: &str,
        offset: u32,
        limit: u32,
        order_by: Option<&str>,
        desc: bool,
        filter: Option<&str>,
    ) -> Result<TablePage, String> {
        let conn = self.get(id)?;
        let limit = limit.clamp(1, MAX_PAGE);
        let (page, count) = sql::page_sql(conn.dialect, schema, table, filter, order_by, desc, limit, offset)?;
        let mut r = conn.run(&[&count, &page], limit, true).await?;
        let result = r.pop().unwrap_or_default();
        let total = r.first().and_then(|c| c.rows.first()).and_then(|row| cell(row, 0).parse().ok());
        Ok(TablePage { result, total })
    }
}

#[cfg(target_os = "macos")]
mod keychain {
    use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};
    const SERVICE: &str = "dev.garnet.ide.db";
    const NOT_FOUND: i32 = -25300;

    pub fn get(id: &str) -> Result<Option<String>, String> {
        match get_generic_password(SERVICE, id) {
            Ok(b) => String::from_utf8(b).map(Some).map_err(|_| "Saved password is not valid UTF-8".into()),
            Err(e) if e.code() == NOT_FOUND => Ok(None),
            Err(e) => Err(format!("Keychain: {e}")),
        }
    }

    pub fn set(id: &str, password: &str) -> Result<(), String> {
        set_generic_password(SERVICE, id, password.as_bytes()).map_err(|e| format!("Keychain: {e}"))
    }

    pub fn delete(id: &str) -> Result<(), String> {
        match delete_generic_password(SERVICE, id) {
            Err(e) if e.code() != NOT_FOUND => Err(format!("Keychain: {e}")),
            _ => Ok(()),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod keychain {
    const UNSUPPORTED: &str = "Saved passwords need the macOS Keychain";
    pub fn get(_: &str) -> Result<Option<String>, String> {
        Err(UNSUPPORTED.into())
    }
    pub fn set(_: &str, _: &str) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    pub fn delete(_: &str) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
}

fn redact<T>(r: Result<T, String>) -> Result<T, String> {
    r.map_err(|e| redact_url(&e))
}

#[tauri::command]
pub async fn db_connect(db: State<'_, Db>, id: String, config: ConnConfig, password: Option<String>) -> Result<ServerInfo, String> {
    let password = match password {
        Some(p) => Some(p),
        None if config.engine == "sqlite" => None,
        None => {
            let id = id.clone();
            tokio::task::spawn_blocking(move || keychain::get(&id)).await.map_err(e2s)??
        }
    };
    let password = password.filter(|p| !p.is_empty());
    redact(db.connect(id, &config, password.as_deref()).await)
}

#[tauri::command]
pub async fn db_disconnect(db: State<'_, Db>, id: String) -> Result<(), String> {
    db.disconnect(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn db_query(db: State<'_, Db>, id: String, sql: String, max_rows: Option<u32>) -> Result<QueryResult, String> {
    redact(db.query(&id, &sql, max_rows).await)
}

#[tauri::command]
pub async fn db_cancel(db: State<'_, Db>, id: String) -> Result<(), String> {
    redact(db.get(&id)?.cancel().await)
}

#[tauri::command]
pub async fn db_schema(db: State<'_, Db>, id: String) -> Result<Schema, String> {
    redact(db.schema(&id).await)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn db_table_page(
    db: State<'_, Db>,
    id: String,
    schema: String,
    table: String,
    offset: u32,
    limit: u32,
    order_by: Option<String>,
    desc: bool,
    filter: Option<String>,
) -> Result<TablePage, String> {
    redact(db.table_page(&id, &schema, &table, offset, limit, order_by.as_deref(), desc, filter.as_deref()).await)
}

#[tauri::command]
pub async fn db_password_set(id: String, password: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || keychain::set(&id, &password)).await.map_err(e2s)?
}

#[tauri::command]
pub async fn db_password_delete(id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || keychain::delete(&id)).await.map_err(e2s)?
}

#[tauri::command]
pub async fn db_password_exists(id: String) -> bool {
    tokio::task::spawn_blocking(move || keychain::get(&id)).await.is_ok_and(|r| matches!(r, Ok(Some(_))))
}

#[tauri::command]
pub async fn db_detect(root: String) -> Result<Vec<detect::Detected>, String> {
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(root);
        detect::detect(&root, &crate::env::shell_env(&root))
    })
    .await
    .map_err(e2s)?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDb(PathBuf);

    impl Drop for TempDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn fixture(name: &str) -> TempDb {
        let dir = std::env::temp_dir().join(format!("garnet-db-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("db")).unwrap();
        let c = rusqlite::Connection::open(dir.join("db/development.sqlite3")).unwrap();
        c.execute_batch(
            "CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT 'anon', avatar BLOB, score REAL);
             CREATE UNIQUE INDEX index_authors_on_name ON authors (name);
             CREATE TABLE posts (id INTEGER PRIMARY KEY, author_id INTEGER REFERENCES authors(id), title TEXT, editor_id INTEGER REFERENCES authors);
             CREATE INDEX index_posts_on_author_and_title ON posts (author_id, title);
             CREATE VIEW recent AS SELECT * FROM posts;
             INSERT INTO authors (name, avatar, score) VALUES ('ann', x'00ff10', 1.0), ('bob', NULL, 2.5), ('cy', NULL, NULL);
             WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30)
             INSERT INTO posts (author_id, title) SELECT 1 + i % 3, 'post ' || i FROM n;",
        )
        .unwrap();
        TempDb(dir)
    }

    fn cfg(dir: &Path, read_only: bool) -> ConnConfig {
        ConnConfig {
            engine: "sqlite".into(),
            host: String::new(),
            port: None,
            database: "db/development.sqlite3".into(),
            username: String::new(),
            sslmode: None,
            read_only,
            root: Some(dir.to_string_lossy().into_owned()),
        }
    }

    #[tokio::test]
    async fn sqlite_query_writes_truncation_and_values() {
        let t = fixture("rw");
        let db = Db::default();
        let info = db.connect("rw".into(), &cfg(&t.0, false), None).await.unwrap();
        assert!(info.version.starts_with('3'));
        let r = db.query("rw", "SELECT id, name, avatar, score FROM authors ORDER BY id;", None).await.unwrap();
        assert_eq!(r.columns, ["id", "name", "avatar", "score"]);
        assert_eq!(r.rows[0], [Some("1".into()), Some("ann".into()), Some("\\x00ff10".into()), Some("1.0".into())]);
        assert_eq!(r.rows[1][2], None);
        assert_eq!(r.rows[2][3], None);
        assert!(!r.truncated && r.rows_affected.is_none());
        let r = db.query("rw", "SELECT * FROM posts", Some(7)).await.unwrap();
        assert_eq!((r.rows.len(), r.truncated), (7, true));
        let r = db.query("rw", "SELECT * FROM posts", Some(30)).await.unwrap();
        assert_eq!((r.rows.len(), r.truncated), (30, false));
        let r = db.query("rw", "INSERT INTO authors (name) VALUES ('dee'), ('eve')", None).await.unwrap();
        assert_eq!(r.rows_affected, Some(2));
        let r = db.query("rw", "UPDATE posts SET title = 'x' WHERE author_id = 1", None).await.unwrap();
        assert_eq!(r.rows_affected, Some(10));
        assert_eq!(db.query("rw", "SELECT 1; DROP TABLE posts", None).await.unwrap_err(), sql::ONE_STATEMENT);
        assert_eq!(db.query("rw", "-- nothing", None).await.unwrap_err(), "Nothing to run");
        let big = db.query("rw", "SELECT zeroblob(300)", None).await.unwrap();
        assert_eq!(big.rows[0][0].as_deref(), Some("<300 bytes>"));
        db.disconnect("rw").await;
        assert_eq!(db.query("rw", "SELECT 1", None).await.unwrap_err(), "Not connected");
    }

    #[tokio::test]
    async fn sqlite_read_only_rejects_writes() {
        let t = fixture("ro");
        let db = Db::default();
        db.connect("ro".into(), &cfg(&t.0, true), None).await.unwrap();
        assert_eq!(db.query("ro", "SELECT COUNT(*) FROM posts", None).await.unwrap().rows[0][0].as_deref(), Some("30"));
        assert!(db.query("ro", "PRAGMA table_info(posts)", None).await.is_ok());
        for bad in ["INSERT INTO authors (name) VALUES ('x')", "UPDATE posts SET title = 'y'", "DROP TABLE posts", "PRAGMA query_only = OFF"] {
            assert_eq!(db.query("ro", bad, None).await.unwrap_err(), sql::READ_ONLY, "{bad}");
        }
        // A writing CTE passes the keyword check; SQLite's read-only checks still stop it.
        assert!(db.query("ro", "WITH x AS (SELECT 1) INSERT INTO authors (name) SELECT 'z' FROM x", None).await.is_err());
        // query_only enforced by SQLite itself, beneath the keyword check.
        let c = Conn::open(&cfg(&t.0, true), None).await.unwrap();
        let Driver::Lite(raw) = &*c.driver.lock().await else { panic!("sqlite") };
        let err = raw.lock().unwrap().execute("DELETE FROM posts", []).unwrap_err().to_string();
        assert!(err.contains("readonly") || err.contains("read-only") || err.contains("attempt to write"), "{err}");
        let n = db.query("ro", "SELECT COUNT(*) FROM posts", None).await.unwrap();
        assert_eq!(n.rows[0][0].as_deref(), Some("30"));
    }

    #[tokio::test]
    async fn sqlite_schema_introspection() {
        let t = fixture("schema");
        let db = Db::default();
        db.connect("s".into(), &cfg(&t.0, false), None).await.unwrap();
        let s = db.schema("s").await.unwrap();
        assert_eq!(s.schemas.len(), 1);
        assert_eq!(s.schemas[0].name, "main");
        let tables = &s.schemas[0].tables;
        let names: Vec<_> = tables.iter().map(|t| (t.name.as_str(), t.kind)).collect();
        assert_eq!(names, [("authors", "table"), ("posts", "table"), ("recent", "view")]);
        let authors = &tables[0];
        let id = &authors.columns[0];
        assert!(id.primary_key && id.data_type == "INTEGER");
        let name = &authors.columns[1];
        assert!(!name.nullable && !name.primary_key);
        assert_eq!(name.default.as_deref(), Some("'anon'"));
        assert!(authors.columns[2].nullable);
        assert_eq!(authors.indexes.len(), 1);
        assert!(authors.indexes[0].unique && authors.indexes[0].columns == ["name"]);
        let posts = &tables[1];
        let ix = posts.indexes.iter().find(|i| i.name == "index_posts_on_author_and_title").unwrap();
        assert!(!ix.unique && ix.columns == ["author_id", "title"]);
        assert_eq!(posts.foreign_keys.len(), 2);
        let by_col = |c: &str| posts.foreign_keys.iter().find(|f| f.columns == [c]).unwrap();
        let fk = by_col("author_id");
        assert_eq!((fk.ref_table.as_str(), fk.ref_columns.as_slice(), fk.ref_schema.as_deref()), ("authors", &["id".to_string()][..], Some("main")));
        assert_eq!(by_col("editor_id").ref_columns, ["id"]);
        assert_eq!(tables[2].columns.len(), 4);
    }

    #[tokio::test]
    async fn sqlite_table_page_paginates_filters_and_rejects_injection() {
        let t = fixture("page");
        let db = Db::default();
        db.connect("p".into(), &cfg(&t.0, false), None).await.unwrap();
        let p = db.table_page("p", "main", "posts", 5, 10, Some("id"), true, None).await.unwrap();
        assert_eq!(p.total, Some(30));
        assert_eq!(p.result.rows.len(), 10);
        assert_eq!(p.result.rows[0][0].as_deref(), Some("25"));
        let p = db.table_page("p", "main", "posts", 0, 100, Some("id"), false, Some("author_id = 2")).await.unwrap();
        assert_eq!((p.total, p.result.rows.len()), (Some(10), 10));
        assert!(p.result.rows.iter().all(|r| r[1].as_deref() == Some("2")));
        let p = db.table_page("p", "main", "posts", 0, 5000, None, false, None).await.unwrap();
        assert_eq!(p.result.rows.len(), 30);
        assert!(db.table_page("p", "main", "posts", 0, 10, None, false, Some("1=1; DROP TABLE posts")).await.is_err());
        assert!(db.table_page("p", "main", "posts", 0, 10, None, false, Some("1=1) --")).await.is_err());
        assert_eq!(db.query("p", "SELECT COUNT(*) FROM posts", None).await.unwrap().rows[0][0].as_deref(), Some("30"));
        let p = db.table_page("p", "main", "authors", 0, 10, Some("id"), false, Some("avatar IS NULL")).await.unwrap();
        assert_eq!((p.total, p.result.rows[0][2].clone()), (Some(2), None));
    }

    #[tokio::test]
    async fn sqlite_missing_file_and_bad_engine() {
        let dir = std::env::temp_dir().join(format!("garnet-db-missing-{}", std::process::id()));
        let db = Db::default();
        let err = db.connect("m".into(), &cfg(&dir, false), None).await.err().unwrap();
        assert!(err.starts_with("SQLite database not found"), "{err}");
        assert!(!dir.join("db/development.sqlite3").exists());
        let mut bad = cfg(&dir, false);
        bad.engine = "oracle".into();
        assert!(db.connect("m".into(), &bad, None).await.is_err());
    }

    #[test]
    fn tracks_console_transactions() {
        assert_eq!(txn_effect("BEGIN", "begin"), Some(true));
        assert_eq!(txn_effect("START", "START TRANSACTION"), Some(true));
        assert_eq!(txn_effect("COMMIT", "commit"), Some(false));
        assert_eq!(txn_effect("ROLLBACK", "rollback"), Some(false));
        assert_eq!(txn_effect("ROLLBACK", "rollback to sp1"), None);
        assert_eq!(txn_effect("SELECT", "select 1"), None);
    }

    #[test]
    fn values_render_as_text() {
        assert_eq!(blob_text(&[0, 255, 16]), "\\x00ff10");
        assert_eq!(blob_text(&[0; 300]), "<300 bytes>");
        assert_eq!(my_text(mysql_async::Value::NULL), None);
        assert_eq!(my_text(mysql_async::Value::Bytes(b"12.50".to_vec())).as_deref(), Some("12.50"));
        assert_eq!(my_text(mysql_async::Value::Bytes(vec![0xff, 0x00])).as_deref(), Some("\\xff00"));
        assert_eq!(my_text(mysql_async::Value::Int(-4)).as_deref(), Some("-4"));
        assert_eq!(lite_text(rusqlite::types::ValueRef::Real(2.0)).as_deref(), Some("2.0"));
    }

    fn net_cfg(url_var: &str, engine: &str) -> Option<(ConnConfig, Option<String>)> {
        let Ok(url) = std::env::var(url_var) else {
            eprintln!("skipped: set {url_var} to run against a local {engine}");
            return None;
        };
        let rest = url.split_once("://").map_or(url.as_str(), |(_, r)| r);
        let (auth, path) = rest.split_once('/').unwrap_or((rest, ""));
        let (userinfo, hostport) = auth.rsplit_once('@').unwrap_or(("", auth));
        let (user, pw) = userinfo.split_once(':').map_or((userinfo, None), |(u, p)| (u, Some(p.to_string())));
        let (host, port) = hostport.split_once(':').map_or((hostport, None), |(h, p)| (h, p.parse().ok()));
        let cfg = ConnConfig {
            engine: engine.to_lowercase(),
            host: host.into(),
            port,
            database: path.split('?').next().unwrap_or("").into(),
            username: user.into(),
            sslmode: Some("disable".into()),
            read_only: false,
            root: None,
        };
        Some((cfg, pw))
    }

    async fn network_roundtrip(url_var: &str, engine: &str, schema: &str) {
        let Some((mut c, pw)) = net_cfg(url_var, engine) else { return };
        let db = Db::default();
        db.connect("n".into(), &c, pw.as_deref()).await.unwrap();
        db.query("n", "DROP TABLE IF EXISTS garnet_test", None).await.unwrap();
        db.query("n", "CREATE TABLE garnet_test (id INT PRIMARY KEY, v TEXT, n NUMERIC(6,2))", None).await.unwrap();
        let r = db.query("n", "INSERT INTO garnet_test VALUES (1, 'a', 1.50), (2, NULL, NULL)", None).await.unwrap();
        assert_eq!(r.rows_affected, Some(2));
        let r = db.query("n", "SELECT id, v, n FROM garnet_test ORDER BY id", Some(1)).await.unwrap();
        assert_eq!((r.rows[0][2].as_deref(), r.truncated), (Some("1.50"), true));
        let s = db.schema("n").await.unwrap();
        let t = s.schemas.iter().flat_map(|s| &s.tables).find(|t| t.name == "garnet_test").unwrap();
        assert!(t.columns[0].primary_key);
        let p = db.table_page("n", schema, "garnet_test", 0, 10, Some("id"), true, Some("v IS NULL")).await.unwrap();
        assert_eq!((p.total, p.result.rows.len()), (Some(1), 1));
        c.read_only = true;
        db.connect("ro".into(), &c, pw.as_deref()).await.unwrap();
        assert_eq!(db.query("ro", "DELETE FROM garnet_test", None).await.unwrap_err(), sql::READ_ONLY);
        assert!(db.query("ro", "WITH d AS (SELECT 1) SELECT * FROM garnet_test", None).await.is_ok());
        db.query("n", "DROP TABLE garnet_test", None).await.unwrap();
        db.close_all().await;
    }

    #[tokio::test]
    async fn postgres_integration() {
        network_roundtrip("GARNET_TEST_PG_URL", "Postgres", "public").await;
    }

    #[tokio::test]
    async fn mysql_integration() {
        let db = std::env::var("GARNET_TEST_MYSQL_URL").ok().and_then(|u| u.rsplit('/').next().map(str::to_string)).unwrap_or_default();
        network_roundtrip("GARNET_TEST_MYSQL_URL", "MySQL", &db).await;
    }
}
