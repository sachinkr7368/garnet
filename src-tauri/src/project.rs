use crate::fsops::e2s;
use crate::index::{self, Index};
use crate::lsp::Lsp;
use crate::pty::Ptys;
use crate::{env, watch};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    root: String,
    name: String,
    git: bool,
    rails: bool,
    rspec: bool,
    minitest: bool,
    bin_rspec: bool,
    debug_bundled: bool,
}

fn detect(root: &Path) -> ProjectInfo {
    let lock = std::fs::read_to_string(root.join("Gemfile.lock")).unwrap_or_default();
    let has_gem = |name: &str| lock.lines().any(|l| l.trim_start().starts_with(&format!("{name} (")));
    ProjectInfo {
        root: root.to_string_lossy().into_owned(),
        name: root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        git: root.join(".git").exists(),
        rails: root.join("config/application.rb").exists() && root.join("bin/rails").exists(),
        rspec: has_gem("rspec-core") || root.join(".rspec").exists(),
        minitest: root.join("test").is_dir(),
        bin_rspec: root.join("bin/rspec").exists(),
        debug_bundled: has_gem("debug"),
    }
}

#[tauri::command]
pub async fn open_project(app: AppHandle, path: String) -> Result<ProjectInfo, String> {
    let root: PathBuf = std::fs::canonicalize(&path).map_err(e2s)?;
    if !root.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    crate::git::git_set_trusted(false);
    app.state::<Ptys>().kill_all();
    app.state::<Lsp>().stop();
    app.state::<Index>().set_root(root.clone());
    let watcher = watch::start(app.clone(), root.clone()).map_err(e2s)?;
    *app.state::<watch::Watch>().0.lock().unwrap() = Some(watcher);
    let handle = app.clone();
    std::thread::spawn(move || index::rebuild(&handle));
    let warm = root.clone();
    std::thread::spawn(move || env::shell_env(&warm));
    Ok(detect(&root))
}

/// Runs a shell command in the project's login-shell environment and returns stdout.
#[tauri::command]
pub async fn run_capture(root: String, command: String, timeout_secs: Option<u64>) -> Result<String, String> {
    let root_path = PathBuf::from(&root);
    let mut cmd = tokio::task::spawn_blocking(move || env::tokio_command(&root_path, "/bin/sh"))
        .await
        .map_err(e2s)?;
    let child = cmd.args(["-c", &command]).output();
    let out = tokio::time::timeout(Duration::from_secs(timeout_secs.unwrap_or(120)), child)
        .await
        .map_err(|_| format!("`{command}` timed out"))?
        .map_err(e2s)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(format!(
            "`{command}` failed:\n{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        ))
    }
}

#[tauri::command]
pub fn initial_path() -> Option<String> {
    std::env::args().skip(1).find(|a| !a.starts_with('-'))
}

/// Config files are flat names inside Garnet's own config dir; anything that could escape it is refused.
fn valid_config_name(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('.') && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
}

fn config_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if !valid_config_name(name) {
        return Err("invalid config name".into());
    }
    let dir = app.path().app_config_dir().map_err(e2s)?;
    std::fs::create_dir_all(&dir).map_err(e2s)?;
    Ok(dir.join(name))
}

#[tauri::command]
pub fn config_path(app: AppHandle, name: String) -> Result<String, String> {
    config_file(&app, &name).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn config_read(app: AppHandle, name: String) -> Result<Option<String>, String> {
    Ok(std::fs::read_to_string(config_file(&app, &name)?).ok())
}

#[tauri::command]
pub fn config_write(app: AppHandle, name: String, content: String) -> Result<(), String> {
    std::fs::write(config_file(&app, &name)?, content).map_err(e2s)
}

#[tauri::command]
pub fn index_root(index: State<'_, Index>) -> Option<String> {
    index.root().ok().map(|p| p.to_string_lossy().into_owned())
}

/// `GARNET_SMOKE=<report path>` runs the frontend's end-to-end smoke script (see CONTRIBUTING.md).
#[tauri::command]
pub fn smoke_target() -> Option<(String, bool)> {
    let report = std::env::var("GARNET_SMOKE").ok()?;
    Some((report, std::env::var_os("GARNET_SMOKE_DEBUG").is_some()))
}

pub static STARTED: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

/// Milliseconds since the process started (cold-start measurement).
#[tauri::command]
pub fn uptime_ms() -> u128 {
    STARTED.get().map(|t| t.elapsed().as_millis()).unwrap_or(0)
}

#[tauri::command]
pub fn smoke_finish(app: AppHandle, report: String) -> Result<(), String> {
    let path = std::env::var("GARNET_SMOKE").map_err(e2s)?;
    std::fs::write(path, report).map_err(e2s)?;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_names_cannot_escape_the_config_dir() {
        for ok in ["settings.json", "run-configs.json", "trusted.json"] {
            assert!(valid_config_name(ok), "{ok}");
        }
        for bad in ["", "..", "../x.json", "a/b.json", "/etc/passwd", ".hidden", "a b.json", "x\\y"] {
            assert!(!valid_config_name(bad), "{bad}");
        }
    }

    #[test]
    fn detects_rails_rspec_minitest_and_bundled_gems() {
        let dir = std::env::temp_dir().join(format!("garnet-detect-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("config")).unwrap();
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        std::fs::create_dir_all(dir.join("test")).unwrap();
        std::fs::write(dir.join("config/application.rb"), "").unwrap();
        std::fs::write(dir.join("bin/rails"), "").unwrap();
        std::fs::write(dir.join("Gemfile.lock"), "GEM\n  specs:\n    debug (1.9.2)\n    debugger-x (1.0)\n    rspec-core (3.13.0)\n").unwrap();
        let p = detect(&dir);
        assert!(p.rails && p.rspec && p.minitest && p.debug_bundled);
        assert!(!p.git && !p.bin_rspec);
        std::fs::remove_file(dir.join("bin/rails")).unwrap();
        std::fs::write(dir.join("Gemfile.lock"), "GEM\n  specs:\n    debugger-x (1.0)\n").unwrap();
        let p = detect(&dir);
        assert!(!p.rails && !p.rspec && !p.debug_bundled);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
