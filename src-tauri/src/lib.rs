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

/// Close/quit requests go to the frontend (unsaved changes prompt), which acknowledges each one and answers with
/// `quit_now`. Only a request the frontend never acknowledged for 5s (dead or not yet loaded webview) is let through;
/// an acknowledged one (prompt showing, Save All running) never is.
#[derive(Default)]
struct CloseGate {
    asked: AtomicU64,
    acked: AtomicBool,
    quitting: AtomicBool,
}

impl CloseGate {
    fn request(&self, now_ms: u64) -> bool {
        if self.quitting.load(Ordering::SeqCst) {
            return true;
        }
        let first = self.asked.load(Ordering::SeqCst);
        if first == 0 {
            self.asked.store(now_ms.max(1), Ordering::SeqCst);
            return false;
        }
        !self.acked.load(Ordering::SeqCst) && now_ms.saturating_sub(first) > 5000
    }

    fn ack(&self) {
        self.acked.store(true, Ordering::SeqCst);
    }

    /// A (re)loaded frontend or an answered request: nothing is pending any more.
    fn reset(&self) {
        self.asked.store(0, Ordering::SeqCst);
        self.acked.store(false, Ordering::SeqCst);
    }
}

static GATE: CloseGate = CloseGate { asked: AtomicU64::new(0), acked: AtomicBool::new(false), quitting: AtomicBool::new(false) };

fn request_close<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    let ok = GATE.request(project::uptime_ms() as u64);
    if !ok {
        let _ = app.emit("close-requested", ());
    }
    ok
}

#[tauri::command]
fn frontend_ready() {
    GATE.reset();
}

#[tauri::command]
fn close_ack() {
    GATE.ack();
}

/// The frontend's answer to "close-requested": quit (after saving or discarding) or stay open.
#[tauri::command]
fn quit_now(app: tauri::AppHandle, quit: bool) {
    GATE.reset();
    if quit {
        GATE.quitting.store(true, Ordering::SeqCst);
    }
    #[cfg(target_os = "macos")]
    if terminate::reply(&app, quit) {
        return;
    }
    if quit {
        app.exit(0);
    }
}

/// Dock Quit, `osascript quit`, Activity Monitor and logout send `terminate:`, which tao lets through without asking
/// (it has no `applicationShouldTerminate:`), so the delegate gets one at runtime that routes through the close gate.
#[cfg(target_os = "macos")]
mod terminate {
    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
    use objc2::{class, msg_send, sel};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;

    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
    /// A logout/shutdown is waiting for `replyToApplicationShouldTerminate:`.
    static LATER: AtomicBool = AtomicBool::new(false);
    const CANCEL: usize = 0;
    const NOW: usize = 1;
    const LATER_REPLY: usize = 2;

    /// Logout, restart and shutdown carry a quit reason ('why?') on the quit Apple event; Dock and scripts do not.
    unsafe fn session_ending() -> bool {
        let manager: *mut AnyObject = msg_send![class!(NSAppleEventManager), sharedAppleEventManager];
        let event: *mut AnyObject = msg_send![manager, currentAppleEvent];
        if event.is_null() {
            return false;
        }
        let why: *mut AnyObject = msg_send![event, attributeDescriptorForKeyword: 0x7768_793F_u32];
        !why.is_null()
    }

    extern "C-unwind" fn should_terminate(_this: *mut AnyObject, _cmd: Sel, _sender: *mut AnyObject) -> usize {
        let Some(app) = APP.get() else { return NOW };
        if super::request_close(app) {
            return NOW;
        }
        if unsafe { session_ending() } {
            LATER.store(true, Ordering::SeqCst);
            return LATER_REPLY;
        }
        CANCEL
    }

    pub fn install(app: &tauri::AppHandle) {
        let _ = APP.set(app.clone());
        unsafe {
            let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let delegate: *mut AnyObject = msg_send![ns_app, delegate];
            if delegate.is_null() {
                return;
            }
            let cls = objc2::ffi::object_getClass(delegate) as *mut AnyClass;
            let imp = std::mem::transmute::<extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize, Imp>(should_terminate);
            let types = c"Q@:@".as_ptr();
            if !objc2::ffi::class_addMethod(cls, sel!(applicationShouldTerminate:), imp, types).as_bool() {
                objc2::ffi::class_replaceMethod(cls, sel!(applicationShouldTerminate:), imp, types);
            }
        }
    }

    /// Answers a pending logout/shutdown; false when none was pending.
    pub fn reply(app: &tauri::AppHandle, quit: bool) -> bool {
        if !LATER.swap(false, Ordering::SeqCst) {
            return false;
        }
        let _ = app.run_on_main_thread(move || unsafe {
            let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let _: () = msg_send![ns_app, replyToApplicationShouldTerminate: Bool::new(quit)];
        });
        true
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
            #[cfg(target_os = "macos")]
            terminate::install(app.handle());
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
            // Quit goes through the close gate, so it still works when the webview's JS is dead.
            if event.id().0 == "quit" {
                if request_close(app) {
                    app.exit(0);
                }
                return;
            }
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
            git::git_rollback,
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
            db::db_test,
            db::db_update_rows,
            db::db_schema,
            db::db_table_page,
            db::db_password_set,
            db::db_password_delete,
            db::db_password_exists,
            db::db_detect,
            quit_now,
            frontend_ready,
            close_ack,
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
    fn close_waits_for_the_frontend_unless_it_never_acknowledges() {
        let gate = CloseGate::default();
        assert!(!gate.request(100));
        assert!(!gate.request(3000));
        assert!(gate.request(5200), "an unacknowledged request lets the next one through after 5s");
        let done = CloseGate::default();
        done.quitting.store(true, Ordering::SeqCst);
        assert!(done.request(100));
    }

    #[test]
    fn a_stale_request_from_before_the_frontend_loaded_does_not_skip_the_prompt() {
        let gate = CloseGate::default();
        assert!(!gate.request(100), "close during boot, nobody listening");
        gate.reset(); // frontend_ready after the (re)load
        assert!(!gate.request(60_000), "a later click must prompt, not close");
    }

    #[test]
    fn an_acknowledged_request_is_never_forced_through() {
        let gate = CloseGate::default();
        assert!(!gate.request(100));
        gate.ack(); // prompt showing or Save All running
        assert!(!gate.request(30_000));
        gate.reset(); // quit_now(false)
        assert!(!gate.request(40_000));
    }
}
