use crate::fsops::e2s;
use std::io::Write;
use std::process::{Command, Stdio};

const SERVICE: &str = "dev.garnet.ide.github";

/// GitHub token from the macOS Keychain.
fn token() -> Option<String> {
    let out = Command::new("security")
        .args(["find-generic-password", "-s", SERVICE, "-a", "github", "-w"])
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|t| !t.is_empty())
}

#[tauri::command]
pub async fn github_signed_in() -> bool {
    token().is_some()
}

#[tauri::command]
pub async fn github_store_token(token: String) -> Result<(), String> {
    // ponytail: `security -w <token>` briefly exposes the token in the process list; a keyring crate avoids that.
    let status = Command::new("security")
        .args(["add-generic-password", "-U", "-s", SERVICE, "-a", "github", "-w", token.trim()])
        .status()
        .map_err(e2s)?;
    status.success().then_some(()).ok_or_else(|| "could not save the token to the Keychain".into())
}

#[tauri::command]
pub async fn github_sign_out() -> Result<(), String> {
    let _ = Command::new("security").args(["delete-generic-password", "-s", SERVICE, "-a", "github"]).status();
    Ok(())
}

/// Calls the GitHub REST API with the stored token. The token is passed to curl on stdin, not argv.
#[tauri::command]
pub async fn github_api(method: String, path: String, body: Option<String>) -> Result<String, String> {
    let token = token().ok_or("Not signed in to GitHub")?;
    if !path.starts_with('/') || path.contains(char::is_whitespace) {
        return Err("invalid API path".into());
    }
    let mut child = Command::new("curl")
        .args(["-sS", "-K", "-", "-X", &method, "-w", "\n%{http_code}", &format!("https://api.github.com{path}")])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(e2s)?;
    let config = format!(
        "header = \"Authorization: Bearer {token}\"\nheader = \"Accept: application/vnd.github+json\"\nheader = \"X-GitHub-Api-Version: 2022-11-28\"\nuser-agent = \"Garnet\"\n"
    );
    // curl reads its config (-K -) from stdin first; a request body cannot share stdin, so it goes via a temp file.
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let mut tmp = None;
    if let Some(b) = &body {
        let path = std::env::temp_dir().join(format!("garnet-gh-{}.json", std::process::id()));
        std::fs::write(&path, b).map_err(e2s)?;
        tmp = Some(path);
    }
    let config = match &tmp {
        Some(p) => config + &format!("data-binary = \"@{}\"\n", p.display()),
        None => config,
    };
    stdin.write_all(config.as_bytes()).map_err(e2s)?;
    drop(stdin);
    let out = child.wait_with_output().map_err(e2s)?;
    if let Some(p) = tmp {
        let _ = std::fs::remove_file(p);
    }
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let (resp, code) = text.rsplit_once('\n').unwrap_or((&text, "0"));
    let code: u16 = code.trim().parse().unwrap_or(0);
    if (200..300).contains(&code) {
        Ok(resp.to_string())
    } else {
        let msg = serde_json::from_str::<serde_json::Value>(resp)
            .ok()
            .and_then(|v| v["message"].as_str().map(str::to_string))
            .unwrap_or_else(|| format!("{resp}{}", String::from_utf8_lossy(&out.stderr)));
        Err(format!("GitHub API {code}: {msg}"))
    }
}

#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("only https URLs can be opened".into());
    }
    Command::new("open").arg(url).status().map(|_| ()).map_err(e2s)
}

/// Opens a project in a separate Garnet window (its own process, so state stays isolated).
#[tauri::command]
pub async fn open_new_window(path: String) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(e2s)?;
    Command::new(exe).arg(path).spawn().map(|_| ()).map_err(e2s)
}

/// Latest published release of Garnet (tag and page URL), for the opt-in update check. Unauthenticated.
#[tauri::command]
pub async fn latest_release() -> Result<(String, String), String> {
    let out = Command::new("curl")
        .args([
            "-sS",
            "-f",
            "--max-time",
            "15",
            "-H",
            "Accept: application/vnd.github+json",
            "-A",
            "Garnet",
            "https://api.github.com/repos/sachinkr7368/garnet/releases/latest",
        ])
        .output()
        .map_err(e2s)?;
    if !out.status.success() {
        return Err(format!("update check failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    parse_release(&String::from_utf8_lossy(&out.stdout))
}

fn parse_release(body: &str) -> Result<(String, String), String> {
    let v: serde_json::Value = serde_json::from_str(body).map_err(e2s)?;
    let tag = v["tag_name"].as_str().ok_or("no tag_name in release")?;
    let url = v["html_url"].as_str().filter(|u| u.starts_with("https://github.com/")).ok_or("no release URL")?;
    Ok((tag.to_string(), url.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_latest_release() {
        let body = r#"{"tag_name":"v0.2.0","html_url":"https://github.com/sachinkr7368/garnet/releases/tag/v0.2.0","assets":[]}"#;
        assert_eq!(parse_release(body).unwrap(), ("v0.2.0".into(), "https://github.com/sachinkr7368/garnet/releases/tag/v0.2.0".into()));
        assert!(parse_release(r#"{"tag_name":"v1","html_url":"https://evil.example/x"}"#).is_err());
        assert!(parse_release("not json").is_err());
    }
}
