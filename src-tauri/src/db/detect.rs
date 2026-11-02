use crate::fsops::e2s;
use serde::Serialize;
use serde_yaml::{Mapping, Value};
use std::collections::HashMap;
use std::path::Path;

// No Debug: holds a password.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Detected {
    pub environment: String,
    pub engine: Option<String>,
    pub adapter: String,
    pub host: String,
    pub port: Option<u16>,
    pub database: String,
    pub username: String,
    pub password: Option<String>,
    pub unresolved: Vec<String>,
}

pub fn detect(root: &Path, env: &HashMap<String, String>) -> Result<Vec<Detected>, String> {
    match std::fs::read_to_string(root.join("config/database.yml")) {
        Ok(src) => parse(&src, env),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e2s(e)),
    }
}

pub fn engine_for(adapter: &str) -> Option<&'static str> {
    match adapter {
        "postgresql" | "postgis" => Some("postgres"),
        "mysql2" | "trilogy" | "mysql" => Some("mysql"),
        "sqlite3" | "sqlite" => Some("sqlite"),
        _ => None,
    }
}

const TOKEN: &str = "__GARNET_ERB_";

/// Replaces every `<%= … %>` with a placeholder token (resolved after YAML parsing, so values can't
/// break YAML structure) and drops `<% … %>` tags. Never runs Ruby: only `eval_erb`'s safe forms resolve.
pub fn erb(src: &str, env: &HashMap<String, String>) -> (String, Vec<Option<String>>, bool) {
    let (mut out, mut vals, mut control) = (String::new(), vec![], false);
    let mut rest = src;
    while let Some(start) = rest.find("<%") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        if let Some(lit) = after.strip_prefix('%') {
            out.push_str("<%");
            rest = lit;
            continue;
        }
        let Some(end) = after.find("%>") else {
            out.push_str(&rest[start..]);
            rest = "";
            break;
        };
        let inner = after[..end].trim_end_matches('-');
        rest = &after[end + 2..];
        match inner.strip_prefix('=') {
            Some(expr) => {
                out.push_str(&format!("{TOKEN}{}__", vals.len()));
                vals.push(eval_erb(expr.trim(), env));
            }
            None => control = true,
        }
    }
    out.push_str(rest);
    (out, vals, control)
}

struct P<'a>(&'a str);

impl P<'_> {
    fn ws(&mut self) {
        self.0 = self.0.trim_start();
    }
    fn eat(&mut self, t: &str) -> bool {
        self.ws();
        match self.0.strip_prefix(t) {
            Some(r) => {
                self.0 = r;
                true
            }
            None => false,
        }
    }
    fn string(&mut self) -> Option<String> {
        self.ws();
        let q = self.0.chars().next().filter(|c| *c == '"' || *c == '\'')?;
        let end = self.0[1..].find(q)? + 1;
        let body = &self.0[1..end];
        if body.contains('\\') || (q == '"' && body.contains("#{")) {
            return None;
        }
        self.0 = &self.0[end + 1..];
        Some(body.to_string())
    }
    /// Literal: string, integer or nil (`Some(None)`).
    fn literal(&mut self) -> Option<Option<String>> {
        if let Some(s) = self.string() {
            return Some(Some(s));
        }
        if self.eat("nil") {
            return Some(None);
        }
        let n = self.0.find(|c: char| !(c.is_ascii_digit() || c == '-')).unwrap_or(self.0.len());
        let num = &self.0[..n];
        (!num.is_empty() && num.parse::<i64>().is_ok()).then(|| {
            self.0 = &self.0[n..];
            Some(num.to_string())
        })
    }
    /// One term; outer None = not a safe form, inner None = Ruby nil.
    fn term(&mut self, env: &HashMap<String, String>) -> Option<Option<String>> {
        if !self.eat("ENV") {
            return self.literal();
        }
        if self.eat("[") {
            let key = self.string()?;
            return self.eat("]").then(|| env.get(&key).cloned());
        }
        if !(self.eat(".fetch") && self.eat("(")) {
            return None;
        }
        let key = self.string()?;
        let mut default = None;
        if self.eat(",") {
            default = Some(self.literal()?);
        }
        if !self.eat(")") {
            return None;
        }
        if default.is_none() && self.eat("{") {
            default = Some(self.literal()?);
            if !self.eat("}") {
                return None;
            }
        }
        match env.get(&key) {
            Some(v) => Some(Some(v.clone())),
            None => default, // ENV.fetch without a default raises KeyError: unresolved
        }
    }
}

/// Resolves the ERB expressions database.yml files use for env vars; None = cannot resolve safely.
pub fn eval_erb(expr: &str, env: &HashMap<String, String>) -> Option<String> {
    let mut p = P(expr);
    let mut v = p.term(env)?;
    while p.eat("||") {
        let rhs = p.term(env)?;
        v = v.or(rhs);
    }
    p.ws();
    p.0.is_empty().then(|| v.unwrap_or_default())
}

/// Applies `<<` merge keys bottom-up so chained merges (`<<: *a` where `a` merges `*b`) resolve.
fn merge_keys(v: &mut Value) {
    match v {
        Value::Mapping(m) => {
            for (_, child) in m.iter_mut() {
                merge_keys(child);
            }
            if let Some(merge) = m.remove("<<") {
                let sources = match merge {
                    Value::Mapping(x) => vec![x],
                    Value::Sequence(s) => s.into_iter().filter_map(|v| if let Value::Mapping(x) = v { Some(x) } else { None }).collect(),
                    _ => vec![],
                };
                for src in sources {
                    for (k, val) in src {
                        m.entry(k).or_insert(val);
                    }
                }
            }
        }
        Value::Sequence(s) => s.iter_mut().for_each(merge_keys),
        Value::Tagged(t) => merge_keys(&mut t.value),
        _ => {}
    }
}

pub fn parse(src: &str, env: &HashMap<String, String>) -> Result<Vec<Detected>, String> {
    let (yaml, vals, control) = erb(src, env);
    let mut doc: Value = serde_yaml::from_str(&yaml).map_err(|e| {
        let hint = if control { " (it uses ERB control flow Garnet does not evaluate)" } else { "" };
        redact_url(&format!("config/database.yml{hint}: {e}"))
    })?;
    merge_keys(&mut doc);
    let Value::Mapping(top) = doc else { return Ok(vec![]) };
    let rails_env = env.get("RAILS_ENV").map(String::as_str).unwrap_or("development");
    let database_url = env.get("DATABASE_URL").filter(|u| !u.is_empty());
    let mut out = vec![];
    for (k, v) in &top {
        let (Some(name), Value::Mapping(m)) = (k.as_str(), v) else { continue };
        let env_url = (name == rails_env).then_some(database_url).flatten().map(String::as_str);
        if is_config(m) {
            out.push(entry(name.into(), m, &vals, env_url));
            continue;
        }
        let mut first = true;
        for (sk, sv) in m {
            if let (Some(sub), Value::Mapping(sm)) = (sk.as_str(), sv) {
                if is_config(sm) {
                    out.push(entry(format!("{name}/{sub}"), sm, &vals, if first { env_url } else { None }));
                    first = false;
                }
            }
        }
    }
    Ok(out)
}

fn is_config(m: &Mapping) -> bool {
    m.contains_key("database") || m.contains_key("url")
}

/// Replaces placeholder tokens with their resolved values; None if any is unresolved.
fn substitute(raw: &str, vals: &[Option<String>]) -> Option<String> {
    let mut out = String::new();
    let mut rest = raw;
    while let Some(i) = rest.find(TOKEN) {
        out.push_str(&rest[..i]);
        let after = &rest[i + TOKEN.len()..];
        let end = after.find("__")?;
        out.push_str(vals.get(after[..end].parse::<usize>().ok()?)?.as_deref()?);
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    Some(out)
}

#[derive(Default)]
struct UrlParts {
    adapter: Option<String>,
    host: Option<String>,
    port: Option<String>,
    database: Option<String>,
    username: Option<String>,
    password: Option<String>,
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = (b[i] == b'%').then(|| s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())).flatten();
        match hex {
            Some(h) => {
                out.push(h);
                i += 3;
            }
            None => {
                out.push(b[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parses `postgres://user:pass@host:port/db?…` and `sqlite3:path` (Rails DATABASE_URL forms).
fn parse_url(url: &str) -> UrlParts {
    let some = |s: &str| (!s.is_empty()).then(|| percent_decode(s));
    let Some((scheme, rest)) = url.split_once(':') else { return UrlParts::default() };
    let adapter = Some(match scheme {
        "postgres" | "postgresql" => "postgresql".to_string(),
        "sqlite" | "sqlite3" => "sqlite3".to_string(),
        s => s.to_string(),
    });
    let rest = rest.split('?').next().unwrap_or("");
    let Some(rest) = rest.strip_prefix("//").filter(|_| adapter.as_deref() != Some("sqlite3")) else {
        let path = rest.strip_prefix("//").unwrap_or(rest);
        return UrlParts { adapter, database: some(path), ..Default::default() };
    };
    let (auth, path) = rest.split_once('/').unwrap_or((rest, ""));
    let (userinfo, hostport) = auth.rsplit_once('@').unwrap_or(("", auth));
    let (user, pass) = userinfo.split_once(':').map_or((userinfo, None), |(u, p)| (u, Some(p)));
    let (host, port) = if let Some(v6) = hostport.strip_prefix('[') {
        let (h, p) = v6.split_once(']').unwrap_or((v6, ""));
        (h, p.strip_prefix(':').unwrap_or(""))
    } else {
        hostport.rsplit_once(':').unwrap_or((hostport, ""))
    };
    UrlParts {
        adapter,
        host: some(host),
        port: some(port),
        database: some(path),
        username: some(user),
        password: pass.map(percent_decode),
    }
}

/// Masks the password in any `scheme://user:pass@host` inside `s`.
pub fn redact_url(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find("://") {
        let (head, tail) = rest.split_at(i + 3);
        out.push_str(head);
        let end = tail.find(|c: char| c == '/' || c == '?' || c == '"' || c == '\'' || c.is_whitespace()).unwrap_or(tail.len());
        let auth = &tail[..end];
        match auth.rfind('@').and_then(|at| auth[..at].find(':').map(|c| (c, at))) {
            Some((c, at)) => {
                out.push_str(&auth[..=c]);
                out.push_str("***");
                out.push_str(&auth[at..]);
            }
            None => out.push_str(auth),
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

fn scalar(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn entry(environment: String, m: &Mapping, vals: &[Option<String>], env_url: Option<&str>) -> Detected {
    let mut unresolved = vec![];
    let mut get = |key: &str| -> Option<String> {
        let raw = m.get(key).and_then(scalar)?;
        let v = substitute(&raw, vals);
        if v.is_none() {
            unresolved.push(key.to_string());
        }
        v.filter(|s| !s.is_empty())
    };
    let mut adapter = get("adapter");
    let mut host = get("host");
    let mut port = get("port");
    let mut database = get("database");
    let mut username = get("username").or_else(|| get("user"));
    let mut password = get("password");
    // Rails (UrlConfig): url values win over individual keys; DATABASE_URL wins over both.
    for url in [get("url"), env_url.map(str::to_string)].into_iter().flatten() {
        let u = parse_url(&url);
        let given = [("adapter", &u.adapter), ("host", &u.host), ("port", &u.port), ("database", &u.database), ("username", &u.username), ("password", &u.password)];
        unresolved.retain(|f| !given.iter().any(|(k, v)| k == f && v.is_some()));
        adapter = u.adapter.or(adapter);
        host = u.host.or(host);
        port = u.port.or(port);
        database = u.database.or(database);
        username = u.username.or(username);
        password = u.password.or(password);
    }
    let adapter = adapter.unwrap_or_default();
    let engine = engine_for(&adapter).map(str::to_string);
    let networked = matches!(engine.as_deref(), Some("postgres" | "mysql"));
    Detected {
        environment,
        host: host.unwrap_or_else(|| if networked { "localhost".into() } else { String::new() }),
        port: port.and_then(|p| p.parse().ok()),
        database: database.unwrap_or_default(),
        username: username.unwrap_or_default(),
        password,
        engine,
        adapter,
        unresolved,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn resolves_only_safe_erb_forms() {
        let e = env(&[("DB_HOST", "db.local"), ("EMPTY", "")]);
        let ok = |x: &str| eval_erb(x, &e);
        assert_eq!(ok(r#"ENV["DB_HOST"]"#).as_deref(), Some("db.local"));
        assert_eq!(ok("ENV['DB_HOST']").as_deref(), Some("db.local"));
        assert_eq!(ok("ENV['MISSING']").as_deref(), Some(""));
        assert_eq!(ok(r#"ENV.fetch("DB_HOST")"#).as_deref(), Some("db.local"));
        assert_eq!(ok(r#"ENV.fetch("MISSING")"#), None);
        assert_eq!(ok(r#"ENV.fetch("MISSING", "lit")"#).as_deref(), Some("lit"));
        assert_eq!(ok(r#"ENV.fetch("MISSING", 5)"#).as_deref(), Some("5"));
        assert_eq!(ok(r#"ENV.fetch("RAILS_MAX_THREADS") { 5 }"#).as_deref(), Some("5"));
        assert_eq!(ok(r#"ENV.fetch("MISSING") { "x" }"#).as_deref(), Some("x"));
        assert_eq!(ok(r#"ENV.fetch("DB_HOST") { "x" }"#).as_deref(), Some("db.local"));
        assert_eq!(ok(r#"ENV["MISSING"] || "fallback""#).as_deref(), Some("fallback"));
        assert_eq!(ok(r#"ENV["EMPTY"] || "fallback""#).as_deref(), Some(""));
        assert_eq!(ok(r#""lit""#).as_deref(), Some("lit"));
        assert_eq!(ok("42").as_deref(), Some("42"));
        for bad in [
            "Rails.application.credentials.db",
            r#"ENV["X"].to_i"#,
            r#"`rm -rf /`"#,
            r##""#{ENV['X']}""##,
            r#"ENV.fetch("X") { system("x") }"#,
            r#"ENV["X"]; exit"#,
            "File.read('/etc/passwd')",
            "",
        ] {
            assert_eq!(eval_erb(bad, &e), None, "{bad}");
        }
    }

    #[test]
    fn erb_pass_uses_placeholders_and_strips_control_tags() {
        let e = env(&[("H", "x: y # not yaml")]);
        let (out, vals, control) = erb("a: <%= ENV['H'] %>\n<% if true %>\nb: <%= foo -%>\nc: <%%= lit %>\n<% end %>\n", &e);
        assert_eq!(out, "a: __GARNET_ERB_0__\n\nb: __GARNET_ERB_1__\nc: <%= lit %>\n\n");
        assert_eq!(vals, vec![Some("x: y # not yaml".to_string()), None]);
        assert!(control);
    }

    const YML: &str = r#"
default: &default
  adapter: postgresql
  encoding: unicode
  pool: <%= ENV.fetch("RAILS_MAX_THREADS") { 5 } %>
  username: <%= ENV["DB_USER"] %>
  password: <%= Rails.application.credentials.dig(:db, :password) %>

local: &local
  <<: *default
  host: <%= ENV.fetch("DB_HOST", "127.0.0.1") %>
  port: <%= ENV.fetch("DB_PORT", 5433) %>

development:
  <<: *local
  database: blog_development

test:
  <<: *default
  database: blog_test

production:
  primary: &primary
    <<: *default
    url: <%= ENV["PRIMARY_URL"] %>
  cache:
    <<: *primary
    adapter: sqlite3
    database: storage/production_cache.sqlite3
    url:
  queue:
    adapter: trilogy
    url: "mysql2://q%40user:p%3Ass@[::1]:3307/queue%5Fdb?pool=5"
"#;

    #[test]
    fn parses_anchors_merges_multi_db_urls_and_unresolved_fields() {
        let e = env(&[("DB_USER", "sachin"), ("PRIMARY_URL", "postgres://app:s3cret@db.example:6543/blog_prod")]);
        let d = parse(YML, &e).unwrap();
        let names: Vec<_> = d.iter().map(|x| x.environment.as_str()).collect();
        assert_eq!(names, ["development", "test", "production/primary", "production/cache", "production/queue"]);

        let dev = &d[0];
        assert_eq!(dev.engine.as_deref(), Some("postgres"));
        assert_eq!(dev.adapter, "postgresql");
        assert_eq!((dev.host.as_str(), dev.port), ("127.0.0.1", Some(5433)));
        assert_eq!((dev.database.as_str(), dev.username.as_str()), ("blog_development", "sachin"));
        assert!(dev.password.is_none());
        assert_eq!(dev.unresolved, ["password"]);

        let test = &d[1];
        assert_eq!((test.host.as_str(), test.port), ("localhost", None));

        let prod = &d[2];
        assert_eq!((prod.host.as_str(), prod.port, prod.database.as_str()), ("db.example", Some(6543), "blog_prod"));
        assert_eq!((prod.username.as_str(), prod.password.as_deref()), ("app", Some("s3cret")));
        assert!(prod.unresolved.is_empty());

        let cache = &d[3];
        assert_eq!(cache.engine.as_deref(), Some("sqlite"));
        assert_eq!((cache.database.as_str(), cache.host.as_str()), ("storage/production_cache.sqlite3", ""));

        let q = &d[4];
        assert_eq!((q.adapter.as_str(), q.engine.as_deref()), ("mysql2", Some("mysql")));
        assert_eq!((q.host.as_str(), q.port, q.database.as_str()), ("::1", Some(3307), "queue_db"));
        assert_eq!((q.username.as_str(), q.password.as_deref()), ("q@user", Some("p:ss")));
    }

    #[test]
    fn database_url_env_overrides_the_current_environment() {
        let yml = "development:\n  adapter: sqlite3\n  database: db/development.sqlite3\nother:\n  adapter: oracle_enhanced\n  database: x\n";
        let d = parse(yml, &env(&[])).unwrap();
        assert_eq!((d[0].engine.as_deref(), d[0].database.as_str()), (Some("sqlite"), "db/development.sqlite3"));
        assert_eq!((d[1].engine.as_deref(), d[1].adapter.as_str()), (None, "oracle_enhanced"));
        let d = parse(yml, &env(&[("DATABASE_URL", "postgresql://localhost/devdb")])).unwrap();
        assert_eq!((d[0].engine.as_deref(), d[0].host.as_str(), d[0].database.as_str()), (Some("postgres"), "localhost", "devdb"));
        assert_eq!(d[1].adapter, "oracle_enhanced");
        let d = parse(yml, &env(&[("DATABASE_URL", "sqlite3:///abs/dev.db")])).unwrap();
        assert_eq!(d[0].database, "/abs/dev.db");
    }

    #[test]
    fn missing_file_and_bad_yaml() {
        let dir = std::env::temp_dir().join(format!("garnet-dbyml-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("config")).unwrap();
        assert!(detect(&dir, &env(&[])).unwrap().is_empty());
        std::fs::write(dir.join("config/database.yml"), "development:\n  url: <%= ENV['U'] %>\n").unwrap();
        let d = detect(&dir, &env(&[("U", "mysql2://root@127.0.0.1/app")])).unwrap();
        assert_eq!((d[0].engine.as_deref(), d[0].username.as_str(), d[0].database.as_str()), (Some("mysql"), "root", "app"));
        let err = parse("<% if x %>\na: 1\n<% else %>\na: 2\n<% end %>\n", &env(&[])).err().unwrap();
        assert!(err.contains("ERB control flow"), "{err}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn redacts_url_passwords() {
        assert_eq!(redact_url("postgres://u:hunter2@h:5432/db"), "postgres://u:***@h:5432/db");
        assert_eq!(redact_url("bad url \"mysql2://root:pw@x/y\" and https://a.b/c"), "bad url \"mysql2://root:***@x/y\" and https://a.b/c");
        assert_eq!(redact_url("postgres://u@h/db"), "postgres://u@h/db");
        assert_eq!(redact_url("no url"), "no url");
        assert_eq!(percent_decode("a%20b%zz%"), "a b%zz%");
    }
}
