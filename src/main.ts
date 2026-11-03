import "./styles.css";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { allCommands, commandIcon, commands, editorHasFocus, installKeyHandler, keyLabel, keysFor, lastKeyCommand, runCommand, runEditorAction, showPalette } from "./commands";
import { attachToProcess, debugView, evaluateSelection, flushBreakpoints, gotoBreakpoint, loadBreakpoints, restartDebug, resume, step, stopAllSessions, stopDebug, toggleBreakpoint, toggleBreakpointEnabled, viewBreakpoints } from "./debug";
import { rerunAll, rerunFailed, testResultsView } from "./testresults";
import {
  activeTab, allTabs, closeActive, closeAll, cycleTab, diffActive, events, goToDiff, handleFsChanged, monaco, navigateBack, navigateForward, openFile,
  dirtyBuffers, focusActiveTab, forgetRecentFile, recentFileList, recentLocations, restoreBuffer, restoreRecentFiles, saveActive, saveAll, targetEditor, unsavedTitles,
} from "./editor";
import {
  blameCurrentLine, commitView, compareWithBranch, diffActiveFile, gitOpState, goToChange, onGitChanged, refreshGit, rollbackLines, showChangeAtCaret, stageHunkAtCaret,
} from "./git";
import { gitLogView, reload as reloadGitLog, showGitLog, stashChanges, unstashChanges } from "./gitlog";
import { abortOperation, continueOperation, showConflicts } from "./merge";
import { api, invoke } from "./ipc";
import { fileStructurePopup, findUsages, goToImplementation, goToTypeDefinition, lspBusy, lspLogView, lspReady, request, outlineView, problemsView, startLsp, stopLsp, workspaceSymbolsPopup } from "./lsp";
import { symbolSearch } from "./symbolsearch";
import { goToTest, loadRoutes, routesView, showRelated } from "./rails";
import { dbProjectOpened } from "./db";
import "./railsprovider";
import "./basics";
import { runRailsGenerator } from "./generators";
import { loadMigrations, migrationsView } from "./migrations";
import { sendToRailsConsole } from "./railsconsole";
import { initUpdateCheck } from "./update";
import { importJetBrainsKeymap, showKeymapReference, welcomeHints } from "./keymapref";
import { editConfigurations, launch, loadRunConfigs, newConfig, pickConfiguration, rakeTask, rerun, runs, runTests, selected } from "./run";
import { findInFiles, replaceInFiles, searchView } from "./search";
import { loadCodeStyle } from "./codestyle";
import {
  addRecentProject, askTrust, checkTrust, currentViewMode, editableSettingsPath, isTrusted, loadSession, modifyConfig, onSettingsChange, loadSettings, recentProjects, saveSession, setAppearance, setting, setViewMode,
  setEditorFontSize, toggleTheme, updateSetting, zoomIDE, type ViewMode,
} from "./settings";
import { offerRestore, backupUnsaved } from "./hotexit";
import { listenForQuit, quitFlow, type QuitHooks } from "./quit";
import { openSettingsWindow } from "./settingsui";
import { cloneDialog, createGist, createPullRequest, githubSignIn, openOnGitHub, refreshAccount } from "./github";
import { openPullRequestByNumber, pullRequestsView, showPullRequests } from "./prs";
import { initToolbar, pullCurrent, pushCurrent, refreshToolbar, showBranches, showProjects, showThemeMenu, showWorktrees } from "./toolbar";
import { abs, debounce, rel, state } from "./state";
import { newTerminal, pasteIntoTerminal, showTerminalPanel, terminals } from "./terminal";
import { expandedPaths, initTree, refreshTree, revealInTree, toggleRailsView, treeView } from "./tree";
import { bottom, Dock, fileIconName, fuzzyScore, h, type PickItem, quickPick, rightbar, setupResizers, sidebar, statusSlot, toast } from "./ui";

type Json = any;
const PENDING_ROOT = "open";

/// Tool windows

sidebar.add({ id: "project", title: "Project", icon: "files", command: "projectView", el: treeView });
sidebar.add({ id: "commit", title: "Commit", icon: "source-control", command: "commitView", el: commitView, onShow: () => refreshGit() });
sidebar.add({ id: "structure", title: "Structure", icon: "symbol-structure", command: "structureView", el: outlineView });
sidebar.add({ id: "pullRequests", title: "Pull Requests", icon: "git-pull-request", command: "githubPullRequests", el: pullRequestsView, onShow: () => showPullRequests() });

bottom.add({ id: "terminal", title: "Terminal", icon: "terminal", command: "terminalView", el: terminals.el, onShow: showTerminalPanel });
bottom.add({ id: "run", title: "Run", icon: "play", command: "runView", el: runs.el, onShow: () => (isTrusted() || runs.items.length ? runs.fitActive() : runs.showGate("Trust project to run configurations.")) });
bottom.add({ id: "tests", title: "Test Results", icon: "beaker", command: "testResultsView", el: testResultsView });
bottom.add({ id: "find", title: "Find", icon: "search", command: "findView", el: searchView });
bottom.add({ id: "problems", title: "Problems", icon: "warning", command: "problemsView", el: problemsView });
bottom.add({ id: "debug", title: "Debug", icon: "debug-alt", command: "debugView", el: debugView });
bottom.add({ id: "gitlog", title: "Git", icon: "git-commit", command: "gitLogView", el: gitLogView, onShow: () => reloadGitLog() });
bottom.add({ id: "routes", title: "Routes", icon: "globe", command: "routesView", el: routesView });
bottom.add({ id: "migrations", title: "Migrations", icon: "versions", command: "migrationsView", el: migrationsView, onShow: () => loadMigrations() });
bottom.add({ id: "log", title: "LSP Log", icon: "output", command: "lspLog", el: lspLogView });
bottom.hide();
setupResizers();

/// Commands

const needProject = (fn: () => unknown) => () => (state.project ? fn() : toast("Open a folder first."));

function goToFile() {
  if (!state.project) return openFolder();
  quickPick({
    placeholder: "Go to file (fuzzy, e.g. usrctl for users_controller.rb)",
    items: async (q) =>
      (await api.findFiles(q, 80)).map((p) => ({ label: p.split("/").pop()!, description: p.split("/").slice(0, -1).join("/"), icon: fileIconName(p), data: p })),
    onAccept: (item, q) => {
      if (!item) return;
      const line = q.match(/:(\d+)$/)?.[1];
      openFile(abs(item.data as string), line ? { line: Number(line) } : undefined);
    },
  });
}

function editorAction(id: string) {
  return () => runEditorAction(targetEditor(), id);
}

async function openFolder() {
  const dir = await open({ directory: true, title: "Open Folder" });
  if (typeof dir === "string") switchProject(dir);
}

async function switchProject(path: string) {
  if (!state.project) return openProject(path);
  if (!(await closeAll())) return;
  await stopLsp().catch(() => {});
  location.search = `?${PENDING_ROOT}=${encodeURIComponent(path)}`;
}

async function openRecent() {
  const list = await recentProjects();
  quickPick({
    placeholder: "Open recent project",
    items: list.map((p) => ({ label: p.split("/").pop()!, description: p, icon: "folder", data: p })),
    onAccept: (item) => item && switchProject(item.data as string),
  });
}

const E = (id: string, title: string, key: string | undefined, action: string) => ({ id, title, key, editor: true, run: editorAction(action) });

// A recent file that no longer opens (deleted, moved, unreadable) leaves the list.
const openRecentFile = (p: string) =>
  openFile(p).then(
    () => activeTab()?.path !== p && forgetRecentFile(p),
    () => forgetRecentFile(p),
  );

function pickPaths(placeholder: string, paths: string[], selectedIndex = 0) {
  quickPick({
    placeholder,
    selected: selectedIndex,
    items: paths.map((p) => ({ label: p.split("/").pop()!, description: rel(p), icon: fileIconName(p), data: p })),
    onAccept: (item) => item && openRecentFile(item.data as string),
  });
}

function recentLocationsPopup() {
  quickPick({
    placeholder: "Recent locations",
    items: recentLocations().map((p) => ({ label: `${p.path.split("/").pop()}:${p.line}`, description: rel(p.path), icon: "location", data: p })),
    onAccept: (item) => {
      const p = item?.data as { path: string; line: number; column: number } | undefined;
      if (p) openFile(p.path, { line: p.line, column: p.column });
    },
  });
}

function searchEverywhere() {
  if (!state.project) return showPalette();
  // Files and actions render at once; workspace symbols are added when ruby-lsp answers (it can be busy indexing).
  const symbols = symbolSearch({
    request: (q, token) => request<Json[] | null>("workspace/symbol", { query: q }, token as monaco.CancellationToken),
    newSource: () => new monaco.CancellationTokenSource(),
    busy: lspBusy,
    current: () => picker.query(),
    refresh: () => void picker.refresh(),
  });
  const picker = quickPick({
    placeholder: "Search everywhere: files, actions, symbols",
    onClose: () => symbols.close(),
    items: async (q): Promise<PickItem[]> => {
      if (!q.trim()) return recentFileList().slice(0, 20).map((p) => ({ label: p.split("/").pop()!, description: rel(p), icon: fileIconName(p), data: { file: p, recent: true } }));
      const found = lspReady() ? symbols.get(q) : [];
      const files = await api.findFiles(q, 30);
      const actions = allCommands()
        .map((c) => ({ c, s: fuzzyScore(q, c.title) }))
        .filter((x) => x.s !== null)
        .sort((a, b) => b.s! - a.s!)
        .slice(0, 8);
      return [
        ...files.map((p) => ({ label: p.split("/").pop()!, description: p, icon: fileIconName(p), data: { file: abs(p) } })),
        ...found.slice(0, 30).map((s) => ({ label: s.name, description: s.containerName ?? "", detail: rel(monaco.Uri.parse(s.location.uri).fsPath), icon: "symbol-class", data: { loc: s.location } })),
        ...actions.map(({ c }) => ({ label: c.title, detail: keyLabel(c), icon: commandIcon(c), data: { cmd: c.id } })),
      ];
    },
    onAccept: (item, q) => {
      const d = item?.data as { file?: string; recent?: boolean; loc?: Json; cmd?: string } | undefined;
      if (!d) return;
      const line = q.match(/:(\d+)$/)?.[1];
      if (d.recent) openRecentFile(d.file!);
      else if (d.file) openFile(d.file, line ? { line: Number(line) } : undefined);
      else if (d.loc) openFile(monaco.Uri.parse(d.loc.uri).fsPath, { line: d.loc.range.start.line + 1, column: d.loc.range.start.character + 1 });
      else if (d.cmd) runCommand(d.cmd);
    },
  });
}

const VCS_ACTIONS = ["commitView", "gitLogView", "push", "pull", "branches", "fileHistory", "gitDiff", "gitBlame", "compareBranch", "stash", "unstash", "resolveConflicts", "worktrees", "githubPr", "githubOpen"];
function vcsPopup() {
  quickPick({
    placeholder: "VCS operations",
    items: VCS_ACTIONS.map((id) => allCommands().find((c) => c.id === id)!).filter(Boolean).map((c) => ({ label: c.title, detail: keyLabel(c), data: c.id })),
    onAccept: (item) => item && runCommand(item.data as string),
  });
}

let hidden: { side: string | null; right: string | null; bottom: string | null } | null = null;
function hideAll() {
  if (hidden && !sidebar.active && !rightbar.active && !bottom.active) {
    if (hidden.side) sidebar.show(hidden.side);
    if (hidden.right) rightbar.show(hidden.right);
    if (hidden.bottom) bottom.show(hidden.bottom);
    hidden = null;
    return;
  }
  hidden = { side: sidebar.active, right: rightbar.active, bottom: bottom.active };
  sidebar.hide();
  rightbar.hide();
  bottom.hide();
}

const docks = [sidebar, rightbar, bottom];
let lastTool: { dock: Dock; id: string } | null = null;
document.addEventListener("focusin", (e) => {
  for (const dock of docks) {
    const id = dock.active;
    if (id && dock.views.get(id)?.el.contains(e.target as Node)) lastTool = { dock, id };
  }
});

function jumpToLastToolWindow() {
  const t = lastTool ?? (bottom.active ? { dock: bottom, id: bottom.active } : sidebar.active ? { dock: sidebar, id: sidebar.active } : null);
  if (t) t.dock.activate(t.id);
}

function hideActiveToolWindow() {
  const focused = docks.find((d) => d.active && d.views.get(d.active)?.el.contains(document.activeElement));
  (focused ?? (bottom.active ? bottom : rightbar.active ? rightbar : sidebar)).hide();
  focusActiveTab();
}
Dock.afterHide = focusActiveTab;

/// Distraction Free and Presentation Mode: tool windows, bars and tabs hidden; Presentation also goes full screen
/// with a larger editor font (Settings › Appearance). Toggling the same mode again restores the layout.
let beforeMode: { side: string | null; right: string | null; bottom: string | null; fullscreen: boolean } | null = null;
async function toggleViewMode(mode: Exclude<ViewMode, "">) {
  const win = getCurrentWindow();
  const leaving = currentViewMode() === mode;
  if (!beforeMode) {
    beforeMode = { side: sidebar.active, right: rightbar.active, bottom: bottom.active, fullscreen: await win.isFullscreen().catch(() => false) };
  }
  const saved = beforeMode;
  setViewMode(leaving ? "" : mode);
  if (leaving) {
    beforeMode = null;
    if (saved.side) sidebar.show(saved.side);
    if (saved.right) rightbar.show(saved.right);
    if (saved.bottom) bottom.show(saved.bottom);
  } else {
    sidebar.hide();
    rightbar.hide();
    bottom.hide();
  }
  await win.setFullscreen(leaving ? saved.fullscreen : mode === "presentation" || saved.fullscreen).catch(() => {});
  focusActiveTab();
}

const toggleSetting = (key: string) => () => updateSetting(key, setting(key) ? false : undefined);
const GARNET_DOCS = "https://github.com/sachinkr7368/garnet#readme";

async function importKeymap() {
  try {
    const xml = await invoke<string | null>("import_file", { title: "Import JetBrains Keymap", extension: "xml" });
    if (xml === null) return;
    await importJetBrainsKeymap(xml);
  } catch (e) {
    toast(`Import failed: ${e instanceof Error ? e.message : e}`, "error");
  }
}

commands(
  { id: "openFolder", title: "File: Open Folder…", run: openFolder },
  { id: "openRecent", title: "File: Open Recent Project…", run: openRecent },
  { id: "projects", title: "File: Switch Project…", run: showProjects },
  { id: "save", title: "File: Save", run: saveActive },
  { id: "saveAll", title: "File: Save All", key: "cmd+s", run: saveAll },
  { id: "closeTab", title: "File: Close Tab", key: "cmd+w", run: closeActive },
  { id: "nextTab", title: "Window: Select Next Tab", key: "cmd+shift+]", run: () => cycleTab(1) },
  { id: "prevTab", title: "Window: Select Previous Tab", key: "cmd+shift+[", run: () => cycleTab(-1) },
  { id: "switcher", title: "Window: Switcher", key: "ctrl+tab", run: () => pickPaths("Switch to file", recentFileList(), 1) },
  { id: "hideAll", title: "Window: Hide All Tool Windows", key: "cmd+shift+f12", run: hideAll },
  { id: "settings", title: "Preferences: Settings…", key: "cmd+,", run: () => openSettingsWindow() },
  { id: "quit", title: "File: Quit Garnet", run: () => quit() },
  { id: "toggleTheme", title: "View: Toggle Theme (Light/Dark)", run: toggleTheme },
  { id: "themeMenu", title: "View: Theme…", run: showThemeMenu },
  { id: "themeSystem", title: "View: Theme: System (follow macOS)", run: () => setAppearance("system") },
  { id: "themeLight", title: "View: Theme: Light", run: () => setAppearance("light") },
  { id: "themeDark", title: "View: Theme: Dark", run: () => setAppearance("dark") },
  { id: "zoomIn", title: "View: Zoom In IDE", key: "ctrl+alt+=", run: () => zoomIDE(1) },
  { id: "zoomOut", title: "View: Zoom Out IDE", key: "ctrl+alt+-", run: () => zoomIDE(-1) },
  { id: "zoomReset", title: "View: Reset IDE Zoom", key: "ctrl+alt+0", run: () => zoomIDE(0) },
  { id: "toggleToolbar", title: "View: Toggle Toolbar", run: toggleSetting("appearance.showToolbar") },
  { id: "toggleToolWindowBars", title: "View: Toggle Tool Window Bars", run: toggleSetting("appearance.showToolWindowBars") },
  { id: "toggleStatusBar", title: "View: Toggle Status Bar", run: toggleSetting("appearance.showStatusBar") },
  { id: "distractionFree", title: "View: Toggle Distraction Free Mode", run: () => toggleViewMode("distractionFree") },
  { id: "presentationMode", title: "View: Toggle Presentation Mode", run: () => toggleViewMode("presentation") },
  { id: "toggleFullScreen", title: "View: Toggle Full Screen", run: async () => { const w = getCurrentWindow(); await w.setFullscreen(!(await w.isFullscreen())); } },
  { id: "newWindow", title: "File: New Window", run: () => invoke("open_new_window", { path: "" }) },
  { id: "closeWindow", title: "Window: Close Window", key: "cmd+shift+w", run: () => invoke("close_window") },
  { id: "help", title: "Help: Garnet Help", run: () => invoke("open_url", { url: GARNET_DOCS }) },
  { id: "reportIssue", title: "Help: Report an Issue…", run: () => invoke("open_url", { url: "https://github.com/sachinkr7368/garnet/issues/new" }) },
  { id: "settingsJson", title: "Preferences: Open Settings (JSON)", run: async () => openFile(await editableSettingsPath()) },
  { id: "keymapSettings", title: "Preferences: Keymap…", run: () => openSettingsWindow("Keymap") },
  { id: "importKeymap", title: "Preferences: Import JetBrains Keymap…", run: importKeymap },
  { id: "keymapReference", title: "Help: Keymap Reference", run: showKeymapReference },
  { id: "commandPalette", title: "Find Action…", key: "cmd+shift+a cmd+shift+p", run: showPalette },
  { id: "searchEverywhere", title: "Navigate: Search Everywhere", run: searchEverywhere },
  { id: "goToFile", title: "Navigate: Go to File…", key: "cmd+shift+o", run: goToFile },
  { id: "goToClass", title: "Navigate: Go to Class…", key: "cmd+o", run: needProject(() => workspaceSymbolsPopup([2, 5])) },
  { id: "goToSymbol", title: "Navigate: Go to Symbol…", key: "cmd+alt+o", run: needProject(() => workspaceSymbolsPopup()) },
  { id: "recentFiles", title: "Navigate: Recent Files…", key: "cmd+e", run: () => pickPaths("Recent files", recentFileList(), 1) },
  { id: "recentLocations", title: "Navigate: Recent Locations…", key: "cmd+shift+e", run: recentLocationsPopup },
  { id: "back", title: "Navigate: Back", key: "cmd+[", run: navigateBack },
  { id: "forward", title: "Navigate: Forward", key: "cmd+]", run: navigateForward },
  { id: "goToLine", title: "Navigate: Go to Line…", key: "cmd+l", editor: true, run: editorAction("editor.action.gotoLine") },
  { id: "fileStructure", title: "Navigate: File Structure…", key: "cmd+f12", run: fileStructurePopup },
  E("goToDefinition", "Navigate: Go to Declaration", "cmd+b", "editor.action.revealDefinition"),
  { id: "goToImplementation", title: "Navigate: Go to Implementation(s)", key: "cmd+alt+b", run: goToImplementation },
  { id: "goToTypeDefinition", title: "Navigate: Go to Type Declaration", key: "cmd+shift+b", run: goToTypeDefinition },
  E("peekDefinition", "Navigate: Quick Definition", "alt+space", "editor.action.peekDefinition"),
  { id: "findUsages", title: "Navigate: Find Usages", key: "alt+f7", run: findUsages },
  E("peekReferences", "Navigate: Show Usages", "cmd+alt+f7", "editor.action.referenceSearch.trigger"),
  { id: "goToTest", title: "Navigate: Test / Subject", key: "cmd+shift+t", run: needProject(goToTest) },
  { id: "related", title: "Navigate: Related Symbol (Rails)…", key: "ctrl+alt+up cmd+ctrl+up", run: needProject(showRelated) },
  { id: "revealInTree", title: "Navigate: Select Opened File in Project", key: "alt+f1", run: () => { const t = activeTab(); if (t) { sidebar.show("project"); revealInTree(t.path); } } },
  E("find", "Find: Find…", "cmd+f", "actions.find"),
  E("replace", "Find: Replace…", "cmd+r", "editor.action.startFindReplaceAction"),
  E("findNext", "Find: Find Next", "cmd+g", "editor.action.nextMatchFindAction"),
  E("findPrevious", "Find: Find Previous", "cmd+shift+g", "editor.action.previousMatchFindAction"),
  { id: "findInFiles", title: "Find: Find in Files…", key: "cmd+shift+f", run: needProject(() => findInFiles()) },
  { id: "replaceInFiles", title: "Find: Replace in Files…", key: "cmd+shift+r", run: needProject(replaceInFiles) },
  E("format", "Code: Reformat Code", "cmd+alt+l", "editor.action.formatDocument"),
  E("rename", "Refactor: Rename…", "shift+f6", "editor.action.rename"),
  E("codeActions", "Code: Show Context Actions", "alt+enter", "editor.action.quickFix"),
  E("toggleComment", "Code: Comment with Line Comment", "cmd+/", "editor.action.commentLine"),
  E("blockComment", "Code: Comment with Block Comment", "cmd+alt+/", "editor.action.blockComment"),
  E("duplicateLine", "Edit: Duplicate Line or Selection", "cmd+d", "editor.action.copyLinesDownAction"),
  E("deleteLine", "Edit: Delete Line", "cmd+backspace", "editor.action.deleteLines"),
  E("expandSelection", "Edit: Extend Selection", "alt+up", "editor.action.smartSelect.expand"),
  E("shrinkSelection", "Edit: Shrink Selection", "alt+down", "editor.action.smartSelect.shrink"),
  E("nextOccurrence", "Edit: Add Selection for Next Occurrence", "ctrl+g", "editor.action.addSelectionToNextFindMatch"),
  E("moveLineUp", "Code: Move Line Up", "cmd+shift+up alt+shift+up", "editor.action.moveLinesUpAction"),
  E("moveLineDown", "Code: Move Line Down", "cmd+shift+down alt+shift+down", "editor.action.moveLinesDownAction"),
  E("selectAllOccurrences", "Edit: Select All Occurrences", "cmd+ctrl+g", "editor.action.selectHighlights"),
  E("caretsOnLines", "Edit: Add Caret to Each Line in Selection", "alt+shift+g", "editor.action.insertCursorAtEndOfEachLineSelected"),
  E("joinLines", "Edit: Join Lines", "ctrl+shift+j", "editor.action.joinLines"),
  E("newLineBefore", "Edit: Start New Line Before Current", "cmd+alt+enter", "editor.action.insertLineBefore"),
  E("matchingBrace", "Navigate: Move Caret to Matching Brace", "ctrl+m", "editor.action.jumpToBracket"),
  E("quickDoc", "Code: Quick Documentation", "f1", "editor.action.showHover"),
  E("parameterInfo", "Code: Parameter Info", "cmd+p", "editor.action.triggerParameterHints"),
  E("nextError", "Navigate: Next Highlighted Error", "f2", "editor.action.marker.nextInFiles"),
  E("prevError", "Navigate: Previous Highlighted Error", "shift+f2", "editor.action.marker.prevInFiles"),
  E("refactorThis", "Refactor: Refactor This…", "ctrl+t", "editor.action.refactor"),
  E("highlightUsages", "Navigate: Highlight Usages in File", "cmd+shift+f7", "editor.action.wordHighlight.trigger"),
  { id: "increaseFont", title: "View: Increase Font Size in All Editors", key: "ctrl+shift+.", run: () => setEditorFontSize(Math.min(32, setting<number>("editor.fontSize") + 1)) },
  { id: "decreaseFont", title: "View: Decrease Font Size in All Editors", key: "ctrl+shift+,", run: () => setEditorFontSize(Math.max(8, setting<number>("editor.fontSize") - 1)) },
  { id: "resetFont", title: "View: Reset Font Size", run: () => setEditorFontSize(undefined) },
  E("expandRegion", "Code: Expand", "cmd+= cmd+numpadadd", "editor.unfold"),
  E("collapseRegion", "Code: Collapse", "cmd+- cmd+numpadsubtract", "editor.fold"),
  E("expandRecursively", "Code: Expand Recursively", "cmd+alt+= cmd+alt+numpadadd", "editor.unfoldRecursively"),
  E("collapseRecursively", "Code: Collapse Recursively", "cmd+alt+- cmd+alt+numpadsubtract", "editor.foldRecursively"),
  E("expandAll", "Code: Expand All", "cmd+shift+= cmd+shift+numpadadd", "editor.unfoldAll"),
  E("collapseAll", "Code: Collapse All", "cmd+shift+- cmd+shift+numpadsubtract", "editor.foldAll"),
  { id: "projectView", title: "View: Project", key: "cmd+1", run: () => sidebar.activate("project") },
  { id: "findView", title: "View: Find", key: "cmd+3", run: () => bottom.activate("find") },
  { id: "runView", title: "View: Run", key: "cmd+4", run: () => bottom.activate("run") },
  { id: "debugView", title: "View: Debug", key: "cmd+5", run: () => bottom.activate("debug") },
  { id: "problemsView", title: "View: Problems", key: "cmd+6", run: () => bottom.activate("problems") },
  { id: "structureView", title: "View: Structure", key: "cmd+7", run: () => sidebar.activate("structure") },
  { id: "commitView", title: "VCS: Commit…", key: "cmd+k cmd+0", run: needProject(() => sidebar.activate("commit")) },
  { id: "terminalView", title: "View: Terminal", key: "alt+f12", run: needProject(() => bottom.activate("terminal")) },
  { id: "lastToolWindow", title: "Window: Jump to Last Tool Window", key: "f12", run: jumpToLastToolWindow },
  { id: "newTerminal", title: "Terminal: New Terminal Tab", run: needProject(() => (bottom.show("terminal"), newTerminal())) },
  { id: "routesView", title: "Rails: Routes", run: needProject(() => (bottom.show("routes"), loadRoutes())) },
  { id: "railsGenerator", title: "Rails: Run Rails Generator…", key: "cmd+alt+g", run: needProject(runRailsGenerator) },
  { id: "migrationsView", title: "Rails: Migrations", run: needProject(() => bottom.show("migrations")) },
  { id: "railsConsoleSend", title: "Rails: Send Selection to Rails Console", key: "cmd+shift+enter", editor: true, run: needProject(sendToRailsConsole) },
  { id: "railsProjectView", title: "Rails: Toggle Rails Project View", run: needProject(() => (sidebar.show("project"), toggleRailsView())) },
  { id: "hidePanels", title: "View: Hide Active Tool Window", key: "shift+escape", run: hideActiveToolWindow },
  { id: "runSelected", title: "Run: Run", key: "ctrl+r", run: needProject(() => (selected() ? launch(selected()!, "run") : editConfigurations())) },
  { id: "debugSelected", title: "Run: Debug", key: "ctrl+d", run: needProject(() => (selected() ? launch(selected()!, "debug") : editConfigurations())) },
  { id: "chooseRun", title: "Run: Run…", key: "ctrl+alt+r", run: needProject(() => pickConfiguration("run")) },
  { id: "chooseDebug", title: "Run: Debug…", key: "ctrl+alt+d", run: needProject(() => pickConfiguration("debug")) },
  { id: "editConfigurations", title: "Run: Edit Configurations…", run: needProject(editConfigurations) },
  { id: "rerun", title: "Run: Rerun", run: rerun },
  { id: "runTestAtCursor", title: "Run: Run Context Configuration", key: "ctrl+shift+r", run: needProject(() => runTests("cursor")) },
  { id: "debugTestAtCursor", title: "Run: Debug Context Configuration", key: "ctrl+shift+d", run: needProject(() => runTests("cursor", "debug")) },
  { id: "runTestFile", title: "Run: Tests in Current File", run: needProject(() => runTests("file")) },
  { id: "runAllTests", title: "Run: All Tests", run: needProject(() => runTests("all")) },
  { id: "rakeTask", title: "Run: Rake / Rails Task…", run: needProject(rakeTask) },
  { id: "runRubyFile", title: "Run: Current Ruby File", run: needProject(() => { const t = activeTab(); if (t) launch(newConfig("ruby", t.title, t.path), "run"); }) },
  { id: "debugRubyFile", title: "Run: Debug Current Ruby File", run: needProject(() => { const t = activeTab(); if (t) launch(newConfig("ruby", t.title, t.path), "debug"); }) },
  { id: "attach", title: "Run: Attach to Process (rdbg port/socket)…", key: "alt+shift+f5", run: needProject(attachToProcess) },
  { id: "toggleBreakpoint", title: "Debug: Toggle Line Breakpoint", key: "cmd+f8", run: () => toggleBreakpoint() },
  { id: "viewBreakpoints", title: "Debug: View Breakpoints…", key: "cmd+shift+f8", run: needProject(() => viewBreakpoints()) },
  { id: "gotoBreakpoint", title: "Debug: Go to Breakpoint…", run: needProject(gotoBreakpoint) },
  { id: "toggleBreakpointEnabled", title: "Debug: Toggle Breakpoint Enabled", run: () => toggleBreakpointEnabled() },
  { id: "stopAllSessions", title: "Debug: Stop All Sessions", run: stopAllSessions },
  { id: "testResultsView", title: "View: Test Results", run: () => bottom.toggle("tests") },
  { id: "rerunFailedTests", title: "Test: Rerun Failed Tests", run: needProject(rerunFailed) },
  { id: "rerunTests", title: "Test: Rerun Last Test Run", run: needProject(rerunAll) },
  { id: "evaluate", title: "Debug: Evaluate Expression…", key: "alt+f8", run: evaluateSelection },
  { id: "resume", title: "Debug: Resume Program", key: "cmd+alt+r f9", run: resume },
  { id: "stepOver", title: "Debug: Step Over", key: "f8", run: () => step("next") },
  { id: "stepInto", title: "Debug: Step Into (Next Difference in a diff)", key: "f7", run: () => (diffActive() ? goToDiff("next") : step("stepIn")) },
  { id: "stepOut", title: "Debug: Step Out", key: "shift+f8", run: () => step("stepOut") },
  { id: "restartDebug", title: "Debug: Restart", key: "cmd+shift+f5", run: restartDebug },
  { id: "stopDebug", title: "Debug: Stop", key: "cmd+f2", run: stopDebug },
  { id: "vcsPopup", title: "VCS: Operations Popup…", key: "ctrl+v", run: needProject(vcsPopup) },
  { id: "push", title: "VCS: Push…", key: "cmd+shift+k", run: needProject(pushCurrent) },
  { id: "pull", title: "VCS: Update Project", key: "cmd+t", run: needProject(pullCurrent) },
  { id: "gitRefresh", title: "VCS: Refresh Status", run: needProject(refreshGit) },
  { id: "gitDiff", title: "VCS: Show Diff for Current File", key: "cmd+alt+d", run: needProject(diffActiveFile) },
  { id: "gitBlame", title: "VCS: Annotate Current Line (Blame)", run: needProject(blameCurrentLine) },
  { id: "branches", title: "VCS: Branches…", run: needProject(showBranches) },
  { id: "gitLogView", title: "View: Git (Log)", key: "cmd+9", run: needProject(() => bottom.activate("gitlog")) },
  { id: "fileHistory", title: "VCS: Show History for Current File", run: needProject(() => { const t = activeTab(); if (t) showGitLog(t.path); else showGitLog(""); }) },
  { id: "stash", title: "VCS: Stash Changes…", run: needProject(stashChanges) },
  { id: "unstash", title: "VCS: Unstash Changes…", run: needProject(unstashChanges) },
  { id: "resolveConflicts", title: "VCS: Resolve Conflicts…", run: needProject(showConflicts) },
  { id: "abortOperation", title: "VCS: Abort Merge / Rebase / Cherry-Pick / Revert", run: needProject(() => (gitOpState().op ? abortOperation(gitOpState().op) : toast("No merge, rebase, cherry-pick or revert in progress."))) },
  { id: "continueOperation", title: "VCS: Continue Merge / Rebase / Cherry-Pick / Revert", run: needProject(() => (gitOpState().op ? continueOperation(gitOpState().op) : toast("No merge, rebase, cherry-pick or revert in progress."))) },
  { id: "compareBranch", title: "VCS: Compare with Branch…", run: needProject(() => (sidebar.show("commit"), compareWithBranch())) },
  { id: "rollbackLines", title: "VCS: Rollback Lines", key: "cmd+alt+z", editor: true, run: needProject(rollbackLines) },
  { id: "nextChange", title: "VCS: Next Change", key: "ctrl+alt+shift+down", editor: true, run: needProject(() => goToChange(1)) },
  { id: "prevChange", title: "VCS: Previous Change", key: "ctrl+alt+shift+up", editor: true, run: needProject(() => goToChange(-1)) },
  { id: "stageHunk", title: "VCS: Stage Hunk at Caret", editor: true, run: needProject(stageHunkAtCaret) },
  { id: "showChange", title: "VCS: Show Change at Caret", editor: true, run: needProject(showChangeAtCaret) },
  { id: "diffNext", title: "Diff: Next Difference", run: () => goToDiff("next") },
  { id: "diffPrev", title: "Diff: Previous Difference", key: "shift+f7", run: () => goToDiff("previous") },
  { id: "worktrees", title: "VCS: Worktrees…", run: needProject(showWorktrees) },
  { id: "githubSignIn", title: "GitHub: Sign In / Sign Out", run: githubSignIn },
  { id: "githubPr", title: "GitHub: Create Pull Request…", run: needProject(createPullRequest) },
  { id: "githubOpen", title: "GitHub: Open File on GitHub", run: needProject(openOnGitHub) },
  { id: "githubGist", title: "GitHub: Create Gist from Selection…", run: needProject(createGist) },
  { id: "githubPullRequests", title: "View: Pull Requests", run: () => sidebar.toggle("pullRequests") },
  { id: "githubOpenPr", title: "GitHub: Open Pull Request…", run: needProject(openPullRequestByNumber) },
  { id: "githubClone", title: "GitHub: Clone Repository…", run: () => cloneDialog(switchProject) },
  { id: "restartLsp", title: "Ruby LSP: Restart", run: needProject(startLsp) },
  { id: "trustProject", title: "File: Trust Project…", run: needProject(askTrust) },
  { id: "toggleBreadcrumbs", title: "View: Toggle Breadcrumbs", run: () => updateSetting("editor.breadcrumbs", !setting("editor.breadcrumbs")) },
  { id: "toggleSemanticHighlighting", title: "View: Toggle Semantic Highlighting", run: () => updateSetting("editor.semanticHighlighting", !setting("editor.semanticHighlighting")) },
  { id: "toggleInlayHints", title: "View: Toggle Inlay Hints", run: () => updateSetting("editor.inlayHints", !setting("editor.inlayHints")) },
  { id: "lspLog", title: "Ruby LSP: Show Log", run: () => bottom.show("log") },
);

/// Welcome screen

async function renderWelcome() {
  const welcome = document.getElementById("welcome")!;
  if (state.project) {
    welcome.replaceChildren(
      h(
        "div",
        { class: "welcome-inner hints" },
        h("div", { class: "welcome-title" }, state.project.name),
        ...welcomeHints().map(([a, k]) => h("div", { class: "welcome-key" }, h("span", {}, a), h("kbd", {}, k))),
      ),
    );
    return;
  }
  const recent = await recentProjects();
  welcome.replaceChildren(
    h(
      "div",
      { class: "welcome-inner" },
      h("div", { class: "welcome-logo" }),
      h("div", { class: "welcome-title" }, "Garnet"),
      h("div", { class: "dim" }, "A fast Ruby and Rails IDE"),
      h("button", { class: "btn primary big", onclick: openFolder }, "Open Folder…"),
      h("button", { class: "btn big", onclick: () => cloneDialog(switchProject) }, "Clone Repository…"),
      recent.length ? h("div", { class: "welcome-recent-title" }, "Recent projects") : null,
      ...recent.map((p) => h("div", { class: "welcome-recent", onclick: () => openProject(p) }, h("span", {}, p.split("/").pop()!), h("span", { class: "dim" }, p))),
    ),
  );
}

onSettingsChange(() => void renderWelcome());

/// Project lifecycle

async function persistNow(): Promise<boolean> {
  if (!state.project) return true;
  const tabs = allTabs().filter((t) => t.kind === "file");
  return saveSession(state.project.root, { tabs: tabs.map((t) => t.path), active: activeTab()?.path, expanded: expandedPaths(), bottom: bottom.active, recent: recentFileList() });
}
const persistSession = debounce(() => void persistNow(), 500);

/// ⌘Q, the red close button, Dock Quit and logout: prompt for unsaved files, save the session, then tell the backend.
const quitHooks: QuitHooks = {
  unsaved: unsavedTitles,
  saveAll: async () => (await saveAll()).every(Boolean),
  persist: async () => {
    const [session, bps] = await Promise.all([persistNow(), flushBreakpoints()]);
    // Saved or deliberately discarded: nothing is left to restore next time.
    if (session && bps && state.project) await backupUnsaved(state.project.root, []);
    return session && bps;
  },
};
const quit = () => quitFlow(quitHooks);
setInterval(() => state.project && void backupUnsaved(state.project.root, dirtyBuffers()), 5000);

async function openProject(path: string) {
  let info;
  try {
    info = await api.openProject(path);
  } catch (e) {
    toast(`Cannot open ${path}: ${e}`, "error");
    return renderWelcome();
  }
  state.project = info;
  const smoke = await invoke<[string, boolean] | null>("smoke_target");
  await Promise.all([loadSettings(info.root), loadCodeStyle(info.root), checkTrust(info.root)]);
  document.body.classList.add("has-project");
  getCurrentWindow().setTitle(`${info.name} — Garnet`).catch(() => {});
  void addRecentProject(info.root).then(() => syncMenu());
  sidebar.show("project");
  await loadBreakpoints();
  const session = await loadSession(info.root);
  await initTree(session?.expanded ?? []);
  renderWelcome();
  refreshGit();
  refreshToolbar();
  void dbProjectOpened();
  if (isTrusted()) {
    loadRunConfigs();
    if (setting("ruby.lspEnabled")) startLsp();
  } else if (smoke || !(await askTrust())) loadRunConfigs();
  if (isTrusted() && session?.bottom && setting("appearance.restoreBottomPanel")) bottom.show(session.bottom);
  for (const p of session?.tabs ?? []) await openFile(p).catch(() => {});
  if (session?.active) await openFile(session.active).catch(() => {});
  if (session?.recent?.length) restoreRecentFiles((await Promise.all(session.recent.map((p) => api.canonicalPath(p).then(() => p, () => "")))).filter(Boolean));
  void offerRestore(info.root, restoreBuffer);
  events.tabsChanged.on(persistSession);
  events.activated.on(persistSession);
  treeView.addEventListener("click", persistSession);
}

/// Backend events

listen<{ paths: string[]; structural: boolean }>("fs-changed", (e) => {
  handleFsChanged(e.payload.paths);
  if (e.payload.structural) refreshTree(e.payload.paths);
});
listen("git-changed", () => {
  onGitChanged();
  refreshToolbarSoon();
});
const refreshToolbarSoon = debounce(() => refreshToolbar(), 500);
const indexSlot = statusSlot("index", "left", undefined, "Project index");
listen<{ count: number; ms: number }>("index-ready", (e) => {
  indexSlot.textContent = `${e.payload.count.toLocaleString()} files indexed`;
  indexSlot.title = `Indexed in ${e.payload.ms} ms`;
});
/// Esc leaves Distraction Free and Presentation Mode unless something else (a widget, a dialog) used it.
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || !currentViewMode() || document.querySelector("#overlay-root > [data-modal]")) return;
  void toggleViewMode(currentViewMode() as Exclude<ViewMode, "">);
});

/// Editor actions from the menu follow the key handler's focus rule: with focus in a field, the terminal or the
/// Project tree, ⌘F/⌘G stay there instead of reaching the editor behind it.
export const menuBlockedByFocus = (id: string, el = document.activeElement) =>
  !!allCommands().find((c) => c.id === id)?.editor && !editorHasFocus(el as HTMLElement | null);

/// Native menu bar: items are command ids, plus "recent:<path>". A shortcut the key handler already ran also
/// reaches the menu when the web view passes it on, so that echo is dropped; dialogs block the menu like they
/// block shortcuts.
listen<string>("menu", (e) => {
  const id = e.payload;
  if (id === "recent:clear") return void modifyConfig<string[]>("recent.json", [], () => []).then(() => syncMenu());
  if (id.startsWith("recent:")) return void switchProject(id.slice(7));
  const last = lastKeyCommand();
  if (last.id === id && performance.now() - last.at < 500) return;
  if (document.querySelector("#overlay-root > [data-modal]") || menuBlockedByFocus(id)) return;
  runCommand(id);
});

/// Editor actions whose shortcut the menu shows; the rest stay off the menu so text fields keep keys like ⌘⌫.
const MENU_EDITOR_KEYS = new Set(["find", "replace", "findNext", "findPrevious"]);
const CHECKS: Record<string, () => boolean> = {
  themeSystem: () => setting("appearance.theme") === "system",
  themeLight: () => setting("appearance.theme") === "light",
  themeDark: () => setting("appearance.theme") === "dark",
  toggleToolbar: () => !!setting("appearance.showToolbar"),
  toggleToolWindowBars: () => !!setting("appearance.showToolWindowBars"),
  toggleStatusBar: () => !!setting("appearance.showStatusBar"),
  toggleBreadcrumbs: () => !!setting("editor.breadcrumbs"),
  distractionFree: () => currentViewMode() === "distractionFree",
  presentationMode: () => currentViewMode() === "presentation",
};
export const menuAccelerators = () =>
  Object.fromEntries(allCommands().filter((c) => c.id !== "quit").map((c) => [c.id, !c.editor || MENU_EDITOR_KEYS.has(c.id) ? (keysFor(c.id)[0] ?? null) : null]));
async function syncMenu() {
  const checked = Object.fromEntries(Object.entries(CHECKS).map(([id, on]) => [id, on()]));
  await invoke("set_menu_state", { state: { accelerators: menuAccelerators(), checked, recent: await recentProjects() } }).catch(() => {});
}
onSettingsChange(debounce(() => void syncMenu(), 50));

/// A folder dropped on the window or the Dock icon opens like File › Open; with a project open it gets its own window.
async function openDropped(paths: string[]) {
  const dirs: string[] = [];
  for (const p of paths) if (await api.listDir(p).then(() => true, () => false)) dirs.push(p);
  if (!dirs.length) return;
  if (!state.project) return switchProject(dirs[0]);
  for (const d of dirs) await invoke("open_new_window", { path: d }).catch((e) => toast(`Cannot open ${d}: ${e}`, "error"));
}
// Until boot has taken the launch paths, it opens them itself.
let launchPathsTaken = false;
listen<string[]>("open-paths", () => launchPathsTaken && void invoke<string[]>("take_opened_paths").then(openDropped));
try {
  void getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type !== "drop") return;
    const at = document.elementFromPoint(e.payload.position.x / devicePixelRatio, e.payload.position.y / devicePixelRatio);
    if (!(at && pasteIntoTerminal(at, e.payload.paths))) void openDropped(e.payload.paths);
  });
} catch {
  // no Tauri webview (tests)
}
void listenForQuit(quitHooks);
window.addEventListener("garnet:open-settings", (e) => openSettingsWindow((e as CustomEvent<string>).detail));
window.addEventListener("garnet:open-file", (e) => void openFile((e as CustomEvent<string>).detail));
window.addEventListener("garnet:trusted", () => {
  refreshToolbar();
  loadRunConfigs();
  if (setting("ruby.lspEnabled")) startLsp();
});

/// Boot

async function boot() {
  installKeyHandler();
  refreshAccount();
  initToolbar(switchProject);
  await loadSettings();
  initUpdateCheck().catch(() => {});
  const smoke = await invoke<[string, boolean] | null>("smoke_target");
  void syncMenu();
  const pending = smoke ? null : new URLSearchParams(location.search).get(PENDING_ROOT);
  const dropped = smoke ? [] : await invoke<string[]>("take_opened_paths").catch(() => [] as string[]);
  launchPathsTaken = true;
  const initial = pending ?? dropped?.[0] ?? (await api.initialPath());
  if (smoke && initial) {
    const { runSmoke } = await import("./smoke");
    return runSmoke(initial, smoke[1], openProject);
  }
  if (initial) await openProject(initial);
  else renderWelcome();
}

window.addEventListener("beforeunload", () => persistSession());
boot();

