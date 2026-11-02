mod dap;
mod env;
mod fsops;
mod git;
mod github;
mod index;
mod lsp;
mod project;
mod pty;
mod rpc;
mod search;
mod watch;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager, RunEvent};

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
                    &item("settings", "Settings…", Some("CmdOrCtrl+,"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
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
        .menu(menu)
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().0.clone());
        })
        .invoke_handler(tauri::generate_handler![
            fsops::list_dir,
            fsops::read_file,
            fsops::write_file,
            fsops::create_path,
            fsops::rename_path,
            fsops::delete_path,
            fsops::reveal_in_finder,
            fsops::canonical_path,
            index::find_files,
            index::index_files,
            search::search_text,
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
            git::git_diff_hunks,
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
            project::uptime_ms,
        ])
        .build(tauri::generate_context!())
        .expect("failed to start Garnet");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            app.state::<pty::Ptys>().kill_all();
            app.state::<lsp::Lsp>().stop();
            app.state::<dap::Dap>().stop();
        }
    });
}
