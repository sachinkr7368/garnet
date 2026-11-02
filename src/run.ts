import { debugSession, sessionFor, stopSession } from "./debug";
import { activeTab, editor, events, monaco, saveAll } from "./editor";
import { api } from "./ipc";
import { setting } from "./settings";
import { abs, rel, root, shellQuote, state } from "./state";
import { PtyTabs, PtyView } from "./terminal";
import { bottom, h, icon, iconButton, quickPick, toast } from "./ui";

export type RunType = "rails-server" | "rails-console" | "rspec" | "minitest" | "rake" | "ruby" | "sidekiq" | "custom";
export type RubyManager = "auto" | "rbenv" | "asdf" | "chruby" | "rvm" | "mise" | "none";

export interface RunConfig {
  name: string;
  type: RunType;
  args: string;
  cwd: string;
  env: Record<string, string>;
  envFile: string;
  rubyManager: RubyManager;
  bundler: boolean;
}

export const TYPE_LABELS: Record<RunType, string> = {
  "rails-server": "Rails server",
  "rails-console": "Rails console",
  rspec: "RSpec",
  minitest: "Minitest",
  rake: "Rake task",
  ruby: "Ruby script",
  sidekiq: "Sidekiq",
  custom: "Custom command",
};

const MANAGER_PREFIX: Record<RubyManager, string> = {
  auto: "",
  none: "",
  rbenv: "rbenv exec ",
  asdf: "asdf exec ",
  mise: "mise exec -- ",
  rvm: "rvm in . do ",
  chruby: 'chruby-exec "$(cat .ruby-version)" -- ',
};

const CONFIG_FILE = () => `${root()}/.garnet/run.json`;
let configs: RunConfig[] = [];
let selectedName = "";
let gemfileLock = "";
let detectedManagers: string[] = [];

export const configList = () => configs;

export function newConfig(type: RunType, name: string, args = ""): RunConfig {
  return { name, type, args, cwd: "", env: {}, envFile: "", rubyManager: setting<RubyManager>("ruby.versionManager"), bundler: type !== "custom" && setting<boolean>("ruby.useBundler") };
}

function defaults(): RunConfig[] {
  const p = state.project!;
  const list: RunConfig[] = [];
  if (p.rails) {
    list.push(newConfig("rails-server", "Rails server"), newConfig("rails-console", "Rails console"));
    if (/^\s{4}sidekiq \(/m.test(gemfileLock)) list.push(newConfig("sidekiq", "Sidekiq"));
  }
  if (p.rspec) list.push(newConfig("rspec", "All specs"));
  else if (p.minitest) list.push(newConfig("minitest", "All tests"));
  return list;
}

export async function loadRunConfigs() {
  gemfileLock = await api.readFile(`${root()}/Gemfile.lock`).catch(() => "");
  try {
    const parsed = JSON.parse(await api.readFile(CONFIG_FILE()));
    configs = (parsed.configurations ?? []).map((c: Partial<RunConfig>) => ({ ...newConfig(c.type ?? "custom", c.name ?? "Unnamed"), ...c }));
    selectedName = parsed.selected ?? "";
  } catch {
    configs = defaults();
    if (configs.length) await saveRunConfigs();
  }
  if (!configs.some((c) => c.name === selectedName)) selectedName = configs[0]?.name ?? "";
  api
    .runCapture(root(), "for m in rbenv asdf chruby-exec rvm mise; do command -v $m >/dev/null 2>&1 && echo $m; done", 20)
    .then((out) => (detectedManagers = out.split("\n").filter(Boolean).map((m) => m.replace("-exec", ""))))
    .catch(() => {});
  renderWidget();
}

export async function saveRunConfigs(list = configs) {
  configs = list;
  await api.createPath(`${root()}/.garnet`, true).catch(() => {});
  await api.writeFile(CONFIG_FILE(), JSON.stringify({ selected: selectedName, configurations: configs }, null, 2) + "\n");
  renderWidget();
}

export const managersDetected = () => detectedManagers;
const debugBundled = () => /^\s{4}debug \(/m.test(gemfileLock);

/// Command line for a configuration; with `debugPort` it is wrapped in rdbg.
export function buildCommand(cfg: RunConfig, debug?: { port: number; globalRdbg?: boolean }): string {
  const p = state.project!;
  const be = cfg.bundler ? "bundle exec " : "";
  let args = cfg.args.trim();
  if (cfg.type === "rails-server") {
    if (!/(^|\s)(-p|--port)\b/.test(args)) args = `-p ${setting("rails.serverPort")} ${args}`;
    if (!/(^|\s)(-b|--binding)\b/.test(args)) args = `-b ${setting("rails.serverBinding")} ${args}`;
  }
  const runner = setting<string>("testing.rspecRunner");
  const rspec = runner !== "auto" ? runner : cfg.bundler ? "bundle exec rspec" : p.binRspec ? "bin/rspec" : "rspec";
  const raw = {
    "rails-server": `bin/rails server ${args}`,
    "rails-console": `bin/rails console ${args}`,
    rspec: `${rspec} ${setting("testing.rspecArgs")} ${args}`,
    minitest: `${p.rails ? "bin/rails test" : `${be}ruby -Itest`} ${setting("testing.minitestArgs")} ${args}`,
    rake: p.rails ? `bin/rails ${args}` : `${be}rake ${args}`,
    ruby: `${be}ruby ${args}`,
    sidekiq: `${be}sidekiq ${args}`,
    custom: args,
  }[cfg.type];
  const base = cfg.type === "custom" ? raw.trim() : raw.replace(/\s+/g, " ").trim();
  const rdbg = setting<string>("debug.rdbgPath") || `${cfg.bundler && debugBundled() && !debug?.globalRdbg ? "bundle exec " : ""}rdbg`;
  const cmd = debug
    ? `${rdbg} --open --port=${debug.port} --host=127.0.0.1 --command -- ${base}`
    : base;
  return MANAGER_PREFIX[cfg.rubyManager] + cmd;
}

/// Parses KEY=VALUE lines (comments, `export` and quotes allowed).
export function parseDotenv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const m = raw.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    env[m[1]] = v.replace(/\\n/g, "\n");
  }
  return env;
}

async function resolveEnv(cfg: RunConfig): Promise<Record<string, string>> {
  let fileEnv = {};
  if (cfg.envFile.trim()) {
    try {
      fileEnv = parseDotenv(await api.readFile(abs(cfg.envFile.trim())));
    } catch (e) {
      toast(`Cannot read env file ${cfg.envFile}: ${e}`, "error");
    }
  }
  const rails = cfg.type.startsWith("rails") || (cfg.type === "rake" && state.project?.rails);
  return { ...(rails ? { RAILS_ENV: setting<string>("rails.environment") } : {}), ...fileEnv, ...cfg.env };
}

/// Run tool window: one console tab per launched configuration

export const runs = new PtyTabs();
let last: { cfg: RunConfig; mode: "run" | "debug" } | null = null;

runs.toolbar.append(
  iconButton("debug-restart", "Restart", () => {
    const item = runs.active;
    const entry = item && running.get(item);
    if (entry) launch(entry.cfg, entry.mode);
  }),
  iconButton("debug-stop", "Stop", () => runs.active && stopItem(runs.active)),
);

type RunItem = PtyTabs["items"][number];
const running = new Map<RunItem, { cfg: RunConfig; mode: "run" | "debug" }>();

function stopItem(item: RunItem) {
  const entry = running.get(item);
  if (entry?.mode === "debug") stopSession(sessionFor(item));
  item.view.kill();
}

export interface RunOptions {
  env?: Record<string, string>;
  cwd?: string;
  onExit?: (code: number | null) => void;
}

export function runInPanel(title: string, command: string, opts: RunOptions = {}): RunItem | undefined {
  if (!state.project) return;
  for (const old of runs.items.filter((i) => i.title === title)) {
    if (!old.view.exited) old.view.kill();
    runs.close(old);
  }
  bottom.show("run");
  const view = new PtyView({
    command,
    env: opts.env,
    cwd: opts.cwd,
    onExit: (code) => {
      runs.setStatus(item, code === 0 ? "ok" : "failed");
      renderWidget();
      opts.onExit?.(code);
    },
  });
  view.term.writeln(`\x1b[2m$ ${command}\x1b[0m`);
  const item = runs.add(title, view);
  runs.setStatus(item, "running");
  return item;
}

export async function launch(cfg: RunConfig, mode: "run" | "debug", opts: { globalRdbg?: boolean } = {}) {
  if (!state.project) return;
  if (mode === "debug" && cfg.bundler && !debugBundled() && !opts.globalRdbg && !setting("debug.rdbgPath")) {
    toast(
      `The debug gem is not in this bundle. Add  gem "debug", group: [:development, :test]  to the Gemfile and run bundle install, or try the globally installed rdbg.`,
      "error",
      [{ label: "Debug with global rdbg", run: () => launch(cfg, mode, { globalRdbg: true }) }],
    );
    return;
  }
  last = { cfg, mode };
  if (setting("run.saveBeforeRun")) await saveAll();
  const env = await resolveEnv(cfg);
  const cwd = cfg.cwd.trim() ? abs(cfg.cwd.trim()) : root();
  const port = mode === "debug" ? await api.freePort() : 0;
  const command = buildCommand(cfg, mode === "debug" ? { port, globalRdbg: opts.globalRdbg } : undefined);
  const title = mode === "debug" ? `${cfg.name} (debug)` : cfg.name;
  const item = runInPanel(title, command, { env, cwd, onExit: () => running.delete(item!) });
  if (!item) return;
  running.set(item, { cfg, mode });
  renderWidget();
  if (mode === "debug") debugSession({ target: String(port), cfg, item, timeoutSecs: setting<number>("debug.connectTimeout") });
}

export function rerun() {
  if (last) launch(last.cfg, last.mode);
  else toast("Nothing to rerun yet.");
}

/// Tests from the editor

const TEST_LINE = /^\s*(?:(?:RSpec\.)?(?:describe|context|it|specify|example|scenario|feature|test|shared_examples)\b|def test_\w+)/;
export const isTestFile = (path: string) => /_spec\.rb$|_test\.rb$/.test(path);

function testNameAt(path: string, line: number): string | null {
  const model = monaco.editor.getModel(monaco.Uri.file(path));
  const text = model?.getLineContent(line) ?? "";
  const def = text.match(/def (test_\w+)/);
  if (def) return def[1];
  const t = text.match(/test\s+["'](.+?)["']/);
  return t ? `test_${t[1].replace(/\s+/g, "_")}` : null;
}

export function testConfig(path?: string, line?: number): RunConfig | null {
  const p = state.project!;
  const kind = path?.endsWith("_spec.rb") ? "rspec" : path?.endsWith("_test.rb") ? "minitest" : p.rspec ? "rspec" : p.minitest ? "minitest" : null;
  if (!kind) return null;
  if (!path) return newConfig(kind, kind === "rspec" ? "All specs" : "All tests", kind === "minitest" && !p.rails ? "-e 'Dir[\"test/**/*_test.rb\"].each { |f| require_relative f }'" : "");
  let target = shellQuote(rel(path));
  if (line && (kind === "rspec" || p.rails)) target += `:${line}`;
  else if (line) {
    const name = testNameAt(path, line);
    if (name) target += ` -n ${shellQuote(`/${name}/`)}`;
  }
  return newConfig(kind, `${rel(path).split("/").pop()}${line ? `:${line}` : ""}`, target);
}

export async function runTests(scope: "all" | "file" | "cursor", mode: "run" | "debug" = "run") {
  const t = activeTab();
  if (scope !== "all" && (!t || !isTestFile(t.path))) {
    if (last) return rerun();
    return toast("Open a spec or test file first.");
  }
  const line = scope === "cursor" ? editor.getPosition()?.lineNumber : undefined;
  const cfg = testConfig(scope === "all" ? undefined : t!.path, line);
  if (!cfg) return toast("No RSpec or Minitest setup detected in this project.");
  launch(cfg, mode);
}

const gutterDecor = editor.createDecorationsCollection();

function refreshTestGutter() {
  const model = editor.getModel();
  const t = activeTab();
  if (!model || !t || t.kind !== "file" || !isTestFile(t.path)) return gutterDecor.clear();
  const decorations: monaco.editor.IModelDeltaDecoration[] = [];
  for (let i = 1; i <= model.getLineCount(); i++) {
    if (TEST_LINE.test(model.getLineContent(i)))
      decorations.push({
        range: new monaco.Range(i, 1, i, 1),
        options: { glyphMarginClassName: "codicon codicon-play glyph-run", glyphMarginHoverMessage: { value: "Run (Alt+click to debug)" } },
      });
  }
  gutterDecor.set(decorations);
}

let gutterTimer = 0;
editor.onDidChangeModelContent(() => {
  clearTimeout(gutterTimer);
  gutterTimer = window.setTimeout(refreshTestGutter, 300);
});
events.activated.on(() => refreshTestGutter());

export const isRunGlyph = (line: number) => gutterDecor.getRanges().some((r) => r.startLineNumber === line);

editor.onMouseDown((e) => {
  if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
  const line = e.target.position?.lineNumber;
  if (!line || !isRunGlyph(line)) return;
  e.event.preventDefault();
  editor.setPosition({ lineNumber: line, column: 1 });
  runTests("cursor", e.event.altKey ? "debug" : "run");
});

/// Toolbar widget: configuration selector + Run / Debug / Stop

const select = h("select", { class: "run-select", title: "Run configuration" });
const widget = document.getElementById("run-widget")!;
widget.append(
  select,
  iconButton("play", "Run selected configuration (⌃R)", () => selected() && launch(selected()!, "run")),
  iconButton("debug-alt", "Debug selected configuration (⌃D)", () => selected() && launch(selected()!, "debug")),
  iconButton("debug-stop", "Stop selected configuration", () => {
    for (const [item, e] of running) if (e.cfg.name === selected()?.name) stopItem(item);
  }),
  iconButton("settings-gear", "Edit run configurations", () => editConfigurations()),
);
select.addEventListener("change", () => {
  if (select.value === "__edit") return editConfigurations();
  selectedName = select.value;
  saveRunConfigs();
});

export const selected = () => configs.find((c) => c.name === selectedName) ?? configs[0] ?? null;

function renderWidget() {
  const live = new Set([...running.entries()].filter(([i]) => !i.view.exited).map(([, e]) => e.cfg.name));
  select.replaceChildren(
    ...configs.map((c) => h("option", { value: c.name, selected: c.name === selectedName }, `${live.has(c.name) ? "● " : ""}${c.name}`)),
    h("option", { value: "__edit" }, "Edit configurations…"),
  );
  if (!configs.length) select.prepend(h("option", { value: "", selected: true }, "No configurations"));
}

/// Pickers

export async function rakeTask() {
  const p = state.project!;
  toast("Loading tasks…");
  let out: string;
  try {
    out = await api.runCapture(root(), `${p.rails ? "bin/rails -T" : "bundle exec rake -T"} 2>/dev/null`, 180);
  } catch (e) {
    return toast(String(e), "error");
  }
  const items = out
    .split("\n")
    .map((l) => l.match(/^(?:rake|rails) (\S+)\s*(?:#\s*(.*))?$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ label: m[1], description: m[2] ?? "", data: m[1] }));
  quickPick({
    placeholder: "Run task",
    items,
    onAccept: (item, query) => {
      const task = (item?.data as string) ?? query.trim();
      if (task) launch(newConfig("rake", `rake ${task}`, task), "run");
    },
  });
}

export function pickConfiguration(mode: "run" | "debug") {
  quickPick({
    placeholder: mode === "run" ? "Run configuration" : "Debug configuration",
    items: [
      ...configs.map((c) => ({ label: c.name, description: buildCommand(c), icon: mode === "run" ? "play" : "debug-alt", data: c })),
      { label: "Edit configurations…", icon: "settings-gear", data: null },
    ],
    onAccept: (item) => {
      if (!item) return;
      if (!item.data) return editConfigurations();
      selectedName = (item.data as RunConfig).name;
      launch(item.data as RunConfig, mode);
      saveRunConfigs();
    },
  });
}

/// Configuration editor dialog

export function editConfigurations() {
  if (!state.project) return;
  renderWidget();
  let draft: RunConfig[] = structuredClone(configs);
  let current = Math.max(0, draft.findIndex((c) => c.name === selectedName));
  const list = h("div", { class: "rc-list" });
  const form = h("div", { class: "rc-form" });
  const preview = h("code", { class: "rc-preview" });

  const field = (label: string, input: HTMLElement, hint = "") =>
    h("label", { class: "rc-field" }, h("span", {}, label), input, hint ? h("small", { class: "dim" }, hint) : null);

  const renderList = () =>
    list.replaceChildren(
      ...draft.map((c, i) =>
        h("div", { class: `rc-item${i === current ? " selected" : ""}`, onclick: () => ((current = i), render()) }, h("span", {}, c.name), h("small", { class: "dim" }, TYPE_LABELS[c.type])),
      ),
    );

  const renderForm = () => {
    const c = draft[current];
    if (!c) return form.replaceChildren(h("div", { class: "empty" }, "Add a configuration with +"));
    const update = () => {
      preview.textContent = `$ ${buildCommand(c)}`;
      renderList();
    };
    const text = (key: "name" | "args" | "cwd" | "envFile", placeholder = "") => {
      const input = h("input", { class: "search-input", value: c[key], placeholder, spellcheck: false });
      input.oninput = () => ((c[key] = input.value), update());
      return input;
    };
    const type = h("select", { class: "run-select" }, ...Object.entries(TYPE_LABELS).map(([v, l]) => h("option", { value: v, selected: v === c.type }, l)));
    type.onchange = () => ((c.type = type.value as RunType), update());
    const manager = h(
      "select",
      { class: "run-select" },
      ...(["auto", "rbenv", "asdf", "chruby", "rvm", "mise", "none"] as RubyManager[]).map((m) => h("option", { value: m, selected: m === c.rubyManager }, m)),
    );
    manager.onchange = () => ((c.rubyManager = manager.value as RubyManager), update());
    const bundler = h("input", { type: "checkbox", checked: c.bundler });
    bundler.onchange = () => ((c.bundler = bundler.checked), update());
    const env = h("textarea", { class: "commit-message", rows: 4, spellcheck: false, placeholder: "RAILS_ENV=development\nPORT=3000" }, Object.entries(c.env).map(([k, v]) => `${k}=${v}`).join("\n"));
    env.oninput = () => ((c.env = parseDotenv(env.value)), update());
    const argsHint = {
      "rails-server": "e.g. -p 3001", "rails-console": "e.g. --sandbox", rspec: "files/lines, e.g. spec/models or spec/a_spec.rb:12",
      minitest: "e.g. test/models/user_test.rb:8", rake: "task and args, e.g. db:migrate", ruby: "script and args, e.g. bin/setup",
      sidekiq: "e.g. -C config/sidekiq.yml", custom: "full shell command",
    }[c.type];
    form.replaceChildren(
      field("Name", text("name")),
      field("Type", type),
      field(c.type === "custom" ? "Command" : "Arguments", text("args"), argsHint),
      field("Working directory", text("cwd", "project root"), "relative to the project root"),
      field("Environment variables", env, "KEY=VALUE per line"),
      field("Env file", text("envFile", ".env"), "loaded before the variables above"),
      field("Ruby version manager", manager, detectedManagers.length ? `detected via login shell: ${detectedManagers.join(", ")}; auto uses your shell setup as is` : "auto uses your login shell setup as is"),
      h("label", { class: "rc-check" }, bundler, " Use bundler (bundle exec)"),
      preview,
    );
    update();
  };

  const render = () => {
    renderList();
    renderForm();
  };

  const add = () => {
    quickPick({
      placeholder: "Configuration type",
      items: Object.entries(TYPE_LABELS).map(([v, l]) => ({ label: l, data: v })),
      onAccept: (item) => {
        if (!item) return;
        const t = item.data as RunType;
        let name = TYPE_LABELS[t];
        for (let n = 2; draft.some((c) => c.name === name); n++) name = `${TYPE_LABELS[t]} ${n}`;
        draft.push(newConfig(t, name));
        current = draft.length - 1;
        render();
      },
    });
  };

  const close = () => backdrop.remove();
  const save = async () => {
    const names = draft.map((c) => c.name.trim());
    if (names.some((n) => !n) || new Set(names).size !== names.length) return toast("Configuration names must be unique and non-empty.", "error");
    if (draft[current]) selectedName = draft[current].name;
    await saveRunConfigs(draft);
    close();
  };

  const dialog = h(
    "div",
    { class: "rc-dialog" },
    h("div", { class: "rc-title" }, icon("play"), " Run / Debug Configurations", h("span", { class: "spacer" }), h("small", { class: "dim" }, rel(CONFIG_FILE()))),
    h(
      "div",
      { class: "rc-body" },
      h(
        "div",
        { class: "rc-side" },
        h(
          "div",
          { class: "view-toolbar" },
          iconButton("add", "Add", add),
          iconButton("copy", "Duplicate", () => {
            if (!draft[current]) return;
            draft.push({ ...structuredClone(draft[current]), name: `${draft[current].name} copy` });
            current = draft.length - 1;
            render();
          }),
          iconButton("remove", "Remove", () => {
            draft.splice(current, 1);
            current = Math.max(0, current - 1);
            render();
          }),
        ),
        list,
      ),
      form,
    ),
    h(
      "div",
      { class: "rc-actions" },
      h("button", { class: "btn", onclick: close }, "Cancel"),
      h("button", { class: "btn primary", onclick: save }, "Save"),
    ),
  );
  const backdrop = h("div", { class: "qp-backdrop", onmousedown: (e: MouseEvent) => e.target === backdrop && close() }, dialog);
  backdrop.addEventListener("keydown", (e) => e.key === "Escape" && close());
  document.getElementById("overlay-root")!.append(backdrop);
  render();
}
