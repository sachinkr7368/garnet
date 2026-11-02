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

export function iconButton(name: string, title: string, onclick: (e: MouseEvent) => void) {
  return h("button", { class: "icon-btn", title, onclick }, icon(name));
}

/// Sidebar and bottom tool windows

interface View {
  id: string;
  title: string;
  icon: string;
  el: HTMLElement;
  onShow?: () => void;
}

class Dock {
  views = new Map<string, View>();
  active: string | null = null;
  constructor(
    private host: HTMLElement,
    private head: HTMLElement,
    private body: HTMLElement,
    private strip: HTMLElement | null,
  ) {}

  add(view: View) {
    this.views.set(view.id, view);
    view.el.classList.add("view");
    view.el.hidden = true;
    this.body.append(view.el);
    const tab = h("button", { class: "dock-tab", title: view.title, onclick: () => this.toggle(view.id) }, icon(view.icon));
    tab.dataset.view = view.id;
    if (!this.strip) tab.append(h("span", {}, view.title));
    (this.strip ?? this.head).append(tab);
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
    view.onShow?.();
    window.dispatchEvent(new Event("resize"));
  }

  hide() {
    this.host.hidden = true;
    this.active = null;
    for (const t of (this.strip ?? this.head).querySelectorAll(".dock-tab")) t.classList.remove("active");
    window.dispatchEvent(new Event("resize"));
  }

  toggle(id: string) {
    if (this.active === id && !this.host.hidden) this.hide();
    else this.show(id);
  }
}

export const sidebar = new Dock(
  document.getElementById("sidebar")!,
  document.getElementById("sidebar-head")!,
  document.getElementById("sidebar-body")!,
  document.getElementById("toolstrip")!,
);
export const bottom = new Dock(
  document.getElementById("bottom")!,
  document.getElementById("bottom-head")!,
  document.getElementById("bottom-body")!,
  null,
);

export function setupResizers() {
  const drag = (handle: HTMLElement, onMove: (e: PointerEvent) => void) => {
    handle.addEventListener("pointerdown", (e) => {
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add("resizing");
      const move = (ev: PointerEvent) => {
        onMove(ev);
        window.dispatchEvent(new Event("resize"));
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener(
        "pointerup",
        () => {
          handle.removeEventListener("pointermove", move);
          document.body.classList.remove("resizing");
        },
        { once: true },
      );
    });
  };
  const side = document.getElementById("sidebar")!;
  drag(document.getElementById("sidebar-resizer")!, (e) => {
    side.style.width = `${Math.max(160, Math.min(700, e.clientX - side.getBoundingClientRect().left))}px`;
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
  items: PickItem[] | ((query: string) => Promise<PickItem[]> | PickItem[]);
  value?: string;
  onAccept: (item: PickItem | undefined, query: string) => void;
  onChange?: (item: PickItem | undefined) => void;
  selected?: number;
}

let closeActiveOverlay: (() => void) | null = null;

export function quickPick(opts: QuickPickOptions) {
  closeActiveOverlay?.();
  const previousFocus = document.activeElement as HTMLElement | null;
  const input = h("input", { class: "qp-input", placeholder: opts.placeholder, spellcheck: false, value: opts.value ?? "" });
  const list = h("div", { class: "qp-list" });
  const box = h("div", { class: "qp" }, input, list);
  const backdrop = h("div", { class: "qp-backdrop", onmousedown: (e: MouseEvent) => e.target === backdrop && close() }, box);
  document.getElementById("overlay-root")!.append(backdrop);
  let items: PickItem[] = [];
  let selected = 0;
  let seq = 0;
  let first = true;

  const close = () => {
    backdrop.remove();
    closeActiveOverlay = null;
    previousFocus?.focus?.();
  };
  closeActiveOverlay = close;

  const render = () => {
    list.replaceChildren(
      ...items.slice(0, 200).map((item, i) =>
        h(
          "div",
          {
            class: `qp-item${i === selected ? " selected" : ""}`,
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

  const update = async () => {
    const mine = ++seq;
    const q = input.value;
    const next =
      typeof opts.items === "function" ? await opts.items(q) : fuzzyFilter(q, opts.items, (i) => `${i.label} ${i.description ?? ""}`);
    if (mine !== seq) return;
    items = next;
    selected = first ? Math.min(opts.selected ?? 0, Math.max(0, next.length - 1)) : 0;
    first = false;
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
    if (e.key === "ArrowDown") selected = Math.min(items.length - 1, selected + 1);
    else if (e.key === "ArrowUp") selected = Math.max(0, selected - 1);
    else if (e.key === "PageDown") selected = Math.min(items.length - 1, selected + 10);
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
  return { close, refresh: update };
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
    h("div", { class: "toast-msg" }, message),
    ...actions.map((a) => h("button", { class: "btn", onclick: () => (el.remove(), a.run()) }, a.label)),
    iconButton("close", "Dismiss", () => el.remove()),
  );
  stack.append(el);
  if (!actions.length) setTimeout(() => el.remove(), kind === "error" ? 9000 : 4000);
}

export function contextMenu(e: MouseEvent, items: ({ label: string; run: () => void } | null)[]) {
  e.preventDefault();
  closeActiveOverlay?.();
  const menu = h(
    "div",
    { class: "ctx-menu", style: `left:${e.clientX}px;top:${e.clientY}px` },
    ...items.map((item) =>
      item
        ? h("div", { class: "ctx-item", onmousedown: (ev: MouseEvent) => (ev.preventDefault(), close(), item.run()) }, item.label)
        : h("div", { class: "ctx-sep" }),
    ),
  );
  const backdrop = h("div", { class: "ctx-backdrop", onmousedown: () => close(), oncontextmenu: (ev: MouseEvent) => (ev.preventDefault(), close()) }, menu);
  const close = () => {
    backdrop.remove();
    closeActiveOverlay = null;
  };
  closeActiveOverlay = close;
  document.getElementById("overlay-root")!.append(backdrop);
  const r = menu.getBoundingClientRect();
  if (r.bottom > window.innerHeight) menu.style.top = `${Math.max(0, window.innerHeight - r.height - 4)}px`;
  if (r.right > window.innerWidth) menu.style.left = `${window.innerWidth - r.width - 4}px`;
}

/// Status bar slots

const statusbar = document.getElementById("statusbar")!;
const slots = new Map<string, HTMLElement>();

export function statusSlot(id: string, side: "left" | "right", onclick?: () => void): HTMLElement {
  let el = slots.get(id);
  if (!el) {
    el = h("span", { class: `status-item ${side}${onclick ? " clickable" : ""}`, onclick });
    slots.set(id, el);
    const spacer = statusbar.querySelector(".status-spacer");
    if (side === "left" && spacer) spacer.before(el);
    else statusbar.append(el);
  }
  return el;
}

statusbar.append(h("span", { class: "status-spacer" }));
