import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
vi.mock("../editor", async () => await import("./fakeEditor"));

import { contextMenu, dragWidth, fileIconName, iconButton, menuIconFor, modal, quickPick, setShortcutResolver, tip, h } from "../ui";

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
