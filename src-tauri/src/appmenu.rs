use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};

enum E<'a> {
    I(&'a str, &'a str),
    C(&'a str, &'a str),
    S,
    Sub(&'a str, Vec<E<'a>>),
}
use E::{C, I, S};

fn sub<'a>(title: &'a str, items: Vec<E<'a>>) -> E<'a> {
    E::Sub(title, items)
}

fn build<R: Runtime>(app: &AppHandle<R>, items: &[E]) -> tauri::Result<Vec<Box<dyn IsMenuItem<R>>>> {
    items
        .iter()
        .map(|e| -> tauri::Result<Box<dyn IsMenuItem<R>>> {
            Ok(match e {
                I(id, label) => Box::new(MenuItem::with_id(app, *id, *label, true, None::<&str>)?),
                C(id, label) => Box::new(CheckMenuItem::with_id(app, *id, *label, true, false, None::<&str>)?),
                S => Box::new(PredefinedMenuItem::separator(app)?),
                E::Sub(title, items) => Box::new(submenu(app, title, items)?),
            })
        })
        .collect()
}

fn submenu<R: Runtime>(app: &AppHandle<R>, title: &str, items: &[E]) -> tauri::Result<Submenu<R>> {
    let built = build(app, items)?;
    Submenu::with_items(app, title, true, &built.iter().map(|b| b.as_ref()).collect::<Vec<_>>())
}

fn with<R: Runtime>(app: &AppHandle<R>, title: &str, head: Vec<Box<dyn IsMenuItem<R>>>, items: &[E], tail: Vec<Box<dyn IsMenuItem<R>>>) -> tauri::Result<Submenu<R>> {
    let mid = build(app, items)?;
    let all: Vec<&dyn IsMenuItem<R>> = head.iter().chain(mid.iter()).chain(tail.iter()).map(|b| b.as_ref()).collect();
    Submenu::with_items(app, title, true, &all)
}

/// The macOS menu bar. Item ids are frontend command ids (sent as "menu" events); shortcuts are filled in from the
/// live keymap by `set_menu_state`, so a rebind shows up here too.
pub fn menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let p = |i: tauri::Result<PredefinedMenuItem<R>>| -> tauri::Result<Box<dyn IsMenuItem<R>>> { Ok(Box::new(i?)) };
    let about = tauri::menu::AboutMetadata {
        version: Some(app.package_info().version.to_string()),
        copyright: Some("Copyright (c) 2026 Sachin. MIT License.".into()),
        website: Some("https://github.com/sachinkr7368/garnet".into()),
        website_label: Some("github.com/sachinkr7368/garnet".into()),
        ..Default::default()
    };
    let garnet = with(
        app,
        "Garnet",
        vec![p(PredefinedMenuItem::about(app, Some("About Garnet"), Some(about)))?, p(PredefinedMenuItem::separator(app))?],
        &[I("settings", "Settings…"), I("keymapSettings", "Keymap…"), S],
        vec![
            p(PredefinedMenuItem::services(app, None))?,
            p(PredefinedMenuItem::separator(app))?,
            p(PredefinedMenuItem::hide(app, Some("Hide Garnet")))?,
            p(PredefinedMenuItem::hide_others(app, None))?,
            p(PredefinedMenuItem::show_all(app, None))?,
            p(PredefinedMenuItem::separator(app))?,
            Box::new(MenuItem::with_id(app, "quit", "Quit Garnet", true, Some("CmdOrCtrl+Q"))?),
        ],
    )?;
    let file = submenu(
        app,
        "File",
        &[
            I("newWindow", "New Window"),
            I("openFolder", "Open…"),
            sub("Open Recent", vec![I("recent:clear", "Clear Recent")]),
            I("githubClone", "Get from Version Control…"),
            S,
            I("closeTab", "Close Tab"),
            I("closeWindow", "Close Window"),
            S,
            I("saveAll", "Save All"),
            S,
            I("settings", "Settings…"),
            I("trustProject", "Trust Project…"),
        ],
    )?;
    let edit = with(
        app,
        "Edit",
        vec![
            p(PredefinedMenuItem::undo(app, None))?,
            p(PredefinedMenuItem::redo(app, None))?,
            p(PredefinedMenuItem::separator(app))?,
            p(PredefinedMenuItem::cut(app, None))?,
            p(PredefinedMenuItem::copy(app, None))?,
            p(PredefinedMenuItem::paste(app, None))?,
            p(PredefinedMenuItem::select_all(app, None))?,
            p(PredefinedMenuItem::separator(app))?,
        ],
        &[sub("Find", vec![I("find", "Find…"), I("replace", "Replace…"), I("findNext", "Find Next"), I("findPrevious", "Find Previous"), S, I("findInFiles", "Find in Files…"), I("replaceInFiles", "Replace in Files…")]), S, I("toggleCase", "Toggle Case")],
        vec![],
    )?;
    let view = submenu(
        app,
        "View",
        &[
            sub(
                "Tool Windows",
                vec![
                    I("projectView", "Project"),
                    I("commitView", "Commit"),
                    I("structureView", "Structure"),
                    I("findView", "Find"),
                    I("runView", "Run"),
                    I("debugView", "Debug"),
                    I("problemsView", "Problems"),
                    I("gitLogView", "Git"),
                    I("terminalView", "Terminal"),
                    I("githubPullRequests", "Pull Requests"),
                ],
            ),
            sub(
                "Appearance",
                vec![
                    I("zoomIn", "Zoom In IDE"),
                    I("zoomOut", "Zoom Out IDE"),
                    I("zoomReset", "Reset IDE Zoom"),
                    S,
                    C("distractionFree", "Distraction Free Mode"),
                    C("presentationMode", "Presentation Mode"),
                    S,
                    C("toggleToolbar", "Toolbar"),
                    C("toggleToolWindowBars", "Tool Window Bars"),
                    C("toggleStatusBar", "Status Bar"),
                    C("toggleBreadcrumbs", "Breadcrumbs"),
                    S,
                    I("toggleSoftWrap", "Soft-Wrap"),
                    I("toggleWhitespace", "Show Whitespaces"),
                ],
            ),
            sub("Theme", vec![C("themeSystem", "System"), C("themeLight", "Light"), C("themeDark", "Dark")]),
            sub("Editor Font Size", vec![I("increaseFont", "Increase Font Size in All Editors"), I("decreaseFont", "Decrease Font Size in All Editors"), I("resetFont", "Reset Font Size")]),
            S,
            I("commandPalette", "Find Action…"),
            I("recentFiles", "Recent Files…"),
            I("fileStructure", "File Structure…"),
        ],
    )?;
    let navigate = submenu(
        app,
        "Navigate",
        &[
            I("back", "Back"),
            I("forward", "Forward"),
            I("lastEditLocation", "Last Edit Location"),
            I("nextEditLocation", "Next Edit Location"),
            S,
            I("searchEverywhere", "Search Everywhere"),
            I("goToClass", "Class…"),
            I("goToFile", "File…"),
            I("goToSymbol", "Symbol…"),
            I("goToLine", "Line…"),
            S,
            I("goToDefinition", "Declaration"),
            I("goToImplementation", "Implementation(s)"),
            I("goToTypeDefinition", "Type Declaration"),
            I("findUsages", "Find Usages"),
            I("goToTest", "Test / Subject"),
            I("related", "Related Symbol…"),
            S,
            I("nextError", "Next Highlighted Error"),
            I("prevError", "Previous Highlighted Error"),
            I("revealInTree", "Select Opened File in Project"),
        ],
    )?;
    let code = submenu(
        app,
        "Code",
        &[
            I("codeActions", "Show Context Actions"),
            I("quickDoc", "Quick Documentation"),
            I("parameterInfo", "Parameter Info"),
            S,
            I("format", "Reformat Code"),
            I("toggleComment", "Comment with Line Comment"),
            I("blockComment", "Comment with Block Comment"),
            I("moveLineUp", "Move Line Up"),
            I("moveLineDown", "Move Line Down"),
            S,
            sub(
                "Folding",
                vec![
                    I("expandRegion", "Expand"),
                    I("collapseRegion", "Collapse"),
                    I("expandRecursively", "Expand Recursively"),
                    I("collapseRecursively", "Collapse Recursively"),
                    I("expandAll", "Expand All"),
                    I("collapseAll", "Collapse All"),
                ],
            ),
        ],
    )?;
    let refactor = submenu(app, "Refactor", &[I("refactorThis", "Refactor This…"), I("rename", "Rename…")])?;
    let run = submenu(
        app,
        "Run",
        &[
            I("runSelected", "Run"),
            I("debugSelected", "Debug"),
            I("chooseRun", "Run…"),
            I("chooseDebug", "Debug…"),
            I("editConfigurations", "Edit Configurations…"),
            S,
            I("runTestAtCursor", "Run Context Configuration"),
            I("rakeTask", "Rake / Rails Task…"),
            S,
            I("stopDebug", "Stop"),
            I("resume", "Resume Program"),
            I("stepOver", "Step Over"),
            I("stepInto", "Step Into"),
            I("stepOut", "Step Out"),
            S,
            I("toggleBreakpoint", "Toggle Line Breakpoint"),
            I("viewBreakpoints", "View Breakpoints…"),
            I("muteBreakpoints", "Mute Breakpoints"),
        ],
    )?;
    let git = submenu(
        app,
        "Git",
        &[
            I("commitView", "Commit…"),
            I("push", "Push…"),
            I("pull", "Update Project…"),
            S,
            I("branches", "Branches…"),
            I("gitLogView", "Show Git Log"),
            I("fileHistory", "Show History for Current File"),
            I("gitDiff", "Show Diff"),
            I("gitBlame", "Annotate with Git Blame"),
            S,
            I("stash", "Stash Changes…"),
            I("unstash", "Unstash Changes…"),
            I("resolveConflicts", "Resolve Conflicts…"),
            I("githubPr", "Create Pull Request…"),
        ],
    )?;
    let window = with(
        app,
        "Window",
        vec![
            p(PredefinedMenuItem::minimize(app, None))?,
            p(PredefinedMenuItem::maximize(app, Some("Zoom")))?,
            p(PredefinedMenuItem::fullscreen(app, None))?,
            p(PredefinedMenuItem::separator(app))?,
        ],
        &[I("reopenClosedTab", "Reopen Closed Tab"), I("nextTab", "Select Next Tab"), I("prevTab", "Select Previous Tab"), I("hideAll", "Hide All Tool Windows"), I("lastToolWindow", "Jump to Last Tool Window"), S],
        vec![p(PredefinedMenuItem::bring_all_to_front(app, None))?],
    )?;
    let help = submenu(
        app,
        "Help",
        &[I("help", "Garnet Help"), I("keymapReference", "Keymap Reference"), I("importKeymap", "Import JetBrains Keymap…"), S, I("reportIssue", "Report an Issue…")],
    )?;
    window.set_as_windows_menu_for_nsapp()?;
    help.set_as_help_menu_for_nsapp()?;
    Menu::with_items(app, &[&garnet, &file, &edit, &view, &navigate, &code, &refactor, &run, &git, &window, &help])
}

fn visit<R: Runtime>(items: Vec<MenuItemKind<R>>, f: &mut dyn FnMut(&MenuItemKind<R>)) {
    for item in items {
        f(&item);
        if let MenuItemKind::Submenu(s) = &item {
            visit(s.items().unwrap_or_default(), f);
        }
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MenuState {
    #[serde(default)]
    accelerators: HashMap<String, Option<String>>,
    #[serde(default)]
    checked: HashMap<String, bool>,
    recent: Option<Vec<String>>,
}

/// Keeps shortcuts, checkmarks and Open Recent in step with the frontend (keymap, settings, recent projects).
#[tauri::command]
pub fn set_menu_state<R: Runtime>(app: AppHandle<R>, state: MenuState) -> Result<(), String> {
    let Some(menu) = app.menu() else { return Ok(()) };
    let mut recent_menu = None;
    visit(menu.items().map_err(|e| e.to_string())?, &mut |item| {
        let id = item.id().0.as_str();
        match item {
            MenuItemKind::MenuItem(m) => {
                if let Some(accel) = state.accelerators.get(id) {
                    if m.set_accelerator(accel.as_deref()).is_err() {
                        let _ = m.set_accelerator(None::<&str>);
                    }
                }
            }
            MenuItemKind::Check(c) => {
                if let Some(accel) = state.accelerators.get(id) {
                    if c.set_accelerator(accel.as_deref()).is_err() {
                        let _ = c.set_accelerator(None::<&str>);
                    }
                }
                if let Some(on) = state.checked.get(id) {
                    let _ = c.set_checked(*on);
                }
            }
            MenuItemKind::Submenu(s) if s.text().is_ok_and(|t| t == "Open Recent") => recent_menu = Some(s.clone()),
            _ => {}
        }
    });
    if let (Some(paths), Some(sub)) = (state.recent, recent_menu) {
        for item in sub.items().unwrap_or_default() {
            let _ = sub.remove(&item);
        }
        for path in paths.iter().take(15) {
            let label = path.rsplit('/').find(|s| !s.is_empty()).unwrap_or(path);
            let item = MenuItem::with_id(&app, format!("recent:{path}"), format!("{label}  {}", tilde(path)), true, None::<&str>).map_err(|e| e.to_string())?;
            let _ = sub.append(&item);
        }
        if !paths.is_empty() {
            let _ = sub.append(&PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?);
        }
        let _ = sub.append(&MenuItem::with_id(&app, "recent:clear", "Clear Recent", !paths.is_empty(), None::<&str>).map_err(|e| e.to_string())?);
    }
    Ok(())
}

fn tilde(path: &str) -> String {
    match std::env::var("HOME") {
        Ok(home) if !home.is_empty() && path.starts_with(&home) => format!("~{}", &path[home.len()..]),
        _ => path.to_string(),
    }
}

/// Folders handed to Garnet by Finder (dropped on the Dock icon, Open With) before the frontend asked for them.
static OPENED: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub fn opened<R: Runtime>(app: &AppHandle<R>, urls: &[tauri::Url]) {
    let paths: Vec<String> = urls.iter().filter_map(|u| u.to_file_path().ok()).filter(|p| p.is_dir()).map(|p| p.to_string_lossy().trim_end_matches('/').to_string()).collect();
    if paths.is_empty() {
        return;
    }
    OPENED.lock().unwrap().extend(paths.clone());
    let _ = app.emit("open-paths", paths);
}

/// Folders Finder opened Garnet with that the frontend has not taken yet (cold launch from a Dock drop).
#[tauri::command]
pub fn take_opened_paths() -> Vec<String> {
    std::mem::take(&mut *OPENED.lock().unwrap())
}

#[tauri::command]
pub fn close_window(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

/// Main window position and size, restored on the next launch.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

static FRAME: Mutex<Option<Frame>> = Mutex::new(None);
static RESTORED: Mutex<Option<Frame>> = Mutex::new(None);

fn frame_file<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("window.json"))
}

/// A saved frame that is big enough and still lands on a connected display (by its title bar), clamped into that
/// display's visible area (shrunk when it no longer fits).
pub fn usable(frame: Frame, min: (f64, f64), displays: &[(f64, f64, f64, f64)]) -> Option<Frame> {
    if !(frame.width >= min.0 && frame.height >= min.1 && frame.width.is_finite() && frame.height.is_finite()) {
        return None;
    }
    let (cx, cy) = (frame.x + frame.width / 2.0, frame.y + 10.0);
    let &(dx, dy, dw, dh) = displays.iter().find(|&&(x, y, w, h)| cx >= x && cx < x + w && cy >= y && cy < y + h)?;
    let (width, height) = (frame.width.min(dw).max(min.0), frame.height.min(dh).max(min.1));
    Some(Frame { x: frame.x.min(dx + dw - width).max(dx), y: frame.y.min(dy + dh - height).max(dy), width, height })
}

/// `--frame=x,y,w,h`: the frame a New Window should open at (its opener's, offset so the two don't stack).
fn frame_arg() -> Option<Frame> {
    let v: Vec<f64> = std::env::args().find_map(|a| a.strip_prefix("--frame=").map(str::to_owned))?.split(',').filter_map(|n| n.parse().ok()).collect();
    (v.len() == 4).then(|| Frame { x: v[0], y: v[1], width: v[2], height: v[3] })
}

pub fn cascade_arg<R: Runtime>(window: &tauri::Window<R>) -> Option<String> {
    let (s, p, z) = (window.scale_factor().ok()?, window.outer_position().ok()?, window.inner_size().ok()?);
    Some(format!("--frame={},{},{},{}", p.x as f64 / s + 24.0, p.y as f64 / s + 24.0, z.width as f64 / s, z.height as f64 / s))
}

pub fn restore_frame<R: Runtime>(app: &AppHandle<R>, window: &mut tauri::utils::config::WindowConfig) {
    let Some(saved) = frame_arg().or_else(|| frame_file(app).and_then(|f| std::fs::read_to_string(f).ok()).and_then(|s| serde_json::from_str::<Frame>(&s).ok())) else { return };
    let displays: Vec<_> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let s = m.scale_factor();
            let a = m.work_area();
            (a.position.x as f64 / s, a.position.y as f64 / s, a.size.width as f64 / s, a.size.height as f64 / s)
        })
        .collect();
    let min = (window.min_width.unwrap_or(0.0), window.min_height.unwrap_or(0.0));
    if let Some(f) = usable(saved, min, &displays) {
        window.x = Some(f.x);
        window.y = Some(f.y);
        window.width = f.width;
        window.height = f.height;
        window.center = false;
        *RESTORED.lock().unwrap() = Some(f);
        *FRAME.lock().unwrap() = Some(f);
    }
}

/// The size restored at launch, for the smoke check.
#[tauri::command]
pub fn restored_frame() -> Option<Frame> {
    *RESTORED.lock().unwrap()
}

pub fn track_frame<R: Runtime>(window: &tauri::Window<R>) {
    if window.is_fullscreen().unwrap_or(false) || window.is_minimized().unwrap_or(false) || window.is_maximized().unwrap_or(false) {
        return;
    }
    let (Ok(s), Ok(p), Ok(z)) = (window.scale_factor(), window.outer_position(), window.inner_size()) else { return };
    *FRAME.lock().unwrap() = Some(Frame { x: p.x as f64 / s, y: p.y as f64 / s, width: z.width as f64 / s, height: z.height as f64 / s });
}

pub fn save_frame<R: Runtime>(app: &AppHandle<R>) {
    if let (Some(f), Some(path)) = (*FRAME.lock().unwrap(), frame_file(app)) {
        let _ = std::fs::write(path, serde_json::to_string(&f).unwrap_or_default());
    }
}

/// Smoke only: stands in for a macOS appearance change by overriding the window's appearance (what WKWebView's
/// prefers-color-scheme reads) without touching the system setting. Returns the app-level appearance Garnet forces
/// ("" when it follows macOS), the window's effective one and the window number (for `screencapture -l`).
#[tauri::command]
pub fn smoke_appearance(window: tauri::WebviewWindow, emulate: Option<String>) -> Result<(String, String, isize), String> {
    if std::env::var_os("GARNET_SMOKE").is_none() {
        return Err("smoke only".into());
    }
    #[cfg(target_os = "macos")]
    {
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        let (tx, rx) = std::sync::mpsc::channel();
        let ns = window.ns_window().map_err(|e| e.to_string())? as usize;
        window
            .run_on_main_thread(move || unsafe {
                let ns = ns as *mut AnyObject;
                let name = |a: *mut AnyObject| -> String {
                    if a.is_null() {
                        return String::new();
                    }
                    let n: *mut AnyObject = msg_send![a, name];
                    let s: *const std::ffi::c_char = msg_send![n, UTF8String];
                    std::ffi::CStr::from_ptr(s).to_string_lossy().into_owned()
                };
                let appearance: *mut AnyObject = match emulate.as_deref() {
                    Some(t) if t != "keep" => {
                        let s: *mut AnyObject = msg_send![class!(NSString), stringWithUTF8String: if t == "dark" { c"NSAppearanceNameDarkAqua".as_ptr() } else { c"NSAppearanceNameAqua".as_ptr() }];
                        msg_send![class!(NSAppearance), appearanceNamed: s]
                    }
                    _ => std::ptr::null_mut(),
                };
                if emulate.as_deref() != Some("keep") {
                    let _: () = msg_send![ns, setAppearance: appearance];
                }
                let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
                let forced: *mut AnyObject = msg_send![app, appearance];
                let effective: *mut AnyObject = msg_send![ns, effectiveAppearance];
                let number: isize = msg_send![ns, windowNumber];
                let _ = tx.send((name(forced), name(effective), number));
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, emulate);
        Err("macOS only".into())
    }
}

/// Smoke only: saves a PNG of the web view (WKWebView takeSnapshot, no screen-recording permission needed).
#[tauri::command]
pub async fn smoke_snapshot(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    if std::env::var_os("GARNET_SMOKE").is_none() {
        return Err("smoke only".into());
    }
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        *snapshot::DONE.lock().unwrap() = Some((path, tx));
        window
            .with_webview(|pw| unsafe { snapshot::take(pw.inner() as *mut objc2::runtime::AnyObject) })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(std::time::Duration::from_secs(10)).map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, path);
        Err("macOS only".into())
    }
}

#[cfg(target_os = "macos")]
mod snapshot {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use std::ffi::{c_void, CString};
    use std::sync::mpsc::Sender;
    use std::sync::Mutex;

    type Pending = (String, Sender<Result<(), String>>);
    pub static DONE: Mutex<Option<Pending>> = Mutex::new(None);

    #[repr(C)]
    struct Descriptor {
        reserved: usize,
        size: usize,
    }
    #[repr(C)]
    struct Block {
        isa: *const c_void,
        flags: i32,
        reserved: i32,
        invoke: unsafe extern "C" fn(*mut Block, *mut AnyObject, *mut AnyObject),
        descriptor: *const Descriptor,
    }
    struct Global(Block);
    unsafe impl Sync for Global {}
    unsafe impl Send for Global {}
    extern "C" {
        static _NSConcreteGlobalBlock: c_void;
    }
    static DESCRIPTOR: Descriptor = Descriptor { reserved: 0, size: std::mem::size_of::<Block>() };

    unsafe extern "C" fn finished(_: *mut Block, image: *mut AnyObject, _error: *mut AnyObject) {
        let Some((path, tx)) = DONE.lock().unwrap().take() else { return };
        let result = (|| {
            if image.is_null() {
                return Err("no snapshot".to_string());
            }
            let tiff: *mut AnyObject = msg_send![image, TIFFRepresentation];
            let rep: *mut AnyObject = msg_send![class!(NSBitmapImageRep), imageRepWithData: tiff];
            let props: *mut AnyObject = msg_send![class!(NSDictionary), dictionary];
            let png: *mut AnyObject = msg_send![rep, representationUsingType: 4usize, properties: props];
            let c = CString::new(path).map_err(|e| e.to_string())?;
            let file: *mut AnyObject = msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()];
            let ok: bool = msg_send![png, writeToFile: file, atomically: true];
            ok.then_some(()).ok_or_else(|| "could not write the PNG".to_string())
        })();
        let _ = tx.send(result);
    }

    pub unsafe fn take(webview: *mut AnyObject) {
        static BLOCK: std::sync::OnceLock<Global> = std::sync::OnceLock::new();
        let block = BLOCK.get_or_init(|| Global(Block { isa: &raw const _NSConcreteGlobalBlock, flags: 1 << 28, reserved: 0, invoke: finished, descriptor: &DESCRIPTOR }));
        let config: *mut AnyObject = std::ptr::null_mut();
        let _: () = msg_send![webview, takeSnapshotWithConfiguration: config, completionHandler: &block.0 as *const Block as *mut c_void];
    }
}

/// Smoke only: top-level menu titles and the checkmarks of check items, as "Title" / "id=true".
#[tauri::command]
pub fn smoke_menu<R: Runtime>(app: AppHandle<R>) -> Vec<String> {
    let mut out = Vec::new();
    let Some(menu) = app.menu() else { return out };
    for item in menu.items().unwrap_or_default() {
        if let MenuItemKind::Submenu(s) = &item {
            out.push(s.text().unwrap_or_default());
        }
    }
    visit(menu.items().unwrap_or_default(), &mut |item| {
        if let MenuItemKind::Check(c) = item {
            out.push(format!("{}={}", c.id().0, c.is_checked().unwrap_or(false)));
        }
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_saved_frame_is_used_only_on_a_connected_display_and_above_the_minimum() {
        let displays = [(0.0, 0.0, 1440.0, 900.0), (1440.0, -200.0, 2560.0, 1440.0)];
        let f = Frame { x: 100.0, y: 50.0, width: 1200.0, height: 800.0 };
        assert_eq!(usable(f, (800.0, 500.0), &displays), Some(f));
        let second = Frame { x: 2000.0, y: -100.0, ..f };
        assert_eq!(usable(second, (800.0, 500.0), &displays), Some(second));
        assert_eq!(usable(Frame { x: 5000.0, ..f }, (800.0, 500.0), &displays), None, "display unplugged");
        assert_eq!(usable(Frame { width: 300.0, ..f }, (800.0, 500.0), &displays), None);
        let big = Frame { x: 400.0, y: 50.0, width: 1600.0, height: 1000.0 };
        assert_eq!(usable(big, (800.0, 500.0), &displays), Some(Frame { x: 0.0, y: 0.0, width: 1440.0, height: 900.0 }), "shrunk into the display");
        let hanging = Frame { x: 600.0, y: 300.0, ..f };
        assert_eq!(usable(hanging, (800.0, 500.0), &displays), Some(Frame { x: 240.0, y: 100.0, ..f }), "moved fully on screen");
    }
}
