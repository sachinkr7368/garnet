mod dap;
mod db;
mod env;
mod fsops;
mod git;
mod github;
mod index;
mod lsp;
mod project;
mod pty;
mod rpc;
mod ruby;
mod search;
mod watch;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

fn menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, label: &str, accel: Option<&str>| MenuItem::with_id(app, id, label, true, accel);
    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                "Garnet",
                true,
                &[
                    &PredefinedMenuItem::about(app, None, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &item("settings", "Settings…", None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &item("quit", "Quit Garnet", Some("CmdOrCtrl+Q"))?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "File",
                true,
                &[
                    &item("openFolder", "Open Folder…", None)?,
                    &item("openRecent", "Open Recent…", None)?,
                    &item("commandPalette", "Find Action…", None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::fullscreen(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Help",
                true,
                &[
                    &item("keymapReference", "Keymap Reference", None)?,
                    &item("importKeymap", "Import JetBrains Keymap…", None)?,
                ],
            )?,
        ],
    )
}

/// When the unanswered close request was made (ms since start, 0 = none), and whether the frontend agreed to quit.
static CLOSE_ASKED: AtomicU64 = AtomicU64::new(0);
static QUITTING: AtomicBool = AtomicBool::new(false);

/// Whether a close/quit request may go ahead now. Otherwise the frontend is asked (unsaved changes prompt) and
/// answers with `quit_now`; a frontend that has not answered a request for 5s cannot keep the app open.
fn close_allowed(asked: &AtomicU64, quitting: bool, now_ms: u64) -> bool {
    if quitting {
        return true;
    }
    let first = asked.load(Ordering::SeqCst);
    if first != 0 && now_ms.saturating_sub(first) > 5000 {
        return true;
    }
    if first == 0 {
        asked.store(now_ms.max(1), Ordering::SeqCst);
    }
    false
}

fn request_close<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    let ok = close_allowed(&CLOSE_ASKED, QUITTING.load(Ordering::SeqCst), project::uptime_ms() as u64);
    if !ok {
        let _ = app.emit("close-requested", ());
    }
    ok
}

/// The frontend's answer to "close-requested": quit (after saving or discarding) or stay open.
#[tauri::command]
fn quit_now(app: tauri::AppHandle, quit: bool) {
    CLOSE_ASKED.store(0, Ordering::SeqCst);
    if quit {
        QUITTING.store(true, Ordering::SeqCst);
        app.exit(0);
    }
}

pub fn run() {
    let _ = project::STARTED.set(std::time::Instant::now());
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::Ptys::default())
        .manage(index::Index::default())
        .manage(search::SearchState::default())
        .manage(lsp::Lsp::default())
        .manage(dap::Dap::default())
        .manage(watch::Watch::default())
        .manage(db::Db::default())
        .menu(menu)
        .setup(|app| {
            let window = project::main_window(app.config().app.windows[0].clone(), project::smoke_target().is_some());
            tauri::WebviewWindowBuilder::from_config(app.handle(), &window)?.build()?;
            project::smoke_watchdog(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if !request_close(window.app_handle()) {
                    api.prevent_close();
                }
            }
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().0.clone());
        })
        .invoke_handler(tauri::generate_handler![
            fsops::list_dir,
            fsops::read_file,
            fsops::write_file,
            fsops::export_file,
            fsops::import_file,
            fsops::create_path,
            fsops::rename_path,
            fsops::delete_path,
            fsops::reveal_in_finder,
            fsops::canonical_path,
            index::find_files,
            index::index_files,
            search::search_text,
            search::replace_in_file,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            dap::dap_connect,
            dap::dap_send,
            dap::dap_disconnect,
            dap::free_port,
            git::git_status,
            git::git_branch,
            git::git_show,
            git::git_file_at,
            git::git_log,
            git::git_diff_files,
            git::git_commit_details,
            git::git_stage_patch,
            git::git_op_state,
            git::git_merge_input,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_fetch,
            git::git_run,
            github::github_signed_in,
            github::github_auth_status,
            github::github_use_gh_token,
            github::github_device_start,
            github::github_device_poll,
            github::github_graphql,
            github::github_clone,
            github::github_store_token,
            github::github_sign_out,
            github::github_api,
            github::open_url,
            github::latest_release,
            github::open_new_window,
            git::git_set_path,
            git::git_set_trusted,
            git::git_blame_line,
            project::open_project,
            project::run_capture,
            project::initial_path,
            project::config_path,
            project::config_read,
            project::config_write,
            project::index_root,
            project::smoke_target,
            project::smoke_finish,
            project::smoke_progress,
            project::uptime_ms,
            db::db_connect,
            db::db_disconnect,
            db::db_query,
            db::db_cancel,
            db::db_schema,
            db::db_table_page,
            db::db_password_set,
            db::db_password_delete,
            db::db_password_exists,
            db::db_detect,
            quit_now,
        ])
        .build(tauri::generate_context!())
        .expect("failed to start Garnet");

    app.run(|app, event| {
        if let RunEvent::ExitRequested { code: None, api, .. } = &event {
            if !request_close(app) {
                api.prevent_exit();
            }
        }
        if let RunEvent::Exit = event {
            app.state::<pty::Ptys>().kill_all();
            app.state::<lsp::Lsp>().stop();
            app.state::<dap::Dap>().stop();
            tauri::async_runtime::block_on(app.state::<db::Db>().close_all());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_waits_for_the_frontend_unless_it_never_answers() {
        let asked = AtomicU64::new(0);
        assert!(!close_allowed(&asked, false, 100));
        assert!(!close_allowed(&asked, false, 3000));
        assert!(close_allowed(&asked, false, 5200));
        assert!(close_allowed(&AtomicU64::new(0), true, 100));
    }
}
