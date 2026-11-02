import { beforeEach, describe, expect, it } from "vitest";
import { fake } from "./fakeIpc";
import { activate, activeTab, activeViewTab, allTabs, closeTab, editor, focusActiveTab, isDirty, monaco, openFile, openViewTab, saveAll, targetEditor } from "../editor";
import { breakpointsIn, toggleBreakpoint } from "../debug";

Element.prototype.scrollIntoView ??= () => {};

const view = (closed: string[] = []) => {
  const input = document.createElement("input");
  const el = document.createElement("div");
  el.append(input);
  return { el, input, icon: "terminal", onClose: () => void closed.push("closed") };
};

describe("view tabs (database console, table data, DDL) in the editor area", () => {
  beforeEach(async () => {
    for (const t of allTabs()) await closeTab(t, true);
    fake.files.set("/p/app.rb", "class App\nend\n");
  });

  it("are not file tabs: activeTab() is null while one is showing, activeViewTab() has it", async () => {
    await openFile("/p/app.rb");
    expect(activeTab()?.path).toBe("/p/app.rb");
    const tab = openViewTab("console:dev", "console [dev]", view());
    expect(activeTab()).toBeNull();
    expect(activeViewTab()).toBe(tab);
    activate(allTabs().find((t) => t.path === "/p/app.rb")!);
    expect(activeTab()?.path).toBe("/p/app.rb");
    expect(activeViewTab()).toBeNull();
  });

  it("detach the hidden main editor so edits and Save All can't reach the file behind the view", async () => {
    await openFile("/p/app.rb");
    openViewTab("console:dev", "console [dev]", view());
    expect(editor.getModel()).toBeNull();
    expect(targetEditor()).toBeNull();
    await saveAll();
    expect(fake.files.get("/p/app.rb")).toBe("class App\nend\n");
    const file = allTabs().find((t) => t.path === "/p/app.rb")!;
    activate(file);
    expect(editor.getModel()).toBe(file.model);
    expect(targetEditor()).toBe(editor);
    expect(isDirty(file)).toBe(false);
  });

  it("send editor commands to the focused editor (the SQL console), not the hidden main editor", async () => {
    await openFile("/p/app.rb");
    const v = view();
    openViewTab("console:dev", "console [dev]", v);
    const host = document.createElement("div");
    v.el.append(host);
    const model = monaco.editor.createModel("select 1", "sql");
    const sqlEditor = monaco.editor.create(host, { model });
    sqlEditor.focus();
    expect(sqlEditor.hasTextFocus()).toBe(true);
    expect(targetEditor()).toBe(sqlEditor);
    sqlEditor.dispose();
    model.dispose();
  });

  it("don't give file commands a fake path (⌘F8 adds no breakpoint)", async () => {
    openViewTab("console:dev", "console [dev]", view());
    toggleBreakpoint(1);
    expect(breakpointsIn("garnet-view:console:dev")).toEqual([]);
  });

  it("focus their own content when focus returns to the editor area, and run onClose when closed", async () => {
    const closed: string[] = [];
    const v = view(closed);
    const tab = openViewTab("table:dev:posts", "posts", v);
    (document.activeElement as HTMLElement | null)?.blur();
    focusActiveTab();
    expect(document.activeElement).toBe(v.input);
    await closeTab(tab);
    expect(closed).toEqual(["closed"]);
    expect(v.el.isConnected).toBe(false);
  });
});
