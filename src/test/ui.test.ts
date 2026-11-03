import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
vi.mock("../editor", async () => await import("./fakeEditor"));

import { bottom, clampPanels, contextMenu, dragWidth, fileIconName, fitTabs, iconButton, menuIconFor, modal, overflowStrip, overflowToolbar, quickPick, setShortcutResolver, tip, h } from "../ui";

Element.prototype.scrollIntoView ??= () => {};
(globalThis as any).Worker ??= class {
  onmessage = null;
  postMessage() {}
  terminate() {}
  addEventListener() {}
};
const overlay = () => document.getElementById("overlay-root")!;
let px = 0;
/// A real pointer move (new coordinates each time); `still` repeats the last position, like WebKit after a scroll.
const move = (el: Element, still = false) => el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: still ? px : ++px, clientY: 10 }));
const key = (el: Element, k: string, extra: KeyboardEventInit = {}) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra }));
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("quick pick hover", () => {
  it("hover moves the selection and the keyboard continues from there", async () => {
    const changes: string[] = [];
    quickPick({ placeholder: "x", items: ["a", "b", "c", "d"].map((label) => ({ label })), onAccept: () => {}, onChange: (i) => i && changes.push(i.label) });
    await tick();
    const items = () => [...overlay().querySelectorAll(".qp-item")];
    expect(items()[0].classList.contains("selected")).toBe(true);
    move(items()[2]);
    expect(items().map((i) => i.classList.contains("selected"))).toEqual([false, false, true, false]);
    expect(changes.at(-1)).toBe("c");
    key(overlay().querySelector(".qp-input")!, "ArrowDown");
    expect(items()[3].classList.contains("selected")).toBe(true);
    move(items()[1]);
    expect(overlay().querySelectorAll(".qp-item.selected")).toHaveLength(1);
    key(overlay().querySelector(".qp-input")!, "Escape");
  });

  it("ignores the synthetic mousemove WebKit sends when the list scrolls under a still pointer", async () => {
    quickPick({ placeholder: "x", items: ["a", "b", "c", "d"].map((label) => ({ label })), onAccept: () => {} });
    await tick();
    const items = () => [...overlay().querySelectorAll(".qp-item")];
    move(items()[1]);
    key(overlay().querySelector(".qp-input")!, "ArrowDown");
    key(overlay().querySelector(".qp-input")!, "ArrowDown");
    expect(items()[3].classList.contains("selected")).toBe(true);
    move(items()[0], true);
    expect(items()[3].classList.contains("selected")).toBe(true);
    move(items()[0]);
    expect(items()[0].classList.contains("selected")).toBe(true);
    key(overlay().querySelector(".qp-input")!, "Escape");
  });

  it("accepts the hovered item on Enter", async () => {
    const accept = vi.fn();
    quickPick({ placeholder: "x", items: [{ label: "one" }, { label: "two" }], onAccept: (i) => accept(i?.label) });
    await tick();
    move(overlay().querySelectorAll(".qp-item")[1]);
    key(overlay().querySelector(".qp-input")!, "Enter");
    expect(accept).toHaveBeenCalledWith("two");
  });
});

describe("quick pick limits and failures", () => {
  it("never selects past the 200 rows it renders", async () => {
    const accept = vi.fn();
    quickPick({ placeholder: "x", items: Array.from({ length: 300 }, (_, i) => ({ label: `item ${i}` })), onAccept: (i) => accept(i?.label) });
    await tick();
    for (let i = 0; i < 30; i++) key(overlay().querySelector(".qp-input")!, "PageDown");
    key(overlay().querySelector(".qp-input")!, "Enter");
    expect(accept).toHaveBeenCalledWith("item 199");
  });

  it("shows a failing item provider as an error row instead of an unhandled rejection", async () => {
    const accept = vi.fn();
    quickPick({ placeholder: "x", items: async () => { throw new Error("index not ready"); }, onAccept: (i) => accept(i) });
    await tick();
    expect(overlay().querySelector(".qp-error")?.textContent).toContain("index not ready");
    key(overlay().querySelector(".qp-input")!, "Enter");
    expect(accept).toHaveBeenCalledWith(undefined);
  });
});

describe("panels on a small window", () => {
  const rect = (id: string, r: Partial<DOMRect>) => (document.getElementById(id)!.getBoundingClientRect = () => ({ width: 0, height: 0, ...r }) as DOMRect);

  it("caps the bottom panel and side panels to what the window has room for", () => {
    rect("main", { width: 900 });
    rect("center", { height: 508 });
    document.getElementById("sidebar")!.style.width = "700px";
    document.getElementById("rightbar")!.hidden = true;
    clampPanels();
    expect(document.getElementById("bottom")!.style.maxHeight).toBe("388px");
    expect(document.getElementById("sidebar")!.style.maxWidth).toBe("580px");
    rect("center", { height: 1000 });
    clampPanels();
    expect(document.getElementById("bottom")!.style.maxHeight).toBe("880px");
  });

  it("keeps the active bottom tab visible when the strip overflows, the rest go to the » menu", () => {
    for (const id of ["a", "b", "c", "far"]) bottom.add({ id, title: id, icon: "output", el: h("div") });
    const head = document.getElementById("bottom-head")!;
    Object.defineProperty(head, "clientWidth", { value: 130, configurable: true });
    for (const el of head.children) el.getBoundingClientRect = () => ({ width: el.classList.contains("tab-overflow") ? 20 : 50 }) as DOMRect;
    bottom.show("far");
    const tab = (id: string) => head.querySelector<HTMLElement>(`.dock-tab[data-view="${id}"]`)!;
    expect(tab("far").hidden).toBe(false);
    expect(tab("far").classList.contains("active")).toBe(true);
    expect(head.querySelector<HTMLElement>(".tab-overflow")!.hidden).toBe(false);
    expect(head.lastElementChild?.classList.contains("tab-overflow")).toBe(true);
    bottom.hide();
  });
});

describe("context menu", () => {
  const open = (items: Parameters<typeof contextMenu>[1]) => contextMenu(new MouseEvent("contextmenu", { clientX: 5, clientY: 5 }), items);

  it("hover and arrow keys share one selection; Enter runs it", () => {
    const ran = vi.fn();
    const { menu } = open([{ label: "Copy Path", run: () => ran("copy") }, null, { label: "Rename…", run: () => ran("rename") }, { label: "Delete…", run: () => ran("delete") }]);
    const rows = [...menu.querySelectorAll(".ctx-item")];
    move(rows[1]);
    expect(rows.map((r) => r.classList.contains("selected"))).toEqual([false, true, false]);
    key(menu, "ArrowDown");
    expect(rows.map((r) => r.classList.contains("selected"))).toEqual([false, false, true]);
    key(menu, "ArrowDown");
    expect(rows[0].classList.contains("selected")).toBe(true);
    move(rows[2]);
    key(menu, "Enter");
    expect(ran).toHaveBeenCalledWith("delete");
    expect(overlay().querySelector(".ctx-menu")).toBeNull();
  });

  it("renders an icon on every item (explicit or from the label) and the live shortcut", () => {
    setShortcutResolver((id) => (id === "dbConsole" ? "⇧⌘L" : ""));
    const { menu } = open([{ label: "Copy Name", run: () => {} }, { label: "New › Query Console", icon: "terminal", command: "dbConsole", run: () => {} }, { label: "Delete…", run: () => {} }]);
    const rows = [...menu.querySelectorAll(".ctx-item")];
    expect(rows.map((r) => r.querySelector(".ctx-icon")?.className)).toEqual([expect.stringContaining("codicon-copy"), expect.stringContaining("codicon-terminal"), expect.stringContaining("codicon-trash")]);
    expect(rows[1].querySelector(".ctx-key")?.textContent).toBe("⇧⌘L");
    key(menu, "Escape");
    setShortcutResolver(() => "");
  });

  it("maps common labels to icons", () => {
    expect(menuIconFor("Show History")).toBe("history");
    expect(menuIconFor("Reveal in Finder")).toBe("folder-opened");
    expect(menuIconFor("Run 'spec'")).toBe("play");
  });
});

describe("modal dialogs", () => {
  const form = () => {
    const a = h("input", { class: "search-input" });
    const b = h("input", { class: "search-input" });
    const label = h("label", { class: "rc-field" }, h("span", {}, "B"), b);
    const ok = h("button", { class: "btn" }, "OK");
    return { a, b, label, ok, box: h("div", { class: "rc-dialog" }, a, label, ok) };
  };

  it("focuses the first field on open and any field on click, including via its label", async () => {
    const f = form();
    const close = vi.fn();
    const backdrop = modal(f.box, close);
    expect(document.activeElement).toBe(f.a);
    f.label.querySelector("span")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await Promise.resolve();
    expect(document.activeElement).toBe(f.b);
    f.a.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await Promise.resolve();
    expect(document.activeElement).toBe(f.a);
    backdrop.remove();
  });

  it("cycles Tab inside the dialog and closes on Escape or a click outside", () => {
    const f = form();
    const close = vi.fn();
    const backdrop = modal(f.box, close);
    key(f.a, "Tab");
    expect(document.activeElement).toBe(f.b);
    key(f.b, "Tab");
    expect(document.activeElement).toBe(f.ok);
    key(f.ok, "Tab");
    expect(document.activeElement).toBe(f.a);
    key(f.a, "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(f.ok);
    key(f.a, "Escape");
    backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(close).toHaveBeenCalledTimes(2);
    backdrop.remove();
  });

  it("returns focus to the outer dialog's field when a nested dialog closes", async () => {
    const outer = form();
    const outerBackdrop = modal(outer.box, () => {});
    outer.b.focus();
    const inner = form();
    const innerBackdrop = modal(inner.box, () => {});
    expect(document.activeElement).toBe(inner.a);
    innerBackdrop.remove();
    await tick();
    expect(document.activeElement).toBe(outer.b);
    outerBackdrop.remove();
  });

  it("takes focus from the editor even when filled after opening, makes the window inert and closes on Escape", async () => {
    const editorInput = h("textarea", { class: "inputarea" });
    document.getElementById("app")!.append(editorInput);
    editorInput.focus();
    const box = h("div", { class: "rc-dialog" });
    const close = vi.fn(() => backdrop.remove());
    const backdrop = modal(box, close);
    const field = h("input", { class: "search-input" });
    box.append(field);
    await Promise.resolve();
    expect(document.activeElement).toBe(field);
    expect(document.getElementById("app")!.hasAttribute("inert")).toBe(true);
    field.blur();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(close).toHaveBeenCalledOnce();
    await tick();
    expect(document.getElementById("app")!.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(editorInput);
    editorInput.remove();
  });

  it("focuses an empty dialog itself so Escape reaches it", async () => {
    const box = h("div", { class: "rc-dialog" }, "Nothing to resolve");
    const close = vi.fn();
    const backdrop = modal(box, close);
    await Promise.resolve();
    expect(document.activeElement).toBe(box);
    key(box, "Escape");
    expect(close).toHaveBeenCalledOnce();
    backdrop.remove();
    await tick();
  });

  it("honours locked (the GitHub clone dialog locks itself while cloning)", () => {
    const f = form();
    const close = vi.fn();
    const backdrop = modal(f.box, close, { locked: () => true });
    key(f.a, "Escape");
    expect(close).not.toHaveBeenCalled();
    backdrop.remove();
  });
});

describe("tooltips", () => {
  it("names the action and its current shortcut, re-resolved on hover", () => {
    let k = "⌘1";
    setShortcutResolver((id) => (id === "projectView" ? k : ""));
    const b = iconButton("files", "Project", () => {}, "projectView");
    expect(b.title).toBe("Project ⌘1");
    expect(b.getAttribute("aria-label")).toBe("Project");
    k = "⌘B";
    b.dispatchEvent(new MouseEvent("mouseenter"));
    expect(b.title).toBe("Project ⌘B");
    expect(tip("Refresh")).toBe("Refresh");
    setShortcutResolver(() => "");
  });

  it("every icon button and stripe button in the app shell has a tooltip", async () => {
    // Same order as main.ts, which matters for the run ↔ test results import cycle.
    const roots: HTMLElement[] = [document.body];
    roots.push((await import("../debug")).debugView);
    roots.push((await import("../testresults")).testResultsView);
    roots.push((await import("../git")).commitView);
    roots.push((await import("../gitlog")).gitLogView);
    roots.push((await import("../rails")).routesView);
    roots.push((await import("../db")).dbView);
    roots.push((await import("../migrations")).migrationsView);
    roots.push((await import("../run")).runs.el);
    roots.push((await import("../search")).searchView);
    roots.push((await import("../prs")).pullRequestsView);
    await import("../toolbar");
    roots.push((await import("../terminal")).terminals.el);
    roots.push((await import("../tree")).treeView);
    const { rightbar } = await import("../ui");
    expect(rightbar.views.has("database")).toBe(true);
    const buttons = new Set(roots.flatMap((r) => [...r.querySelectorAll<HTMLElement>(".icon-btn, .dock-tab, .tab-close")]));
    const untitled = [...buttons].filter((b) => !(b.title || b.getAttribute("aria-label"))).map((b) => b.outerHTML.slice(0, 120));
    expect(untitled).toEqual([]);
    expect(buttons.size).toBeGreaterThan(30);
  });
});

describe("file-type icons", () => {
  it.each([
    ["app/models/post.rb", "ruby"],
    ["Gemfile", "ruby"],
    ["app/views/posts/index.html.erb", "code"],
    ["config/database.yml", "settings"],
    ["package.json", "json"],
    ["app/javascript/app.js", "file-code"],
    ["README.md", "markdown"],
    ["db/development.sqlite3", "database"],
    ["Procfile.dev", "terminal"],
    ["LICENSE", "file"],
  ])("%s → %s", (path, name) => expect(fileIconName(path)).toBe(name));
});

describe("layout guards (no pane paints outside itself; every tool window scrolls)", () => {
  const css = readFileSync(`${process.cwd()}/src/styles.css`, "utf8");
  const rule = (sel: string) => {
    const m = css.match(new RegExp(`(?:^|\\n)${sel.replace(/[#.()[\]+*]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
    return m?.[1] ?? "";
  };
  it("clips the editor area and the empty-editor hints", () => {
    expect(rule("#editor-area")).toMatch(/overflow: hidden/);
    expect(css).toMatch(/#welcome \{[^}]*overflow: hidden[^}]*container-type: size/);
    expect(css).toMatch(/@container \(max-height: 120px\)/);
  });
  it("lets the bottom panel shrink so it never pushes past the window", () => {
    expect(rule("#center")).toMatch(/min-height: 0[\s\S]*overflow: hidden/);
    expect(rule("#bottom")).toMatch(/flex: 0 1 auto/);
  });
  it("gives every tool window body min-height:0 and clipping so its list scrolls", () => {
    expect(css).toMatch(/#sidebar-body,\n#rightbar-body,\n#bottom-body \{[^}]*min-height: 0[^}]*overflow: hidden/);
    expect(rule(".view")).toMatch(/min-height: 0/);
    expect(rule(".view > *")).toMatch(/min-height: 0/);
  });
});

describe("panel resizers", () => {
  it("compute side-panel widths for both sides (tool window bar left or right)", () => {
    const rect = { left: 1000, right: 1300 };
    expect(dragWidth(rect, 950, false, 200, 800)).toBe(350);
    expect(dragWidth({ left: 40, right: 340 }, 400, true, 200, 800)).toBe(360);
    expect(dragWidth({ left: 40, right: 340 }, 100, true, 200, 800)).toBe(200);
  });

  it.each(["pointerup", "pointercancel", "lostpointercapture"])("never leave the window click-dead after a drag that ends with %s", async (end) => {
    const { setupResizers } = await import("../ui");
    setupResizers();
    const handle = document.getElementById("bottom-resizer")!;
    handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(document.body.classList.contains("resizing")).toBe(true);
    handle.dispatchEvent(new MouseEvent(end));
    expect(document.body.classList.contains("resizing")).toBe(false);
  });

  it("clears the drag when the window loses focus mid-drag", async () => {
    const handle = document.getElementById("sidebar-resizer")!;
    handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    window.dispatchEvent(new Event("blur"));
    expect(document.body.classList.contains("resizing")).toBe(false);
  });
});

describe("tab strip overflow", () => {
  it("keeps every tab when they fit", () => {
    expect(fitTabs([50, 50, 50], 150, 20, 2)).toEqual([0, 1, 2]);
  });

  it("keeps the tabs that fit next to the » button, in order", () => {
    expect(fitTabs([50, 50, 50, 50], 150, 20, 0)).toEqual([0, 1]);
  });

  it("always keeps the active tab, even when it is last", () => {
    expect(fitTabs([50, 50, 50, 50], 150, 20, 3)).toEqual([0, 3]);
  });

  it("stops at the first tab that doesn't fit so the order never skips", () => {
    expect(fitTabs([50, 90, 10, 10], 100, 20, 0)).toEqual([0]);
  });

  it("keeps only the active tab when nothing else fits, and copes with no active tab", () => {
    expect(fitTabs([80, 80, 80], 90, 20, 1)).toEqual([1]);
    expect(fitTabs([40, 40, 40], 100, 20, -1)).toEqual([0, 1]);
  });

  it("hides overflowing tabs and lists them in the » menu with their tooltips", () => {
    const strip = h("div", {});
    const picked: string[] = [];
    const closed: string[] = [];
    const tabs = ["Terminal", "Run", "Git"].map((t, i) => h("button", { class: i === 2 ? "active" : "", title: `${t} tip` }, h("span", { class: "codicon codicon-terminal" }), t));
    strip.append(...tabs);
    const { more, fit } = overflowStrip(strip, {
      title: "More tool windows",
      label: (t) => t.textContent ?? "",
      detail: () => "app/models",
      pick: (t) => picked.push(t.textContent!),
      close: (t) => closed.push(t.textContent!),
    });
    document.body.append(strip);
    Object.defineProperty(strip, "clientWidth", { value: 130, configurable: true });
    for (const el of [...tabs, more]) el.getBoundingClientRect = () => ({ width: el === more ? 20 : 50 }) as DOMRect;
    fit();
    expect(tabs.map((t) => t.hidden)).toEqual([false, true, false]);
    expect(more.hidden).toBe(false);
    expect(more.title).toBe("More tool windows");
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    more.click();
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const row = overlay().querySelector<HTMLElement>(".ctx-item")!;
    expect(row.querySelector(".ctx-label")!.textContent).toBe("Run");
    expect(row.textContent).toContain("app/models");
    expect(row.title).toBe("Run tip");
    row.querySelector(".ctx-close")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(closed).toEqual(["Run"]);
    expect(picked).toEqual([]);
    more.click();
    overlay().querySelector<HTMLElement>(".ctx-item")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(picked).toEqual(["Run"]);
    Object.defineProperty(strip, "clientWidth", { value: 400, configurable: true });
    fit();
    expect(tabs.every((t) => !t.hidden) && more.hidden).toBe(true);
    strip.remove();
  });

  it("keeps focus on a visible tab by not re-appending » when it is already last", () => {
    const strip = h("div", {});
    strip.append(h("button", { class: "active" }, "A"), h("button", {}, "B"));
    const { more, fit } = overflowStrip(strip, { title: "More", label: (t) => t.textContent ?? "", pick: () => {} });
    Object.defineProperty(strip, "clientWidth", { value: 60, configurable: true });
    for (const el of strip.children) (el as HTMLElement).getBoundingClientRect = () => ({ width: 50 }) as DOMRect;
    const append = vi.spyOn(strip, "append");
    fit();
    expect(more.hidden).toBe(false);
    expect(append).not.toHaveBeenCalled();
  });

  it("moves trailing toolbar buttons into » and shows toggles as checked", () => {
    const bar = h("div", {});
    const buttons = ["Refresh", "Filter", "Wrap"].map((t, i) => h("button", { class: `icon-btn${i === 2 ? " on" : ""}`, title: t, "aria-label": t }, h("span", { class: "codicon codicon-refresh" })));
    bar.append(...buttons);
    const fit = overflowToolbar(bar);
    let wide = false;
    Object.defineProperty(bar, "clientWidth", { get: () => (wide ? 400 : 60) });
    Object.defineProperty(bar, "scrollWidth", { get: () => (wide ? 400 : buttons.filter((b) => !b.classList.contains("overflowed")).length * 30 + (bar.lastElementChild!.hasAttribute("hidden") ? 0 : 30)) });
    for (const b of buttons) b.getBoundingClientRect = () => ({ width: 30 }) as DOMRect;
    fit();
    expect(buttons.map((b) => b.classList.contains("overflowed"))).toEqual([false, true, true]);
    const more = bar.lastElementChild as HTMLElement;
    more.click();
    const rows = [...overlay().querySelectorAll<HTMLElement>(".ctx-item")];
    expect(rows.map((r) => r.querySelector(".ctx-label")!.textContent)).toEqual(["Filter", "Wrap"]);
    expect(rows.map((r) => r.getAttribute("aria-checked"))).toEqual([null, "true"]);
    expect(rows[1].querySelector(".ctx-check")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    wide = true;
    fit();
    expect(buttons.some((b) => b.classList.contains("overflowed"))).toBe(false);
  });
});
