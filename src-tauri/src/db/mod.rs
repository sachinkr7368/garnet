mod detect;
mod sql;

use crate::fsops::e2s;
use detect::redact_url;
use futures_util::StreamExt;
use mysql_async::prelude::Queryable;
use serde::{Deserialize, Serialize};
use sql::Dialect;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
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

#[derive(Serialize)]
pub struct TestInfo {
    version: String,
    ms: u64,
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
    driver: tokio::sync::Mutex<Driver>,
    cancel: Cancel,
    /// Id of the console query running now; db_cancel only interrupts that one.
    running: tokio::sync::Mutex<Option<String>>,
    /// Per query id, `(sql, token)` of the destructive statement refused pending the user's confirmation.
    /// An accident guard (a statement the frontend's checks missed still gets a dialog), not a security boundary:
    /// the webview can always answer the handshake itself.
    confirm: Mutex<HashMap<String, (String, String)>>,
    /// Writable Postgres/MySQL connections read grids and the schema on this second, read-only session, so a
    /// filter's side effects can't write and the console's open transaction is never touched.
    reader: Option<Box<Conn>>,
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
        .pass(pw)
        // Affected rows = matched rows, so a grid edit that writes the same value still counts its row.
        .client_found_rows(true);
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
        Ok(Conn {
            dialect,
            read_only: cfg.read_only,
            driver: tokio::sync::Mutex::new(driver),
            cancel,
            running: tokio::sync::Mutex::new(None),
            confirm: Mutex::new(HashMap::new()),
            reader: None,
        })
    }

    /// Runs statements in order. On a read-only connection they run inside a read-only transaction that is
    /// always rolled back; a writable connection never gets that wrapper, since its BEGIN/ROLLBACK would end
    /// (MySQL: commit) whatever the console has open. `require_ro` makes SQLite refuse writing statements.
    async fn run(&self, stmts: &[&str], max: u32, require_ro: bool, query_id: Option<&str>) -> Result<Vec<QueryResult>, String> {
        let mut d = self.driver.lock().await;
        let begin = match self.dialect {
            Dialect::Postgres => "BEGIN READ ONLY",
            Dialect::Mysql => "START TRANSACTION READ ONLY",
            Dialect::Sqlite => "",
        };
        let wrap = self.read_only && !begin.is_empty();
        if wrap {
            d.exec(begin, 0, false).await?;
        }
        *self.running.lock().await = query_id.map(str::to_string);
        let mut out = vec![];
        let mut err = None;
        for s in stmts {
            let t = Instant::now();
            match d.exec(s, max, require_ro || self.read_only).await {
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
        *self.running.lock().await = None;
        if wrap {
            let rb = d.exec("ROLLBACK", 0, false).await;
            if err.is_none() {
                rb?;
            }
        }
        err.map_or(Ok(out), Err)
    }

    /// Cancels `query_id` if it is still the one running. The `running` lock is held while the cancel is sent,
    /// so the next query cannot start (and be the one interrupted) in between.
    async fn cancel_query(&self, query_id: &str) -> Result<bool, String> {
        let running = self.running.lock().await;
        if running.as_deref() != Some(query_id) {
            return Ok(false);
        }
        self.cancel().await.map(|_| true)
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
        if let Some(r) = &self.reader {
            Box::pin(r.close()).await;
        }
        let _ = tokio::time::timeout(Duration::from_secs(2), self.cancel()).await;
        let Ok(mut d) = tokio::time::timeout(Duration::from_secs(2), self.driver.lock()).await else { return };
        // Every driver is dropped here, so SQLite releases its locks even if a tab still holds the Arc<Conn>.
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

fn token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
    format!("{:016x}", h.finish())
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
        let open = |cfg: ConnConfig| async move {
            tokio::time::timeout(TIMEOUT + Duration::from_secs(1), Conn::open(&cfg, pw))
                .await
                .map_err(|_| "Connection timed out".to_string())?
                .map_err(scrub)
        };
        let mut conn = open(cfg.clone()).await?;
        if !cfg.read_only && conn.dialect != Dialect::Sqlite {
            conn.reader = Some(Box::new(open(ConnConfig { read_only: true, ..cfg.clone() }).await?));
        }
        let q = match conn.dialect {
            Dialect::Postgres => "SHOW server_version",
            Dialect::Mysql => "SELECT VERSION()",
            Dialect::Sqlite => "SELECT sqlite_version()",
        };
        let r = conn.run(&[q], 1, false, None).await?;
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

    /// Runs one statement. A destructive one (see `Scan::destructive`) is refused with `CONFIRM:<token>:<reason>`
    /// until it is sent again, unchanged, with that single-use token after the user confirmed it.
    async fn query(&self, id: &str, sql: &str, max_rows: Option<u32>, query_id: Option<&str>, confirm: Option<&str>) -> Result<QueryResult, String> {
        let conn = self.get(id)?;
        let scan = sql::check_single(sql, conn.dialect)?;
        scan.first_keyword().ok_or("Nothing to run")?;
        if conn.read_only {
            sql::check_read_only(&scan, conn.dialect)?;
        } else if let Some(reason) = scan.destructive() {
            let mut pending = conn.confirm.lock().unwrap_or_else(|p| p.into_inner());
            let slot = query_id.unwrap_or_default().to_string();
            let ok = matches!((pending.remove(&slot), confirm), (Some((s, t)), Some(c)) if s == sql && t == c);
            if !ok {
                if pending.len() >= 32 {
                    pending.clear();
                }
                let t = token();
                pending.insert(slot, (sql.to_string(), t.clone()));
                return Err(format!("{}{t}:{reason}", sql::CONFIRM));
            }
        }
        let max = max_rows.unwrap_or(MAX_ROWS).clamp(1, MAX_ROWS);
        Ok(conn.run(&[sql], max, false, query_id).await?.pop().unwrap_or_default())
    }

    async fn schema(&self, id: &str) -> Result<Schema, String> {
        let conn = self.get(id)?;
        let q = sql::schema_queries(conn.dialect);
        let q: Vec<&str> = q.iter().map(String::as_str).collect();
        let r = conn.reads().run(&q, u32::MAX, true, None).await?;
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
        let mut r = conn.reads().run(&[&count, &page], limit, true, None).await?;
        let result = r.pop().unwrap_or_default();
        let total = r.first().and_then(|c| c.rows.first()).and_then(|row| cell(row, 0).parse().ok());
        Ok(TablePage { result, total })
    }
}

#[derive(Deserialize, Debug, Clone)]
pub struct RowEdit {
    pk: BTreeMap<String, String>,
    changes: BTreeMap<String, Option<String>>,
    originals: BTreeMap<String, Option<String>>,
}

const BINARY: [&str; 3] = ["blob", "bytea", "binary"];

type Statement = (String, Vec<Option<String>>);

/// Checks the edits against the introspected table and builds one parameterized UPDATE per row: SET each changed
/// column, WHERE the primary key matches and each changed column still holds the value the grid showed.
fn update_statements(d: Dialect, schema: &str, t: &TableInfo, rows: &[RowEdit]) -> Result<Vec<Statement>, String> {
    if t.kind != "table" {
        return Err(format!("{} is a view", t.name));
    }
    let pk: Vec<&Column> = t.columns.iter().filter(|c| c.primary_key).collect();
    if pk.is_empty() {
        return Err(format!("{} has no primary key, so rows can't be addressed safely", t.name));
    }
    let col = |name: &str| t.columns.iter().find(|c| c.name == name).ok_or_else(|| format!("{name} isn't a column of {}", t.name));
    let binary = |c: &Column| BINARY.iter().any(|b| c.data_type.to_ascii_lowercase().contains(b));
    if pk.iter().any(|c| binary(c)) {
        return Err(format!("{}'s primary key is binary", t.name));
    }
    let table = if d == Dialect::Sqlite { sql::quote_ident(&t.name, d) } else { format!("{}.{}", sql::quote_ident(schema, d), sql::quote_ident(&t.name, d)) };
    let mut out = vec![];
    for (n, r) in rows.iter().enumerate() {
        let row = n + 1;
        if r.changes.is_empty() || r.pk.len() != pk.len() || pk.iter().any(|c| !r.pk.contains_key(&c.name)) {
            return Err(format!("Row {row}: the primary key ({}) and at least one change are required", pk.iter().map(|c| c.name.as_str()).collect::<Vec<_>>().join(", ")));
        }
        let mut params = vec![];
        let mut arg = |v: Option<String>, c: &Column| {
            params.push(v);
            match d {
                Dialect::Postgres => format!("CAST(${}::text AS {})", params.len(), c.data_type),
                _ => "?".to_string(),
            }
        };
        let mut set = vec![];
        let mut cond = vec![];
        for (name, v) in &r.changes {
            let c = col(name)?;
            if c.primary_key || binary(c) {
                return Err(format!("Row {row}: {name} can't be edited in the grid ({})", if c.primary_key { "primary key" } else { "binary" }));
            }
            let Some(orig) = r.originals.get(name) else { return Err(format!("Row {row}: the original value of {name} is missing")) };
            set.push(format!("{} = {}", sql::quote_ident(name, d), arg(v.clone(), c)));
            let same = match d {
                Dialect::Postgres => "IS NOT DISTINCT FROM",
                Dialect::Mysql => "<=>",
                Dialect::Sqlite => "IS",
            };
            cond.push((name, same, orig.clone(), c));
        }
        let mut wh: Vec<String> = pk.iter().map(|c| format!("{} = {}", sql::quote_ident(&c.name, d), arg(Some(r.pk[&c.name].clone()), c))).collect();
        for (name, same, orig, c) in cond {
            wh.push(format!("{} {same} {}", sql::quote_ident(name, d), arg(orig, c)));
        }
        out.push((format!("UPDATE {table} SET {} WHERE {}", set.join(", "), wh.join(" AND ")), params));
    }
    Ok(out)
}

impl Driver {
    /// Runs one parameterized statement (driver bind parameters, never spliced text) and returns the affected rows.
    async fn exec_params(&mut self, sql: &str, params: Vec<Option<String>>) -> Result<u64, String> {
        match self {
            Driver::Pg(c) => {
                let refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = params.iter().map(|p| p as &(dyn tokio_postgres::types::ToSql + Sync)).collect();
                c.execute(sql, &refs).await.map_err(pg_err)
            }
            Driver::My(c) => {
                let values: Vec<mysql_async::Value> = params.into_iter().map(|p| p.map_or(mysql_async::Value::NULL, |s| mysql_async::Value::Bytes(s.into_bytes()))).collect();
                c.exec_drop(sql, mysql_async::Params::Positional(values)).await.map_err(e2s)?;
                Ok(c.affected_rows())
            }
            Driver::Lite(c) => {
                let (c, sql) = (c.clone(), sql.to_string());
                let run = move || {
                    let c = c.lock().unwrap_or_else(|p| p.into_inner());
                    c.execute(&sql, rusqlite::params_from_iter(params.iter())).map(|n| n as u64).map_err(e2s)
                };
                tokio::task::spawn_blocking(run).await.map_err(e2s)?
            }
            Driver::Closed => Err("Connection closed".into()),
        }
    }

    /// Whether the session has a transaction open (the console ran BEGIN, or MySQL autocommit is off).
    async fn in_transaction(&mut self) -> Result<bool, String> {
        match self {
            Driver::Pg(c) => {
                // now() is the transaction's start; it equals the statement's start only outside a transaction block.
                let rows = c.simple_query("SELECT now() = statement_timestamp()").await.map_err(pg_err)?;
                let same = rows.iter().find_map(|m| match m {
                    tokio_postgres::SimpleQueryMessage::Row(r) => r.get(0).map(|v| v == "t"),
                    _ => None,
                });
                Ok(same != Some(true))
            }
            Driver::My(c) => {
                use mysql_async::consts::StatusFlags;
                c.query_drop("DO 0").await.map_err(e2s)?;
                let flags = c.last_ok_packet().map(|p| p.status_flags()).unwrap_or(StatusFlags::SERVER_STATUS_IN_TRANS);
                Ok(flags.contains(StatusFlags::SERVER_STATUS_IN_TRANS) || !flags.contains(StatusFlags::SERVER_STATUS_AUTOCOMMIT))
            }
            Driver::Lite(c) => Ok(!c.lock().unwrap_or_else(|p| p.into_inner()).is_autocommit()),
            Driver::Closed => Err("Connection closed".into()),
        }
    }
}

impl Conn {
    fn reads(&self) -> &Conn {
        self.reader.as_deref().unwrap_or(self)
    }
}

impl Db {
    /// Grid cell edits: checked against a fresh introspection, refused while the console has a transaction open,
    /// then run in one transaction that is rolled back unless every UPDATE matched exactly one row.
    async fn update_rows(&self, id: &str, schema: &str, table: &str, rows: &[RowEdit]) -> Result<u64, String> {
        let conn = self.get(id)?;
        if conn.read_only {
            return Err(sql::READ_ONLY.into());
        }
        let s = self.schema(id).await?;
        let t = s.schemas.iter().filter(|x| x.name == schema).flat_map(|x| &x.tables).find(|t| t.name == table).ok_or_else(|| format!("{schema}.{table} not found"))?;
        let stmts = update_statements(conn.dialect, schema, t, rows)?;
        let mut d = conn.driver.lock().await;
        if d.in_transaction().await? {
            return Err("The console has a transaction open on this connection; commit or roll it back first".into());
        }
        d.exec("BEGIN", 0, false).await?;
        for (n, (sql, params)) in stmts.into_iter().enumerate() {
            let res = d.exec_params(&sql, params).await;
            let bad = match res {
                Ok(1) => continue,
                Ok(k) => format!("Row {}: matched {k} rows (it changed or was deleted since it was loaded)", n + 1),
                Err(e) => format!("Row {}: {e}", n + 1),
            };
            let _ = d.exec("ROLLBACK", 0, false).await;
            return Err(format!("{bad}; nothing was saved"));
        }
        d.exec("COMMIT", 0, false).await?;
        Ok(rows.len() as u64)
    }
}

/// The Keychain entry is bound to where the password was saved for; it is only offered to that same server.
fn binding(cfg: &ConnConfig) -> String {
    let host = cfg.host.trim().to_ascii_lowercase();
    let port = cfg.port.unwrap_or(if cfg.engine == "mysql" { 3306 } else { 5432 });
    format!("{}|{}|{port}|{}", cfg.engine, if host.is_empty() { "localhost" } else { &host }, cfg.username.trim())
}

#[derive(Serialize, Deserialize)]
struct Saved {
    password: String,
    bind: String,
}

/// The saved password for `cfg`, or None when it was saved for another host, port or user (or by an older
/// Garnet without a binding: the connect then fails and the password is asked for and saved again).
fn saved_password(raw: Option<String>, cfg: &ConnConfig) -> Option<String> {
    let s: Saved = serde_json::from_str(&raw?).ok()?;
    (s.bind == binding(cfg)).then_some(s.password)
}

async fn keychain_password(id: String, cfg: &ConnConfig) -> Result<Option<String>, String> {
    if cfg.engine == "sqlite" {
        return Ok(None);
    }
    let raw = tokio::task::spawn_blocking(move || keychain::get(&id)).await.map_err(e2s)??;
    Ok(saved_password(raw, cfg))
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
        None => keychain_password(id.clone(), &config).await?,
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
pub async fn db_query(
    db: State<'_, Db>,
    id: String,
    sql: String,
    max_rows: Option<u32>,
    query_id: Option<String>,
    confirm: Option<String>,
) -> Result<QueryResult, String> {
    redact(db.query(&id, &sql, max_rows, query_id.as_deref(), confirm.as_deref()).await)
}

/// Cancels the console query `query_id`; returns false when it already finished.
#[tauri::command]
pub async fn db_cancel(db: State<'_, Db>, id: String, query_id: String) -> Result<bool, String> {
    redact(db.get(&id)?.cancel_query(&query_id).await)
}

/// Connects without keeping the connection, for the data source dialog's Test Connection.
#[tauri::command]
pub async fn db_test(id: String, config: ConnConfig, password: Option<String>) -> Result<TestInfo, String> {
    let password = match password.filter(|p| !p.is_empty()) {
        Some(p) => Some(p),
        None => keychain_password(id, &config).await?,
    };
    let db = Db::default();
    let t = Instant::now();
    let r = db.connect("test".into(), &config, password.as_deref()).await;
    let ms = t.elapsed().as_millis() as u64;
    db.close_all().await;
    redact(r.map(|info| TestInfo { version: info.version, ms }))
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
pub async fn db_update_rows(db: State<'_, Db>, id: String, schema: String, table: String, rows: Vec<RowEdit>) -> Result<u64, String> {
    redact(db.update_rows(&id, &schema, &table, &rows).await)
}

#[tauri::command]
pub async fn db_password_set(id: String, password: String, config: ConnConfig) -> Result<(), String> {
    let value = serde_json::to_string(&Saved { password, bind: binding(&config) }).map_err(e2s)?;
    tokio::task::spawn_blocking(move || keychain::set(&id, &value)).await.map_err(e2s)?
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
        let r = db.query("rw", "SELECT id, name, avatar, score FROM authors ORDER BY id;", None, None, None).await.unwrap();
        assert_eq!(r.columns, ["id", "name", "avatar", "score"]);
        assert_eq!(r.rows[0], [Some("1".into()), Some("ann".into()), Some("\\x00ff10".into()), Some("1.0".into())]);
        assert_eq!(r.rows[1][2], None);
        assert_eq!(r.rows[2][3], None);
        assert!(!r.truncated && r.rows_affected.is_none());
        let r = db.query("rw", "SELECT * FROM posts", Some(7), None, None).await.unwrap();
        assert_eq!((r.rows.len(), r.truncated), (7, true));
        let r = db.query("rw", "SELECT * FROM posts", Some(30), None, None).await.unwrap();
        assert_eq!((r.rows.len(), r.truncated), (30, false));
        let r = db.query("rw", "INSERT INTO authors (name) VALUES ('dee'), ('eve')", None, None, None).await.unwrap();
        assert_eq!(r.rows_affected, Some(2));
        let r = db.query("rw", "UPDATE posts SET title = 'x' WHERE author_id = 1", None, None, None).await.unwrap();
        assert_eq!(r.rows_affected, Some(10));
        assert_eq!(db.query("rw", "SELECT 1; DROP TABLE posts", None, None, None).await.unwrap_err(), sql::ONE_STATEMENT);
        assert_eq!(db.query("rw", "-- nothing", None, None, None).await.unwrap_err(), "Nothing to run");
        let big = db.query("rw", "SELECT zeroblob(300)", None, None, None).await.unwrap();
        assert_eq!(big.rows[0][0].as_deref(), Some("<300 bytes>"));
        db.disconnect("rw").await;
        assert_eq!(db.query("rw", "SELECT 1", None, None, None).await.unwrap_err(), "Not connected");
    }

    #[tokio::test]
    async fn sqlite_read_only_rejects_writes() {
        let t = fixture("ro");
        let db = Db::default();
        db.connect("ro".into(), &cfg(&t.0, true), None).await.unwrap();
        assert_eq!(db.query("ro", "SELECT COUNT(*) FROM posts", None, None, None).await.unwrap().rows[0][0].as_deref(), Some("30"));
        assert!(db.query("ro", "PRAGMA table_info(posts)", None, None, None).await.is_ok());
        for bad in ["INSERT INTO authors (name) VALUES ('x')", "UPDATE posts SET title = 'y'", "DROP TABLE posts", "PRAGMA query_only = OFF"] {
            assert_eq!(db.query("ro", bad, None, None, None).await.unwrap_err(), sql::READ_ONLY, "{bad}");
        }
        // A writing CTE passes the keyword check; SQLite's read-only checks still stop it.
        assert!(db.query("ro", "WITH x AS (SELECT 1) INSERT INTO authors (name) SELECT 'z' FROM x", None, None, None).await.is_err());
        // query_only enforced by SQLite itself, beneath the keyword check.
        let c = Conn::open(&cfg(&t.0, true), None).await.unwrap();
        let Driver::Lite(raw) = &*c.driver.lock().await else { panic!("sqlite") };
        let err = raw.lock().unwrap().execute("DELETE FROM posts", []).unwrap_err().to_string();
        assert!(err.contains("readonly") || err.contains("read-only") || err.contains("attempt to write"), "{err}");
        let n = db.query("ro", "SELECT COUNT(*) FROM posts", None, None, None).await.unwrap();
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
        assert_eq!(db.query("p", "SELECT COUNT(*) FROM posts", None, None, None).await.unwrap().rows[0][0].as_deref(), Some("30"));
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

    async fn confirmed(db: &Db, id: &str, sql: &str) -> Result<QueryResult, String> {
        let err = db.query(id, sql, None, None, None).await.unwrap_err();
        let token = err.strip_prefix(sql::CONFIRM).and_then(|r| r.split(':').next()).ok_or(err.clone())?;
        db.query(id, sql, None, None, Some(token)).await
    }

    #[tokio::test]
    async fn destructive_statements_need_a_single_use_token() {
        let t = fixture("confirm");
        let db = Db::default();
        db.connect("c".into(), &cfg(&t.0, false), None).await.unwrap();
        let err = db.query("c", "DELETE FROM posts", None, None, None).await.unwrap_err();
        assert!(err.starts_with(sql::CONFIRM) && err.ends_with(":DELETE without a WHERE clause"), "{err}");
        let token = err[sql::CONFIRM.len()..].split(':').next().unwrap().to_string();
        assert!(db.query("c", "DELETE FROM posts", None, None, Some("wrong")).await.unwrap_err().starts_with(sql::CONFIRM));
        // The wrong guess burned the token; a fresh refusal issues a new one.
        let err = db.query("c", "DELETE FROM authors", None, None, Some(&token)).await.unwrap_err();
        let token = err[sql::CONFIRM.len()..].split(':').next().unwrap().to_string();
        assert!(db.query("c", "DELETE FROM posts", None, None, Some(&token)).await.unwrap_err().starts_with(sql::CONFIRM), "token is bound to its statement");
        let r = confirmed(&db, "c", "DELETE FROM posts").await.unwrap();
        assert_eq!(r.rows_affected, Some(30));
        assert_eq!(db.query("c", "DELETE FROM authors WHERE id = 3", None, None, None).await.unwrap().rows_affected, Some(1));
        assert_eq!(db.query("c", "SELECT COUNT(*) FROM authors", None, None, None).await.unwrap().rows[0][0].as_deref(), Some("2"));
    }

    #[tokio::test]
    async fn confirmation_tokens_are_kept_per_query_id() {
        let t = fixture("slots");
        let db = Db::default();
        db.connect("s".into(), &cfg(&t.0, false), None).await.unwrap();
        let tok = |e: String| e[sql::CONFIRM.len()..].split(':').next().unwrap().to_string();
        let a = tok(db.query("s", "DELETE FROM posts", None, Some("qa"), None).await.unwrap_err());
        let b = tok(db.query("s", "DELETE FROM authors", None, Some("qb"), None).await.unwrap_err());
        // The second pending confirmation didn't evict the first.
        assert!(db.query("s", "DELETE FROM posts", None, Some("qa"), Some(&a)).await.is_ok());
        assert!(db.query("s", "DELETE FROM authors", None, Some("qb"), Some(&a)).await.unwrap_err().starts_with(sql::CONFIRM), "a token only answers its own query id");
        let b2 = tok(db.query("s", "DELETE FROM authors", None, Some("qb"), Some(&b)).await.unwrap_err());
        assert!(db.query("s", "DELETE FROM authors", None, Some("qb"), Some(&b2)).await.is_ok());
    }

    fn edit(pk: &str, col: &str, new: Option<&str>, old: Option<&str>) -> RowEdit {
        RowEdit {
            pk: [("id".to_string(), pk.to_string())].into(),
            changes: [(col.to_string(), new.map(str::to_string))].into(),
            originals: [(col.to_string(), old.map(str::to_string))].into(),
        }
    }

    #[tokio::test]
    async fn grid_edits_run_as_one_checked_transaction() {
        let t = fixture("edits");
        let db = Db::default();
        db.connect("e".into(), &cfg(&t.0, false), None).await.unwrap();
        db.query("e", "CREATE TABLE nopk (a TEXT)", None, None, None).await.unwrap();
        let db = &db;
        let name = |id: u32| async move { db.query("e", &format!("SELECT name, score FROM authors WHERE id = {id}"), None, None, None).await.unwrap().rows[0].clone() };
        let n = db.update_rows("e", "main", "authors", &[edit("1", "name", Some("it's \\ ann"), Some("ann")), edit("2", "score", None, Some("2.5"))]).await.unwrap();
        assert_eq!(n, 2);
        assert_eq!(name(1).await[0].as_deref(), Some("it's \\ ann"));
        assert_eq!(name(2).await[1], None);
        // A row that changed since it was loaded stops the whole batch; the first row's edit is rolled back too.
        let err = db.update_rows("e", "main", "authors", &[edit("3", "name", Some("x"), Some("cy")), edit("1", "name", Some("y"), Some("ann"))]).await.unwrap_err();
        assert!(err.starts_with("Row 2: matched 0 rows"), "{err}");
        assert_eq!(db.query("e", "SELECT name FROM authors WHERE id = 3", None, None, None).await.unwrap().rows[0][0].as_deref(), Some("cy"));
        for (table, rows, why) in [
            ("recent", vec![edit("1", "title", Some("x"), None)], "is a view"),
            ("nopk", vec![edit("1", "a", Some("x"), None)], "no primary key"),
            ("authors", vec![edit("1", "avatar", Some("x"), None)], "binary"),
            ("authors", vec![edit("1", "nope", Some("x"), None)], "isn't a column"),
            ("authors", vec![edit("1", "id", Some("9"), Some("1"))], "primary key"),
            ("authors", vec![RowEdit { originals: BTreeMap::new(), ..edit("1", "name", Some("x"), None) }], "original value"),
        ] {
            let err = db.update_rows("e", "main", table, &rows).await.unwrap_err();
            assert!(err.contains(why), "{table}: {err}");
        }
        db.query("e", "BEGIN", None, None, None).await.unwrap();
        let err = db.update_rows("e", "main", "authors", &[edit("3", "name", Some("x"), Some("cy"))]).await.unwrap_err();
        assert!(err.contains("transaction open"), "{err}");
        db.query("e", "ROLLBACK", None, None, None).await.unwrap();
        db.connect("ro".into(), &cfg(&t.0, true), None).await.unwrap();
        assert_eq!(db.update_rows("ro", "main", "authors", &[edit("3", "name", Some("x"), Some("cy"))]).await.unwrap_err(), sql::READ_ONLY);
    }

    #[test]
    fn keychain_password_is_only_offered_to_the_server_it_was_saved_for() {
        let mut c = cfg(Path::new("/x"), false);
        c.engine = "postgres".into();
        c.host = "db.local".into();
        c.username = "app".into();
        let raw = serde_json::to_string(&Saved { password: "pw".into(), bind: binding(&c) }).unwrap();
        assert_eq!(saved_password(Some(raw.clone()), &c).as_deref(), Some("pw"));
        let explicit = ConnConfig { port: Some(5432), host: " DB.local ".into(), ..c.clone() };
        assert_eq!(saved_password(Some(raw.clone()), &explicit).as_deref(), Some("pw"));
        for other in [ConnConfig { host: "evil.example".into(), ..c.clone() }, ConnConfig { port: Some(6543), ..c.clone() }, ConnConfig { username: "root".into(), ..c.clone() }] {
            assert_eq!(saved_password(Some(raw.clone()), &other), None);
        }
        assert_eq!(saved_password(Some("legacy-plain-password".into()), &c), None);
        assert_eq!(saved_password(None, &c), None);
    }

    #[tokio::test]
    async fn cancel_only_interrupts_the_named_query() {
        let t = fixture("cancel");
        let db = Arc::new(Db::default());
        db.connect("x".into(), &cfg(&t.0, false), None).await.unwrap();
        let slow = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT COUNT(*) FROM n";
        let runner = db.clone();
        let task = tokio::spawn(async move { runner.query("x", slow, None, Some("q1"), None).await });
        let conn = db.get("x").unwrap();
        while conn.running.lock().await.is_none() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(conn.cancel_query("q0").await, Ok(false));
        assert!(!task.is_finished());
        assert_eq!(conn.cancel_query("q1").await, Ok(true));
        let err = task.await.unwrap().unwrap_err();
        assert!(err.contains("interrupt"), "{err}");
        assert_eq!(conn.cancel_query("q1").await, Ok(false));
        assert!(db.query("x", "SELECT 1", None, Some("q2"), None).await.is_ok());
    }

    #[tokio::test]
    async fn close_all_releases_locks_held_by_open_transactions() {
        let t = fixture("close");
        let db = Db::default();
        db.connect("w".into(), &cfg(&t.0, false), None).await.unwrap();
        db.query("w", "BEGIN", None, None, None).await.unwrap();
        db.query("w", "UPDATE posts SET title = 'locked' WHERE id = 1", None, None, None).await.unwrap();
        let other = rusqlite::Connection::open(t.0.join("db/development.sqlite3")).unwrap();
        other.busy_timeout(Duration::ZERO).unwrap();
        assert!(other.execute("UPDATE posts SET title = 'mine' WHERE id = 2", []).is_err());
        db.close_all().await;
        assert_eq!(other.execute("UPDATE posts SET title = 'mine' WHERE id = 2", []).unwrap(), 1);
        let title: String = other.query_row("SELECT title FROM posts WHERE id = 1", [], |r| r.get(0)).unwrap();
        assert_eq!(title, "post 1", "the open transaction was rolled back, not committed");
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
        confirmed(&db, "n", "DROP TABLE IF EXISTS garnet_test").await.unwrap();
        db.query("n", "CREATE TABLE garnet_test (id INT PRIMARY KEY, v TEXT, n NUMERIC(6,2))", None, None, None).await.unwrap();
        let r = db.query("n", "INSERT INTO garnet_test VALUES (1, 'a', 1.50), (2, NULL, NULL)", None, None, None).await.unwrap();
        assert_eq!(r.rows_affected, Some(2));
        let r = db.query("n", "SELECT id, v, n FROM garnet_test ORDER BY id", Some(1), None, None).await.unwrap();
        assert_eq!((r.rows[0][2].as_deref(), r.truncated), (Some("1.50"), true));
        let s = db.schema("n").await.unwrap();
        let t = s.schemas.iter().flat_map(|s| &s.tables).find(|t| t.name == "garnet_test").unwrap();
        assert!(t.columns[0].primary_key);
        let p = db.table_page("n", schema, "garnet_test", 0, 10, Some("id"), true, Some("v IS NULL")).await.unwrap();
        assert_eq!((p.total, p.result.rows.len()), (Some(1), 1));
        // The table viewer reads inside the console's open transaction instead of failing or ending it.
        let v1 = || async { db.query("n", "SELECT v FROM garnet_test WHERE id = 1", None, None, None).await.unwrap().rows[0][0].clone() };
        db.query("n", "BEGIN", None, None, None).await.unwrap();
        db.query("n", "UPDATE garnet_test SET v = 'b' WHERE id = 1", None, None, None).await.unwrap();
        db.query("n", "COMMIT AND CHAIN", None, None, None).await.unwrap();
        db.query("n", "UPDATE garnet_test SET v = 'c' WHERE id = 1", None, None, None).await.unwrap();
        let p = db.table_page("n", schema, "garnet_test", 0, 10, Some("id"), false, None).await.unwrap();
        assert_eq!(p.result.rows[0][1].as_deref(), Some("c"));
        db.query("n", "UPDATE garnet_test SET v = 'd' WHERE id = 1", None, None, None).await.unwrap();
        db.schema("n").await.unwrap();
        db.query("n", "ROLLBACK", None, None, None).await.unwrap();
        assert_eq!(v1().await.as_deref(), Some("b"));
        // Grid reads run on the read-only session, so a filter can't write even on a writable connection.
        if engine == "Postgres" {
            db.query("n", "CREATE SEQUENCE IF NOT EXISTS garnet_seq", None, None, None).await.unwrap();
            let err = db.table_page("n", schema, "garnet_test", 0, 10, None, false, Some("nextval('garnet_seq') > 0")).await.unwrap_err();
            assert!(err.contains("read-only"), "{err}");
            confirmed(&db, "n", "DROP SEQUENCE garnet_seq").await.unwrap();
        }
        let n = db.update_rows("n", schema, "garnet_test", &[RowEdit {
            pk: [("id".to_string(), "1".to_string())].into(),
            changes: [("n".to_string(), Some("2.25".to_string()))].into(),
            originals: [("n".to_string(), Some("1.50".to_string()))].into(),
        }]).await.unwrap();
        assert_eq!(n, 1);
        db.query("n", "BEGIN", None, None, None).await.unwrap();
        assert!(db.update_rows("n", schema, "garnet_test", &[RowEdit {
            pk: [("id".to_string(), "1".to_string())].into(),
            changes: [("v".to_string(), Some("z".to_string()))].into(),
            originals: [("v".to_string(), Some("b".to_string()))].into(),
        }]).await.unwrap_err().contains("transaction open"));
        db.query("n", "ROLLBACK", None, None, None).await.unwrap();
        c.read_only = true;
        db.connect("ro".into(), &c, pw.as_deref()).await.unwrap();
        assert_eq!(db.query("ro", "DELETE FROM garnet_test", None, None, None).await.unwrap_err(), sql::READ_ONLY);
        assert!(db.query("ro", "WITH d AS (SELECT 1) SELECT * FROM garnet_test", None, None, None).await.is_ok());
        assert_eq!(db.query("ro", "SELECT * FROM garnet_test INTO OUTFILE '/tmp/garnet-x'", None, None, None).await.unwrap_err(), sql::READ_ONLY);
        // The session itself is read-only: a write that slipped past the keyword check is still refused.
        let conn = db.get("ro").unwrap();
        let mut d = conn.driver.lock().await;
        assert!(d.exec("UPDATE garnet_test SET v = 'x' WHERE id = 2", 0, false).await.is_err());
        drop(d);
        confirmed(&db, "n", "DROP TABLE garnet_test").await.unwrap();
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
