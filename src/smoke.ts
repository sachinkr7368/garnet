// End-to-end smoke run: GARNET_SMOKE=<report.json> Garnet.app/Contents/MacOS/garnet <rails-project>
// Exercises the real UI code paths, measures performance budgets, writes a JSON report and quits.
import { listen } from "@tauri-apps/api/event";
import { allCommands, keymap } from "./commands";
import { importJetBrainsKeymap, jetbrainsKeystroke } from "./keymapref";
import { debugState, evaluate, resume, smokeHooks, stopDebug, toggleBreakpoint } from "./debug";
import { editor, openFile } from "./editor";
import { refreshGit } from "./git";
import { api, Channel, invoke, type PtyEvent } from "./ipc";
import { lspReady, request } from "./lsp";
import { buildCommand, configList, editConfigurations, launch, newConfig, safeEnv, validateConfig } from "./run";
import { isTrusted, loadSettings, setting, updateSetting } from "./settings";
import { openSettingsWindow } from "./settingsui";
import { refreshToolbar } from "./toolbar";
import { monaco } from "./editor";
import { state } from "./state";

type Report = Record<string, unknown> & { checks: Record<string, boolean | string> };

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
  const check = (name: string, ok: boolean | string) => (report.checks[name] = ok);
  try {
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

    await refreshGit();
    check("git status", (await api.gitBranch(state.project!.root).catch((e) => String(e))) !== "");

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

    await uiChecks(check);
    if (withDebug) await debugRailsRequest(report, controller, check);
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
  toggleBreakpoint(bpLine);
  const port = await api.freePort();
  const cfg = newConfig("rails-server", "Rails server", `-p ${port}`);
  report.debugCommand = buildCommand(cfg, { port: 0 });
  const connected = new Promise<void>((r) => (smokeHooks.connected = r));
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
  const expect: Record<string, string> = { "cmd+e": "recentFiles", "cmd+o": "goToClass", "cmd+shift+o": "goToFile", "ctrl+r": "runSelected", "ctrl+d": "debugSelected", "cmd+shift+k": "push", "cmd+[": "back", "cmd+shift+f8": "viewBreakpoints", "alt+f8": "evaluate", "cmd+shift+a": "commandPalette" };
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
  check(".garnet/run.json saved", (await api.readFile(`${state.project!.root}/.garnet/run.json`).catch(() => "")).includes("Rails server"));
  editConfigurations();
  check("run configuration dialog lists configs", overlay.querySelectorAll(".rc-item").length === names.length);
  overlay.replaceChildren();
  await refreshToolbar();
  const branch = (await invoke<string>("git_run", { root: state.project!.root, args: ["rev-parse", "--abbrev-ref", "HEAD"] })).trim();
  check("toolbar shows current branch", document.getElementById("switchers")!.textContent!.includes(branch));
  await invoke("git_run", { root: state.project!.root, args: ["branch", "garnet-smoke"] });
  const listed = await invoke<string>("git_run", { root: state.project!.root, args: ["branch", "--list", "garnet-smoke"] });
  await invoke("git_run", { root: state.project!.root, args: ["branch", "-D", "garnet-smoke"] });
  check("git_run branch create/delete", listed.includes("garnet-smoke"));
}
