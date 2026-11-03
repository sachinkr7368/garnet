use crate::index::Index;
use ignore::WalkBuilder;
use serde::Serialize;
use std::fs;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager, State};

#[derive(Serialize)]
pub struct Entry {
    name: String,
    path: String,
    dir: bool,
}

pub fn e2s(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    let mut entries: Vec<Entry> = WalkBuilder::new(&path)
        .max_depth(Some(1))
        .hidden(false)
        .require_git(false)
        .filter_entry(|e| e.file_name() != ".git" && e.file_name() != ".DS_Store")
        .build()
        .filter_map(Result::ok)
        .filter(|e| e.depth() == 1)
        .map(|e| Entry {
            name: e.file_name().to_string_lossy().into_owned(),
            path: e.path().to_string_lossy().into_owned(),
            dir: e.file_type().is_some_and(|t| t.is_dir()),
        })
        .collect();
    entries.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub async fn read_file(app: AppHandle, index: State<'_, Index>, path: String) -> Result<String, String> {
    let mut roots = write_roots(&app, &index);
    roots.extend(app.path().app_data_dir().ok().and_then(|d| fs::canonicalize(d).ok()));
    if let Ok(project) = index.root() {
        roots.extend(tauri::async_runtime::spawn_blocking(move || ruby_roots(&project)).await.map_err(e2s)?);
    }
    let (canonical, id) = check_read(&path, &roots)?;
    read_text(&canonical, Some(id))
}

/// Reads a file; with `id` (device, inode) it must be the file that was checked: opened without following a final
/// symlink and compared after opening, so swapping the file or a parent directory in between is refused.
fn read_text(path: &Path, id: Option<(u64, u64)>) -> Result<String, String> {
    use std::io::Read;
    use std::os::unix::fs::MetadataExt;
    let mut file = fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(path).map_err(e2s)?;
    let meta = file.metadata().map_err(e2s)?;
    if id.is_some_and(|id| id != (meta.dev(), meta.ino())) {
        return Err(format!("{} changed while it was being opened", path.display()));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(e2s)?;
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Err("binary file".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Where the project's Ruby keeps its standard library and gems (asked once per project from that Ruby), plus the
/// Bundler `path:` gems from Gemfile.lock: public code that go to declaration, the debugger and backtrace links open.
pub fn ruby_roots(project: &Path) -> Vec<PathBuf> {
    static CACHE: std::sync::Mutex<Option<std::collections::HashMap<PathBuf, Vec<PathBuf>>>> = std::sync::Mutex::new(None);
    if let Some(hit) = CACHE.lock().unwrap().as_ref().and_then(|c| c.get(project).cloned()) {
        return hit;
    }
    let lock = fs::read_to_string(project.join("Gemfile.lock")).unwrap_or_default();
    let mut dirs: Vec<PathBuf> = path_gems(&lock).into_iter().map(|p| project.join(p)).collect();
    dirs.extend(ruby_lib_dirs(project));
    let dirs: Vec<PathBuf> = dirs.into_iter().filter_map(|d| fs::canonicalize(d).ok()).filter(|d| d.parent().is_some() && d != Path::new("/")).collect();
    CACHE.lock().unwrap().get_or_insert_with(Default::default).insert(project.to_path_buf(), dirs.clone());
    dirs
}

fn ruby_lib_dirs(project: &Path) -> Vec<PathBuf> {
    let (_, mut argv) = crate::lsp::project_ruby(project, "auto");
    argv.push("ruby".into());
    let script = r#"puts Gem.path; puts RbConfig::CONFIG.values_at("rubylibdir", "rubyarchdir", "sitelibdir", "vendorlibdir").compact"#;
    let out = crate::env::command(project, &argv[0]).args(&argv[1..]).args(["-e", script]).stdin(std::process::Stdio::null()).output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).lines().filter(|l| l.starts_with('/')).map(PathBuf::from).collect(),
        _ => vec![],
    }
}

/// `remote:` of each PATH section in Gemfile.lock (gems Bundler loads from a local directory).
fn path_gems(lock: &str) -> Vec<String> {
    let mut out = vec![];
    let mut in_path = false;
    for line in lock.lines() {
        if !line.starts_with(' ') {
            in_path = line == "PATH";
        } else if let Some(remote) = line.strip_prefix("  remote: ").filter(|_| in_path) {
            out.push(remote.trim().to_string());
        }
    }
    out
}

/// Reads are limited to `roots` (the project, Garnet's own dirs and the project's Ruby library dirs) after resolving
/// symlinks. Returns the resolved path and its (device, inode) for `read_text` to confirm it opened that same file.
pub fn check_read(path: &str, roots: &[PathBuf]) -> Result<(PathBuf, (u64, u64)), String> {
    use std::os::unix::fs::MetadataExt;
    let canonical = fs::canonicalize(path).map_err(e2s)?;
    if !roots.iter().any(|r| canonical.starts_with(r)) {
        return Err(format!("refusing to read {path}: outside the project"));
    }
    let meta = fs::metadata(&canonical).map_err(e2s)?;
    Ok((canonical, (meta.dev(), meta.ino())))
}

/// Asks for a file in a native open dialog (never a path from the webview) and returns its text, or None.
#[tauri::command]
pub async fn import_file(app: AppHandle, title: String, extension: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let ext = extension.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().set_title(&title).add_filter(ext.to_uppercase(), &[ext.as_str()]).blocking_pick_file())
        .await
        .map_err(e2s)?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(e2s)?;
    check_export_path(&path, &extension)?;
    read_text(&path, None).map(Some)
}

/// Where Garnet may write: the open project and its own config directory.
pub(crate) fn write_roots(app: &AppHandle, index: &Index) -> Vec<PathBuf> {
    [index.root().ok(), app.path().app_config_dir().ok()]
        .into_iter()
        .flatten()
        .filter_map(|r| fs::canonicalize(r).ok())
        .collect()
}

/// Refuses writes outside `roots` (after resolving symlinked parents) and, unless `allow_link`, writes to a
/// path that is itself a symlink, so a repo cannot redirect a save, merge result or rename elsewhere.
pub fn check_write(path: &str, roots: &[PathBuf], allow_link: bool) -> Result<(), String> {
    let p = Path::new(path);
    if !p.is_absolute() || p.components().any(|c| c == Component::ParentDir) {
        return Err(format!("refusing to write {path}: not a plain absolute path"));
    }
    if !allow_link && fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(format!("refusing to write through the symlink {path}"));
    }
    let mut existing = p.parent().unwrap_or(p);
    let mut rest = vec![p.file_name().unwrap_or_default()];
    while !existing.exists() {
        rest.push(existing.file_name().unwrap_or_default());
        existing = existing.parent().ok_or("no existing parent")?;
    }
    let mut canonical = fs::canonicalize(existing).map_err(e2s)?;
    canonical.extend(rest.iter().rev());
    if !roots.iter().any(|r| canonical.starts_with(r)) {
        return Err(format!("refusing to write {path}: outside the project"));
    }
    if canonical.components().any(|c| c.as_os_str() == ".git") || roots.iter().flat_map(|r| git_dirs(r)).any(|d| canonical.starts_with(d)) {
        return Err(format!("refusing to write {path}: inside a git directory (its config can run programs)"));
    }
    Ok(())
}

/// Git directories a root points to through a `.git` file (linked worktree, --separate-git-dir) and their common dir.
fn git_dirs(root: &Path) -> Vec<PathBuf> {
    let Some(dir) = fs::read_to_string(root.join(".git")).ok().and_then(|t| t.strip_prefix("gitdir:").map(|d| root.join(d.trim()))) else {
        return Vec::new();
    };
    let common = fs::read_to_string(dir.join("commondir")).ok().map(|c| dir.join(c.trim()));
    [Some(dir), common].into_iter().flatten().filter_map(|d| fs::canonicalize(d).ok()).collect()
}

pub(crate) fn write_new(p: &Path, content: &str, create_new: bool) -> Result<(), String> {
    use std::io::Write;
    let mut opts = fs::OpenOptions::new();
    opts.write(true).custom_flags(libc::O_NOFOLLOW);
    if create_new {
        opts.create_new(true);
    } else {
        opts.create(true).truncate(true);
    }
    opts.open(p).and_then(|mut f| f.write_all(content.as_bytes())).map_err(e2s)
}

#[tauri::command]
pub async fn write_file(app: AppHandle, index: State<'_, Index>, path: String, content: String) -> Result<(), String> {
    check_write(&path, &write_roots(&app, &index), false)?;
    write_new(Path::new(&path), &content, false)
}

/// The only export formats; the extension is enforced on the path the save dialog returns.
fn export_extension(format: &str) -> Result<&'static str, String> {
    match format {
        "csv" => Ok("csv"),
        "json" => Ok("json"),
        _ => Err(format!("unsupported export format {format}")),
    }
}

fn check_export_path(path: &Path, ext: &str) -> Result<(), String> {
    let ok = path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case(ext));
    ok.then_some(()).ok_or_else(|| format!("exports must be saved as .{ext} files"))
}

/// Asks for the destination in a native save dialog (opened here, never a path from the webview) and writes the
/// export there with the same symlink and `..` checks as `write_file`. Returns the path, or None when cancelled.
#[tauri::command]
pub async fn export_file(app: AppHandle, format: String, default_name: String, content: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let ext = export_extension(&format)?;
    let name = Path::new(&default_name).file_name().and_then(|n| n.to_str()).unwrap_or("export").to_string();
    if let Some(path) = crate::project::smoke_export_path(ext) {
        write_new(&path, &content, false)?;
        return Ok(Some(path.to_string_lossy().into_owned()));
    }
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().set_file_name(&name).add_filter(ext.to_uppercase(), &[ext]).blocking_save_file()
    })
    .await
    .map_err(e2s)?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(e2s)?;
    check_export_path(&path, ext)?;
    let dir = path.parent().ok_or("invalid export path")?;
    let text = path.to_string_lossy().into_owned();
    check_write(&text, &[fs::canonicalize(dir).map_err(e2s)?], false)?;
    write_new(&path, &content, false)?;
    Ok(Some(text))
}

#[tauri::command]
pub async fn create_path(app: AppHandle, index: State<'_, Index>, path: String, dir: bool) -> Result<(), String> {
    check_write(&path, &write_roots(&app, &index), false)?;
    let p = Path::new(&path);
    if p.exists() {
        return Err(format!("{} already exists", p.display()));
    }
    if dir {
        fs::create_dir_all(p).map_err(e2s)
    } else {
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).map_err(e2s)?;
        }
        write_new(p, "", true)
    }
}

#[tauri::command]
pub async fn rename_path(app: AppHandle, index: State<'_, Index>, from: String, to: String) -> Result<(), String> {
    let roots = write_roots(&app, &index);
    check_write(&from, &roots, true)?;
    check_write(&to, &roots, false)?;
    if Path::new(&to).exists() {
        return Err(format!("{to} already exists"));
    }
    if let Some(parent) = Path::new(&to).parent() {
        fs::create_dir_all(parent).map_err(e2s)?;
    }
    fs::rename(from, to).map_err(e2s)
}

#[tauri::command]
pub async fn delete_path(app: AppHandle, index: State<'_, Index>, path: String) -> Result<(), String> {
    check_write(&path, &write_roots(&app, &index), true)?;
    let p = Path::new(&path);
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(e2s)
    } else {
        fs::remove_file(p).map_err(e2s)
    }
}

#[tauri::command]
pub async fn reveal_in_finder(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .args(["-R", &path])
        .status()
        .map(|_| ())
        .map_err(e2s)
}

#[tauri::command]
pub fn canonical_path(path: String) -> Result<String, String> {
    std::fs::canonicalize(&path).map(|p| p.to_string_lossy().into_owned()).map_err(e2s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_stay_inside_the_project_and_never_follow_symlinks() {
        let base = std::env::temp_dir().join(format!("garnet-fs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let (proj, outside) = (base.join("proj"), base.join("outside"));
        fs::create_dir_all(proj.join("app")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret"), "keep").unwrap();
        std::os::unix::fs::symlink(outside.join("secret"), proj.join("link.rb")).unwrap();
        std::os::unix::fs::symlink(&outside, proj.join("linkdir")).unwrap();
        let roots = vec![fs::canonicalize(&proj).unwrap()];
        let at = |p: &Path| p.to_string_lossy().into_owned();

        assert!(check_write(&at(&proj.join("app/a.rb")), &roots, false).is_ok());
        assert!(check_write(&at(&proj.join("new/dir/b.rb")), &roots, false).is_ok());
        assert!(check_write(&at(&proj.join("link.rb")), &roots, false).unwrap_err().contains("symlink"));
        assert!(check_write(&at(&proj.join("linkdir/x.rb")), &roots, false).unwrap_err().contains("outside"));
        assert!(check_write(&at(&outside.join("secret")), &roots, false).is_err());
        assert!(check_write(&format!("{}/app/../../outside/secret", proj.display()), &roots, false).is_err());
        assert!(check_write("relative.rb", &roots, false).is_err());
        fs::create_dir_all(proj.join(".git")).unwrap();
        assert!(check_write(&at(&proj.join(".git/config")), &roots, false).unwrap_err().contains("git directory"));
        assert!(check_write(&at(&proj.join("vendor/x/.git/hooks/pre-commit")), &roots, false).is_err());
        assert!(check_write(&at(&proj.join(".gitattributes")), &roots, false).is_ok());
        fs::remove_dir_all(proj.join(".git")).unwrap();
        fs::create_dir_all(proj.join("store/worktrees/wt")).unwrap();
        fs::write(proj.join("store/worktrees/wt/commondir"), "../..").unwrap();
        fs::write(proj.join(".git"), "gitdir: store/worktrees/wt\n").unwrap();
        assert!(check_write(&at(&proj.join("store/worktrees/wt/HEAD")), &roots, false).is_err(), "worktree gitdir");
        assert!(check_write(&at(&proj.join("store/config")), &roots, false).is_err(), "common dir");
        assert!(write_new(&proj.join("link.rb"), "pwned", false).is_err());
        assert_eq!(fs::read_to_string(outside.join("secret")).unwrap(), "keep");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn reads_stay_inside_the_project_or_its_ruby_library_dirs() {
        let base = fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("garnet-read-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let (proj, home) = (base.join("proj"), base.join("home"));
        fs::create_dir_all(proj.join("app")).unwrap();
        fs::create_dir_all(home.join(".ssh")).unwrap();
        fs::create_dir_all(home.join(".rbenv/versions/3.3.0/lib/ruby/3.3.0")).unwrap();
        fs::create_dir_all(home.join(".gem/ruby/3.3.0/gems/rack-3.0/lib")).unwrap();
        fs::create_dir_all(home.join("work/gems/secrets")).unwrap();
        fs::create_dir_all(home.join("other/lib/ruby")).unwrap();
        for f in ["proj/app/a.rb", "home/.ssh/id_rsa", "home/.rbenv/versions/3.3.0/lib/ruby/3.3.0/set.rb", "home/.gem/ruby/3.3.0/gems/rack-3.0/lib/rack.rb", "home/work/gems/secrets/key.rb", "home/other/lib/ruby/x.rb"] {
            fs::write(base.join(f), "x").unwrap();
        }
        std::os::unix::fs::symlink(home.join(".ssh/id_rsa"), proj.join("key.rb")).unwrap();
        let roots = vec![proj.clone(), home.join(".rbenv/versions/3.3.0/lib/ruby/3.3.0"), home.join(".gem/ruby/3.3.0")];
        let at = |p: PathBuf| p.to_string_lossy().into_owned();
        assert!(check_read(&at(proj.join("app/a.rb")), &roots).is_ok());
        assert!(check_read(&at(home.join(".rbenv/versions/3.3.0/lib/ruby/3.3.0/set.rb")), &roots).is_ok());
        let (gem, id) = check_read(&at(home.join(".gem/ruby/3.3.0/gems/rack-3.0/lib/rack.rb")), &roots).unwrap();
        assert_eq!(read_text(&gem, Some(id)).unwrap(), "x");
        assert!(check_read(&at(home.join("work/gems/secrets/key.rb")), &roots).unwrap_err().contains("outside"), "any /gems/ path");
        assert!(check_read(&at(home.join("other/lib/ruby/x.rb")), &roots).unwrap_err().contains("outside"), "any lib/ruby path");
        assert!(check_read(&at(home.join(".ssh/id_rsa")), &roots).unwrap_err().contains("outside"));
        assert!(check_read(&at(proj.join("key.rb")), &roots).unwrap_err().contains("outside"));
        assert!(check_read(&format!("{}/app/../../home/.ssh/id_rsa", proj.display()), &roots).is_err());
        // The file opened must be the one checked.
        let (checked, id) = check_read(&at(proj.join("app/a.rb")), &roots).unwrap();
        fs::remove_file(&checked).unwrap();
        std::os::unix::fs::symlink(home.join(".ssh/id_rsa"), &checked).unwrap();
        assert!(read_text(&checked, Some(id)).is_err(), "a symlink swapped in after the check was followed");
        fs::remove_file(&checked).unwrap();
        fs::write(&checked, "y").unwrap();
        assert!(read_text(&checked, Some(id)).is_err(), "a different file swapped in after the check was read");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn asks_the_projects_ruby_for_its_library_dirs() {
        let dirs = ruby_lib_dirs(Path::new(env!("CARGO_MANIFEST_DIR")));
        // No Ruby on this machine: nothing outside the project is readable, which is the safe answer.
        if !dirs.is_empty() {
            assert!(dirs.iter().any(|d| d.join("rubygems.rb").exists()), "{dirs:?}");
        }
    }

    #[test]
    fn bundler_path_gems_come_from_gemfile_lock_path_sections() {
        let lock = "GIT\n  remote: https://github.com/x/y.git\n  specs:\n\nPATH\n  remote: ../engines/billing\n  specs:\n    billing (0.1.0)\n\nPATH\n  remote: vendor/gems/z\n  specs:\n\nGEM\n  remote: https://rubygems.org/\n";
        assert_eq!(path_gems(lock), vec!["../engines/billing", "vendor/gems/z"]);
        assert!(path_gems("").is_empty());
    }

    #[test]
    fn exports_only_allow_csv_and_json_extensions() {
        assert_eq!(export_extension("csv").unwrap(), "csv");
        assert_eq!(export_extension("json").unwrap(), "json");
        assert!(export_extension("sh").is_err());
        assert!(check_export_path(Path::new("/tmp/out.csv"), "csv").is_ok());
        assert!(check_export_path(Path::new("/tmp/OUT.JSON"), "json").is_ok());
        assert!(check_export_path(Path::new("/tmp/out.json"), "csv").is_err());
        assert!(check_export_path(Path::new("/tmp/out.csv.sh"), "csv").is_err());
        assert!(check_export_path(Path::new("/tmp/out"), "csv").is_err());
    }
}
