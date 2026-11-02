// End-to-end smoke run: GARNET_SMOKE=<report.json> Garnet.app/Contents/MacOS/garnet <rails-project>
// Exercises the real UI code paths, measures performance budgets, writes a JSON report and quits.
import { listen } from "@tauri-apps/api/event";
import { allCommands, keymap, runCommand } from "./commands";
import { importJetBrainsKeymap, jetbrainsKeystroke } from "./keymapref";
import { breakpointsIn, debugSessions, debugState, evaluate, flushBreakpoints, loadBreakpoints, resume, resumeSession, selectDebugSession, smokeHooks, stopAllSessions, stopDebug, toggleBreakpoint } from "./debug";
import { rerunFailed, testRunState, testStatusAt } from "./testresults";
import { defaultDocker } from "./docker";
import { activeTab, allTabs, closeTab, editor, languageFor, openFile } from "./editor";
import { symbolPath } from "./breadcrumbs";
import { snippetsFor } from "./languages/snippets";
import { replaceInFiles, searchView } from "./search";
import { decodeTokens, ruleFor, SEMANTIC_RULES } from "./semantic";
import { commitView, gutterHunks, refreshGit, updateGutterNow } from "./git";
import { logState, showGitLog } from "./gitlog";
import { continueOperation, openResolver, runGitOp } from "./merge";
import { stagePatch } from "./difflogic";
import { api, Channel, invoke, type PtyEvent } from "./ipc";
import { cachedSymbols, goToImplementation, lspCapabilities, lspReady, request } from "./lsp";
import { buildCommand, configList, dockerUnavailable, editConfigurations, launch, newConfig, runs, safeEnv, validateConfig, type RunConfig } from "./run";
import { isDarkTheme, isTrusted, loadSettings, setting, toggleTheme, updateSetting } from "./settings";
import { openSettingsWindow } from "./settingsui";
import { refreshToolbar } from "./toolbar";
import { monaco } from "./editor";
import { shellQuote, state } from "./state";
import { dbSmokeHooks } from "./db";
import { runRailsGenerator } from "./generators";
import { loadMigrations } from "./migrations";
import { railsTreeEl, refreshRailsTree } from "./railsview";
import { toggleRailsView } from "./tree";
import { gh, refreshAccount, signIn } from "./github";
import { bottom, rightbar } from "./ui";

type Report = Record<string, unknown> & { checks: Record<string, boolean | string> };

let substep = (_: string) => {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | Promise<T>, timeoutMs: number, everyMs = 100): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  return null;
}

export async function runSmoke(project: string, withDebug: boolean, openProject: (p: string) => Promise<void>) {
  const report: Report = { checks: {} };
  let current = "startup";
  const save = (log = "") => void invoke("smoke_progress", { report: JSON.stringify({ ...report, step: current }, null, 2), step: log }).catch(() => {});
  const check = (name: string, ok: boolean | string) => ((report.checks[name] = ok), save(ok === true ? "" : `  FAIL ${name}`));
  const step = (name: string) => ((current = name), save(name));
  substep = (name: string) => step(`${current.split(" › ")[0]} › ${name}`);
  try {
    step("open project");
    let indexMs = -1;
    const indexStart = performance.now();
    const indexReady = new Promise<void>((resolve) =>
      listen<{ count: number; ms: number }>("index-ready", (e) => {
        indexMs = performance.now() - indexStart;
        report.indexFiles = e.payload.count;
        report.indexBackendMs = e.payload.ms;
        resolve();
      }),
    );
    const t0 = performance.now();
    const projectOpened = openProject(project);
    await until(() => document.querySelectorAll(".tree-row").length > 1, 5000, 5);
    report.treeVisibleMs = Math.round(performance.now() - t0);
    report.coldStartToUsableMs = await invoke<number>("uptime_ms");
    await projectOpened;
    report.root = state.project?.root;
    if (state.project?.root !== project.replace(/\/$/, "")) throw new Error(`refusing to continue: opened ${state.project?.root}, expected ${project}`);
    report.webviewMsBeforeSmoke = Math.round(t0);
    await Promise.race([indexReady, sleep(10000)]);
    report.indexReadyMs = Math.round(indexMs);

    step("go to file and find in files");
    const goto: number[] = [];
    let hits: string[] = [];
    for (const q of ["p", "po", "pos", "post", "postsc", "postscontroller"]) {
      const s = performance.now();
      hits = await api.findFiles(q, 80);
      goto.push(Math.round((performance.now() - s) * 10) / 10);
    }
    report.goToFileMsPerKeystroke = goto;
    check("goToFile finds posts_controller", hits.some((h) => h.endsWith("posts_controller.rb")));

    const searchMs = await new Promise<number>((resolve) => {
      const s = performance.now();
      const ch = new Channel<{ type: string; total?: number }>();
      ch.onmessage = (ev) => {
        if (ev.type === "done") {
          report.findInFilesMatches = ev.total;
          resolve(Math.round(performance.now() - s));
        }
      };
      invoke("search_text", { opts: { query: "def ", regex: false, caseSensitive: true, wholeWord: false, include: null }, onEvent: ch });
    });
    report.findInFilesMs = searchMs;

    step("editor typing");
    const controller = `${state.project!.root}/app/controllers/posts_controller.rb`;
    await openFile(controller);
    const model = editor.getModel()!;
    check("editor opened controller", model?.uri.fsPath === controller);
    if (model?.uri.fsPath !== controller) throw new Error("controller not open; stopping before any edits");

    const typed = 300;
    const ts = performance.now();
    editor.setPosition({ lineNumber: model.getLineCount(), column: 1 });
    for (let i = 0; i < typed; i++) editor.trigger("keyboard", "type", { text: i % 40 === 39 ? "\n" : "x" });
    report.typingSyncMsPerKeystroke = Math.round(((performance.now() - ts) / typed) * 1000) / 1000;
    while (model.getAlternativeVersionId() !== 1 && model.canUndo()) model.undo();

    step("terminal");
    const term = await new Promise<string>((resolve) => {
      let buf = "";
      const ch = new Channel<PtyEvent>();
      ch.onmessage = (ev) => {
        if (ev.type === "data") buf += ev.data;
        else resolve(buf);
      };
      invoke("pty_spawn", { cwd: state.project!.root, command: "ruby -e 'puts RUBY_VERSION'", env: null, cols: 80, rows: 24, onEvent: ch });
      setTimeout(() => resolve(buf), 20000);
    });
    check("pty login shell runs ruby", /\d+\.\d+\.\d+/.test(term) || term.slice(-200));

    step("git status");
    await refreshGit();
    check("git status", (await api.gitBranch(state.project!.root).catch((e) => String(e))) !== "");

    step("ruby-lsp");
    const lspStart = performance.now();
    const ok = await until(() => lspReady(), 90000, 200);
    report.lspReadyMs = ok ? Math.round(performance.now() - lspStart) : -1;
    check("ruby-lsp initialized", !!ok);
    if (ok) {
      const uri = model.uri.toString();
      const symbols = await request<any[]>("textDocument/documentSymbol", { textDocument: { uri } }).catch(() => []);
      check("lsp document symbols", (symbols ?? []).some((s) => s.name === "PostsController"));
      const line = model.findMatches("Post.all", false, false, true, null, false)[0]?.range;
      if (line) {
        const position = { line: line.startLineNumber - 1, character: line.startColumn };
        const def = await until(async () => {
          const r = await request<any>("textDocument/definition", { textDocument: { uri }, position }).catch(() => null);
          return JSON.stringify(r ?? "").includes("post.rb") ? r : null;
        }, 60000, 1000);
        const hover = await request<any>("textDocument/hover", { textDocument: { uri }, position }).catch(() => null);
        check("lsp hover on Post", !!hover?.contents);
        check("lsp definition of Post -> app/models/post.rb", JSON.stringify(def ?? "").includes("app/models/post.rb"));
      }
      const fmt = await request<any[]>("textDocument/formatting", { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } }).catch((e) => String(e));
      check("lsp formatting responds", Array.isArray(fmt) || fmt === null || String(fmt));
    }

    step("settings and UI");
    await uiChecks(check);
    step("editor features");
    await editorFeatureChecks(check, !!ok);
    step("git tools");
    await gitChecks(controller, check);
    step("breakpoints");
    const bpRestored = await breakpointChecks(check);
    step("test tree");
    await testTreeChecks(report, check);
    step("database");
    await databaseChecks(report, check);
    step("rails tools");
    await railsToolChecks(report, check);
    step("github (read-only)");
    await githubChecks(report, check);
    step("docker");
    await dockerChecks(report, check);
    if (withDebug) {
      step("debug: rails request");
      await debugRailsRequest(report, controller, check);
      step("debug: two sessions");
      await twoDebugSessions(report, check);
    }
    check("breakpoint survives an app restart", bpRestored);
  } catch (e) {
    check("exception", String(e));
  }
  await invoke("smoke_finish", { report: JSON.stringify(report, null, 2) });
}

async function debugRailsRequest(report: Report, controller: string, check: (n: string, ok: boolean | string) => void) {
  await openFile(controller);
  const model = editor.getModel()!;
  const bpLine = model.findMatches("@posts = Post.all", false, false, true, null, false)[0]?.range.startLineNumber;
  if (!bpLine) return check("debug: breakpoint line found", false);
  if (!breakpointsIn(controller).some((b) => b.line === bpLine)) toggleBreakpoint(bpLine);
  const port = await api.freePort();
  const cfg = newConfig("rails-server", "Rails server", `-p ${port}`);
  report.debugCommand = buildCommand(cfg, { debug: { port: 0 } });
  const connected = new Promise<void>((r) => (smokeHooks.connected = () => r()));
  const started = performance.now();
  launch(cfg, "debug");
  await Promise.race([connected, sleep(120000)]);
  report.debugConnectMs = Math.round(performance.now() - started);
  const curl = api.runCapture(
    state.project!.root,
    `for i in $(seq 1 120); do code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/posts) && [ "$code" != "000" ] && echo $code && exit 0; sleep 0.5; done; echo timeout`,
    180,
  );
  const paused = await until(() => debugState().paused && debugState().frame, 120000, 200);
  report.debugPausedAt = paused;
  check("debug: request paused at controller breakpoint", !!paused && paused.path === controller && paused.line === bpLine);
  if (paused) {
    await until(() => debugState().variables.includes("self"), 5000);
    report.debugVariables = debugState().variables.slice(0, 300);
    const ev = await evaluate("params[:controller]").catch((e) => ({ result: String(e) }));
    check("debug: evaluate in frame", ev?.result === '"posts"' || String(ev?.result));
    resume();
  }
  const code = await curl.catch((e) => String(e));
  check("debug: request completed after resume (HTTP 200)", code.trim() === "200" || code.trim());
  await stopDebug();
  await sleep(1500);
}

async function uiChecks(check: (n: string, ok: boolean | string) => void) {
  const overlay = document.getElementById("overlay-root")!;
  openSettingsWindow();
  check("settings window renders pages", overlay.querySelectorAll(".st-node").length > 10);
  [...overlay.querySelectorAll<HTMLElement>(".st-node")].find((n) => n.textContent === "Keymap")?.click();
  check("keymap page lists actions", overlay.querySelectorAll(".st-key-row").length > 40);
  overlay.replaceChildren();
  const km = keymap();
  const expect: Record<string, string> = { "cmd+shift+r": "replaceInFiles", "cmd+alt+b": "goToImplementation", "cmd+shift+b": "goToTypeDefinition", "alt+f12": "terminalView", "cmd+s": "saveAll", "cmd+e": "recentFiles", "cmd+o": "goToClass", "cmd+shift+o": "goToFile", "ctrl+r": "runSelected", "ctrl+d": "debugSelected", "cmd+shift+k": "push", "cmd+[": "back", "cmd+shift+f8": "viewBreakpoints", "alt+f8": "evaluate", "cmd+shift+a": "commandPalette" };
  check("JetBrains default keymap", Object.entries(expect).every(([k, id]) => km.get(k) === id) || JSON.stringify(Object.entries(expect).filter(([k, id]) => km.get(k) !== id)));
  const shadowed = allCommands().flatMap((c) => (c.key ?? "").split(" ").filter(Boolean).filter((k) => km.get(k) !== c.id).map((k) => `${k}:${c.id}`));
  check("no conflicting default shortcuts", shadowed.length === 0 || shadowed.join(","));
  check("JetBrains keystroke parse", jetbrainsKeystroke("meta shift O") === "cmd+shift+o" && jetbrainsKeystroke("control alt UP") === "ctrl+alt+up");
  const prevBindings = setting<Record<string, string>>("keymap.bindings");
  const prevRemoved = setting<string[]>("keymap.removed");
  await importJetBrainsKeymap('<keymap version="1" name="Mine" parent="Mac OS X 10.5+"><action id="RecentFiles"><keyboard-shortcut first-keystroke="meta alt E"/></action></keymap>');
  check("JetBrains keymap import", keymap().get("cmd+alt+e") === "recentFiles" && !keymap().has("cmd+e"));
  await updateSetting("keymap.bindings", prevBindings && Object.keys(prevBindings).length ? prevBindings : undefined);
  await updateSetting("keymap.removed", prevRemoved?.length ? prevRemoved : undefined);
  check("keymap restored after import", keymap().get("cmd+e") === "recentFiles");
  check("smoke project trusted", isTrusted());
  const projSettings = `${state.project!.root}/.garnet/settings.json`;
  const prevProj = await api.readFile(projSettings).catch(() => null);
  await api.writeFile(projSettings, JSON.stringify({ "ruby.lspCommand": "touch /tmp/pwned", "git.path": "./evil", "terminal.env": { A: "1" }, "editor.tabSize": 3 }));
  await loadSettings(state.project!.root);
  check("project settings cannot set global-only keys", setting("ruby.lspCommand") !== "touch /tmp/pwned" && setting("git.path") !== "./evil" && setting("editor.tabSize") === 3);
  if (prevProj === null) await api.deletePath(projSettings);
  else await api.writeFile(projSettings, prevProj);
  await loadSettings(state.project!.root);
  check("run.json validation", validateConfig({ name: "x", type: "rspec", args: ["rm"] }) === null && validateConfig({ name: "x", type: "evil" }) === null && validateConfig({ name: "ok", type: "rspec", env: { PATH: "/tmp", RUBYOPT: "-r/tmp/x", DYLD_INSERT_LIBRARIES: "x", FOO: "1" } })?.env.FOO === "1");
  check("blocked env overrides", JSON.stringify(safeEnv({ PATH: "x", BASH_ENV: "x", ENV: "x", LD_PRELOAD: "x", KEEP: "1" }, "smoke")) === '{"KEEP":"1"}');
  await invoke("git_set_trusted", { trusted: false });
  check("git refuses to run while untrusted", await invoke("git_run", { root: state.project!.root, args: ["status"] }).then(() => false, (e) => String(e).includes("Trust project")));
  await invoke("git_set_trusted", { trusted: true });
  check("git.path rejects relative path", await invoke("git_set_path", { path: "./git" }).then(() => false, () => true));
  await invoke("git_set_path", { path: setting<string>("git.path") });
  const before = setting<number>("editor.fontSize");
  await updateSetting("editor.fontSize", 17, "project");
  check("project setting applies to editor", editor.getOption(monaco.editor.EditorOption.fontSize) === 17);
  await updateSetting("editor.fontSize", undefined, "project");
  check("project setting reset", editor.getOption(monaco.editor.EditorOption.fontSize) === before);
  const names = configList().map((c) => c.name);
  check("default run configurations", names.includes("Rails server") && names.includes("Rails console") || names.join(","));
  const stored = JSON.parse((await api.configRead("run-configs.json")) ?? "{}")[state.project!.root];
  const sharedNames = configList().filter((c) => c.shared).map((c) => c.name);
  check("run configurations stored in Garnet's config dir", (stored?.configurations.length ?? 0) + sharedNames.length === names.length || JSON.stringify({ stored, sharedNames, names }));
  editConfigurations();
  check("run configuration dialog lists configs", overlay.querySelectorAll(".rc-item").length === names.length);
  check("run configuration dialog offers Store as project file", [...overlay.querySelectorAll(".rc-check")].some((l) => l.textContent?.includes("Store as project file")));
  overlay.replaceChildren();
  const prevTheme = setting<string>("appearance.theme");
  const wasDark = isDarkTheme();
  await toggleTheme();
  const monacoDark = () => document.querySelector(".monaco-editor")?.classList.contains("vs-dark");
  check("toggle theme switches chrome and editor live", isDarkTheme() === !wasDark && monacoDark() === !wasDark && setting("appearance.theme") === (wasDark ? "light" : "dark"));
  await toggleTheme();
  check("toggle theme back", isDarkTheme() === wasDark && monacoDark() === wasDark);
  await updateSetting("appearance.theme", prevTheme === "system" ? undefined : prevTheme);
  await refreshToolbar();
  const worktreeLabel = document.querySelector<HTMLElement>('#switchers [title="Git worktrees"]');
  check("worktree switcher shows the current worktree name", !!worktreeLabel && !worktreeLabel.hidden && !/\d+ worktrees/.test(worktreeLabel.textContent ?? "") && (worktreeLabel.textContent ?? "").length > 0);
  const branch = (await invoke<string>("git_run", { root: state.project!.root, args: ["rev-parse", "--abbrev-ref", "HEAD"] })).trim();
  check("toolbar shows current branch", document.getElementById("switchers")!.textContent!.includes(branch));
  await invoke("git_run", { root: state.project!.root, args: ["branch", "garnet-smoke"] });
  const listed = await invoke<string>("git_run", { root: state.project!.root, args: ["branch", "--list", "garnet-smoke"] });
  await invoke("git_run", { root: state.project!.root, args: ["branch", "-D", "garnet-smoke"] });
  check("git_run branch create/delete", listed.includes("garnet-smoke"));
}

async function editorFeatureChecks(check: (n: string, ok: boolean | string) => void, lsp: boolean) {
  const root = state.project!.root;
  const overlay = document.getElementById("overlay-root")!;
  openSettingsWindow("Editor/General");
  const settingsText = overlay.textContent ?? "";
  const missing = ["breadcrumbs", "Semantic highlighting", "Inlay hints", "Live templates"].filter((t) => !settingsText.includes(t));
  check("settings list breadcrumbs/semantic/inlay/templates toggles", missing.length === 0 || missing.join(","));
  overlay.replaceChildren();

  // Templates: HAML / Slim tokenization and snippets
  const kinds = (text: string, lang: string) => monaco.editor.tokenize(text, lang).flat().map((t) => t.type);
  const haml = kinds("%p.title{ class: \"x\" }= @post.title\n-# note\n", "haml");
  check("HAML tokens (tag, class, hash, ruby, comment)", ["tag.haml", "attribute.name.haml", "key.haml", "metatag.haml", "comment.haml"].every((t) => haml.includes(t)) && haml.some((t) => t.endsWith(".ruby")) || haml.join(","));
  const slim = kinds("a.btn href=post_path(@post) Show #{@post.title}\n= link_to \"x\", y\n", "slim");
  check("Slim tokens (tag, attr, interpolation, ruby)", ["tag.slim", "attribute.name.slim", "delimiter.interpolation.slim", "variable.instance.slim", "metatag.slim"].every((t) => slim.includes(t)) && slim.some((t) => t.endsWith(".ruby")) || slim.join(","));
  check("languageFor haml/slim", languageFor(`${root}/app/views/a.html.haml`) === "haml" && languageFor(`${root}/app/views/a.html.slim`) === "slim");
  check("snippets per file type", snippetsFor("ruby", "spec/a_spec.rb").some((s) => s.prefix === "describe") && !snippetsFor("ruby", "app/a.rb").some((s) => s.prefix === "describe") && snippetsFor("erb", "a.erb").some((s) => s.body === "<%= $0 %>"));

  // Replace in Files: regex groups, per-match exclusion, open buffer edited with undo, gitignored files skipped
  const fileA = `${root}/app/models/garnet_replace_smoke_a.rb`;
  const fileB = `${root}/app/models/garnet_replace_smoke_b.rb`;
  const ignored = `${root}/tmp/garnet_replace_smoke_c.rb`;
  const body = "garnet_smoke_user_id = garnet_smoke_post_id\n";
  for (const f of [fileA, fileB, ignored]) await api.writeFile(f, body);
  try {
    await openFile(fileA);
    const modelA = editor.getModel()!;
    replaceInFiles();
    const inputs = searchView.querySelectorAll<HTMLInputElement>(".search-input");
    const [q, rep] = [inputs[0], inputs[1]];
    const regexBtn = searchView.querySelector<HTMLElement>('[title="Regular expression"]')!;
    if (!regexBtn.classList.contains("on")) regexBtn.classList.add("on");
    q.value = "garnet_smoke_(\\w+)_id";
    rep.value = "smoke${1}Id";
    rep.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    const groups = await until(() => {
      const g = [...searchView.querySelectorAll<HTMLElement>(".result-group")];
      return g.length >= 2 && searchView.querySelector(".search-summary")?.textContent?.includes("ms") ? g : null;
    }, 10000);
    const names = (groups ?? []).map((g) => g.querySelector(".result-name")?.textContent);
    check("replace preview lists matches, skips .gitignored", names.includes("garnet_replace_smoke_a.rb") && names.includes("garnet_replace_smoke_b.rb") && !names.includes("garnet_replace_smoke_c.rb") || names.join(","));
    const ins = [...searchView.querySelectorAll(".rep-match ins")].map((e) => e.textContent);
    check("replace preview expands regex groups", ins.includes("smokeuserId") && ins.includes("smokepostId") || ins.join(","));
    const groupB = groups?.find((g) => g.querySelector(".result-name")?.textContent === "garnet_replace_smoke_b.rb");
    groupB?.querySelectorAll<HTMLElement>(".rep-match")[1]?.click();
    [...searchView.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Replace Selected")!.click();
    const onDisk = await until(async () => {
      const t = await api.readFile(fileB);
      return t !== body ? t : null;
    }, 5000);
    check("replace selected writes unopened file, keeps excluded match", onDisk === "smokeuserId = garnet_smoke_post_id\n" || String(onDisk));
    check("replace edits open buffer, not disk", modelA.getValue() === "smokeuserId = smokepostId\n" && (await api.readFile(fileA)) === body || modelA.getValue());
    modelA.undo();
    check("replace in open buffer is undoable", modelA.getValue() === body || modelA.getValue());
    for (const t of allTabs().filter((t) => t.path === fileA)) await closeTab(t, true);
  } finally {
    for (const f of [fileA, fileB, ignored]) await api.deletePath(f).catch(() => {});
  }
  clearToasts();

  if (!lsp) return;
  const caps = lspCapabilities();
  const controller = `${root}/app/controllers/posts_controller.rb`;
  await openFile(controller);
  const model = editor.getModel()!;
  const idx = model.findMatches("def index", false, false, true, null, false)[0]?.range;
  if (idx) {
    editor.setPosition({ lineNumber: idx.startLineNumber + 1, column: 3 });
    const path = symbolPath(await cachedSymbols(model), idx.startLineNumber + 1, 3).map((s) => s.name);
    check("breadcrumb symbol path", path.join(">") === "PostsController>index" || path.join(">"));
    const bar = await until(() => {
      const el = document.querySelector<HTMLElement>(".breadcrumbs");
      return el && !el.hidden && el.textContent?.includes("index") ? el : null;
    }, 5000);
    check("breadcrumbs bar shows class and method", !!bar && bar.textContent!.includes("PostsController") && bar.textContent!.includes("posts_controller.rb") || String(bar?.textContent));
    editor.setPosition({ lineNumber: model.getLineCount(), column: 1 });
    [...(bar?.querySelectorAll<HTMLElement>(".crumb") ?? [])].find((c) => c.textContent === "index")?.click();
    check("breadcrumb click jumps to symbol", editor.getPosition()?.lineNumber === idx.startLineNumber);
  }

  const legend = caps.semanticTokensProvider?.legend;
  check("semantic tokens provider with legend", !!legend);
  if (legend) {
    const res = await request<any>("textDocument/semanticTokens/full", { textDocument: { uri: model.uri.toString() } }).catch(() => null);
    const tokens = decodeTokens(res?.data ?? [], legend);
    const types = [...new Set(tokens.map((t) => t.type))];
    check("semantic tokens decoded", tokens.length > 0 && types.length > 0 || JSON.stringify(res).slice(0, 200));
    const unstyled = types.filter((t) => !ruleFor(t, [], SEMANTIC_RULES.dark) || !ruleFor(t, [], SEMANTIC_RULES.light));
    check("every semantic token type has dark and light colors", unstyled.length === 0 || unstyled.join(","));
    check("semantic highlighting enabled in editor", (editor.getRawOptions() as Record<string, unknown>)["semanticHighlighting.enabled"] === true);
  }

  check("inlay hint provider", !!caps.inlayHintProvider);
  const hintsFile = `${root}/app/models/garnet_hints_smoke.rb`;
  await api.writeFile(hintsFile, "class GarnetHintsSmoke\n  def run\n    work\n  rescue\n    nil\n  end\nend\n");
  try {
    await openFile(hintsFile);
    const hm = editor.getModel()!;
    const hints = await until(async () => {
      const r = await request<any[]>("textDocument/inlayHint", { textDocument: { uri: hm.uri.toString() }, range: { start: { line: 0, character: 0 }, end: { line: 7, character: 0 } } }).catch(() => null);
      return r?.length ? r : null;
    }, 10000, 500);
    check("inlay hint for implicit rescue", JSON.stringify(hints ?? "").includes("StandardError") || JSON.stringify(hints));
    for (const t of allTabs().filter((t) => t.path === hintsFile)) await closeTab(t, true);
  } finally {
    await api.deletePath(hintsFile).catch(() => {});
  }

  const base = `${root}/app/models/application_record.rb`;
  await openFile(base);
  const bm = editor.getModel()!;
  const at = bm.findMatches("ApplicationRecord", false, false, true, null, false)[0]?.range;
  if (at) {
    editor.setPosition({ lineNumber: at.startLineNumber, column: at.startColumn + 2 });
    const landed = await until(async () => {
      await goToImplementation();
      await sleep(300);
      document.querySelector<HTMLElement>(".qp-backdrop")?.remove();
      return activeTab()?.path.endsWith("app/models/post.rb") ? true : (await openFile(base), editor.setPosition({ lineNumber: at.startLineNumber, column: at.startColumn + 2 }), null);
    }, 60000, 1000);
    check("go to implementation: ApplicationRecord -> Post", !!landed);
  }
}

function clearToasts() {
  document.querySelector<HTMLElement>(".toasts")?.replaceChildren();
}

const SMOKE_SCRIPT = "lib/smoke_debug.rb";
const SMOKE_BP_LINE = 5;

/// Breakpoints follow edits, persist in Garnet's state dir and reload; the one left at SMOKE_BP_LINE is checked by the next run.
async function breakpointChecks(check: (n: string, ok: boolean | string) => void): Promise<boolean | string> {
  const path = `${state.project!.root}/${SMOKE_SCRIPT}`;
  const restored = breakpointsIn(path).some((b) => b.line === SMOKE_BP_LINE && b.enabled);
  await openFile(path);
  const model = editor.getModel()!;
  if (!restored) toggleBreakpoint(SMOKE_BP_LINE);
  check("breakpoint set", breakpointsIn(path).some((b) => b.line === SMOKE_BP_LINE));
  model.pushEditOperations([], [{ range: new monaco.Range(1, 1, 1, 1), text: "# moved\n# twice\n" }], () => null);
  check("breakpoint follows inserted lines", breakpointsIn(path).some((b) => b.line === SMOKE_BP_LINE + 2) || JSON.stringify(breakpointsIn(path)));
  while (model.canUndo() && model.getAlternativeVersionId() !== 1) model.undo();
  check("breakpoint moves back on undo", breakpointsIn(path).some((b) => b.line === SMOKE_BP_LINE) || JSON.stringify(breakpointsIn(path)));
  await flushBreakpoints();
  const stored = (await api.configRead("breakpoints.json")) ?? "";
  check("breakpoints stored in Garnet's state dir, not the repo", stored.includes(SMOKE_SCRIPT) && !(await api.readFile(`${state.project!.root}/.garnet/breakpoints.json`).then(() => true, () => false)));
  await loadBreakpoints();
  check("breakpoints reload from disk", breakpointsIn(path).some((b) => b.line === SMOKE_BP_LINE && b.enabled));
  return restored || "first run: rerun the smoke to verify";
}

async function runToEnd(cfg: RunConfig, mode: "run" | "debug" = "run") {
  const before = testRunState()?.id;
  launch(cfg, mode);
  const started = await until(() => testRunState()?.id !== before && testRunState(), 30000);
  if (!started) return null;
  return until(() => (testRunState()?.exited ? testRunState() : null), 180000, 200);
}

async function testTreeChecks(report: Report, check: (n: string, ok: boolean | string) => void) {
  const root = state.project!.root;
  const spec = `${root}/spec/calc_spec.rb`;
  const rspec = { ...newConfig("rspec", "Smoke specs", "spec/calc_spec.rb"), bundler: false };
  substep("rspec");
  const r = await runToEnd(rspec);
  report.rspecTree = r && { counts: r.counts, rows: r.rows, progress: r.progressWidth };
  check("rspec tree: 1 passed, 1 failed, 1 pending", !!r && r.counts.passed === 1 && r.counts.failed === 1 && r.counts.pending === 1 || JSON.stringify(r?.counts ?? null));
  check("rspec tree rows (file, groups, examples)", (r?.rows ?? 0) >= 5 || String(r?.rows));
  const failed = r?.results.find((x) => x.status === "failed");
  check("rspec failure message and backtrace", !!failed?.message?.includes("expected: 5") && !!failed.backtrace?.some((l) => l.includes("calc_spec.rb:8")) || JSON.stringify(failed ?? null));
  check("rspec progress complete", r?.progressWidth === "100%" || String(r?.progressWidth));
  check("gutter shows last result", testStatusAt(spec, 7) === "failed" && testStatusAt(spec, 3) === "passed" && testStatusAt(spec, 2) === "failed" || String(testStatusAt(spec, 7)));
  substep("rspec rerun failed");
  const before = testRunState()?.id;
  rerunFailed();
  await until(() => testRunState()?.id !== before, 30000);
  const rf = await until(() => (testRunState()?.exited ? testRunState() : null), 180000, 200);
  check("rspec rerun failed runs only the failure", !!rf && rf.counts.failed === 1 && rf.counts.total === 1 || JSON.stringify(rf?.counts ?? null));

  substep("minitest");
  const mt = await runToEnd(newConfig("minitest", "Smoke tests", "test/models/smoke_calc_test.rb"));
  report.minitestTree = mt && { counts: mt.counts, rows: mt.rows };
  check("minitest tree: 1 passed, 1 failed, 1 skipped", !!mt && mt.counts.passed === 1 && mt.counts.failed === 1 && mt.counts.pending === 1 || JSON.stringify(mt?.counts ?? null));
  const mf = mt?.results.find((x) => x.status === "failed");
  check("minitest failure message and line", !!mf?.message?.includes("Expected: 5") && mf.line === 8 || JSON.stringify(mf ?? null));
  substep("minitest rerun failed");
  const before2 = testRunState()?.id;
  rerunFailed();
  await until(() => testRunState()?.id !== before2, 30000);
  const mrf = await until(() => (testRunState()?.exited ? testRunState() : null), 180000, 200);
  check("minitest rerun failed runs only the failure", !!mrf && mrf.counts.failed === 1 && mrf.counts.total === 1 || JSON.stringify(mrf?.counts ?? null));
}

async function dockerChecks(report: Report, check: (n: string, ok: boolean | string) => void) {
  const why = await dockerUnavailable();
  report.docker = why || "available";
  if (why) return check("docker compose run", `untested: ${why}`);
  const cfg: RunConfig = { ...newConfig("ruby", "Smoke docker", SMOKE_SCRIPT), bundler: false, rubyManager: "none", docker: { ...defaultDocker(), service: "app", composeFile: "docker-compose.yml" } };
  report.dockerCommand = buildCommand(cfg);
  launch(cfg, "run");
  const item = await until(() => runs.items.find((i) => i.title === cfg.name && i.view.exited), 300000, 500);
  const buffer = item ? [...Array(item.view.term.buffer.active.length).keys()].map((y) => item.view.term.buffer.active.getLine(y)?.translateToString(true) ?? "").join("\n") : "";
  check("docker compose run (exit 0, output from container)", (item?.status === "ok" && buffer.includes("total=3")) || `${item?.status}: ${buffer.slice(-300)}`);
}

/// Two configurations under rdbg at once, both paused at the same persisted breakpoint.
async function twoDebugSessions(report: Report, check: (n: string, ok: boolean | string) => void) {
  const path = `${state.project!.root}/${SMOKE_SCRIPT}`;
  const a = newConfig("ruby", "Smoke A", SMOKE_SCRIPT);
  const b = newConfig("ruby", "Smoke B", SMOKE_SCRIPT);
  launch(a, "debug");
  await sleep(300);
  launch(b, "debug");
  const both = await until(() => {
    const list = debugSessions().filter((s) => (s.name === "Smoke A" || s.name === "Smoke B") && s.paused && s.frame);
    return list.length === 2 ? list : null;
  }, 120000, 200);
  report.twoSessions = both ?? debugSessions();
  check("two debug sessions paused at the same time", !!both && both.every((s) => s.frame?.path === path && s.frame.line === SMOKE_BP_LINE) || JSON.stringify(debugSessions()));
  if (both) {
    selectDebugSession("Smoke A");
    const aFrame = debugState().frame;
    selectDebugSession("Smoke B");
    const bFrame = debugState().frame;
    check("panel follows the selected session", aFrame?.line === SMOKE_BP_LINE && bFrame?.line === SMOKE_BP_LINE && debugSessions().find((s) => s.selected)?.name === "Smoke B");
    resumeSession("Smoke A");
    const aEnded = await until(() => debugSessions().find((s) => s.name === "Smoke A")?.ended, 30000);
    check("resuming one session leaves the other paused", !!aEnded && !!debugSessions().find((s) => s.name === "Smoke B")?.paused);
    resumeSession("Smoke B");
    await until(() => debugSessions().find((s) => s.name === "Smoke B")?.ended, 30000);
  }
  await stopAllSessions();
}

async function gitChecks(controller: string, check: (n: string, ok: boolean | string) => void) {
  const root = state.project!.root;
  showGitLog("");
  const listed = await until(() => logState().commits.length > 0 && logState().details.querySelector(".log-meta"), 10000);
  check("git log lists commits with details", !!listed);
  check("git log draws the graph", !!document.querySelector(".log-row svg.log-graph"));
  const total = logState().commits.length;
  showGitLog(controller);
  await until(() => logState().commits.length > 0 && logState().commits.length <= total && logState().details.querySelector(".change-row.selected"), 10000);
  check("file history filters the log to the file", logState().commits.length > 0 && !!logState().details.querySelector(".change-row.selected"));
  showGitLog("");

  await openFile(controller);
  const model = editor.getModel()!;
  await updateGutterNow();
  const before = gutterHunks().length;
  editor.setPosition({ lineNumber: 1, column: 1 });
  editor.trigger("keyboard", "type", { text: "# garnet smoke\n" });
  await updateGutterNow();
  check("live gutter marks unsaved edits", gutterHunks().length === before + 1 || JSON.stringify(gutterHunks()));
  while (model.getAlternativeVersionId() !== 1 && model.canUndo()) model.undo();
  await refreshGit();
  check("commit panel renders the changes tree", !!commitView.querySelector(".changes"));

  const dir = `${root}/tmp/garnet-smoke-git`;
  const sh = (cmd: string) => api.runCapture(root, `cd ${JSON.stringify(dir)} && ${cmd}`, 30);
  await api.runCapture(root, `rm -rf ${JSON.stringify(dir)} && mkdir -p ${JSON.stringify(dir)}`, 30);
  const saved = state.project!;
  state.project = { ...saved, root: dir };
  try {
    await sh(
      "git init -q -b main && git config user.email s@example.com && git config user.name smoke && printf 'a\\nb\\nc\\n' > f.rb && git add f.rb && git commit -qm init" +
        " && git checkout -qb feature && printf 'a\\nTHEIRS\\nc\\n' > f.rb && git commit -qam theirs && git checkout -q main && printf 'a\\nOURS\\nc\\n' > f.rb && git commit -qam ours",
    );
    const merged = await runGitOp("Merge", ["merge", "feature"]);
    document.getElementById("overlay-root")!.replaceChildren();
    const op = await api.gitOpState(dir);
    check("merge conflict detected", !merged && op.op === "merge" && op.conflicts.join() === "f.rb");
    const r = await openResolver("f.rb");
    check("resolver shows one conflict in three panes", r?.chunks.length === 1 && document.querySelectorAll(".merge-pane .monaco-editor").length === 3);
    if (r) {
      r.accept(0, "both");
      check("accept both yields yours then theirs", r.result.getValue() === "a\nOURS\nTHEIRS\nc\n" || r.result.getValue());
      check("resolver applies and marks resolved", await r.apply());
    }
    check("no conflicts left", (await api.gitOpState(dir)).conflicts.length === 0);
    await continueOperation("merge");
    check("merge continued into a merge commit", (await api.gitOpState(dir)).op === "" && (await api.gitCommitDetails(dir, "HEAD")).parents.length === 2);

    await sh("echo x >> f.rb && echo new > u.rb && git stash push -q --include-untracked -m wip");
    const st = await api.gitCommitDetails(dir, "stash@{0}");
    check("stash details list tracked and untracked files", st.files.some((f) => f.path === "f.rb") && st.files.some((f) => f.path === "u.rb" && f.status === "?"));
    await runGitOp("Pop stash", ["stash", "pop"]);
    const index = (await api.gitFileAt(dir, "", "f.rb")) ?? "";
    const work = await api.readFile(`${dir}/f.rb`);
    const patch = stagePatch("f.rb", index, `X\n${work}`, 0, 1);
    await api.gitStagePatch(dir, `${dir}/f.rb`, patch!);
    check("hunk staging stages only the chosen hunk", (await api.gitFileAt(dir, "", "f.rb")) === `X\n${index}`);
    await sh("echo 'f.rb filter=crypt' > .gitattributes");
    check("hunk staging refuses filtered files", await api.gitStagePatch(dir, `${dir}/f.rb`, patch!).then(() => false, (e) => String(e).includes("'crypt' filter")));
    await sh("ln -s /etc/hosts link.rb");
    check("writes through symlinks are refused", await api.writeFile(`${dir}/link.rb`, "x").then(() => false, (e) => String(e).includes("symlink")));
    check("writes outside the project are refused", await api.writeFile(`${root}/../garnet-smoke-outside`, "x").then(() => false, () => true));
  } catch (e) {
    check("git scenario", String(e));
  } finally {
    state.project = saved;
    await api.runCapture(root, `rm -rf ${JSON.stringify(dir)}`, 30);
    document.getElementById("overlay-root")!.replaceChildren();
  }
}

type Check = (n: string, ok: boolean | string) => void;

const click = (el: Element | null | undefined, detail = 1) => el?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail }));
const dbRow = (label: string) => [...document.querySelectorAll<HTMLElement>(".db-tree .tree-row")].find((r) => r.querySelector(".tree-label")?.textContent === label);
const dblclick = (el: Element | null | undefined) => {
  click(el);
  el?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
};
const dbPane = () => [...document.querySelectorAll<HTMLElement>("#editor-area > .editor-view")].find((p) => !p.hidden && p.offsetParent !== null) ?? null;
const inside = (el: Element | null, pane: Element | null) => {
  const a = el?.getBoundingClientRect();
  const b = pane?.getBoundingClientRect();
  return !!a && !!b && a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
};

/// Runs SQL in the visible SQL console the way a user does: text in the editor, selection, Run button.
async function consoleRun(sql: string) {
  const pane = await until(() => dbPane()?.classList.contains("db-console") && dbPane(), 5000);
  const model = monaco.editor.getModels().filter((m) => m.getLanguageId() === "sql").pop();
  const ed = monaco.editor.getEditors().find((e) => e.getModel() === model);
  if (!pane || !model || !ed) return null;
  model.setValue(sql);
  ed.setSelection(model.getFullModelRange());
  pane.querySelector<HTMLButtonElement>('[title^="Run statement"]')!.click();
  return until(() => {
    const text = pane.querySelector(".db-results")?.textContent ?? "";
    return !pane.querySelector<HTMLButtonElement>('[title^="Run statement"]')!.disabled && !/Running…/.test(text) && text ? pane : null;
  }, 30000);
}

async function databaseChecks(report: Report, check: Check) {
  const root = state.project!.root;
  const dev = `${root}::env::development`;
  const test = `${root}::env::test`;
  const q = (id: string, sql: string) => invoke<{ rows: (string | null)[][] }>("db_query", { id, sql, maxRows: 1000 });
  const prevHistory = await api.configRead("db-history.json");
  const exportPath = `${(await invoke<[string, boolean] | null>("smoke_target"))![0]}.export.csv`;
  try {
    rightbar.show("database");
    check("db: Database tool window is docked on the right with a stripe button", !!document.querySelector('#rightstrip .dock-tab[data-view="database"]') && !document.getElementById("rightbar")!.hidden && !!document.querySelector("#rightbar .db-view"));

    runCommand("dbNewConnection");
    const dlg = await until(() => document.querySelector<HTMLElement>(".db-dialog"), 5000);
    const fields = [...(dlg?.querySelectorAll<HTMLInputElement>("input.search-input") ?? [])];
    const hit = fields.every((f) => {
      const r = f.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return at === f || f.closest("label")?.contains(at);
    });
    check("db: New Connection fields are clickable (hit-test) and the first one has focus", (fields.length >= 4 && hit && document.activeElement === fields[0]) || JSON.stringify({ n: fields.length, hit, active: document.activeElement?.outerHTML.slice(0, 80) }));
    fields[2]?.focus();
    check("db: New Connection fields take focus", document.activeElement === fields[2]);
    dlg?.closest(".qp-backdrop")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    check("db: New Connection closes on Escape", !document.querySelector(".db-dialog"));

    const detected = await until(() => dbRow("development")?.textContent?.includes("sqlite storage/development.sqlite3") && dbRow("test"), 15000);
    report.dbConnections = [...document.querySelectorAll(".db-tree .tree-row")].map((r) => r.textContent);
    check("db: development connection detected from config/database.yml", !!detected || JSON.stringify(report.dbConnections));
    if (!detected) return;
    dblclick(dbRow("development"));
    const live = await until(() => dbRow("development")?.querySelector(".db-live"), 15000);
    check("db: connect to development (sqlite)", !!live || String(document.querySelector(".toasts")?.textContent));
    if (!live) return;
    await q(dev, "INSERT INTO posts (title, body, created_at, updated_at) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150) SELECT 'garnet-smoke-' || i, 'body', datetime('now'), datetime('now') FROM n");
    await q(dev, "CREATE TABLE IF NOT EXISTS garnet_smoke_drop (id integer)");
    const postsRow = await until(() => dbRow("posts"), 15000);
    check("db: schema lists the posts table", !!postsRow && !!dbRow("schema_migrations") || String(document.querySelector(".db-tree")?.textContent));

    dblclick(postsRow);
    const range = () => dbPane()?.querySelector(".db-range")?.textContent ?? "";
    const first = await until(() => /^rows 1–100 of 1\d\d$/.test(range()) && range(), 15000);
    check("db: table viewer shows the first page of 100", !!first || range());
    const total = Number(range().split(" of ")[1]);
    click(dbPane()?.querySelector('[title="Next page"]'));
    const second = await until(() => range() === `rows 101–${total} of ${total}` && range(), 15000);
    check("db: table viewer pages forward", !!second || range());
    check("db: table data opens as an editor tab", allTabs().some((t) => t.kind === "view" && t.title === "posts" && t === activeTab()));

    const tree = document.querySelector<HTMLElement>(".db-tree")!;
    for (const name of ["posts", "comments", "schema_migrations", "ar_internal_metadata"]) {
      const tw = dbRow(name)?.querySelector(".twisty");
      if (tw && !tw.classList.contains("codicon-chevron-down")) click(tw);
    }
    const oldHeight = document.getElementById("rightbar")!.style.height;
    document.getElementById("rightbar")!.style.height = "220px";
    const scrollable = await until(() => tree.scrollHeight > tree.clientHeight + 10, 3000);
    tree.scrollTop = tree.scrollHeight;
    check("db: tree scrolls and stays inside its tool window", (!!scrollable && tree.scrollTop > 0 && inside(tree, document.getElementById("rightbar"))) || JSON.stringify({ sh: tree.scrollHeight, ch: tree.clientHeight, top: tree.scrollTop }));
    tree.scrollTop = 0;
    document.getElementById("rightbar")!.style.height = oldHeight;

    const bottomEl = document.getElementById("bottom")!;
    const prevBottom = bottomEl.style.height;
    bottom.show("find");
    bottomEl.style.height = "5000px";
    await new Promise((res) => setTimeout(res, 50));
    const statusTop = document.getElementById("statusbar")!.getBoundingClientRect().top;
    check(
      "layout: a tall bottom panel stays above the status bar and the editor area clips its content",
      (bottomEl.getBoundingClientRect().bottom <= statusTop + 1 && getComputedStyle(document.getElementById("editor-area")!).overflow === "hidden" && getComputedStyle(document.getElementById("welcome")!).overflow === "hidden") ||
        JSON.stringify({ bottom: bottomEl.getBoundingClientRect().bottom, statusTop }),
    );
    bottomEl.style.height = prevBottom;
    bottom.hide();

    const devRow = dbRow("development")!;
    devRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
    const consoleItem = await until(() => [...document.querySelectorAll<HTMLElement>(".ctx-item")].find((i) => i.textContent?.includes("Query Console")), 3000);
    check("db: data source context menu has icons and New › Query Console", !!consoleItem && !!consoleItem.querySelector(".codicon:not(.codicon-blank)") || String(document.querySelector(".ctx-menu")?.textContent));
    consoleItem?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const fromMenu = await until(() => dbPane()?.classList.contains("db-console") && activeTab()?.title === "console [development]", 5000);
    check("db: console opens from the context menu as an editor tab", !!fromMenu || String(activeTab()?.title));

    const limit = await until(() => dbPane()?.querySelector<HTMLInputElement>(".db-limit input"), 5000);
    if (limit) limit.checked = true;
    await updateSetting("database.autoLimitRows", 7);
    let pane = await consoleRun("SELECT * FROM posts");
    const status = () => pane?.querySelector(".db-status")?.textContent ?? pane?.querySelector(".db-results")?.textContent ?? "";
    check("db: console SELECT gets LIMIT injected (7 rows)", status().startsWith("7 rows") || status());
    await updateSetting("database.autoLimitRows", undefined);
    pane = await consoleRun("SELECT id, title FROM posts WHERE title LIKE 'garnet-smoke-%' ORDER BY id");
    check("db: console SELECT returns rows", status().startsWith("150 rows") || status());

    click([...(pane?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Export CSV"));
    const exported = await until(() => [...document.querySelectorAll(".toast-msg")].find((t) => t.textContent?.includes(exportPath))?.textContent, 10000);
    const csv = exported ? await api.runCapture(root, `cat ${shellQuote(exportPath)}`, 30) : "";
    const lines = csv.trim().split(/\r?\n/);
    check("db: CSV export (dialog skipped in smoke mode)", (lines[0] === "id,title" && lines.length === 151 && lines[1].endsWith(",garnet-smoke-1")) || `${exported}: ${csv.slice(0, 120)}`);
    await api.runCapture(root, `rm -f ${shellQuote(exportPath)}`, 30);

    let asked: { message: string; title?: string } | null = null;
    dbSmokeHooks.ask = async (message, opts) => ((asked = { message, title: typeof opts === "string" ? opts : opts?.title }), false);
    pane = await consoleRun("DROP TABLE garnet_smoke_drop");
    const a = asked as { message: string; title?: string } | null;
    const still = (await q(dev, "SELECT name FROM sqlite_master WHERE name = 'garnet_smoke_drop'")).rows.length === 1;
    check("db: DROP on a writable connection asks first; cancel runs nothing", (!!a && a.title === "Dangerous Statement" && a.message.includes("DROP statement") && still && !!pane?.textContent?.includes("Cancelled; nothing was run.")) || JSON.stringify({ a, still, pane: pane?.textContent?.slice(0, 200) }));

    click(dbRow("test"), 2);
    const testLive = await until(() => dbRow("test")?.querySelector(".db-live"), 15000);
    check("db: test connection is read-only by default", !!dbRow("test")?.querySelector(".db-ro") || String(dbRow("test")?.textContent));
    if (testLive) {
      click(dbRow("test"));
      click(document.querySelector('.db-view [title="Open SQL Console"]'));
      await until(() => dbPane()?.querySelector(".db-conn-head strong")?.textContent === "test", 5000);
      pane = await consoleRun("DELETE FROM posts WHERE id = -1");
      check("db: write blocked on a read-only connection (UI)", !!pane?.textContent?.includes('"test" is read-only') || String(pane?.textContent?.slice(0, 200)));
      const backend = await q(test, "INSERT INTO posts (title, created_at, updated_at) VALUES ('x', datetime('now'), datetime('now'))").then(() => "written!", (e) => String(e));
      check("db: write blocked on a read-only connection (backend)", backend !== "written!" || backend);
    }
  } catch (e) {
    check("db scenario", String(e));
  } finally {
    dbSmokeHooks.ask = undefined;
    await updateSetting("database.autoLimitRows", undefined);
    await q(dev, "DELETE FROM posts WHERE title LIKE 'garnet-smoke-%'").catch(() => {});
    await q(dev, "DROP TABLE IF EXISTS garnet_smoke_drop").catch(() => {});
    for (const id of [dev, test]) await invoke("db_disconnect", { id }).catch(() => {});
    if (prevHistory === null) await api.configWrite("db-history.json", "{}");
    else await api.configWrite("db-history.json", prevHistory);
    clearToasts();
  }
}

async function railsToolChecks(report: Report, check: Check) {
  const root = state.project!.root;
  const overlay = document.getElementById("overlay-root")!;
  substep("generator list");
  await runRailsGenerator();
  const labels = [...overlay.querySelectorAll(".qp-item .qp-label")].map((e) => e.textContent ?? "");
  report.generators = labels.length;
  check("rails: generator list parsed from bin/rails generate --help", ["scaffold", "model", "controller", "migration"].every((g) => labels.includes(g)) || labels.join(","));
  const scaffold = [...overlay.querySelectorAll<HTMLElement>(".qp-item")].find((e) => e.querySelector(".qp-label")?.textContent === "scaffold");
  scaffold?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  substep("generator dialog");
  const dlg = await until(() => overlay.querySelector<HTMLElement>(".gen-dialog"), 60000);
  if (dlg) {
    const args = [...dlg.querySelectorAll<HTMLElement>(".rc-field")].find((f) => f.querySelector("span")?.textContent === "Arguments")?.querySelector("input");
    args!.value = "GarnetSmokeWidget name:string";
    args!.dispatchEvent(new Event("input"));
    [...dlg.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Preview (--pretend)")!.click();
    const out = await until(() => {
      const t = [...dlg.querySelectorAll<HTMLElement>(".gen-form > pre.gen-output")].pop()?.textContent ?? "";
      return t.includes("app/models/garnet_smoke_widget.rb") ? t : null;
    }, 120000, 250);
    const created = await api.readFile(`${root}/app/models/garnet_smoke_widget.rb`).then(() => true, () => false);
    check("rails: scaffold --pretend previews files without creating them", (!!out && out.includes("--pretend") && !created) || `created=${created}`);
    [...dlg.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Cancel")!.click();
  } else check("rails: scaffold --pretend previews files without creating them", "generator dialog did not open");
  overlay.querySelector(".qp-backdrop")?.remove();

  substep("migrations");
  bottom.show("migrations");
  await loadMigrations();
  const migRows = [...document.querySelectorAll<HTMLElement>(".migration-row")];
  const files = (await api.indexFiles()).filter((f) => /^db\/migrate\/\d+_.+\.rb$/.test(f));
  report.migrations = migRows.map((r) => r.textContent);
  check("rails: migrations status lists every migration as up", (migRows.length === files.length && migRows.length > 0 && migRows.every((r) => r.classList.contains("up"))) || JSON.stringify(report.migrations));

  substep("project view");
  toggleRailsView(true);
  await refreshRailsTree();
  const railsText = [...railsTreeEl.querySelectorAll(".tree-row")].map((r) => r.textContent ?? "");
  check("rails: project view lists models and controllers", (railsText.some((t) => t.startsWith("Models")) && railsText.includes("post.rb") && railsText.some((t) => t.startsWith("Controllers")) && railsText.includes("posts_controller.rb")) || railsText.join("|"));
  toggleRailsView(false);

  substep("cmd+click");
  const nav = `${root}/app/views/posts/garnet_smoke_nav.html.erb`;
  const partial = `${root}/app/views/posts/_garnet_smoke_partial.html.erb`;
  const locale = `${root}/config/locales/garnet_smoke.en.yml`;
  await api.writeFile(nav, '<%= render "garnet_smoke_partial" %>\n<%= t(".garnet_smoke_title") %>\n');
  await api.writeFile(partial, "<p>smoke</p>\n");
  await api.writeFile(locale, 'en:\n  posts:\n    garnet_smoke_nav:\n      garnet_smoke_title: "Smoke"\n');
  const jump = async (file: string, needle: string, target: string) =>
    until(async () => {
      await openFile(file);
      const m = editor.getModel()!;
      const at = m.findMatches(needle, false, false, true, null, false)[0]?.range;
      if (!at) return null;
      editor.setPosition({ lineNumber: at.startLineNumber, column: at.startColumn + 2 });
      editor.trigger("smoke", "editor.action.revealDefinition", null);
      await sleep(400);
      document.querySelector<HTMLElement>(".peekview-widget")?.remove();
      return activeTab()?.path === target ? { line: editor.getPosition()?.lineNumber } : null;
    }, 15000, 500);
  try {
    const real = await jump(`${root}/app/views/posts/new.html.erb`, '"form"', `${root}/app/views/posts/_form.html.erb`);
    check("rails: Cmd+click render \"form\" opens _form.html.erb", !!real || String(activeTab()?.path));
    const p = await jump(nav, '"garnet_smoke_partial"', partial);
    check("rails: Cmd+click partial opens the new partial", !!p || String(activeTab()?.path));
    const k = await jump(nav, '".garnet_smoke_title"', locale);
    check("rails: Cmd+click i18n key opens the locale file at the key", k?.line === 4 || JSON.stringify({ k, at: activeTab()?.path }));
  } finally {
    for (const t of allTabs().filter((t) => [nav, partial, locale, `${root}/app/views/posts/_form.html.erb`, `${root}/app/views/posts/new.html.erb`].includes(t.path))) await closeTab(t, true);
    for (const f of [nav, partial, locale]) await api.deletePath(f).catch(() => {});
  }
  clearToasts();
}

/// Read-only: never signs in, stores a token or writes anything on GitHub.
async function githubChecks(report: Report, check: Check) {
  const s = await refreshAccount();
  const ghLoggedIn = (await api.runCapture(state.project!.root, "gh auth status >/dev/null 2>&1 && echo yes || echo no", 30).catch(() => "no")).trim() === "yes";
  report.github = { signedIn: s.signedIn, ghAvailable: s.ghAvailable, ghLoggedIn };
  check("github: gh CLI account detection", s.ghAvailable === ghLoggedIn || JSON.stringify(report.github));
  if (s.ghAvailable) {
    const overlay = document.getElementById("overlay-root")!;
    const closed = signIn();
    const offer = await until(() => [...overlay.querySelectorAll<HTMLButtonElement>(".gh-dialog button")].find((b) => b.textContent === "Use gh Account"), 15000);
    check("github: sign-in dialog offers the gh account", !!offer);
    [...overlay.querySelectorAll<HTMLButtonElement>(".gh-dialog button")].find((b) => b.textContent === "Cancel")?.click();
    await closed;
  } else check("github: sign-in dialog offers the gh account", "skipped: gh is not logged in");
  if (!s.signedIn) return check("github: signed-in account", "skipped: not signed in to Garnet");
  const me = await gh<{ login: string }>("GET", "/user").catch((e) => ({ login: String(e) }));
  check("github: signed-in account", (!!s.login && me.login === s.login && !!document.querySelector(".status-item.clickable")?.parentElement?.textContent?.includes(s.login)) || JSON.stringify({ login: s.login, me }));
}
