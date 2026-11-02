import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { openFile } from "./editor";
import { Channel, invoke, type PtyEvent } from "./ipc";
import { isDarkTheme, onSettingsChange, setting } from "./settings";
import { abs, root } from "./state";
import { TERMINAL } from "./theme";
import { bottom, h, icon, iconButton } from "./ui";


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
  el = h("div", { class: "pty" });
  id: number | null = null;
  exited = false;
  private observer: ResizeObserver;

  constructor(private opts: PtyOptions = {}) {
    this.term = new Terminal({
      ...termOptions(),
      scrollback: opts.command ? setting<number>("run.consoleScrollback") : 10000,
      allowProposedApi: true,
      macOptionIsMeta: true,
    });
    this.term.loadAddon(this.fit);
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
      if (ev.type === "data") this.term.write(ev.data);
      else {
        this.exited = true;
        this.term.write(`\r\n\x1b[2m[process exited${ev.code !== null ? ` with code ${ev.code}` : ""}]\x1b[0m\r\n`);
        this.opts.onExit?.(ev.code);
      }
    };
    this.id = await invoke<number>("pty_spawn", {
      cwd: this.opts.cwd ?? root(),
      command: this.opts.command ?? null,
      env: { ...setting<Record<string, string>>("terminal.env"), ...this.opts.env },
      shell: setting<string>("terminal.shell") || null,
      cols: this.term.cols,
      rows: this.term.rows,
      onEvent: channel,
    });
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
  el = h("div", { class: "pty-tabs" }, h("div", { class: "subtab-bar" }, this.tabsEl, this.toolbar), this.bodyEl);
  items: { title: string; view: PtyView; tab: HTMLElement; status: string }[] = [];
  active: PtyTabs["items"][number] | null = null;

  add(title: string, view: PtyView) {
    const item = { title, view, tab: h("div"), status: "" };
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
        h(
          "div",
          {
            class: `subtab${item === this.active ? " active" : ""} ${item.status}`,
            onmousedown: (e: MouseEvent) => (e.button === 1 ? this.close(item) : this.select(item)),
          },
          item.status ? icon(item.status === "running" ? "loading" : item.status === "ok" ? "pass" : "error", item.status === "running" ? "codicon-modifier-spin" : "") : null,
          h("span", {}, item.title),
          h("button", { class: "tab-close", title: "Close", "aria-label": "Close", onmousedown: (e: MouseEvent) => e.stopPropagation(), onclick: () => this.close(item) }, icon("close")),
        ),
      ),
    );
  }

  fitActive() {
    this.active?.view.fitSoon();
  }
}

export const terminals = new PtyTabs();
let termCount = 0;
terminals.toolbar.append(iconButton("add", "New Terminal", () => newTerminal()));

export function newTerminal() {
  terminals.add(`Local${++termCount > 1 ? ` (${termCount})` : ""}`, new PtyView());
}

/// Runs a command the user asked for in a new Terminal tab, so its output stays visible.
export function runInTerminal(title: string, command: string, onExit?: (code: number | null) => void) {
  const item = terminals.add(title, new PtyView({ command, onExit }));
  bottom.show("terminal");
  return item;
}

export function showTerminalPanel() {
  if (!terminals.items.length) newTerminal();
  else terminals.active?.view.term.focus();
  terminals.fitActive();
}
