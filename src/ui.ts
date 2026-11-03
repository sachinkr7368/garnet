type Child = Node | string | null | undefined | false;
type Props = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "style") el.setAttribute("style", String(v));
    else if (k.startsWith("on") && typeof v === "function") (el as any)[k.toLowerCase()] = v;
    else if (k in el) (el as any)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export const icon = (name: string, extra = "") => h("span", { class: `codicon codicon-${name} ${extra}` });

let shortcutFor: (command: string) => string = () => "";
/// commands.ts registers the keymap lookup here, so tooltips follow rebinds without a circular import.
export const setShortcutResolver = (fn: (command: string) => string) => (shortcutFor = fn);

/// "Action ⌘K" when the command has a shortcut in the current keymap, else just the action name.
export function tip(title: string, command?: string) {
  const key = command ? shortcutFor(command) : "";
  return key ? `${title} ${key}` : title;
}

/// Keeps an element's tooltip in sync with the keymap: resolved now and again on every hover.
export function withTip<T extends HTMLElement>(el: T, title: string, command?: string): T {
  el.title = tip(title, command);
  el.setAttribute("aria-label", title);
  if (command) el.addEventListener("mouseenter", () => (el.title = tip(title, command)));
  return el;
}

const FILE_ICONS: [RegExp, string][] = [
  [/(\.(rb|rake|gemspec|ru|jbuilder)|^(Gemfile|Rakefile|Guardfile|Capfile|Brewfile))$/, "ruby"],
  [/\.(erb|haml|slim|html?)$/, "code"],
  [/\.(ya?ml|toml|ini|env)$|^\.env/, "settings"],
  [/\.json$/, "json"],
  [/\.(md|markdown)$/, "markdown"],
  [/\.(js|mjs|cjs|ts|tsx|jsx|coffee)$/, "file-code"],
  [/\.(css|scss|sass|less)$/, "symbol-color"],
  [/\.(png|jpe?g|gif|svg|ico|webp)$/, "file-media"],
  [/\.(sql|sqlite3?|db)$/, "database"],
  [/\.(sh|bash|zsh)$|^(Procfile.*|Dockerfile.*)$/, "terminal"],
  [/\.lock$/, "lock"],
  [/\.log$/, "output"],
  [/\.(zip|gz|tgz|tar)$/, "file-zip"],
];

/// Codicon for a file, by type (Ruby, ERB, YAML, JS…), like RubyMine's file-type icons.
export function fileIconName(path: string): string {
  const name = path.split("/").pop() ?? path;
  return FILE_ICONS.find(([re]) => re.test(name))?.[1] ?? "file";
}

export const fileIcon = (path: string, extra = "") => {
  const ext = path.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
  return icon(fileIconName(path), `file-icon${ext ? ` ext-${ext}` : ""}${extra ? ` ${extra}` : ""}`);
};

const MENU_ICONS: [RegExp, string][] = [
  [/^(copy|copy \w+)/i, "copy"],
  [/^(delete|remove|drop)/i, "trash"],
  [/^rename/i, "edit"],
  [/^edit/i, "edit"],
  [/^new file/i, "new-file"],
  [/^new folder/i, "new-folder"],
  [/^new\b/i, "add"],
  [/^(reveal|show in finder|open in finder)/i, "folder-opened"],
  [/history|log\b/i, "history"],
  [/^open on github|github/i, "github"],
  [/^open/i, "go-to-file"],
  [/^debug/i, "debug-alt"],
  [/^(run|rerun)/i, "play"],
  [/^(refresh|reload)/i, "refresh"],
  [/^(rollback|revert|discard)/i, "discard"],
  [/^unstage/i, "remove"],
  [/^stage/i, "add"],
  [/^(checkout|check out|switch)/i, "git-branch"],
  [/^cherry/i, "git-commit"],
  [/^(compare|show diff|diff)/i, "git-compare"],
  [/^merge/i, "git-merge"],
  [/^rebase/i, "git-pull-request"],
  [/^(push)/i, "repo-push"],
  [/^(pull|update|fetch)/i, "repo-pull"],
  [/^(stash|unstash)/i, "archive"],
  [/breakpoint|logpoint/i, "debug-breakpoint"],
  [/condition|pass count/i, "filter"],
  [/^(disable|enable)/i, "circle-slash"],
  [/^(connect)/i, "plug"],
  [/^(disconnect)/i, "debug-disconnect"],
  [/^(go to|jump to|navigate)/i, "arrow-right"],
  [/^(annotate|blame)/i, "person"],
  [/^(mark|toggle)/i, "check"],
];

/// Default icon for a context-menu item from its label, so every menu shows icons without each caller listing them.
export const menuIconFor = (label: string) => MENU_ICONS.find(([re]) => re.test(label))?.[1] ?? "blank";

export function iconButton(name: string, title: string, onclick: (e: MouseEvent) => void, command?: string) {
  return withTip(h("button", { class: "icon-btn", onclick }, icon(name)), title, command);
}

/// Which tabs of a strip stay visible: all when they fit, else as many as fit in order next to the "»" button,
/// always including the active one.
export function fitTabs(widths: number[], available: number, moreWidth: number, active: number): number[] {
  const all = widths.map((_, i) => i);
  if (widths.reduce((a, b) => a + b, 0) <= available) return all;
  let budget = available - moreWidth - (widths[active] ?? 0);
  const keep = new Set(active >= 0 && active < widths.length ? [active] : []);
  for (const i of all) {
    if (keep.has(i)) continue;
    if (widths[i] > budget) break;
    budget -= widths[i];
    keep.add(i);
  }
  return all.filter((i) => keep.has(i));
}

const codiconOf = (el: Element) => el.querySelector(".codicon")?.className.match(/codicon-([\w-]+)/)?.[1] ?? "blank";

/// Opens a "»" menu under its button and keeps aria-expanded in step with it.
function overflowMenu(more: HTMLElement, items: MenuItem[]) {
  const r = more.getBoundingClientRect();
  const { menu } = contextMenu({ clientX: r.left, clientY: r.bottom, preventDefault() {} } as MouseEvent, items);
  more.setAttribute("aria-expanded", "true");
  const root = document.getElementById("overlay-root")!;
  const watch = new MutationObserver(() => {
    if (menu.isConnected) return;
    more.setAttribute("aria-expanded", "false");
    watch.disconnect();
  });
  watch.observe(root, { childList: true });
}

const moreButton = (cls: string, title: string) => {
  const more = withTip(h("button", { class: cls, hidden: true, "aria-haspopup": "menu", "aria-expanded": "false" }, "»"), title);
  return more;
};

interface StripOptions {
  title: string;
  label: (tab: HTMLElement) => string;
  pick: (tab: HTMLElement) => void;
  detail?: (tab: HTMLElement) => string | undefined;
  close?: (tab: HTMLElement) => void;
}

/// Keeps a tab strip on one line: tabs that don't fit are hidden and listed in a trailing "»" menu.
export function overflowStrip(strip: HTMLElement, opts: StripOptions) {
  const tabs = () => [...strip.children].filter((c): c is HTMLElement => c !== more && c instanceof HTMLElement);
  const more = moreButton("tab-overflow", opts.title);
  more.onclick = () =>
    overflowMenu(
      more,
      tabs()
        .filter((t) => t.hidden)
        .map((t) => ({ label: opts.label(t), detail: opts.detail?.(t), title: t.title, icon: codiconOf(t), run: () => opts.pick(t), close: opts.close && (() => opts.close!(t)) })),
    );
  strip.append(more);
  const fit = () => {
    const all = tabs();
    for (const t of all) t.hidden = false;
    more.hidden = false;
    const style = getComputedStyle(strip);
    const gap = parseFloat(style.columnGap) || 0;
    const pad = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) || 0;
    const widths = all.map((t) => t.getBoundingClientRect().width + gap);
    const visible = new Set(fitTabs(widths, strip.clientWidth - pad, more.getBoundingClientRect().width + gap, all.findIndex((t) => t.classList.contains("active"))));
    all.forEach((t, i) => (t.hidden = !visible.has(i)));
    more.hidden = visible.size === all.length;
    if (!more.hidden && strip.lastElementChild !== more) strip.append(more);
  };
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => fit()).observe(strip);
  return { more, fit };
}

/// RubyMine's toolbar "»": icon buttons that don't fit move into a menu, starting from the end of the toolbar.
export function overflowToolbar(bar: HTMLElement) {
  const more = moreButton("icon-btn toolbar-overflow", "More actions");
  const buttons = () => [...bar.children].filter((c): c is HTMLButtonElement => c instanceof HTMLButtonElement && c.classList.contains("icon-btn") && c !== more);
  more.onclick = () =>
    overflowMenu(
      more,
      buttons()
        .filter((b) => b.classList.contains("overflowed") && !b.hidden)
        .map((b) => ({ label: b.getAttribute("aria-label") || b.title, title: b.title, icon: codiconOf(b), disabled: b.disabled, checked: b.matches(".on, .active") || undefined, run: () => b.click() })),
    );
  bar.append(more);
  const fit = () => {
    const all = buttons();
    for (const b of all) b.classList.remove("overflowed");
    more.hidden = true;
    if (bar.scrollWidth <= bar.clientWidth + 1) return;
    more.hidden = false;
    const gap = parseFloat(getComputedStyle(bar).columnGap) || 0;
    const widths = all.map((b) => b.getBoundingClientRect().width + gap);
    let excess = bar.scrollWidth - bar.clientWidth;
    let first = all.length;
    while (first > 0 && excess > 1) excess -= widths[--first];
    for (const b of all.slice(first)) b.classList.add("overflowed");
  };
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => fit()).observe(bar);
  return fit;
}

/// A toolbar built after its tool window was added, with the same "»" overflow.
export const withOverflow = (...args: Parameters<typeof h>) => {
  const bar = h(...args);
  overflowToolbar(bar);
  return bar;
};

/// Sidebar and bottom tool windows

interface View {
  id: string;
  title: string;
  icon: string;
  el: HTMLElement;
  command?: string;
  onShow?: () => void;
}

export class Dock {
  views = new Map<string, View>();
  active: string | null = null;
  private overflow: ReturnType<typeof overflowStrip> | null = null;
  private toolbars = new Map<string, (() => void)[]>();
  constructor(
    private host: HTMLElement,
    private head: HTMLElement,
    private body: HTMLElement,
    private strip: HTMLElement | null,
  ) {
    if (!strip) this.overflow = overflowStrip(head, { title: "More tool windows", label: (t) => t.textContent ?? "", pick: (t) => this.show(t.dataset.view!) });
  }

  add(view: View) {
    this.views.set(view.id, view);
    this.toolbars.set(view.id, [...view.el.querySelectorAll<HTMLElement>(".view-toolbar, .search-bar")].map(overflowToolbar));
    view.el.classList.add("view");
    view.el.hidden = true;
    this.body.append(view.el);
    const tab = withTip(h("button", { class: "dock-tab", onclick: () => this.toggle(view.id) }, icon(view.icon)), view.title, view.command);
    tab.dataset.view = view.id;
    if (!this.strip) tab.append(h("span", {}, view.title));
    if (this.overflow) this.overflow.more.before(tab);
    else (this.strip ?? this.head).append(tab);
  }

  show(id: string) {
    const view = this.views.get(id);
    if (!view) return;
    for (const v of this.views.values()) v.el.hidden = v.id !== id;
    this.host.hidden = false;
    this.active = id;
    for (const t of (this.strip ?? this.head).querySelectorAll<HTMLElement>(".dock-tab"))
      t.classList.toggle("active", t.dataset.view === id);
    if (this.strip) this.head.textContent = view.title;
    this.overflow?.fit();
    view.onShow?.();
    for (const fit of this.toolbars.get(id) ?? []) fit();
    window.dispatchEvent(new Event("resize"));
  }

  hide() {
    this.host.hidden = true;
    this.active = null;
    for (const t of (this.strip ?? this.head).querySelectorAll(".dock-tab")) t.classList.remove("active");
    this.overflow?.fit();
    window.dispatchEvent(new Event("resize"));
  }

  toggle(id: string) {
    if (this.active === id && !this.host.hidden) this.hide();
    else this.show(id);
  }

  /// JetBrains "Activate tool window": show and focus it; hide only when it is already focused.
  activate(id: string) {
    const view = this.views.get(id);
    if (!view) return;
    if (this.active === id && !this.host.hidden && view.el.contains(document.activeElement)) {
      this.hide();
      Dock.afterHide();
      return;
    }
    if (this.active !== id || this.host.hidden) this.show(id);
    else view.onShow?.();
    if (!view.el.contains(document.activeElement)) view.el.querySelector<HTMLElement>("[tabindex], input, textarea, .xterm-helper-textarea")?.focus();
  }

  static afterHide: () => void = () => {};
}

export const sidebar = new Dock(
  document.getElementById("sidebar")!,
  document.getElementById("sidebar-head")!,
  document.getElementById("sidebar-body")!,
  document.getElementById("toolstrip")!,
);
export const rightbar = new Dock(
  document.getElementById("rightbar")!,
  document.getElementById("rightbar-head")!,
  document.getElementById("rightbar-body")!,
  document.getElementById("rightstrip")!,
);
export const bottom = new Dock(
  document.getElementById("bottom")!,
  document.getElementById("bottom-head")!,
  document.getElementById("bottom-body")!,
  null,
);

const DRAG_ENDS = ["pointerup", "pointercancel", "lostpointercapture"] as const;

/// Tracks one pointer drag from `e` on `handle`. `body.resizing` turns off pointer events everywhere, so every way
/// a drag can end clears it: a release outside the window ends in pointercancel/lostpointercapture, not pointerup.
export function trackDrag(handle: HTMLElement, e: PointerEvent, onMove: (ev: PointerEvent) => void) {
  handle.setPointerCapture?.(e.pointerId);
  document.body.classList.add("resizing");
  const end = () => {
    handle.removeEventListener("pointermove", onMove);
    document.body.classList.remove("resizing");
    for (const t of DRAG_ENDS) handle.removeEventListener(t, end);
    window.removeEventListener("blur", end);
  };
  handle.addEventListener("pointermove", onMove);
  for (const t of DRAG_ENDS) handle.addEventListener(t, end);
  window.addEventListener("blur", end);
}

/// New width of a side panel dragged by its inner edge. `edgeOnRight` is true when the handle sits on the panel's
/// right edge (panel on the left of the window), false when it sits on its left edge (panel on the right).
export function dragWidth(rect: { left: number; right: number }, clientX: number, edgeOnRight: boolean, min: number, max: number) {
  return Math.max(min, Math.min(max, edgeOnRight ? clientX - rect.left : rect.right - clientX));
}

/// Caps the bottom panel and the side panels to what the window has room for, keeping 120px for the editor and its
/// tabs and 320px of editor width. Caps (not sizes) so a panel grows back when the window does.
export function clampPanels() {
  const main = document.getElementById("main")!.getBoundingClientRect().width - document.getElementById("toolstrip")!.offsetWidth - document.getElementById("rightstrip")!.offsetWidth;
  const center = document.getElementById("center")!.getBoundingClientRect().height;
  const side = document.getElementById("sidebar")!;
  const right = document.getElementById("rightbar")!;
  document.getElementById("bottom")!.style.maxHeight = `${Math.max(80, center - 120)}px`;
  const room = main - 320;
  const wanted = (el: HTMLElement, fallback: number) => (el.hidden ? 0 : Math.min(parseFloat(el.style.width) || fallback, room / 2));
  side.style.maxWidth = `${Math.max(160, room - wanted(right, 340))}px`;
  right.style.maxWidth = `${Math.max(200, room - wanted(side, 280))}px`;
}

export function setupResizers() {
  window.addEventListener("resize", clampPanels);
  clampPanels();
  const drag = (handle: HTMLElement, onMove: (e: PointerEvent) => void) =>
    handle.addEventListener("pointerdown", (e) =>
      trackDrag(handle, e, (ev) => {
        onMove(ev);
        window.dispatchEvent(new Event("resize"));
      }),
    );
  // With "Tool window bar position: right" the row is reversed: the sidebar sits on the right and the rightbar on the left.
  const flipped = () => document.body.classList.contains("sidebar-right");
  const side = document.getElementById("sidebar")!;
  drag(document.getElementById("sidebar-resizer")!, (e) => {
    side.style.width = `${dragWidth(side.getBoundingClientRect(), e.clientX, !flipped(), 160, 700)}px`;
  });
  const right = document.getElementById("rightbar")!;
  drag(document.getElementById("rightbar-resizer")!, (e) => {
    right.style.width = `${dragWidth(right.getBoundingClientRect(), e.clientX, flipped(), 200, 800)}px`;
  });
  const bottomEl = document.getElementById("bottom")!;
  drag(document.getElementById("bottom-resizer")!, (e) => {
    const total = document.getElementById("center")!.getBoundingClientRect().bottom;
    bottomEl.style.height = `${Math.max(100, Math.min(window.innerHeight - 160, total - e.clientY))}px`;
  });
}

/// Fuzzy subsequence scoring for small in-memory lists (commands, symbols).

export function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === " ") continue;
    const i = t.indexOf(ch, ti);
    if (i < 0) return null;
    score += i === prev + 1 ? 5 : 1;
    if (i === 0 || /[\s_\-/.:#]/.test(t[i - 1]) || (text[i] >= "A" && text[i] <= "Z")) score += 3;
    prev = i;
    ti = i + 1;
  }
  return score - t.length * 0.01;
}

export function fuzzyFilter<T>(query: string, items: T[], key: (t: T) => string): T[] {
  if (!query.trim()) return items;
  return items
    .map((item) => ({ item, s: fuzzyScore(query, key(item)) }))
    .filter((x) => x.s !== null)
    .sort((a, b) => b.s! - a.s!)
    .map((x) => x.item);
}

/// Quick pick overlay

export interface PickItem {
  label: string;
  description?: string;
  detail?: string;
  icon?: string;
  data?: unknown;
}

interface QuickPickOptions {
  placeholder: string;
  title?: string;
  items: PickItem[] | ((query: string) => Promise<PickItem[]> | PickItem[]);
  value?: string;
  onAccept: (item: PickItem | undefined, query: string) => void;
  onChange?: (item: PickItem | undefined) => void;
  onClose?: () => void;
  selected?: number;
}

const pickKey = (i: PickItem | undefined) => (i ? `${i.label}\0${i.description ?? ""}\0${JSON.stringify(i.data ?? null)}` : "");

let closeActiveOverlay: (() => void) | null = null;

/// WebKit fires a mousemove with unchanged coordinates when a list scrolls under a still pointer; only a real
/// move may change a hovered list's selection, so arrow-key paging never jumps to the row under the pointer.
let pointerMoved = false;
let lastPointer = { x: NaN, y: NaN };
window.addEventListener(
  "mousemove",
  (e) => {
    pointerMoved = e.clientX !== lastPointer.x || e.clientY !== lastPointer.y;
    lastPointer = { x: e.clientX, y: e.clientY };
  },
  true,
);

const MAX_ROWS = 200;

export function quickPick(opts: QuickPickOptions) {
  closeActiveOverlay?.();
  const previousFocus = document.activeElement as HTMLElement | null;
  const input = h("input", { class: "qp-input", placeholder: opts.placeholder, spellcheck: false, value: opts.value ?? "" });
  const list = h("div", { class: "qp-list" });
  const box = h("div", { class: "qp" }, opts.title ? h("div", { class: "qp-title" }, opts.title) : null, input, list);
  const backdrop = h("div", { class: "qp-backdrop", onmousedown: (e: MouseEvent) => e.target === backdrop && close() }, box);
  document.getElementById("overlay-root")!.append(backdrop);
  let items: PickItem[] = [];
  let selected = 0;
  let seq = 0;
  let first = true;
  let shown: string | null = null;

  const close = () => {
    backdrop.remove();
    closeActiveOverlay = null;
    opts.onClose?.();
    previousFocus?.focus?.();
  };
  closeActiveOverlay = close;

  const render = () => {
    list.replaceChildren(
      ...items.slice(0, MAX_ROWS).map((item, i) =>
        h(
          "div",
          {
            class: `qp-item${i === selected ? " selected" : ""}`,
            onmousemove: () => pointerMoved && select(i),
            onmousedown: (e: MouseEvent) => {
              e.preventDefault();
              selected = i;
              accept();
            },
          },
          item.icon ? icon(item.icon) : null,
          h("span", { class: "qp-label" }, item.label),
          item.description ? h("span", { class: "qp-desc" }, item.description) : null,
          item.detail ? h("span", { class: "qp-detail" }, item.detail) : null,
        ),
      ),
    );
    list.children[selected]?.scrollIntoView({ block: "nearest" });
    opts.onChange?.(items[selected]);
  };

  /// Hover moves the selection, like JetBrains popups; mousemove (not mouseenter) so keyboard scrolling under a still pointer keeps the keyboard's choice.
  const select = (i: number) => {
    if (i === selected) return;
    list.children[selected]?.classList.remove("selected");
    selected = i;
    list.children[i]?.classList.add("selected");
    opts.onChange?.(items[selected]);
  };

  const update = async () => {
    const mine = ++seq;
    const q = input.value;
    let next: PickItem[];
    try {
      next = typeof opts.items === "function" ? await opts.items(q) : fuzzyFilter(q, opts.items, (i) => `${i.label} ${i.description ?? ""}`);
    } catch (e) {
      if (mine !== seq) return;
      items = [];
      render();
      list.append(h("div", { class: "qp-item qp-error" }, icon("error"), h("span", { class: "qp-label" }, `Search failed: ${e instanceof Error ? e.message : e}`)));
      return;
    }
    if (mine !== seq) return;
    // A refresh of the same query (late results) keeps the selected item; a new query starts at the top.
    const keep = q === shown ? next.findIndex((i) => pickKey(i) === pickKey(items[selected])) : -1;
    items = next;
    selected = keep >= 0 ? keep : first ? Math.min(opts.selected ?? 0, Math.max(0, next.length - 1)) : 0;
    first = false;
    shown = q;
    list.dataset.query = q;
    render();
  };

  const accept = () => {
    const item = items[selected];
    const q = input.value;
    close();
    opts.onAccept(item, q);
  };

  input.addEventListener("input", update);
  input.addEventListener("keydown", (e) => {
    const last = Math.min(items.length, MAX_ROWS) - 1;
    if (e.key === "ArrowDown") selected = Math.min(last, selected + 1);
    else if (e.key === "ArrowUp") selected = Math.max(0, selected - 1);
    else if (e.key === "PageDown") selected = Math.min(last, selected + 10);
    else if (e.key === "PageUp") selected = Math.max(0, selected - 10);
    else if (e.key === "Enter") return accept();
    else if (e.key === "Escape") return close();
    else return;
    e.preventDefault();
    render();
  });
  input.focus();
  input.select();
  update();
  return { close, refresh: update, query: () => input.value };
}

export function inputBox(placeholder: string, value = "", selectUntil?: number): Promise<string | null> {
  return new Promise((resolve) => {
    closeActiveOverlay?.();
    const previousFocus = document.activeElement as HTMLElement | null;
    const input = h("input", { class: "qp-input", placeholder, spellcheck: false, value });
    const box = h("div", { class: "qp" }, h("div", { class: "qp-title" }, placeholder), input);
    const backdrop = h("div", { class: "qp-backdrop", onmousedown: (e: MouseEvent) => e.target === backdrop && done(null) }, box);
    document.getElementById("overlay-root")!.append(backdrop);
    const done = (v: string | null) => {
      backdrop.remove();
      closeActiveOverlay = null;
      previousFocus?.focus?.();
      resolve(v);
    };
    closeActiveOverlay = () => done(null);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(input.value);
      if (e.key === "Escape") done(null);
    });
    input.focus();
    input.setSelectionRange(0, selectUntil ?? value.length);
  });
}

export function toast(message: string, kind: "info" | "error" = "info", actions: { label: string; run: () => void }[] = []) {
  const root = document.getElementById("overlay-root")!;
  let stack = root.querySelector<HTMLElement>(".toasts");
  if (!stack) root.append((stack = h("div", { class: "toasts" })));
  const el = h(
    "div",
    { class: `toast ${kind}` },
    icon(kind === "error" ? "error" : "info", "toast-icon"),
    h("div", { class: "toast-msg" }, message),
    ...actions.map((a) => h("button", { class: "btn", onclick: () => (el.remove(), a.run()) }, a.label)),
    iconButton("close", "Dismiss", () => el.remove()),
  );
  stack.append(el);
  if (!actions.length) setTimeout(() => el.remove(), kind === "error" ? 9000 : 4000);
  return el;
}

export interface MenuItem {
  label: string;
  run: () => void;
  icon?: string;
  command?: string;
  /// Fixed context-local shortcut (tree keys), shown when there is no keymap command.
  shortcut?: string;
  title?: string;
  /// Dim text after the label (a file's folder).
  detail?: string;
  /// Shown as a checkmark for toggle actions.
  checked?: boolean;
  /// Adds a close button to the row (hidden editor tabs in the "»" menu).
  close?: () => void;
  disabled?: boolean;
}

export function contextMenu(e: MouseEvent, items: (MenuItem | null)[]) {
  e.preventDefault();
  closeActiveOverlay?.();
  const previousFocus = document.activeElement as HTMLElement | null;
  const rows: HTMLElement[] = [];
  const actions: MenuItem[] = [];
  let selected = -1;
  const select = (i: number) => {
    rows[selected]?.classList.remove("selected");
    selected = i;
    rows[i]?.classList.add("selected");
    rows[i]?.scrollIntoView({ block: "nearest" });
  };
  const runItem = (item: MenuItem) => {
    if (item.disabled) return;
    close();
    item.run();
  };
  const menu = h(
    "div",
    { class: "ctx-menu", role: "menu", tabIndex: -1, style: `left:${e.clientX}px;top:${e.clientY}px` },
    ...items.map((item) => {
      if (!item) return h("div", { class: "ctx-sep" });
      const i = rows.length;
      const key = item.command ? tip("", item.command).trim() : (item.shortcut ?? "");
      const row = h(
        "div",
        {
          class: `ctx-item${item.disabled ? " disabled" : ""}`,
          role: item.checked === undefined ? "menuitem" : "menuitemcheckbox",
          "aria-checked": item.checked === undefined ? undefined : String(item.checked),
          title: item.title,
          onmousemove: () => pointerMoved && selected !== i && select(i),
          onmousedown: (ev: MouseEvent) => (ev.preventDefault(), runItem(item)),
        },
        icon(item.icon ?? menuIconFor(item.label), "ctx-icon"),
        h("span", { class: "ctx-label" }, item.label),
        item.detail ? h("span", { class: "ctx-detail" }, item.detail) : null,
        key ? h("span", { class: "ctx-key" }, key) : null,
        item.checked ? icon("check", "ctx-check") : null,
        item.close
          ? withTip(
              h("button", { class: "tab-close ctx-close", onmousedown: (ev: MouseEvent) => (ev.preventDefault(), ev.stopPropagation(), close(), item.close!()) }, icon("close")),
              "Close",
            )
          : null,
      );
      rows.push(row);
      actions.push(item);
      return row;
    }),
  );
  menu.addEventListener("mouseleave", () => select(-1));
  menu.addEventListener("keydown", (ev) => {
    const step = (d: number) => {
      for (let n = 1; n <= rows.length; n++) {
        const i = (Math.max(selected, d > 0 ? -1 : 0) + d * n + rows.length) % rows.length;
        if (!actions[i].disabled) return select(i);
      }
    };
    if (ev.key === "ArrowDown") step(1);
    else if (ev.key === "ArrowUp") step(-1);
    else if (ev.key === "Enter" && selected >= 0) runItem(actions[selected]);
    else if (ev.key === "Escape") close();
    else return;
    ev.preventDefault();
    ev.stopPropagation();
  });
  const backdrop = h("div", { class: "ctx-backdrop", onmousedown: () => close(), oncontextmenu: (ev: MouseEvent) => (ev.preventDefault(), close()) }, menu);
  menu.addEventListener("mousedown", (ev) => ev.stopPropagation());
  const close = () => {
    backdrop.remove();
    closeActiveOverlay = null;
    previousFocus?.focus?.();
  };
  closeActiveOverlay = close;
  document.getElementById("overlay-root")!.append(backdrop);
  menu.focus();
  const r = menu.getBoundingClientRect();
  if (r.bottom > window.innerHeight) menu.style.top = `${Math.max(0, window.innerHeight - r.height - 4)}px`;
  if (r.right > window.innerWidth) menu.style.left = `${window.innerWidth - r.width - 4}px`;
  return { close, menu };
}

/// Modal dialogs

const FOCUSABLE = 'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';
const FIELD = 'input:not([disabled]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), select:not([disabled]), textarea:not([disabled])';

const appRoot = () => document.getElementById("app");
const modals = () => [...document.querySelectorAll<HTMLElement>("#overlay-root > [data-modal]")];

/// Shared backdrop for every dialog: clicking a field always focuses it, Tab cycles inside the dialog,
/// Escape and clicking outside close it, and the first field (or `autofocus`) gets focus on open. The window
/// behind is inert while it is open, so typing and shortcuts never reach the editor behind the dialog.
export function modal(box: HTMLElement, onClose: () => void, opts: { class?: string; autofocus?: HTMLElement | null; locked?: () => boolean } = {}) {
  const previousFocus = document.activeElement as HTMLElement | null;
  const backdrop = h("div", { class: `qp-backdrop${opts.class ? ` ${opts.class}` : ""}` }, box);
  backdrop.dataset.modal = "";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  const close = () => {
    if (opts.locked?.()) return;
    onClose();
  };
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) return close();
    const t = e.target as HTMLElement;
    const control = t.closest<HTMLElement>(FIELD) ?? (t.closest("label") as HTMLLabelElement | null)?.control ?? null;
    if (control && box.contains(control) && control.matches(FIELD)) queueMicrotask(() => document.activeElement !== control && control.focus());
  });
  backdrop.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !(e.target as HTMLElement).matches?.("textarea")) {
      e.stopPropagation();
      return close();
    }
    if (e.key !== "Tab") return;
    const all = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest("[hidden]") && !el.closest(".monaco-editor"));
    if (!all.length) return;
    const i = all.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (i <= 0 ? all.length - 1 : i - 1) : i < 0 || i === all.length - 1 ? 0 : i + 1;
    e.preventDefault();
    all[next].focus();
  });
  // Escape while focus is nowhere in an overlay (it was in the editor when the dialog opened): the topmost dialog closes.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || modals().at(-1) !== backdrop || document.getElementById("overlay-root")!.contains(document.activeElement)) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  window.addEventListener("keydown", onKey, true);
  const observer = new MutationObserver(() => {
    if (backdrop.isConnected) return;
    observer.disconnect();
    window.removeEventListener("keydown", onKey, true);
    if (!modals().length) appRoot()?.toggleAttribute("inert", false);
    // Back to where focus was: the outer dialog's field for a nested dialog, or the editor/panel for a top-level one.
    if (previousFocus?.isConnected && (previousFocus.closest(".qp-backdrop") || !document.querySelector(".qp-backdrop"))) previousFocus.focus?.();
  });
  const root = document.getElementById("overlay-root")!;
  root.append(backdrop);
  appRoot()?.toggleAttribute("inert", true);
  observer.observe(root, { childList: true });
  // Callers often fill the dialog right after opening it, so focus is placed once that has happened.
  const first = () => opts.autofocus ?? box.querySelector<HTMLElement>("[autofocus]") ?? box.querySelector<HTMLElement>(FIELD) ?? box.querySelector<HTMLElement>(FOCUSABLE);
  first()?.focus();
  queueMicrotask(() => {
    if (!backdrop.isConnected || (box !== document.activeElement && box.contains(document.activeElement))) return;
    const target = first();
    if (target) return target.focus();
    box.tabIndex = -1;
    box.focus();
  });
  return backdrop;
}

/// Text cut off by an ellipsis shows in full on hover, unless it or an ancestor already has its own tooltip.
document.addEventListener("mouseover", (e) => {
  let el = e.target instanceof HTMLElement ? e.target : null;
  if (!el || el.closest(".monaco-editor")) return;
  for (let i = 0; el && i < 3 && getComputedStyle(el).textOverflow !== "ellipsis"; i++) el = el.parentElement;
  if (!el || getComputedStyle(el).textOverflow !== "ellipsis") return;
  const own = el.closest<HTMLElement>("[title]:not([data-auto-title])");
  if (own?.title) return;
  const cut = el.scrollWidth > el.clientWidth + 1;
  if (cut) {
    el.title = (el.textContent ?? "").trim();
    el.dataset.autoTitle = "";
  } else if (el.dataset.autoTitle !== undefined) {
    el.removeAttribute("title");
    delete el.dataset.autoTitle;
  }
});

/// Status bar slots

const statusbar = document.getElementById("statusbar")!;
const slots = new Map<string, HTMLElement>();

export function statusSlot(id: string, side: "left" | "right", onclick?: () => void, title?: string, command?: string): HTMLElement {
  let el = slots.get(id);
  if (!el) {
    el = h("span", { class: `status-item ${side}${onclick ? " clickable" : ""}`, onclick });
    if (title) withTip(el, title, command);
    slots.set(id, el);
    const spacer = statusbar.querySelector(".status-spacer");
    if (side === "left" && spacer) spacer.before(el);
    else statusbar.append(el);
  }
  return el;
}

statusbar.append(h("span", { class: "status-spacer" }));
