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
pub async fn read_file(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(e2s)?;
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Err("binary file".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Where Garnet may write: the open project and its own config directory.
fn write_roots(app: &AppHandle, index: &Index) -> Vec<PathBuf> {
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
    if roots.iter().any(|r| canonical.starts_with(r)) {
        Ok(())
    } else {
        Err(format!("refusing to write {path}: outside the project"))
    }
}

fn write_new(p: &Path, content: &str, create_new: bool) -> Result<(), String> {
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

/// Writes an export (CSV/JSON) to a path the user picked in a save dialog: same symlink and `..` checks as
/// `write_file`, with the chosen folder as the only allowed root.
#[tauri::command]
pub async fn export_file(path: String, content: String) -> Result<(), String> {
    let dir = Path::new(&path).parent().ok_or("invalid export path")?;
    let root = fs::canonicalize(dir).map_err(e2s)?;
    check_write(&path, &[root], false)?;
    write_new(Path::new(&path), &content, false)
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
        assert!(write_new(&proj.join("link.rb"), "pwned", false).is_err());
        assert_eq!(fs::read_to_string(outside.join("secret")).unwrap(), "keep");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn exports_write_to_the_chosen_folder_but_never_through_symlinks() {
        let base = std::env::temp_dir().join(format!("garnet-export-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        fs::write(base.join("target"), "keep").unwrap();
        std::os::unix::fs::symlink(base.join("target"), base.join("link.csv")).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let at = |p: &Path| p.to_string_lossy().into_owned();
        rt.block_on(export_file(at(&base.join("out.csv")), "a,b\n".into())).unwrap();
        assert_eq!(fs::read_to_string(base.join("out.csv")).unwrap(), "a,b\n");
        assert!(rt.block_on(export_file(at(&base.join("link.csv")), "x".into())).is_err());
        assert!(rt.block_on(export_file("out.csv".into(), "x".into())).is_err());
        assert_eq!(fs::read_to_string(base.join("target")).unwrap(), "keep");
        fs::remove_dir_all(&base).unwrap();
    }
}
