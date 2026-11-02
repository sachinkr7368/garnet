import "./styles.css";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { allCommands, commands, installKeyHandler, keyLabel, runCommand, showPalette } from "./commands";
import { attachToProcess, debugView, evaluateSelection, gotoBreakpoint, loadBreakpoints, restartDebug, resume, step, stopAllSessions, stopDebug, toggleBreakpoint, toggleBreakpointEnabled, viewBreakpoints } from "./debug";
import { rerunAll, rerunFailed, testResultsView } from "./testresults";
import {
  activeTab, allTabs, closeActive, closeAll, cycleTab, diffActive, editor, events, goToDiff, handleFsChanged, monaco, navigateBack, navigateForward, openFile,
  recentFileList, recentLocations, saveActive, saveAll,
} from "./editor";
import {
  blameCurrentLine, commitView, compareWithBranch, diffActiveFile, gitOpState, goToChange, onGitChanged, refreshGit, rollbackLines, showChangeAtCaret, stageHunkAtCaret,
} from "./git";
import { gitLogView, reload as reloadGitLog, showGitLog, stashChanges, unstashChanges } from "./gitlog";
import { abortOperation, continueOperation, showConflicts } from "./merge";
import { api, invoke } from "./ipc";
import { fileStructurePopup, findUsages, goToImplementation, goToTypeDefinition, lspLogView, lspReady, request, outlineView, problemsView, startLsp, stopLsp, workspaceSymbolsPopup } from "./lsp";
import { goToTest, loadRoutes, routesView, showRelated } from "./rails";
import "./db";
import { importJetBrainsKeymap, showKeymapReference } from "./keymapref";
import { editConfigurations, launch, loadRunConfigs, newConfig, pickConfiguration, rakeTask, rerun, runs, runTests, selected } from "./run";
import { findInFiles, replaceInFiles, searchView } from "./search";
import { loadCodeStyle } from "./codestyle";
import { addRecentProject, askTrust, checkTrust, isTrusted, loadSession, trustProject, loadSettings, recentProjects, saveSession, setting, settingsPath, toggleTheme, updateSetting } from "./settings";
import { openSettingsWindow } from "./settingsui";
import { createGist, createPullRequest, githubSignIn, initToolbar, openOnGitHub, pullCurrent, pushCurrent, refreshToolbar, showBranches, showProjects, showWorktrees } from "./toolbar";
import { abs, debounce, rel, state } from "./state";
import { newTerminal, showTerminalPanel, terminals } from "./terminal";
import { expandedPaths, initTree, refreshTree, revealInTree, treeView } from "./tree";
import { bottom, fuzzyScore, h, type PickItem, quickPick, setupResizers, sidebar, statusSlot, toast } from "./ui";

type Json = any;
const PENDING_ROOT = "open";

/// Tool windows

sidebar.add({ id: "project", title: "Project", icon: "files", el: treeView });
sidebar.add({ id: "commit", title: "Commit", icon: "source-control", el: commitView, onShow: () => refreshGit() });
sidebar.add({ id: "structure", title: "Structure", icon: "symbol-structure", el: outlineView });

bottom.add({ id: "terminal", title: "Terminal", icon: "terminal", el: terminals.el, onShow: showTerminalPanel });
bottom.add({ id: "run", title: "Run", icon: "play", el: runs.el, onShow: () => runs.fitActive() });
bottom.add({ id: "tests", title: "Test Results", icon: "beaker", el: testResultsView });
bottom.add({ id: "find", title: "Find", icon: "search", el: searchView });
bottom.add({ id: "problems", title: "Problems", icon: "warning", el: problemsView });
bottom.add({ id: "debug", title: "Debug", icon: "debug-alt", el: debugView });
bottom.add({ id: "gitlog", title: "Git", icon: "git-commit", el: gitLogView, onShow: () => reloadGitLog() });
bottom.add({ id: "routes", title: "Routes", icon: "globe", el: routesView });
bottom.add({ id: "log", title: "LSP Log", icon: "output", el: lspLogView });
bottom.hide();
setupResizers();

/// Commands

const needProject = (fn: () => unknown) => () => (state.project ? fn() : toast("Open a folder first."));

function goToFile() {
  if (!state.project) return openFolder();
  quickPick({
    placeholder: "Go to file (fuzzy, e.g. usrctl for users_controller.rb)",
    items: async (q) =>
      (await api.findFiles(q, 80)).map((p) => ({ label: p.split("/").pop()!, description: p.split("/").slice(0, -1).join("/"), icon: "file", data: p })),
    onAccept: (item, q) => {
      if (!item) return;
      const line = q.match(/:(\d+)$/)?.[1];
      openFile(abs(item.data as string), line ? { line: Number(line) } : undefined);
    },
  });
}

function editorAction(id: string) {
  return () => editor.getAction(id)?.run();
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

function pickPaths(placeholder: string, paths: string[], selectedIndex = 0) {
  quickPick({
    placeholder,
    selected: selectedIndex,
    items: paths.map((p) => ({ label: p.split("/").pop()!, description: rel(p), icon: "file", data: p })),
    onAccept: (item) => item && openFile(item.data as string),
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
  quickPick({
    placeholder: "Search everywhere: files, actions, symbols",
    items: async (q): Promise<PickItem[]> => {
      if (!q.trim()) return recentFileList().slice(0, 20).map((p) => ({ label: p.split("/").pop()!, description: rel(p), icon: "file", data: { file: p } }));
      const [files, symbols] = await Promise.all([
        api.findFiles(q, 30),
        lspReady() ? request<Json[] | null>("workspace/symbol", { query: q }).catch(() => null) : Promise.resolve(null),
      ]);
      const actions = allCommands()
        .map((c) => ({ c, s: fuzzyScore(q, c.title) }))
        .filter((x) => x.s !== null)
        .sort((a, b) => b.s! - a.s!)
        .slice(0, 8);
      return [
        ...files.map((p) => ({ label: p.split("/").pop()!, description: p, icon: "file", data: { file: abs(p) } })),
        ...(symbols ?? []).slice(0, 30).map((s) => ({ label: s.name, description: s.containerName ?? "", detail: rel(monaco.Uri.parse(s.location.uri).fsPath), icon: "symbol-class", data: { loc: s.location } })),
        ...actions.map(({ c }) => ({ label: c.title, detail: keyLabel(c), icon: "zap", data: { cmd: c.id } })),
      ];
    },
    onAccept: (item, q) => {
      const d = item?.data as { file?: string; loc?: Json; cmd?: string } | undefined;
      if (!d) return;
      const line = q.match(/:(\d+)$/)?.[1];
      if (d.file) openFile(d.file, line ? { line: Number(line) } : undefined);
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

let hidden: { side: string | null; bottom: string | null } | null = null;
function hideAll() {
  if (hidden && !sidebar.active && !bottom.active) {
    if (hidden.side) sidebar.show(hidden.side);
    if (hidden.bottom) bottom.show(hidden.bottom);
    hidden = null;
    return;
  }
  hidden = { side: sidebar.active, bottom: bottom.active };
  sidebar.hide();
  bottom.hide();
}

async function importKeymap() {
  const file = await open({ title: "Import JetBrains Keymap", filters: [{ name: "Keymap XML", extensions: ["xml"] }] });
  if (typeof file !== "string") return;
  try {
    await importJetBrainsKeymap(await api.readFile(file));
  } catch (e) {
    toast(`Import failed: ${e instanceof Error ? e.message : e}`, "error");
  }
}

commands(
  { id: "openFolder", title: "File: Open Folder…", run: openFolder },
  { id: "openRecent", title: "File: Open Recent Project…", run: openRecent },
  { id: "projects", title: "File: Switch Project…", run: showProjects },
  { id: "save", title: "File: Save", key: "cmd+s", run: saveActive },
  { id: "saveAll", title: "File: Save All", key: "cmd+alt+s", run: saveAll },
  { id: "closeTab", title: "File: Close Tab", key: "cmd+w", run: closeActive },
  { id: "nextTab", title: "Window: Select Next Tab", key: "cmd+shift+]", run: () => cycleTab(1) },
  { id: "prevTab", title: "Window: Select Previous Tab", key: "cmd+shift+[", run: () => cycleTab(-1) },
  { id: "switcher", title: "Window: Switcher", key: "ctrl+tab", run: () => pickPaths("Switch to file", recentFileList(), 1) },
  { id: "hideAll", title: "Window: Hide All Tool Windows", key: "cmd+shift+f12", run: hideAll },
  { id: "settings", title: "Preferences: Settings…", key: "cmd+,", run: () => openSettingsWindow() },
  { id: "toggleTheme", title: "View: Toggle Theme (Light/Dark)", run: toggleTheme },
  { id: "settingsJson", title: "Preferences: Open Settings (JSON)", run: async () => openFile(await settingsPath()) },
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
  { id: "goToTypeDefinition", title: "Navigate: Go to Type Declaration", key: "ctrl+shift+b", run: goToTypeDefinition },
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
  E("moveLineUp", "Code: Move Line Up", "cmd+shift+up", "editor.action.moveLinesUpAction"),
  E("moveLineDown", "Code: Move Line Down", "cmd+shift+down", "editor.action.moveLinesDownAction"),
  { id: "projectView", title: "View: Project", key: "cmd+1", run: () => sidebar.toggle("project") },
  { id: "findView", title: "View: Find", key: "cmd+3", run: () => bottom.toggle("find") },
  { id: "runView", title: "View: Run", key: "cmd+4", run: () => bottom.toggle("run") },
  { id: "debugView", title: "View: Debug", key: "cmd+5", run: () => bottom.toggle("debug") },
  { id: "problemsView", title: "View: Problems", key: "cmd+6", run: () => bottom.toggle("problems") },
  { id: "structureView", title: "View: Structure", key: "cmd+7", run: () => sidebar.toggle("structure") },
  { id: "commitView", title: "VCS: Commit…", key: "cmd+k cmd+0", run: needProject(() => sidebar.show("commit")) },
  { id: "terminalView", title: "View: Terminal", key: "alt+f12", run: needProject(() => bottom.toggle("terminal")) },
  { id: "newTerminal", title: "Terminal: New Terminal Tab", run: needProject(() => (bottom.show("terminal"), newTerminal())) },
  { id: "routesView", title: "Rails: Routes", run: needProject(() => (bottom.show("routes"), loadRoutes())) },
  { id: "hidePanels", title: "View: Hide Active Tool Window", key: "shift+escape", run: () => bottom.hide() },
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
  { id: "attach", title: "Run: Attach to Process (rdbg port/socket)…", run: needProject(attachToProcess) },
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
  { id: "gitLogView", title: "View: Git (Log)", key: "cmd+9", run: needProject(() => bottom.toggle("gitlog")) },
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
  const keys: [string, string][] = [
    ["Go to File", "⇧⇧  or  ⌘⇧O"],
    ["Find in Files", "⌘⇧F"],
    ["All Commands", "⌘⇧P"],
    ["Related Files", "⌃⌘↑"],
    ["Run / Debug configuration", "⌃R / ⌃D"],
    ["Run Test at Cursor", "⌃⇧R"],
    ["Terminal", "⌥F12"],
  ];
  if (state.project) {
    welcome.replaceChildren(
      h("div", { class: "welcome-inner" }, h("div", { class: "welcome-title" }, state.project.name), ...keys.map(([a, k]) => h("div", { class: "welcome-key" }, h("span", {}, a), h("kbd", {}, k)))),
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
      recent.length ? h("div", { class: "welcome-recent-title" }, "Recent projects") : null,
      ...recent.map((p) => h("div", { class: "welcome-recent", onclick: () => openProject(p) }, h("span", {}, p.split("/").pop()!), h("span", { class: "dim" }, p))),
    ),
  );
}

/// Project lifecycle

const persistSession = debounce(() => {
  if (!state.project) return;
  const tabs = allTabs().filter((t) => t.kind === "file");
  saveSession(state.project.root, { tabs: tabs.map((t) => t.path), active: activeTab()?.path, expanded: expandedPaths(), bottom: bottom.active });
}, 500);

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
  if (smoke && !(await checkTrust(info.root))) await trustProject(info.root, true);
  await Promise.all([loadSettings(info.root), loadCodeStyle(info.root), checkTrust(info.root)]);
  document.body.classList.add("has-project");
  getCurrentWindow().setTitle(`${info.name} — Garnet`).catch(() => {});
  addRecentProject(info.root);
  sidebar.show("project");
  await loadBreakpoints();
  const session = await loadSession(info.root);
  await initTree(session?.expanded ?? []);
  renderWelcome();
  refreshGit();
  refreshToolbar();
  if (isTrusted()) {
    loadRunConfigs();
    if (setting("ruby.lspEnabled")) startLsp();
  } else if (!(await askTrust())) loadRunConfigs();
  if (isTrusted() && session?.bottom && setting("appearance.restoreBottomPanel")) bottom.show(session.bottom);
  for (const p of session?.tabs ?? []) await openFile(p).catch(() => {});
  if (session?.active) await openFile(session.active).catch(() => {});
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
const indexSlot = statusSlot("index", "left");
listen<{ count: number; ms: number }>("index-ready", (e) => {
  indexSlot.textContent = `${e.payload.count.toLocaleString()} files indexed`;
  indexSlot.title = `Indexed in ${e.payload.ms} ms`;
});
listen<string>("menu", (e) => runCommand(e.payload));
window.addEventListener("garnet:trusted", () => {
  refreshToolbar();
  loadRunConfigs();
  if (setting("ruby.lspEnabled")) startLsp();
});

/// Boot

async function boot() {
  installKeyHandler();
  initToolbar(switchProject);
  await loadSettings();
  const smoke = await invoke<[string, boolean] | null>("smoke_target");
  const pending = smoke ? null : new URLSearchParams(location.search).get(PENDING_ROOT);
  const initial = pending ?? (await api.initialPath());
  if (smoke && initial) {
    const { runSmoke } = await import("./smoke");
    return runSmoke(initial, smoke[1], openProject);
  }
  if (initial) await openProject(initial);
  else renderWelcome();
}

window.addEventListener("beforeunload", () => persistSession());
boot();

