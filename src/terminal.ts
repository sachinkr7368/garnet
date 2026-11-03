import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { eventKey, keysFor } from "./commands";
import "@xterm/xterm/css/xterm.css";
import { openFile } from "./editor";
import { Channel, invoke, type PtyEvent } from "./ipc";
import { askTrust, isDarkTheme, isTrusted, onSettingsChange, setting } from "./settings";
import { abs, root } from "./state";
import { TERMINAL } from "./theme";
import { bottom, h, icon, iconButton, overflowStrip, toast } from "./ui";


const views = new Set<PtyView>();
const termOptions = () => ({
  theme: TERMINAL[isDarkTheme() ? "dark" : "light"],
  fontSize: setting<number>("terminal.fontSize"),
  fontFamily: setting<string>("terminal.fontFamily") || setting<string>("editor.fontFamily"),
  cursorBlink: setting<boolean>("terminal.cursorBlink"),
});
onSettingsChange(() => {
  for (const v of views) {
    Object.assign(v.term.options, termOptions());
    v.fitSoon();
  }
});

export const FILE_LINE = /((?:\.{0,2}\/)?[\w@.\-/]+\.(?:rb|erb|rake|ru|ya?ml|haml|slim|jbuilder|js|ts|css|scss|json)):(\d+)(?::(\d+))?/g;

export interface PtyOptions {
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  onExit?: (code: number | null) => void;
}

/// An xterm.js view bound to a backend PTY session.
export class PtyView {
  term: Terminal;
  fit = new FitAddon();
  search = new SearchAddon();
  /// Set by PtyTabs: the Find keystroke (⌘F) in this terminal, and search result counts.
  onFind?: () => void;
  onResults?: (r: { resultIndex: number; resultCount: number }) => void;
  el = h("div", { class: "pty" });
  id: number | null = null;
  exited = false;
  private disposed = false;
  private observer: ResizeObserver;

  constructor(private opts: PtyOptions = {}) {
    this.term = new Terminal({
      ...termOptions(),
      scrollback: opts.command ? setting<number>("run.consoleScrollback") : 10000,
      allowProposedApi: true,
      macOptionIsMeta: true,
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.search.onDidChangeResults((r) => this.onResults?.(r));
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !this.onFind || !keysFor("find").includes(eventKey(e))) return true;
      e.preventDefault();
      this.onFind();
      return false;
    });
    this.term.registerLinkProvider({
      provideLinks: (y, callback) => {
        const line = this.term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
        const links = [...line.matchAll(FILE_LINE)].map((m) => ({
          range: { start: { x: m.index! + 1, y }, end: { x: m.index! + m[0].length, y } },
          text: m[0],
          activate: () => openFile(abs(m[1]), { line: Number(m[2]), column: Number(m[3] ?? 1) }),
        }));
        callback(links);
      },
    });
    this.observer = new ResizeObserver(() => this.fitSoon());
    views.add(this);
  }

  private fitTimer = 0;
  fitSoon() {
    clearTimeout(this.fitTimer);
    this.fitTimer = window.setTimeout(() => {
      if (!this.el.isConnected || this.el.offsetParent === null) return;
      this.fit.fit();
      if (this.id !== null && !this.exited)
        invoke("pty_resize", { id: this.id, cols: this.term.cols, rows: this.term.rows }).catch(() => {});
    }, 30);
  }

  async start(host: HTMLElement) {
    host.append(this.el);
    this.term.open(this.el);
    this.observer.observe(this.el);
    this.fit.fit();
    const channel = new Channel<PtyEvent>();
    channel.onmessage = (ev) => {
      if (ev.type === "data") {
        if (!this.disposed) this.term.write(ev.data);
        return;
      }
      this.exited = true;
      // The tab may already be closed (xterm disposed); the exit callback (test tree, run status) still has to run.
      this.opts.onExit?.(ev.code);
      if (!this.disposed) this.term.write(`\r\n\x1b[2m[process exited${ev.code !== null ? ` with code ${ev.code}` : ""}]\x1b[0m\r\n`);
    };
    const shell = setting<string>("terminal.shell") || null;
    let id: number;
    try {
      id = await invoke<number>("pty_spawn", {
        cwd: this.opts.cwd ?? root(),
        command: this.opts.command ?? null,
        env: { ...setting<Record<string, string>>("terminal.env"), ...this.opts.env },
        shell,
        cols: this.term.cols,
        rows: this.term.rows,
        onEvent: channel,
      });
    } catch (e) {
      this.exited = true;
      if (!this.disposed) this.term.write(`\x1b[31m${String(e)}\x1b[0m\r\n`);
      toast(`Could not start ${shell ?? "the shell"}: ${e}`, "error", shell ? [{ label: "Fix in Settings", run: () => window.dispatchEvent(new CustomEvent("garnet:open-settings", { detail: "Terminal" })) }] : []);
      this.opts.onExit?.(null);
      return;
    }
    // Closed while the process was starting: nobody will kill it otherwise.
    if (this.disposed) return void invoke("pty_kill", { id }).catch(() => {});
    this.id = id;
    this.term.onData((data) => {
      if (this.id !== null && !this.exited) invoke("pty_write", { id: this.id, data }).catch(() => {});
    });
  }

  kill() {
    if (this.id !== null && !this.exited) invoke("pty_kill", { id: this.id });
  }

  interrupt() {
    if (this.id !== null && !this.exited) invoke("pty_write", { id: this.id, data: "\x03" });
  }

  dispose() {
    this.disposed = true;
    this.kill();
    this.observer.disconnect();
    views.delete(this);
    this.term.dispose();
    this.el.remove();
  }
}

/// A tabbed set of PtyViews; used by the Terminal and Run tool windows.
export class PtyTabs {
  tabsEl = h("div", { class: "subtabs" });
  bodyEl = h("div", { class: "subtab-body" });
  toolbar = h("div", { class: "subtab-tools" });
  /// Safe Mode: what this window would run needs trust (the backend refuses terminals and commands until then).
  gate = h("div", { class: "empty pty-gate", hidden: true });
  el = h("div", { class: "pty-tabs" }, h("div", { class: "subtab-bar" }, this.tabsEl, this.toolbar), this.gate, this.bodyEl);
  items: { title: string; view: PtyView; tab: HTMLElement; status: string }[] = [];
  active: PtyTabs["items"][number] | null = null;
  overflow = overflowStrip(this.tabsEl, {
    title: "Show Hidden Tabs",
    label: (t) => t.querySelector("span:not(.codicon)")?.textContent ?? "",
    pick: (t) => {
      const item = this.items.find((i) => i.tab === t);
      if (item) this.select(item);
    },
    close: (t) => {
      const item = this.items.find((i) => i.tab === t);
      if (item) this.close(item);
    },
  });

  findInput = h("input", { class: "search-input term-find-input", placeholder: "Find", spellcheck: false, "aria-label": "Find in terminal" });
  findCount = h("span", { class: "dim term-find-count" });
  findBar = h(
    "div",
    { class: "term-find", hidden: true },
    this.findInput,
    this.findCount,
    iconButton("arrow-up", "Previous Occurrence", () => this.find(-1)),
    iconButton("arrow-down", "Next Occurrence", () => this.find(1)),
    iconButton("close", "Close", () => this.closeFind()),
  );

  constructor() {
    window.addEventListener("garnet:trusted", () => (this.gate.hidden = true));
    this.bodyEl.append(this.findBar);
    this.findInput.addEventListener("input", () => this.find(0));
    this.findInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.find(e.shiftKey ? -1 : 1);
      else if (e.key === "Escape") this.closeFind();
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }

  /// Find in the active terminal (⌘F there): highlights every match and steps through them.
  openFind() {
    const view = this.active?.view;
    if (!view) return;
    const sel = view.term.getSelection();
    if (sel && !sel.includes("\n")) this.findInput.value = sel;
    this.findBar.hidden = false;
    this.findInput.focus();
    this.findInput.select();
    if (this.findInput.value) this.find(0);
  }

  find(dir: -1 | 0 | 1): boolean {
    const view = this.active?.view;
    if (!view) return false;
    const term = this.findInput.value;
    view.onResults = (r) => (this.findCount.textContent = r.resultCount ? `${r.resultIndex + 1}/${r.resultCount}` : "No matches");
    if (!term) {
      view.search.clearDecorations();
      this.findCount.textContent = "";
      return false;
    }
    const opts: ISearchOptions = { incremental: dir === 0, decorations: FIND_DECORATIONS };
    const found = dir < 0 ? view.search.findPrevious(term, opts) : view.search.findNext(term, opts);
    if (!found) this.findCount.textContent = "No matches";
    return found;
  }

  closeFind() {
    this.findBar.hidden = true;
    this.active?.view.search.clearDecorations();
    this.active?.view.term.focus();
  }

  showGate(message: string) {
    this.gate.replaceChildren(h("span", {}, message), " ", h("button", { class: "btn primary", onclick: () => void askTrust() }, "Trust Project"));
    this.gate.hidden = false;
  }

  add(title: string, view: PtyView) {
    const item = { title, view, tab: h("div"), status: "" };
    view.onFind = () => this.openFind();
    this.items.push(item);
    view.start(this.bodyEl);
    this.select(item);
    return item;
  }

  select(item: PtyTabs["items"][number]) {
    this.active = item;
    for (const i of this.items) i.view.el.hidden = i !== item;
    this.render();
    item.view.fitSoon();
    item.view.term.focus();
  }

  close(item: PtyTabs["items"][number]) {
    const i = this.items.indexOf(item);
    if (i < 0) return;
    this.items.splice(i, 1);
    item.view.dispose();
    if (this.active === item) {
      const next = this.items[Math.min(i, this.items.length - 1)];
      if (next) this.select(next);
      else this.active = null;
    }
    this.render();
  }

  setStatus(item: PtyTabs["items"][number], status: string) {
    item.status = status;
    this.render();
  }

  render() {
    this.tabsEl.replaceChildren(
      ...this.items.map((item) =>
        (item.tab = h(
          "div",
          {
            class: `subtab${item === this.active ? " active" : ""} ${item.status}`,
            onmousedown: (e: MouseEvent) => (e.button === 1 ? this.close(item) : this.select(item)),
          },
          item.status ? icon(item.status === "running" ? "loading" : item.status === "ok" ? "pass" : "error", item.status === "running" ? "codicon-modifier-spin" : "") : null,
          h("span", {}, item.title),
          h("button", { class: "tab-close", title: "Close", "aria-label": "Close", onmousedown: (e: MouseEvent) => e.stopPropagation(), onclick: () => this.close(item) }, icon("close")),
        )),
      ),
      this.overflow.more,
    );
    this.overflow.fit();
  }

  fitActive() {
    this.active?.view.fitSoon();
  }
}

const FIND_DECORATIONS = {
  matchBackground: "#d7a74466",
  matchOverviewRuler: "#d7a744",
  activeMatchBackground: "#e8b84d",
  activeMatchColorOverviewRuler: "#e8b84d",
};

export const terminals = new PtyTabs();
let termCount = 0;
terminals.toolbar.append(iconButton("add", "New Terminal", () => newTerminal()));

const TERMINAL_GATE = "Trust project to open a terminal.";
window.addEventListener("garnet:trusted", () => bottom.active === "terminal" && !terminals.items.length && newTerminal());

export function newTerminal(cwd?: string) {
  if (!isTrusted()) return terminals.showGate(TERMINAL_GATE);
  // Like RubyMine, a shell that exits (exit, ⌃D) closes its tab; one Garnet killed or could not start stays.
  const item = terminals.add(`Local${++termCount > 1 ? ` (${termCount})` : ""}`, new PtyView({ cwd, onExit: (code) => code === 0 && terminals.close(item) }));
}

/// Runs a command the user asked for in a new Terminal tab, so its output stays visible.
export function runInTerminal(title: string, command: string, onExit?: (code: number | null) => void) {
  const item = terminals.add(title, new PtyView({ command, onExit }));
  bottom.show("terminal");
  return item;
}

export function showTerminalPanel() {
  if (!isTrusted()) terminals.showGate(TERMINAL_GATE);
  else if (!terminals.items.length) newTerminal();
  else terminals.active?.view.term.focus();
  terminals.fitActive();
}
