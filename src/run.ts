import { debugSession, sessionFor, stopSession } from "./debug";
import { checkPublishedPort, composeCommand, debugPortFor, defaultDocker, ENV_NAME, hostSocket, localfsMap, mapPath, rdbgListen, validateDocker, type DockerTarget } from "./docker";
import { activeTab, editor, events, monaco, saveAll } from "./editor";
import { api } from "./ipc";
import { askTrust, isTrusted, setting } from "./settings";
import { mergeConfigs, projectFile, projectFileText, readLocal, splitConfigs, writeLocal } from "./runstore";
import { abs, rel, root, shellQuote, state } from "./state";
import { onTestStatuses, prepareTestRun, startTestRun, statusIcon, testStatusAt } from "./testresults";
import { PtyTabs, PtyView } from "./terminal";
import { bottom, h, icon, iconButton, modal, quickPick, tip, toast } from "./ui";

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
  /// Stored in .garnet/run.json (shared via VCS) instead of Garnet's own config dir.
  shared?: boolean;
  /// Run inside a docker compose service instead of on the host.
  docker?: DockerTarget;
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

/// Per-type icons, like RubyMine's run configuration icons.
export const TYPE_ICONS: Record<RunType, string> = {
  "rails-server": "server-process",
  "rails-console": "debug-console",
  rspec: "beaker",
  minitest: "beaker",
  rake: "tools",
  ruby: "ruby",
  sidekiq: "server-environment",
  custom: "terminal",
};

const MANAGERS: RubyManager[] = ["auto", "none", "rbenv", "asdf", "mise", "rvm", "chruby"];

/// Runs a command with the chosen version manager. rvm and chruby read the project root's Ruby version, not the
/// configuration's working directory.
function managerPrefix(m: RubyManager, root: string): string {
  if (m === "rbenv" || m === "asdf") return `${m} exec `;
  if (m === "mise") return "mise exec -- ";
  if (m === "rvm") return `rvm in ${shellQuote(root)} do `;
  if (m === "chruby") return `chruby-exec "$(cat ${shellQuote(`${root}/.ruby-version`)})" -- `;
  return "";
}

let configs: RunConfig[] = [];
/// .garnet/run.json as read (null when absent or untrusted) and the shared configurations it yielded.
let projectRaw: Record<string, unknown> | null = null;
let sharedLoaded: Omit<RunConfig, "shared">[] = [];
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

const BLOCKED_ENV = /^(PATH|RUBYOPT|BASH_ENV|ENV|DYLD_\w*|LD_\w*)$/;

/// Drops variables that would let a config hijack the interpreter or shell (PATH, RUBYOPT, BASH_ENV, DYLD_*, ...).
export function safeEnv(env: Record<string, string>, source: string): Record<string, string> {
  const blocked = Object.keys(env).filter((k) => BLOCKED_ENV.test(k));
  if (blocked.length) toast(`${source}: ignored ${blocked.join(", ")}; set these in your shell instead.`, "error");
  return Object.fromEntries(Object.entries(env).filter(([k]) => !BLOCKED_ENV.test(k)));
}

/// Accepts a run.json entry only when every field has the expected type.
export function validateConfig(raw: unknown): RunConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const str = (v: unknown) => v === undefined || typeof v === "string";
  if (typeof c.name !== "string" || !c.name.trim() || typeof c.type !== "string" || !(c.type in TYPE_LABELS)) return null;
  if (!str(c.args) || !str(c.cwd) || !str(c.envFile)) return null;
  if (c.rubyManager !== undefined && !(typeof c.rubyManager === "string" && MANAGERS.includes(c.rubyManager as RubyManager))) return null;
  if (c.bundler !== undefined && typeof c.bundler !== "boolean") return null;
  if (c.env !== undefined && (!c.env || typeof c.env !== "object" || Array.isArray(c.env) || Object.entries(c.env).some(([k, v]) => !ENV_NAME.test(k) || typeof v !== "string"))) return null;
  const docker = c.docker === undefined ? undefined : validateDocker(c.docker);
  if (docker === null) return null;
  const base = newConfig(c.type as RunType, c.name);
  return {
    ...base,
    args: (c.args as string) ?? "",
    cwd: (c.cwd as string) ?? "",
    envFile: (c.envFile as string) ?? "",
    env: safeEnv((c.env as Record<string, string>) ?? {}, `run.json "${c.name}"`),
    rubyManager: (c.rubyManager as RubyManager) ?? base.rubyManager,
    bundler: (c.bundler as boolean) ?? base.bundler,
    ...(docker ? { docker } : {}),
  };
}

const validList = (list: unknown[], source: string) => {
  const valid = list.map(validateConfig).filter((c): c is RunConfig => !!c);
  if (valid.length < list.length) toast(`${source}: skipped ${list.length - valid.length} invalid configuration(s).`, "error");
  return valid;
};

/// Local configurations come from Garnet's config dir; shared ones from .garnet/run.json, read only when trusted.
export async function loadRunConfigs() {
  gemfileLock = await api.readFile(`${root()}/Gemfile.lock`).catch(() => "");
  const local = await readLocal(root());
  let shared: RunConfig[] = [];
  let sharedSelected = "";
  projectRaw = null;
  if (isTrusted()) {
    const raw = await api.readFile(projectFile(root())).catch(() => null);
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw);
        shared = validList(Array.isArray(parsed?.configurations) ? parsed.configurations : [], ".garnet/run.json");
        sharedSelected = typeof parsed?.selected === "string" ? parsed.selected : "";
        projectRaw = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      } catch (e) {
        toast(`.garnet/run.json is not valid JSON (${e}); ignoring it.`, "error");
      }
    }
  }
  sharedLoaded = splitConfigs(mergeConfigs([], shared)).shared;
  if (!local && !projectRaw) {
    configs = defaults();
    if (configs.length) await saveRunConfigs();
  } else {
    configs = mergeConfigs(local ? validList(local.configurations, "Run configurations") : [], shared);
    selectedName = local?.selected || sharedSelected;
  }
  if (!configs.some((c) => c.name === selectedName)) selectedName = configs[0]?.name ?? "";
  if (isTrusted())
    api
      .runCapture(root(), "for m in rbenv asdf chruby-exec rvm mise; do command -v $m >/dev/null 2>&1 && echo $m; done", 20)
      .then((out) => (detectedManagers = out.split("\n").filter(Boolean).map((m) => m.replace("-exec", ""))))
      .catch(() => {});
  renderWidget();
}

/// Safe Mode keeps selections and edits in memory: .garnet/run.json was not read, so anything stored now (the defaults
/// included) would shadow its configurations once the project is trusted.
export async function saveRunConfigs(list = configs) {
  configs = list;
  if (!isTrusted()) return renderWidget();
  const { local, shared } = splitConfigs(list);
  await writeLocal(root(), { selected: selectedName, configurations: local });
  const text = projectFileText(projectRaw, sharedLoaded, shared);
  if (text !== null) {
    await api.createPath(`${root()}/.garnet`, true).catch(() => {});
    await api.writeFile(projectFile(root()), text);
    projectRaw = JSON.parse(text);
    sharedLoaded = shared;
  }
  renderWidget();
}

export const managersDetected = () => detectedManagers;
const debugBundled = () => /^\s{4}debug \(/m.test(gemfileLock);

export interface BuildOptions {
  /// Wrap the command in rdbg listening on this port.
  debug?: { port: number; globalRdbg?: boolean };
  /// Extra test runner arguments (the results-tree formatter).
  testArgs?: string;
  /// Variables passed into a docker container; defaults to the configuration's own env keys.
  envNames?: string[];
}

/// Command line for a configuration, optionally under rdbg and/or inside a docker compose service.
export function buildCommand(cfg: RunConfig, opts: BuildOptions = {}): string {
  const p = state.project!;
  const { debug, testArgs } = opts;
  const docker = cfg.docker;
  const be = cfg.bundler ? "bundle exec " : "";
  let args = cfg.args.trim();
  if (cfg.type === "rails-server") {
    if (!/(^|\s)(-p|--port)\b/.test(args)) args = `-p ${setting("rails.serverPort")} ${args}`;
    if (!/(^|\s)(-b|--binding)\b/.test(args)) args = `-b ${setting("rails.serverBinding")} ${args}`;
  }
  if (testArgs) args = `${args} ${testArgs}`;
  const runner = setting<string>("testing.rspecRunner");
  // auto: the project's binstub, else the bundle's rspec when rspec-core is in Gemfile.lock, else a global rspec.
  const rspec = runner !== "auto" ? runner : p.binRspec ? "bin/rspec" : cfg.bundler && /^\s{4}rspec-core \(/m.test(gemfileLock) ? "bundle exec rspec" : "rspec";
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
  const bundledRdbg = `${cfg.bundler && debugBundled() && !debug?.globalRdbg ? "bundle exec " : ""}rdbg`;
  const rdbg = docker ? bundledRdbg : setting<string>("debug.rdbgPath") || bundledRdbg;
  const cmd = debug ? `${rdbg} --open ${docker ? rdbgListen(docker, debug.port, shellQuote) : `--port=${debug.port} --host=127.0.0.1`} --command -- ${base}` : base;
  if (!docker) return managerPrefix(cfg.rubyManager, p.root) + cmd;
  return composeCommand(
    docker,
    cmd,
    { envNames: opts.envNames ?? Object.keys(cfg.env), cwd: cfg.cwd.trim() ? rel(abs(cfg.cwd.trim())) : "", publish: debug && docker.mode === "run" && !docker.socketPath ? debug.port : undefined },
    shellQuote,
  );
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
      fileEnv = safeEnv(parseDotenv(await api.readFile(abs(cfg.envFile.trim()))), cfg.envFile.trim());
    } catch (e) {
      toast(`Cannot read env file ${cfg.envFile}: ${e}`, "error");
    }
  }
  const rails = cfg.type.startsWith("rails") || (cfg.type === "rake" && state.project?.rails);
  return { ...(rails ? { RAILS_ENV: setting<string>("rails.environment") } : {}), ...fileEnv, ...safeEnv(cfg.env, cfg.name) };
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

/// Console header for Docker runs: where it runs and the effective Rails binding.
export function dockerHeader(cfg: RunConfig, d: DockerTarget): string {
  const binding = cfg.args.match(/(?:^|\s)(?:-b|--binding)[\s=](\S+)/)?.[1] ?? setting<string>("rails.serverBinding");
  const parts = [`service ${d.service} (docker compose ${d.mode})`, `${root()} ↔ ${d.containerRoot}`];
  if (cfg.type === "rails-server") parts.push(`Rails binding ${binding}${/^(127\.|localhost|::1)/.test(binding) ? " (only reachable inside the container; use -b 0.0.0.0 with published ports to reach it from the host)" : ""}`);
  return parts.join(" · ");
}

export interface RunOptions {
  header?: string;
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
  if (opts.header) view.term.writeln(`\x1b[2m[docker] ${opts.header}\x1b[0m`);
  view.term.writeln(`\x1b[2m$ ${command}\x1b[0m`);
  const item = runs.add(title, view);
  runs.setStatus(item, "running");
  return item;
}

export async function launch(cfg: RunConfig, mode: "run" | "debug", opts: { globalRdbg?: boolean } = {}) {
  if (!state.project || !(await askTrust())) return;
  if (mode === "debug" && cfg.bundler && !debugBundled() && !opts.globalRdbg && !setting("debug.rdbgPath")) {
    toast(
      `The debug gem is not in this bundle. Add  gem "debug", group: [:development, :test]  to the Gemfile and run bundle install, or try the globally installed rdbg.`,
      "error",
      [{ label: "Debug with global rdbg", run: () => launch(cfg, mode, { globalRdbg: true }) }],
    );
    return;
  }
  const docker = cfg.docker;
  if (docker) {
    const why = await dockerUnavailable();
    if (why) return toast(`Cannot run "${cfg.name}" in Docker: ${why}`, "error");
    if (cfg.cwd.trim() && mapPath(abs(cfg.cwd.trim()), root(), docker.containerRoot) === null) return toast(`"${cfg.name}": the working directory must be inside the project to map it into the container.`, "error");
  }
  last = { cfg, mode };
  if (setting("run.saveBeforeRun")) await saveAll();
  const env = await resolveEnv(cfg);
  const cwd = cfg.cwd.trim() && !docker ? abs(cfg.cwd.trim()) : root();
  const port = mode === "debug" ? (docker ? debugPortFor(docker, await api.freePort()) : await api.freePort()) : 0;
  let attachPort = port;
  if (mode === "debug" && docker?.mode === "exec" && !docker.socketPath) {
    const out = await api.runCapture(root(), `docker compose ${docker.composeFile ? `-f ${shellQuote(docker.composeFile)} ` : ""}port ${docker.service} ${port} 2>&1`, 30).catch((e) => String(e));
    const checked = checkPublishedPort(out, port);
    if ("error" in checked) return toast(`Not debugging "${cfg.name}": ${checked.error}`, "error");
    attachPort = checked.port;
  }
  const test = docker ? null : await prepareTestRun(cfg, env);
  const command = buildCommand(cfg, { debug: mode === "debug" ? { port, globalRdbg: opts.globalRdbg } : undefined, testArgs: test?.args, envNames: Object.keys(env) });
  const title = mode === "debug" ? `${cfg.name} (debug)` : cfg.name;
  const item = runInPanel(title, command, {
    header: docker ? dockerHeader(cfg, docker) : undefined,
    env: { ...env, ...test?.env },
    cwd,
    onExit: () => {
      running.delete(item!);
      test?.finished();
    },
  });
  if (!item) return;
  running.set(item, { cfg, mode });
  renderWidget();
  if (test) startTestRun(test, cfg, item);
  if (mode === "debug")
    debugSession({
      target: docker ? (docker.socketPath ? hostSocket(docker, root()) : `127.0.0.1:${attachPort}`) : String(port),
      cfg,
      item,
      localfsMap: docker ? localfsMap(docker, root()) : undefined,
      timeoutSecs: setting<number>("debug.connectTimeout"),
    });
}

let dockerCheck: Promise<string> | null = null;

/// Empty when `docker compose` works; otherwise why Docker run targets are unavailable.
export function dockerUnavailable(): Promise<string> {
  // Every caller asks for Trust first; Safe Mode refusing to run commands says nothing about Docker.
  if (!isTrusted()) return Promise.resolve("");
  dockerCheck ??= api
    .runCapture(root(), "command -v docker >/dev/null 2>&1 || { echo 'docker is not installed (not found on PATH)'; exit 0; }; docker compose version >/dev/null 2>&1 || { echo 'the docker compose plugin is not installed'; exit 0; }; docker info >/dev/null 2>&1 || echo 'the Docker daemon is not running'", 30)
    .then((out) => out.trim())
    .catch((e) => String(e));
  const check = dockerCheck;
  check.then((why) => why && check === dockerCheck && (dockerCheck = null));
  return check;
}

export const stopRun = (item: RunItem) => stopItem(item);

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
    if (!TEST_LINE.test(model.getLineContent(i))) continue;
    const last = testStatusAt(t.path, i);
    decorations.push({
      range: new monaco.Range(i, 1, i, 1),
      options: {
        glyphMarginClassName: last ? `codicon codicon-${statusIcon(last)} glyph-run ${last}` : "codicon codicon-play glyph-run",
        glyphMarginHoverMessage: { value: `${last ? `Last run: ${last === "pending" ? "ignored" : last}. ` : ""}Run (Alt+click to debug)` },
      },
    });
  }
  gutterDecor.set(decorations);
}
onTestStatuses(refreshTestGutter);

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

const select = h("select", { class: "run-select", title: "Run/Debug Configurations" });
/// "Run 'Rails server' ⌃R": the selected configuration's name plus the live shortcut, refreshed on hover.
function namedTip(btn: HTMLButtonElement, verb: string, command: string) {
  btn.addEventListener("mouseenter", () => (btn.title = tip(selected() ? `${verb} '${selected()!.name}'` : verb, command)));
  return btn;
}
const widget = document.getElementById("run-widget")!;
widget.append(
  select,
  namedTip(iconButton("play", "Run", () => selected() && launch(selected()!, "run"), "runSelected"), "Run", "runSelected"),
  namedTip(iconButton("debug-alt", "Debug", () => selected() && launch(selected()!, "debug"), "debugSelected"), "Debug", "debugSelected"),
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
  if (!(await askTrust())) return;
  const p = state.project!;
  toast("Loading tasks…");
  let out: string;
  try {
    out = await api.runCapture(root(), `${p.rails ? "bin/rails -T" : "bundle exec rake -T"} 2>&1`, 180);
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
      ...configs.map((c) => ({ label: c.name, description: buildCommand(c), icon: TYPE_ICONS[c.type] ?? (mode === "run" ? "play" : "debug-alt"), data: c })),
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

/// Edits are written to the project's run configuration files, so editing waits for Trust.
export async function editConfigurations() {
  if (!state.project || !(await askTrust())) return;
  renderWidget();
  let draft: RunConfig[] = structuredClone(configs);
  let current = Math.max(0, draft.findIndex((c) => c.name === selectedName));
  const list = h("div", { class: "rc-list" });
  const form = h("div", { class: "rc-form" });
  const preview = h("code", { class: "rc-preview" });
  let dockerWhy: string | null = null;
  let services: string[] = [];
  dockerUnavailable().then(async (why) => {
    dockerWhy = why;
    if (!why && isTrusted()) {
      const files = [...new Set(draft.map((c) => c.docker?.composeFile.trim() ?? ""))];
      const lists = await Promise.all(files.map((f) => api.runCapture(root(), `docker compose ${f ? `-f ${shellQuote(f)} ` : ""}config --services 2>/dev/null`, 30).catch(() => "")));
      services = [...new Set(lists.flatMap((l) => l.split("\n").map((x) => x.trim()).filter(Boolean)))];
    }
    if (backdrop.isConnected) renderForm();
  });

  const field = (label: string, input: HTMLElement, hint = "") =>
    h("label", { class: "rc-field" }, h("span", {}, label), input, hint ? h("small", { class: "dim" }, hint) : null);

  const renderList = () =>
    list.replaceChildren(
      ...draft.map((c, i) =>
        h("div", { class: `rc-item${i === current ? " selected" : ""}`, onclick: () => ((current = i), render()) }, h("span", {}, icon(TYPE_ICONS[c.type] ?? "play"), " ", c.name), h("small", { class: "dim" }, TYPE_LABELS[c.type])),
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
    const shared = h("input", { type: "checkbox", checked: !!c.shared, disabled: !isTrusted() && !c.shared });
    shared.onchange = () => ((c.shared = shared.checked), renderForm());
    const env = h("textarea", { class: "commit-message", rows: 4, spellcheck: false, placeholder: "RAILS_ENV=development\nPORT=3000" }, Object.entries(c.env).map(([k, v]) => `${k}=${v}`).join("\n"));
    env.oninput = () => ((c.env = parseDotenv(env.value)), update());
    const dockerBox = h("input", { type: "checkbox", checked: !!c.docker, disabled: dockerWhy !== "" && !c.docker });
    dockerBox.onchange = () => {
      c.docker = dockerBox.checked ? { ...defaultDocker(), service: services[0] ?? "" } : undefined;
      renderForm();
    };
    const dockerFields = () => {
      const d = c.docker!;
      const input = (key: "service" | "composeFile" | "containerRoot", placeholder: string, list?: string) => {
        const el = h("input", { class: "search-input", value: d[key], placeholder, spellcheck: false, list });
        el.oninput = () => ((d[key] = el.value.trim()), update());
        return el;
      };
      const mode = h("select", { class: "run-select" }, h("option", { value: "run", selected: d.mode === "run" }, "docker compose run (new container)"), h("option", { value: "exec", selected: d.mode === "exec" }, "docker compose exec (running container)"));
      mode.onchange = () => ((d.mode = mode.value as DockerTarget["mode"]), renderForm());
      const servicePorts = h("input", { type: "checkbox", checked: d.servicePorts });
      servicePorts.onchange = () => ((d.servicePorts = servicePorts.checked), update());
      const socket = h("input", { class: "search-input", value: d.socketPath, placeholder: "tmp/rdbg.sock", spellcheck: false });
      socket.oninput = () => ((d.socketPath = socket.value.trim()), renderForm());
      const port = h("input", { class: "search-input", type: "number", min: 1, max: 65535, value: String(d.debugPort) });
      port.oninput = () => ((d.debugPort = Number(port.value) || d.debugPort), update());
      return [
        field("Service", input("service", "web", "rc-services"), services.length ? `services: ${services.join(", ")}` : "service name from the compose file"),
        h("datalist", { id: "rc-services" }, ...services.map((sv) => h("option", { value: sv }))),
        field("Mode", mode),
        field("Compose file", input("composeFile", "docker-compose.yml"), "relative to the project root; empty uses compose's default lookup"),
        field("Project root in container", input("containerRoot", "/app"), `path mapping for the debugger: ${root()} ↔ container path`),
        d.mode === "run" ? h("label", { class: "rc-check" }, servicePorts, " Publish the service's ports (--service-ports)") : null,
        field("rdbg socket on a shared volume (optional)", socket, "relative to the project root, which must be mounted at the container path; preferred over TCP. Docker Desktop for Mac can't share sockets through bind mounts, so leave empty there"),
        d.socketPath
          ? null
          : d.mode === "exec"
            ? field("rdbg port", port, `debugging with exec needs this port published on loopback only: ports: ["127.0.0.1:${d.debugPort}:${d.debugPort}"]; Garnet refuses ports published on all interfaces`)
            : h("small", { class: "dim" }, "Debug publishes a free port on 127.0.0.1 only and attaches to rdbg in the container. The service needs the debug gem."),
        c.type === "rails-server" ? h("small", { class: "dim" }, `Effective Rails binding: ${c.args.match(/(?:^|\s)(?:-b|--binding)[\s=](\S+)/)?.[1] ?? setting<string>("rails.serverBinding")} (from ${/(^|\s)(-b|--binding)\b/.test(c.args) ? "the arguments" : "Settings › Rails"}); inside a container 127.0.0.1 is only reachable from the container itself`) : null,
      ];
    };
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
      h(
        "label",
        { class: "rc-check", title: isTrusted() ? "" : "Trust the project to share configurations through it" },
        shared,
        " Store as project file (share via VCS)",
        h("small", { class: "dim" }, c.shared ? "  .garnet/run.json" : "  kept in Garnet's settings, not in the repository"),
      ),
      h("label", { class: "rc-check", title: dockerWhy || "" }, dockerBox, " Run inside a Docker Compose service", dockerWhy ? h("small", { class: "dim" }, ` (unavailable: ${dockerWhy})`) : dockerWhy === null ? h("small", { class: "dim" }, " (checking Docker…)") : null),
      ...(c.docker ? dockerFields().filter((x): x is HTMLElement => !!x) : []),
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
      items: Object.entries(TYPE_LABELS).map(([v, l]) => ({ label: l, icon: TYPE_ICONS[v as RunType], data: v })),
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
    const badDocker = draft.find((c) => c.docker && !validateDocker(c.docker));
    if (badDocker) return toast(`"${badDocker.name}": enter a service name, an absolute container path, a relative compose file and a valid port.`, "error");
    draft = draft.map((c) => (c.docker ? { ...c, docker: validateDocker(c.docker)! } : c));
    if (draft[current]) selectedName = draft[current].name;
    await saveRunConfigs(draft);
    close();
  };

  const dialog = h(
    "div",
    { class: "rc-dialog" },
    h("div", { class: "rc-title" }, icon("play"), " Run / Debug Configurations"),
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
  const backdrop = modal(dialog, () => close());
  render();
}
