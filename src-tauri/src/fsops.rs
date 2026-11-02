use ignore::WalkBuilder;
use serde::Serialize;
use std::fs;
use std::path::Path;

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

#[tauri::command]
pub async fn write_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(e2s)
}

#[tauri::command]
pub async fn create_path(path: String, dir: bool) -> Result<(), String> {
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
        fs::write(p, "").map_err(e2s)
    }
}

#[tauri::command]
pub async fn rename_path(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() {
        return Err(format!("{to} already exists"));
    }
    if let Some(parent) = Path::new(&to).parent() {
        fs::create_dir_all(parent).map_err(e2s)?;
    }
    fs::rename(from, to).map_err(e2s)
}

#[tauri::command]
pub async fn delete_path(path: String) -> Result<(), String> {
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
