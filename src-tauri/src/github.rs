use crate::fsops::e2s;
use reqwest::header::{HeaderMap, ACCEPT, AUTHORIZATION, LINK};
use reqwest::{Method, StatusCode};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;
use tokio::io::AsyncReadExt;

const SERVICE: &str = "dev.garnet.ide.github";
const API: &str = "https://api.github.com";
const WEB: &str = "https://github.com";
/// Scopes requested by the device flow: private repos and PRs, org repos in the clone dialog, gists.
const SCOPES: &str = "repo read:org gist";

/// Errors carry a machine-readable prefix the frontend reacts to: `AUTH:` (sign in again), `RATE:`, `OFFLINE:`.
type Res<T> = Result<T, String>;

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::builder()
            .user_agent("Garnet")
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .build()
            .expect("http client")
    })
}

/// Where requests go and with which token. Tests point `api`/`web` at a mock server.
pub struct Gh {
    api: String,
    web: String,
    token: Option<String>,
}

impl Gh {
    fn live() -> Self {
        Gh { api: API.into(), web: WEB.into(), token: token() }
    }

    fn redact(&self, s: String) -> String {
        match &self.token {
            Some(t) if !t.is_empty() => s.replace(t.as_str(), "***"),
            _ => s,
        }
    }

    fn net_error(&self, e: reqwest::Error) -> String {
        if e.is_connect() || e.is_timeout() {
            "OFFLINE: Can't reach GitHub. Check your network connection and try again.".into()
        } else {
            self.redact(format!("GitHub request failed: {}", e.without_url()))
        }
    }

    async fn send(&self, method: Method, url: &str, body: Option<&Value>, accept: &str) -> Res<(StatusCode, HeaderMap, String)> {
        let mut req = client()
            .request(method, url)
            .header(ACCEPT, accept)
            .header("X-GitHub-Api-Version", "2022-11-28");
        if let Some(t) = &self.token {
            req = req.header(AUTHORIZATION, format!("Bearer {t}"));
        }
        if let Some(b) = body {
            req = req.json(b);
        }
        let resp = req.send().await.map_err(|e| self.net_error(e))?;
        let (status, headers) = (resp.status(), resp.headers().clone());
        let text = resp.text().await.map_err(|e| self.net_error(e))?;
        Ok((status, headers, text))
    }

    /// One REST call. `raw` returns the body as a string (file contents); `pages` follows `Link: rel="next"`
    /// up to that many pages and concatenates arrays (or the `items` of search results).
    pub async fn rest(&self, method: &str, path: &str, body: Option<Value>, raw: bool, pages: u32) -> Res<Value> {
        check_path(path)?;
        let method = Method::from_bytes(method.as_bytes()).map_err(|_| "invalid HTTP method".to_string())?;
        let accept = if raw { "application/vnd.github.raw" } else { "application/vnd.github+json" };
        let mut url = format!("{}{path}", self.api);
        let mut all: Option<Value> = None;
        for _ in 0..pages.max(1) {
            let (status, headers, text) = self.send(method.clone(), &url, body.as_ref(), accept).await?;
            if !status.is_success() {
                return Err(self.redact(http_error(status, &headers, &text)));
            }
            if raw {
                return Ok(Value::String(text));
            }
            let page: Value = if text.trim().is_empty() { Value::Null } else { serde_json::from_str(&text).map_err(e2s)? };
            all = Some(match all {
                None => page,
                Some(mut acc) => {
                    merge_page(&mut acc, page);
                    acc
                }
            });
            match next_link(&headers) {
                Some(next) if pages > 1 && next.starts_with(&format!("{}/", self.api)) => url = next,
                _ => break,
            }
        }
        Ok(all.unwrap_or(Value::Null))
    }

    pub async fn graphql(&self, query: &str, variables: Value) -> Res<Value> {
        let url = format!("{}/graphql", self.api);
        let body = json!({ "query": query, "variables": variables });
        let (status, headers, text) = self.send(Method::POST, &url, Some(&body), "application/json").await?;
        if !status.is_success() {
            return Err(self.redact(http_error(status, &headers, &text)));
        }
        let v: Value = serde_json::from_str(&text).map_err(e2s)?;
        if let Some(errors) = v["errors"].as_array().filter(|e| !e.is_empty()) {
            let msgs: Vec<&str> = errors.iter().filter_map(|e| e["message"].as_str()).collect();
            let rate = errors.iter().any(|e| e["type"] == "RATE_LIMITED");
            return Err(self.redact(format!("{}GitHub: {}", if rate { "RATE: " } else { "" }, msgs.join("; "))));
        }
        Ok(v["data"].clone())
    }

    pub async fn user(&self) -> Res<String> {
        let me = self.rest("GET", "/user", None, false, 1).await?;
        me["login"].as_str().map(str::to_string).ok_or_else(|| "GitHub returned no user".into())
    }

    async fn form(&self, path: &str, fields: &[(&str, &str)]) -> Res<Value> {
        let resp = client()
            .post(format!("{}{path}", self.web))
            .header(ACCEPT, "application/json")
            .form(fields)
            .send()
            .await
            .map_err(|e| self.net_error(e))?;
        let (status, headers) = (resp.status(), resp.headers().clone());
        let text = resp.text().await.map_err(|e| self.net_error(e))?;
        if !status.is_success() {
            return Err(http_error(status, &headers, &text));
        }
        serde_json::from_str(&text).map_err(e2s)
    }

    pub async fn device_start(&self, client_id: &str) -> Res<DeviceCode> {
        let v = self.form("/login/device/code", &[("client_id", client_id), ("scope", SCOPES)]).await?;
        if let Some(err) = v["error"].as_str() {
            return Err(format!("GitHub: {}", v["error_description"].as_str().unwrap_or(err)));
        }
        Ok(DeviceCode {
            device_code: v["device_code"].as_str().unwrap_or_default().into(),
            user_code: v["user_code"].as_str().unwrap_or_default().into(),
            verification_uri: v["verification_uri"].as_str().unwrap_or("https://github.com/login/device").into(),
            interval: v["interval"].as_u64().unwrap_or(5),
            expires_in: v["expires_in"].as_u64().unwrap_or(900),
        })
    }

    /// One poll of the device flow. On success the token is returned to the caller (Rust only), never to the UI.
    pub async fn device_poll(&self, client_id: &str, device_code: &str) -> Res<DevicePoll> {
        let v = self
            .form(
                "/login/oauth/access_token",
                &[("client_id", client_id), ("device_code", device_code), ("grant_type", "urn:ietf:params:oauth:grant-type:device_code")],
            )
            .await?;
        if let Some(t) = v["access_token"].as_str() {
            return Ok(DevicePoll::Token(t.to_string()));
        }
        Ok(match v["error"].as_str().unwrap_or("") {
            "authorization_pending" => DevicePoll::Pending,
            "slow_down" => DevicePoll::SlowDown(v["interval"].as_u64().unwrap_or(10)),
            "expired_token" => DevicePoll::Failed("The code expired. Start sign-in again.".into()),
            "access_denied" => DevicePoll::Failed("Sign-in was cancelled on GitHub.".into()),
            other => DevicePoll::Failed(format!("GitHub: {}", v["error_description"].as_str().unwrap_or(other))),
        })
    }
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    device_code: String,
    user_code: String,
    verification_uri: String,
    interval: u64,
    expires_in: u64,
}

#[derive(Debug, PartialEq)]
pub enum DevicePoll {
    Pending,
    SlowDown(u64),
    Token(String),
    Failed(String),
}

fn check_path(path: &str) -> Res<()> {
    if !path.starts_with('/') || path.starts_with("//") || path.contains(char::is_whitespace) || path.contains("..") {
        return Err("invalid API path".into());
    }
    Ok(())
}

fn merge_page(acc: &mut Value, page: Value) {
    match (acc, page) {
        (Value::Array(a), Value::Array(b)) => a.extend(b),
        (Value::Object(a), Value::Object(mut b)) => {
            if let (Some(Value::Array(items)), Some(Value::Array(more))) = (a.get_mut("items"), b.remove("items")) {
                items.extend(more);
            }
        }
        _ => {}
    }
}

fn next_link(headers: &HeaderMap) -> Option<String> {
    let link = headers.get(LINK)?.to_str().ok()?;
    link.split(',').find(|p| p.contains("rel=\"next\"")).and_then(|p| {
        let p = p.trim();
        Some(p[p.find('<')? + 1..p.find('>')?].to_string())
    })
}

fn header_u64(headers: &HeaderMap, name: &str) -> Option<u64> {
    headers.get(name)?.to_str().ok()?.trim().parse().ok()
}

fn http_error(status: StatusCode, headers: &HeaderMap, body: &str) -> String {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let mut msg = v["message"].as_str().unwrap_or("").to_string();
    if let Some(errors) = v["errors"].as_array() {
        let details: Vec<String> = errors
            .iter()
            .filter_map(|e| e["message"].as_str().map(str::to_string).or_else(|| e["code"].as_str().map(|c| format!("{} {c}", e["field"].as_str().unwrap_or("")))))
            .collect();
        if !details.is_empty() {
            msg = format!("{msg} ({})", details.join("; "));
        }
    }
    let code = status.as_u16();
    if code == 401 {
        return "AUTH: GitHub rejected the saved token (expired or revoked). Sign in again.".into();
    }
    let limited = header_u64(headers, "x-ratelimit-remaining") == Some(0);
    if code == 429 || (code == 403 && (limited || headers.contains_key("retry-after"))) {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let wait = header_u64(headers, "retry-after").or_else(|| header_u64(headers, "x-ratelimit-reset").map(|r| r.saturating_sub(now)));
        let when = wait.map(|s| format!(" Try again in {} min.", s.div_ceil(60).max(1))).unwrap_or_default();
        return format!("RATE: GitHub API rate limit reached.{when}");
    }
    if code == 404 && msg.is_empty() || msg == "Not Found" {
        return "GitHub 404: not found, or your token has no access to it.".into();
    }
    if msg.is_empty() {
        msg = body.chars().take(200).collect();
    }
    format!("GitHub {code}: {msg}")
}

// Keychain

fn token() -> Option<String> {
    let out = Command::new("security").args(["find-generic-password", "-s", SERVICE, "-a", "github", "-w"]).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|t| !t.is_empty())
}

fn valid_token(t: &str) -> bool {
    (20..=255).contains(&t.len()) && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Saves the token through `security -i` so it is read from stdin and never appears in a process's argv.
fn store_token(t: &str) -> Res<()> {
    if !valid_token(t) {
        return Err("That does not look like a GitHub token.".into());
    }
    let mut child = Command::new("security").arg("-i").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(e2s)?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    stdin.write_all(format!("add-generic-password -U -s {SERVICE} -a github -w {t}\n").as_bytes()).map_err(e2s)?;
    drop(stdin);
    child.wait().map_err(e2s)?;
    (token().as_deref() == Some(t)).then_some(()).ok_or_else(|| "Could not save the token to the Keychain.".into())
}

static LOGIN: Mutex<Option<String>> = Mutex::new(None);

async fn adopt(t: String) -> Res<String> {
    let login = Gh { api: API.into(), web: WEB.into(), token: Some(t.clone()) }.user().await?;
    store_token(&t)?;
    *LOGIN.lock().unwrap() = Some(login.clone());
    Ok(login)
}

fn gh_cli() -> Option<std::path::PathBuf> {
    // ponytail: GUI apps get a minimal PATH; the usual install locations cover Homebrew and the pkg installer.
    let mut dirs: Vec<std::path::PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(Into::into));
    dirs.into_iter().map(|d| d.join("gh")).find(|p| p.is_file())
}

fn gh_cli_token() -> Option<String> {
    let out = Command::new(gh_cli()?).args(["auth", "token", "--hostname", "github.com"]).stdin(Stdio::null()).output().ok()?;
    let t = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && valid_token(&t)).then_some(t)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    login: Option<String>,
    signed_in: bool,
    gh_available: bool,
    build_client_id: Option<String>,
}

/// Who is signed in, whether `gh` has a token to reuse, and the OAuth client id compiled in (if any).
#[tauri::command]
pub async fn github_auth_status() -> AuthStatus {
    let gh_available = tokio::task::spawn_blocking(|| gh_cli_token().is_some()).await.unwrap_or(false);
    let build_client_id = option_env!("GARNET_GITHUB_CLIENT_ID").filter(|s| !s.is_empty()).map(str::to_string);
    let signed_in = token().is_some();
    if !signed_in {
        *LOGIN.lock().unwrap() = None;
        return AuthStatus { login: None, signed_in, gh_available, build_client_id };
    }
    let cached = LOGIN.lock().unwrap().clone();
    let login = match cached {
        Some(l) => Some(l),
        None => match Gh::live().user().await {
            Ok(l) => {
                *LOGIN.lock().unwrap() = Some(l.clone());
                Some(l)
            }
            Err(_) => None,
        },
    };
    AuthStatus { login, signed_in, gh_available, build_client_id }
}

#[tauri::command]
pub async fn github_signed_in() -> bool {
    token().is_some()
}

/// Copies the GitHub CLI's token into the Keychain after checking it works. Returns the login.
#[tauri::command]
pub async fn github_use_gh_token() -> Res<String> {
    let t = tokio::task::spawn_blocking(gh_cli_token).await.map_err(e2s)?.ok_or("The GitHub CLI is not installed or not logged in (gh auth login).")?;
    adopt(t).await
}

/// Stores a pasted personal access token after checking it with GET /user. Returns the login.
#[tauri::command]
pub async fn github_store_token(token: String) -> Res<String> {
    let t = token.trim().to_string();
    if !valid_token(&t) {
        return Err("That does not look like a GitHub token.".into());
    }
    adopt(t).await
}

#[tauri::command]
pub async fn github_sign_out() -> Res<()> {
    let _ = Command::new("security").args(["delete-generic-password", "-s", SERVICE, "-a", "github"]).output();
    *LOGIN.lock().unwrap() = None;
    Ok(())
}

#[tauri::command]
pub async fn github_device_start(client_id: String) -> Res<DeviceCode> {
    Gh::live().device_start(client_id.trim()).await
}

/// Returns "pending", "slow_down:<secs>" or the login once signed in; errors end the flow.
#[tauri::command]
pub async fn github_device_poll(client_id: String, device_code: String) -> Res<String> {
    match Gh::live().device_poll(client_id.trim(), &device_code).await? {
        DevicePoll::Pending => Ok("pending".into()),
        DevicePoll::SlowDown(s) => Ok(format!("slow_down:{s}")),
        DevicePoll::Token(t) => adopt(t).await.map(|login| format!("ok:{login}")),
        DevicePoll::Failed(m) => Err(m),
    }
}

#[tauri::command]
pub async fn github_api(method: String, path: String, body: Option<Value>, raw: Option<bool>, pages: Option<u32>) -> Res<Value> {
    Gh::live().rest(&method, &path, body, raw.unwrap_or(false), pages.unwrap_or(1).min(20)).await
}

#[tauri::command]
pub async fn github_graphql(query: String, variables: Option<Value>) -> Res<Value> {
    let gh = Gh::live();
    if gh.token.is_none() {
        return Err("AUTH: Sign in to GitHub first.".into());
    }
    gh.graphql(&query, variables.unwrap_or(json!({}))).await
}

// Clone

/// Splits git's progress stream (lines end in \r or \n) into displayable lines.
fn progress_lines(buf: &mut String, chunk: &str) -> Vec<String> {
    buf.push_str(chunk);
    let mut out = Vec::new();
    while let Some(i) = buf.find(['\r', '\n']) {
        let line = buf[..i].trim().to_string();
        buf.drain(..=i);
        if !line.is_empty() {
            out.push(line);
        }
    }
    out
}

/// A clone target must be a new folder (not even a dangling symlink) directly inside an existing, real directory.
fn check_clone_dest(dest: &str) -> Res<()> {
    let p = std::path::Path::new(dest);
    if !p.is_absolute() || p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("Choose an absolute destination folder.".into());
    }
    if std::fs::symlink_metadata(p).is_ok() {
        return Err(format!("{dest} already exists."));
    }
    let parent = p.parent().ok_or("invalid destination")?;
    let meta = std::fs::symlink_metadata(parent).map_err(|_| format!("{} does not exist.", parent.display()))?;
    if !meta.is_dir() {
        return Err(format!("{} is not a folder (symlinked parents are refused).", parent.display()));
    }
    Ok(())
}

/// `git clone --progress`, streaming progress lines. For github.com HTTPS URLs the signed-in token is passed as an
/// extra header through GIT_CONFIG_* environment variables, so it is neither in argv nor written to .git/config.
pub async fn clone_repo(url: &str, dest: &str, token: Option<&str>, on_line: impl Fn(String)) -> Res<()> {
    if url.starts_with('-') {
        return Err("invalid clone URL".into());
    }
    check_clone_dest(dest)?;
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(["clone", "--progress", "--", url, dest]).env("GIT_TERMINAL_PROMPT", "0").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true);
    if let Some(t) = token.filter(|_| url.starts_with("https://github.com/")) {
        use base64::Engine;
        let basic = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{t}"));
        cmd.env("GIT_CONFIG_COUNT", "1").env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader").env("GIT_CONFIG_VALUE_0", format!("AUTHORIZATION: basic {basic}"));
    }
    let mut child = cmd.spawn().map_err(e2s)?;
    let mut stderr = child.stderr.take().ok_or("no stderr")?;
    let (mut buf, mut chunk, mut last) = (String::new(), [0u8; 4096], Vec::new());
    loop {
        let n = stderr.read(&mut chunk).await.map_err(e2s)?;
        if n == 0 {
            break;
        }
        for line in progress_lines(&mut buf, &String::from_utf8_lossy(&chunk[..n])) {
            last.push(line.clone());
            if last.len() > 5 {
                last.remove(0);
            }
            on_line(line);
        }
    }
    let status = child.wait().await.map_err(e2s)?;
    if status.success() {
        return Ok(());
    }
    let _ = std::fs::remove_dir_all(dest);
    let msg = last.join("\n");
    Err(match token {
        Some(t) => msg.replace(t, "***"),
        None => msg,
    })
}

#[tauri::command]
pub async fn github_clone(url: String, dest: String, on_progress: Channel<String>) -> Res<()> {
    let t = token();
    clone_repo(url.trim(), &dest, t.as_deref(), |line| {
        let _ = on_progress.send(line);
    })
    .await
}

#[tauri::command]
pub async fn open_url(url: String) -> Res<()> {
    if !url.starts_with("https://") {
        return Err("only https URLs can be opened".into());
    }
    Command::new("open").arg(url).status().map(|_| ()).map_err(e2s)
}

/// Opens a project in a separate Garnet window (its own process, so state stays isolated).
#[tauri::command]
pub async fn open_new_window(path: String) -> Res<()> {
    let exe = std::env::current_exe().map_err(e2s)?;
    Command::new(exe).arg(path).spawn().map(|_| ()).map_err(e2s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::{Matcher, Server};

    const TOKEN: &str = "ghp_testtoken1234567890abcdef";

    fn gh(server: &Server) -> Gh {
        Gh { api: server.url(), web: server.url(), token: Some(TOKEN.into()) }
    }

    #[tokio::test]
    async fn rest_sends_auth_and_api_headers() {
        let mut s = Server::new_async().await;
        let m = s
            .mock("GET", "/user")
            .match_header("authorization", format!("Bearer {TOKEN}").as_str())
            .match_header("accept", "application/vnd.github+json")
            .match_header("x-github-api-version", "2022-11-28")
            .match_header("user-agent", "Garnet")
            .with_body(r#"{"login":"octo"}"#)
            .create_async()
            .await;
        assert_eq!(gh(&s).user().await.unwrap(), "octo");
        m.assert_async().await;
    }

    #[tokio::test]
    async fn unauthorized_asks_to_sign_in_again_without_leaking_the_token() {
        let mut s = Server::new_async().await;
        s.mock("GET", "/user").with_status(401).with_body(format!(r#"{{"message":"Bad credentials {TOKEN}"}}"#)).create_async().await;
        let err = gh(&s).user().await.unwrap_err();
        assert!(err.starts_with("AUTH:"), "{err}");
        assert!(!err.contains(TOKEN));
    }

    #[tokio::test]
    async fn rate_limits_are_reported_with_a_wait_time() {
        let mut s = Server::new_async().await;
        let reset = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() + 300;
        s.mock("GET", "/a")
            .with_status(403)
            .with_header("x-ratelimit-remaining", "0")
            .with_header("x-ratelimit-reset", &reset.to_string())
            .with_body(r#"{"message":"API rate limit exceeded"}"#)
            .create_async()
            .await;
        s.mock("GET", "/b").with_status(429).with_header("retry-after", "61").with_body("{}").create_async().await;
        let a = gh(&s).rest("GET", "/a", None, false, 1).await.unwrap_err();
        assert!(a.starts_with("RATE:") && a.contains("5 min"), "{a}");
        let b = gh(&s).rest("GET", "/b", None, false, 1).await.unwrap_err();
        assert!(b.starts_with("RATE:") && b.contains("2 min"), "{b}");
    }

    #[tokio::test]
    async fn validation_and_missing_resources_have_readable_errors() {
        let mut s = Server::new_async().await;
        s.mock("POST", "/repos/o/r/pulls")
            .with_status(422)
            .with_body(r#"{"message":"Validation Failed","errors":[{"message":"A pull request already exists for o:feat."}]}"#)
            .create_async()
            .await;
        s.mock("GET", "/repos/o/missing").with_status(404).with_body(r#"{"message":"Not Found"}"#).create_async().await;
        s.mock("GET", "/forbidden").with_status(403).with_body(r#"{"message":"Resource not accessible by personal access token"}"#).create_async().await;
        let e = gh(&s).rest("POST", "/repos/o/r/pulls", Some(json!({})), false, 1).await.unwrap_err();
        assert_eq!(e, "GitHub 422: Validation Failed (A pull request already exists for o:feat.)");
        assert!(gh(&s).rest("GET", "/repos/o/missing", None, false, 1).await.unwrap_err().contains("no access"));
        assert_eq!(gh(&s).rest("GET", "/forbidden", None, false, 1).await.unwrap_err(), "GitHub 403: Resource not accessible by personal access token");
    }

    #[tokio::test]
    async fn offline_is_detected() {
        let g = Gh { api: "http://127.0.0.1:9".into(), web: "http://127.0.0.1:9".into(), token: Some(TOKEN.into()) };
        let e = g.rest("GET", "/user", None, false, 1).await.unwrap_err();
        assert!(e.starts_with("OFFLINE:"), "{e}");
    }

    #[tokio::test]
    async fn pagination_follows_next_links_on_the_api_host_only() {
        let mut s = Server::new_async().await;
        let next = format!("<{}/items?page=2>; rel=\"next\", <{}/items?page=2>; rel=\"last\"", s.url(), s.url());
        s.mock("GET", "/items").match_query(Matcher::Missing).with_header("link", &next).with_body("[1,2]").create_async().await;
        s.mock("GET", "/items").match_query(Matcher::UrlEncoded("page".into(), "2".into())).with_body("[3]").create_async().await;
        assert_eq!(gh(&s).rest("GET", "/items", None, false, 5).await.unwrap(), json!([1, 2, 3]));
        assert_eq!(gh(&s).rest("GET", "/items", None, false, 1).await.unwrap(), json!([1, 2]));

        s.mock("GET", "/search").match_query(Matcher::Missing).with_header("link", &format!("<{}/search?page=2>; rel=\"next\"", s.url())).with_body(r#"{"total_count":3,"items":[1,2]}"#).create_async().await;
        s.mock("GET", "/search").match_query(Matcher::UrlEncoded("page".into(), "2".into())).with_body(r#"{"total_count":3,"items":[3]}"#).create_async().await;
        assert_eq!(gh(&s).rest("GET", "/search", None, false, 3).await.unwrap()["items"], json!([1, 2, 3]));

        s.mock("GET", "/evil").with_header("link", "<https://evil.example/steal>; rel=\"next\"").with_body("[1]").create_async().await;
        assert_eq!(gh(&s).rest("GET", "/evil", None, false, 5).await.unwrap(), json!([1]));
    }

    #[tokio::test]
    async fn rejects_paths_that_could_leave_the_api() {
        let s = Server::new_async().await;
        for p in ["user", "//evil.example/x", "/a b", "/repos/../x"] {
            assert_eq!(gh(&s).rest("GET", p, None, false, 1).await.unwrap_err(), "invalid API path");
        }
    }

    #[tokio::test]
    async fn raw_contents_come_back_as_text() {
        let mut s = Server::new_async().await;
        s.mock("GET", "/repos/o/r/contents/app/a.rb")
            .match_query(Matcher::UrlEncoded("ref".into(), "abc".into()))
            .match_header("accept", "application/vnd.github.raw")
            .with_body("puts 1\n")
            .create_async()
            .await;
        assert_eq!(gh(&s).rest("GET", "/repos/o/r/contents/app/a.rb?ref=abc", None, true, 1).await.unwrap(), json!("puts 1\n"));
    }

    #[tokio::test]
    async fn graphql_returns_data_and_surfaces_errors() {
        let mut s = Server::new_async().await;
        s.mock("POST", "/graphql")
            .match_body(Matcher::PartialJson(json!({"variables":{"n":1}})))
            .with_body(r#"{"data":{"viewer":{"login":"octo"}}}"#)
            .create_async()
            .await;
        assert_eq!(gh(&s).graphql("query { viewer { login } }", json!({"n":1})).await.unwrap()["viewer"]["login"], "octo");
        s.mock("POST", "/graphql")
            .match_body(Matcher::PartialJson(json!({"variables":{"n":2}})))
            .with_body(r#"{"data":null,"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded"}]}"#)
            .create_async()
            .await;
        assert!(gh(&s).graphql("q", json!({"n":2})).await.unwrap_err().starts_with("RATE:"));
        s.mock("POST", "/graphql")
            .match_body(Matcher::PartialJson(json!({"variables":{"n":3}})))
            .with_body(r#"{"errors":[{"type":"NOT_FOUND","message":"Could not resolve to a PullRequest"}]}"#)
            .create_async()
            .await;
        assert_eq!(gh(&s).graphql("q", json!({"n":3})).await.unwrap_err(), "GitHub: Could not resolve to a PullRequest");
        s.mock("POST", "/graphql").match_body(Matcher::PartialJson(json!({"variables":{"n":4}}))).with_status(401).create_async().await;
        assert!(gh(&s).graphql("q", json!({"n":4})).await.unwrap_err().starts_with("AUTH:"));
    }

    #[tokio::test]
    async fn device_flow_start_and_every_poll_outcome() {
        let mut s = Server::new_async().await;
        s.mock("POST", "/login/device/code")
            .match_header("accept", "application/json")
            .match_body(Matcher::AllOf(vec![Matcher::UrlEncoded("client_id".into(), "cid".into()), Matcher::UrlEncoded("scope".into(), SCOPES.into())]))
            .with_body(r#"{"device_code":"dc","user_code":"ABCD-1234","verification_uri":"https://github.com/login/device","interval":5,"expires_in":899}"#)
            .create_async()
            .await;
        let g = gh(&s);
        let code = g.device_start("cid").await.unwrap();
        assert_eq!((code.user_code.as_str(), code.device_code.as_str(), code.interval), ("ABCD-1234", "dc", 5));

        let mut poll = |device: &str, body: &str| {
            s.mock("POST", "/login/oauth/access_token")
                .match_body(Matcher::AllOf(vec![
                    Matcher::UrlEncoded("device_code".into(), device.into()),
                    Matcher::UrlEncoded("grant_type".into(), "urn:ietf:params:oauth:grant-type:device_code".into()),
                ]))
                .with_body(body)
                .create()
        };
        let _a = poll("p", r#"{"error":"authorization_pending"}"#);
        let _b = poll("s", r#"{"error":"slow_down","interval":10}"#);
        let _c = poll("e", r#"{"error":"expired_token"}"#);
        let _d = poll("d", r#"{"error":"access_denied"}"#);
        let _e = poll("t", r#"{"access_token":"gho_abcdefghijklmnopqrstuvwxyz","token_type":"bearer","scope":"repo"}"#);
        assert_eq!(g.device_poll("cid", "p").await.unwrap(), DevicePoll::Pending);
        assert_eq!(g.device_poll("cid", "s").await.unwrap(), DevicePoll::SlowDown(10));
        assert!(matches!(g.device_poll("cid", "e").await.unwrap(), DevicePoll::Failed(m) if m.contains("expired")));
        assert!(matches!(g.device_poll("cid", "d").await.unwrap(), DevicePoll::Failed(m) if m.contains("cancelled")));
        assert_eq!(g.device_poll("cid", "t").await.unwrap(), DevicePoll::Token("gho_abcdefghijklmnopqrstuvwxyz".into()));

        s.mock("POST", "/login/device/code").match_body(Matcher::UrlEncoded("client_id".into(), "bad".into())).with_body(r#"{"error":"unauthorized_client","error_description":"Device flow is not enabled"}"#).create_async().await;
        assert_eq!(g.device_start("bad").await.unwrap_err(), "GitHub: Device flow is not enabled");
    }

    /// Every endpoint the frontend calls, with its method and request body, against the mock.
    #[tokio::test]
    async fn frontend_endpoints_send_the_expected_requests() {
        let mut s = Server::new_async().await;
        let cases: Vec<(&str, &str, Option<Value>)> = vec![
            ("GET", "/repos/o/r", None),
            ("POST", "/repos/o/r/pulls", Some(json!({"title":"T","head":"feat","base":"main","body":"## Notes\n\n- a","draft":true}))),
            ("POST", "/gists", Some(json!({"public":false,"files":{"a.rb":{"content":"puts 1"}}}))),
            ("POST", "/markdown", Some(json!({"text":"**hi**","mode":"gfm","context":"o/r"}))),
            ("GET", "/repos/o/r/pulls/7/files?per_page=100", None),
            ("POST", "/repos/o/r/pulls/7/comments", Some(json!({"body":"nit","commit_id":"abc","path":"a.rb","line":3,"side":"RIGHT","start_line":2,"start_side":"RIGHT"}))),
            ("POST", "/repos/o/r/pulls/7/comments/99/replies", Some(json!({"body":"done"}))),
            ("POST", "/repos/o/r/pulls/7/reviews", Some(json!({"commit_id":"abc","event":"APPROVE","body":"","comments":[{"path":"a.rb","line":3,"side":"RIGHT","body":"x"}]}))),
            ("PUT", "/repos/o/r/pulls/7/merge", Some(json!({"merge_method":"squash","sha":"abc"}))),
            ("GET", "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member", None),
            ("GET", "/search/repositories?q=garnet&per_page=30", None),
            ("GET", "/repos/o/r/branches?per_page=100", None),
        ];
        let mut mocks = Vec::new();
        for (method, path, body) in &cases {
            let (p, q) = path.split_once('?').unwrap_or((path, ""));
            let mut m = s.mock(method, p).match_query(if q.is_empty() { Matcher::Missing } else { Matcher::Exact(q.into()) }).with_body("{}");
            if let Some(b) = body {
                m = m.match_body(Matcher::Json(b.clone()));
            }
            mocks.push(m.create_async().await);
        }
        for (method, path, body) in cases {
            gh(&s).rest(method, path, body, false, 1).await.unwrap_or_else(|e| panic!("{method} {path}: {e}"));
        }
        for m in mocks {
            m.assert_async().await;
        }
    }

    /// Read-only check against the real API over TLS: `GARNET_LIVE_GITHUB_TOKEN=$(gh auth token) cargo test live -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn live_read_only_calls() {
        let g = Gh { api: API.into(), web: WEB.into(), token: std::env::var("GARNET_LIVE_GITHUB_TOKEN").ok() };
        assert!(!g.user().await.unwrap().is_empty());
        let repo = g.rest("GET", "/repos/sachinkr7368/garnet", None, false, 1).await.unwrap();
        assert_eq!(repo["full_name"], "sachinkr7368/garnet");
        let pulls = g.rest("GET", "/repos/sachinkr7368/garnet/pulls?state=all&per_page=2", None, false, 2).await.unwrap();
        assert_eq!(pulls.as_array().unwrap().len(), 4);
        let readme = g.rest("GET", "/repos/sachinkr7368/garnet/contents/README.md", None, true, 1).await.unwrap();
        assert!(readme.as_str().unwrap().contains("Garnet"));
        let v = g.graphql("query($n: Int!) { repository(owner: \"sachinkr7368\", name: \"garnet\") { pullRequest(number: $n) { number } } }", json!({"n": 3})).await.unwrap();
        assert_eq!(v["repository"]["pullRequest"]["number"], 3);
        assert!(g.rest("GET", "/repos/sachinkr7368/definitely-missing-repo", None, false, 1).await.unwrap_err().contains("404"));
    }

    #[test]
    fn error_messages_and_link_parsing() {
        let mut h = HeaderMap::new();
        h.insert(LINK, "<https://api.github.com/x?page=3>; rel=\"next\", <https://api.github.com/x?page=9>; rel=\"last\"".parse().unwrap());
        assert_eq!(next_link(&h).as_deref(), Some("https://api.github.com/x?page=3"));
        assert_eq!(next_link(&HeaderMap::new()), None);
        assert_eq!(http_error(StatusCode::BAD_GATEWAY, &HeaderMap::new(), "upstream down"), "GitHub 502: upstream down");
        assert!(valid_token("github_pat_11ABCDEFG0123456789_abcdefghijklmnop"));
        assert!(!valid_token("ghp_x; rm -rf /"));
        assert!(!valid_token("short"));
    }

    #[test]
    fn progress_stream_is_split_on_carriage_returns() {
        let mut buf = String::new();
        assert_eq!(progress_lines(&mut buf, "Cloning into 'x'...\nReceiving objects:  10%"), vec!["Cloning into 'x'..."]);
        assert_eq!(progress_lines(&mut buf, " (1/10)\rReceiving objects: 100% (10/10), done.\n"), vec!["Receiving objects:  10% (1/10)", "Receiving objects: 100% (10/10), done."]);
        assert!(buf.is_empty());
    }

    #[tokio::test]
    async fn clones_a_local_repository_with_progress() {
        let base = std::env::temp_dir().join(format!("garnet-clone-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("src");
        std::fs::create_dir_all(&src).unwrap();
        let git = |args: &[&str]| assert!(Command::new("git").args(args).current_dir(&src).output().unwrap().status.success());
        git(&["init", "-q", "-b", "main"]);
        std::fs::write(src.join("a.rb"), "puts 1\n").unwrap();
        git(&["add", "."]);
        git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
        let dest = base.join("dest");
        let lines = std::sync::Arc::new(Mutex::new(Vec::new()));
        let sink = lines.clone();
        clone_repo(&format!("file://{}", src.display()), dest.to_str().unwrap(), Some(TOKEN), move |l| sink.lock().unwrap().push(l)).await.unwrap();
        assert!(dest.join("a.rb").is_file());
        assert!(lines.lock().unwrap().iter().any(|l| l.starts_with("Cloning into")));
        assert!(!std::fs::read_to_string(dest.join(".git/config")).unwrap().contains("extraheader"));
        assert!(clone_repo("file:///nope", dest.to_str().unwrap(), None, |_| {}).await.unwrap_err().contains("already exists"));
        std::os::unix::fs::symlink(base.join("gone"), base.join("dangling")).unwrap();
        assert!(clone_repo("file:///nope", base.join("dangling").to_str().unwrap(), None, |_| {}).await.unwrap_err().contains("already exists"));
        std::os::unix::fs::symlink(&src, base.join("linkdir")).unwrap();
        assert!(clone_repo("file:///nope", base.join("linkdir/x").to_str().unwrap(), None, |_| {}).await.unwrap_err().contains("symlinked"));
        assert!(clone_repo("file:///nope", "relative/x", None, |_| {}).await.unwrap_err().contains("absolute"));
        assert!(clone_repo("file:///nope", base.join("a/../b").to_str().unwrap(), None, |_| {}).await.unwrap_err().contains("absolute"));
        let missing = base.join("missing");
        assert!(clone_repo(&format!("file://{}/nope", base.display()), missing.to_str().unwrap(), None, |_| {}).await.is_err());
        assert!(!missing.exists());
        std::fs::remove_dir_all(&base).unwrap();
    }
}
