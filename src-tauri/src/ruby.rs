use serde::Serialize;
use std::path::{Path, PathBuf};

/// Ruby version managers in detection order. mise comes first because it also reads
/// `.ruby-version` and `.tool-versions`, so it wins when several are installed.
pub const MANAGERS: [&str; 5] = ["mise", "rbenv", "asdf", "chruby", "rvm"];

#[derive(Serialize, Debug, PartialEq)]
pub struct Detection {
    /// One of MANAGERS or "none".
    pub manager: String,
    /// Absolute path of the manager executable (empty for "none").
    pub tool: String,
    /// Why this manager was picked, shown in the Ruby LSP log.
    pub reason: String,
}

fn executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

fn program(manager: &str) -> &str {
    if manager == "chruby" { "chruby-exec" } else { manager }
}

/// Directories searched after the login-shell PATH (Homebrew on Apple silicon and Intel).
pub const EXTRA_PATH: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];

/// The manager's executable: first on `path`, then in its usual install locations under `home`.
pub fn find_tool(manager: &str, path: &[PathBuf], home: &Path) -> Option<PathBuf> {
    let name = program(manager);
    let known: Vec<PathBuf> = match manager {
        "mise" => vec![home.join(".local/bin/mise"), home.join(".local/share/mise/bin/mise")],
        "rbenv" => vec![home.join(".rbenv/bin/rbenv")],
        "asdf" => vec![home.join(".asdf/bin/asdf")],
        "rvm" => vec![home.join(".rvm/bin/rvm")],
        _ => vec![],
    };
    path.iter().filter(|d| d.is_absolute()).map(|d| d.join(name)).chain(known).find(|p| executable(p))
}

fn ruby_version_file(root: &Path) -> Option<String> {
    let v = std::fs::read_to_string(root.join(".ruby-version")).ok()?;
    let v = v.trim().trim_start_matches("ruby-").to_string();
    (!v.is_empty()).then_some(v)
}

/// Version files in the project root, and which managers read each one.
fn version_files(root: &Path) -> Vec<(&'static str, &'static [&'static str])> {
    let mut found = Vec::new();
    for f in ["mise.toml", ".mise.toml", ".config/mise.toml", "mise.local.toml"] {
        if root.join(f).is_file() {
            found.push((f, &["mise"][..]));
            break;
        }
    }
    let tool_versions = std::fs::read_to_string(root.join(".tool-versions")).unwrap_or_default();
    if tool_versions.lines().any(|l| l.split_whitespace().next() == Some("ruby")) {
        found.push((".tool-versions", &["mise", "asdf"][..]));
    }
    if ruby_version_file(root).is_some() {
        found.push((".ruby-version", &["mise", "rbenv", "chruby", "asdf", "rvm"][..]));
    }
    found
}

/// Picks the version manager for `root`. Order: the setting when it is not "auto"; else the first installed
/// manager that reads the project's version file (mise.toml, then .tool-versions, then .ruby-version); else
/// the first installed manager in MANAGERS order (chruby needs a .ruby-version); else none (Ruby from PATH).
pub fn detect(root: &Path, path: &[PathBuf], home: &Path, setting: &str) -> Detection {
    let pick = |m: &str, reason: String| Detection {
        manager: m.into(),
        tool: find_tool(m, path, home).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        reason,
    };
    if setting != "auto" && !setting.is_empty() {
        let d = pick(setting, format!("set in Settings › Languages › Ruby ({setting})"));
        if setting == "none" || !d.tool.is_empty() {
            return d;
        }
        return Detection { reason: format!("{setting} is selected in Settings but {} was not found", program(setting)), ..d };
    }
    let installed: Vec<&str> = MANAGERS.iter().copied().filter(|m| find_tool(m, path, home).is_some()).collect();
    for (file, readers) in version_files(root) {
        if let Some(m) = readers.iter().find(|m| installed.contains(m)) {
            return pick(m, format!("{file} is read by {m}; installed: {}", installed.join(", ")));
        }
    }
    let has_ruby_version = ruby_version_file(root).is_some();
    match installed.iter().find(|m| **m != "chruby" || has_ruby_version) {
        Some(m) => pick(m, format!("first installed of {}", installed.join(", "))),
        None => pick("none", "no version manager found; using ruby-lsp from PATH".into()),
    }
}

/// Prefix that runs a command with the project's Ruby under `d` (empty for "none").
pub fn exec_prefix(d: &Detection, root: &Path) -> Vec<String> {
    let tool = d.tool.clone();
    match d.manager.as_str() {
        "mise" => vec![tool, "exec".into(), "--".into()],
        "rbenv" | "asdf" => vec![tool, "exec".into()],
        "rvm" => vec![tool, "in".into(), root.to_string_lossy().into_owned(), "do".into()],
        "chruby" => vec![tool, ruby_version_file(root).unwrap_or_else(|| "ruby".into()), "--".into()],
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    struct Fixture {
        dir: PathBuf,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("garnet-ruby-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("home")).unwrap();
            std::fs::create_dir_all(dir.join("project")).unwrap();
            std::fs::create_dir_all(dir.join("bin")).unwrap();
            Fixture { dir }
        }
        fn home(&self) -> PathBuf {
            self.dir.join("home")
        }
        fn root(&self) -> PathBuf {
            self.dir.join("project")
        }
        fn path(&self) -> Vec<PathBuf> {
            vec![self.dir.join("bin")]
        }
        fn tool(&self, rel: &str) -> PathBuf {
            let p = self.dir.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            p
        }
        fn file(&self, rel: &str, body: &str) {
            std::fs::write(self.root().join(rel), body).unwrap();
        }
        fn detect(&self, setting: &str) -> Detection {
            detect(&self.root(), &self.path(), &self.home(), setting)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn mise_beats_rbenv_when_both_are_installed() {
        let f = Fixture::new("both");
        f.tool("home/.local/bin/mise");
        f.tool("bin/rbenv");
        f.file(".ruby-version", "3.3.4\n");
        let d = f.detect("auto");
        assert_eq!(d.manager, "mise");
        assert!(d.tool.ends_with("home/.local/bin/mise"));
        assert!(d.reason.contains(".ruby-version"), "{}", d.reason);
        assert_eq!(f.detect("auto").manager, "mise", "deterministic");
    }

    #[test]
    fn version_files_pick_a_manager_that_reads_them() {
        let f = Fixture::new("files");
        f.tool("bin/rbenv");
        f.tool("bin/asdf");
        f.file(".tool-versions", "nodejs 20\nruby 3.3.4\n");
        assert_eq!(f.detect("auto").manager, "asdf");
        std::fs::remove_file(f.root().join(".tool-versions")).unwrap();
        f.file(".tool-versions", "nodejs 20\n");
        f.file(".ruby-version", "ruby-3.2.0");
        assert_eq!(f.detect("auto").manager, "rbenv");
        f.file("mise.toml", "[tools]\nruby = \"3.3\"\n");
        assert_eq!(f.detect("auto").manager, "rbenv", "mise.toml is ignored when mise is not installed");
        f.tool("bin/mise");
        assert_eq!(f.detect("auto").manager, "mise");
    }

    #[test]
    fn falls_back_to_installed_order_then_none() {
        let f = Fixture::new("order");
        assert_eq!(f.detect("auto").manager, "none");
        f.tool("bin/chruby-exec");
        assert_eq!(f.detect("auto").manager, "none", "chruby needs a .ruby-version");
        f.file(".ruby-version", "3.3.4");
        let d = f.detect("auto");
        assert_eq!(d.manager, "chruby");
        assert_eq!(exec_prefix(&d, &f.root())[1..], ["3.3.4".to_string(), "--".into()]);
        f.tool("home/.rvm/bin/rvm");
        f.tool("home/.asdf/bin/asdf");
        assert_eq!(f.detect("auto").manager, "chruby", ".ruby-version readers: chruby before asdf and rvm");
        std::fs::remove_file(f.root().join(".ruby-version")).unwrap();
        assert_eq!(f.detect("auto").manager, "asdf");
    }

    #[test]
    fn setting_overrides_detection() {
        let f = Fixture::new("setting");
        f.tool("bin/mise");
        f.tool("bin/rbenv");
        assert_eq!(f.detect("rbenv").manager, "rbenv");
        assert_eq!(f.detect("none").manager, "none");
        let d = f.detect("rvm");
        assert_eq!((d.manager.as_str(), d.tool.as_str()), ("rvm", ""));
        assert!(d.reason.contains("not found"));
    }

    #[test]
    fn exec_prefixes() {
        let root = Path::new("/p");
        let d = |m: &str| Detection { manager: m.into(), tool: format!("/t/{m}"), reason: String::new() };
        assert_eq!(exec_prefix(&d("mise"), root), ["/t/mise", "exec", "--"]);
        assert_eq!(exec_prefix(&d("rbenv"), root), ["/t/rbenv", "exec"]);
        assert_eq!(exec_prefix(&d("asdf"), root), ["/t/asdf", "exec"]);
        assert_eq!(exec_prefix(&d("rvm"), root), ["/t/rvm", "in", "/p", "do"]);
        assert!(exec_prefix(&d("none"), root).is_empty());
    }
}
