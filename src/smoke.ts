// End-to-end smoke run: GARNET_SMOKE=<report.json> Garnet.app/Contents/MacOS/garnet <rails-project>
// Exercises the real UI code paths, measures performance budgets, writes a JSON report and quits.
import { listen } from "@tauri-apps/api/event";
import { allCommands, keymap } from "./commands";
import { importJetBrainsKeymap, jetbrainsKeystroke } from "./keymapref";
import { debugState, evaluate, resume, smokeHooks, stopDebug, toggleBreakpoint } from "./debug";
import { activeTab, allTabs, closeTab, editor, languageFor, openFile } from "./editor";
import { symbolPath } from "./breadcrumbs";
import { snippetsFor } from "./languages/snippets";
import { replaceInFiles, searchView } from "./search";
import { decodeTokens, ruleFor, SEMANTIC_RULES } from "./semantic";
import { refreshGit } from "./git";
import { api, Channel, invoke, type PtyEvent } from "./ipc";
import { cachedSymbols, goToImplementation, lspCapabilities, lspReady, request } from "./lsp";
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
    await editorFeatureChecks(check, !!ok);
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
  const expect: Record<string, string> = { "cmd+shift+r": "replaceInFiles", "cmd+alt+b": "goToImplementation", "ctrl+shift+b": "goToTypeDefinition", "cmd+e": "recentFiles", "cmd+o": "goToClass", "cmd+shift+o": "goToFile", "ctrl+r": "runSelected", "ctrl+d": "debugSelected", "cmd+shift+k": "push", "cmd+[": "back", "cmd+shift+f8": "viewBreakpoints", "alt+f8": "evaluate", "cmd+shift+a": "commandPalette" };
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

async function editorFeatureChecks(check: (n: string, ok: boolean | string) => void, lsp: boolean) {
  const root = state.project!.root;
  const overlay = document.getElementById("overlay-root")!;
  openSettingsWindow();
  const settingsText = overlay.textContent ?? "";
  check("settings list breadcrumbs/semantic/inlay/templates toggles", ["breadcrumbs", "Semantic highlighting", "Inlay hints", "Live templates"].every((t) => settingsText.includes(t)));
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
