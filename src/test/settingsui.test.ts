import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../editor", async () => await import("./fakeEditor"));
vi.mock("../run", () => ({ managersDetected: () => [] }));

import { commands } from "../commands";
import { loadSettings, setting, updateSetting } from "../settings";
import { openSettingsWindow } from "../settingsui";
import { fake } from "./fakeIpc";

const settle = () => new Promise((r) => setTimeout(r, 10));
const row = (key: string) => document.querySelector<HTMLElement>(`.st-row[title="${key}"]`)!;

beforeEach(async () => {
  document.getElementById("overlay-root")!.replaceChildren();
  fake.reset();
  await loadSettings(null);
});

describe("settings window", () => {
  it("keeps the caret in the next field after a change", async () => {
    openSettingsWindow("Editor/Font");
    const size = row("editor.fontSize").querySelector("input")!;
    size.value = "16";
    size.dispatchEvent(new Event("change"));
    row("editor.lineHeight").querySelector("input")!.focus();
    await settle();
    expect(setting("editor.fontSize")).toBe(16);
    expect((document.activeElement as HTMLElement).closest(".st-row")?.getAttribute("title")).toBe("editor.lineHeight");
    expect(document.activeElement!.isConnected).toBe(true);
  });

  it("does not re-render under a click that is in progress", async () => {
    openSettingsWindow("Editor/Font");
    const dialog = document.querySelector(".st-dialog")!;
    const box = row("editor.fontLigatures").querySelector("input")!;
    dialog.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await updateSetting("editor.fontFamily", "Menlo");
    expect(box.isConnected).toBe(true);
    dialog.dispatchEvent(new Event("pointerup", { bubbles: true }));
    await settle();
    expect(box.isConnected).toBe(false);
    expect(row("editor.fontFamily").querySelector("input")!.value).toBe("Menlo");
  });

  it("re-renders after a click released outside the dialog or cancelled", async () => {
    for (const end of ["pointerup", "pointercancel"]) {
      document.getElementById("overlay-root")!.replaceChildren();
      openSettingsWindow("Editor/Font");
      const dialog = document.querySelector(".st-dialog")!;
      const box = row("editor.fontLigatures").querySelector("input")!;
      dialog.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      await updateSetting("editor.fontFamily", end);
      expect(box.isConnected).toBe(true);
      window.dispatchEvent(new Event(end));
      await settle();
      expect(box.isConnected, end).toBe(false);
      expect(row("editor.fontFamily").querySelector("input")!.value).toBe(end);
    }
  });

  it("keeps the Keymap search filter after adding a shortcut", async () => {
    commands({ id: "saveAll", title: "File: Save All", key: "cmd+s", run: () => {} }, { id: "goToLine", title: "Navigate: Go to Line…", key: "cmd+l", run: () => {} });
    openSettingsWindow("Keymap");
    const filter = document.querySelector<HTMLInputElement>(".st-keys-filter")!;
    filter.value = "Save All";
    filter.dispatchEvent(new Event("input"));
    expect(document.querySelectorAll(".st-key-row")).toHaveLength(1);
    await updateSetting("keymap.bindings", { "cmd+ctrl+j": "saveAll" });
    await settle();
    expect(document.querySelector<HTMLInputElement>(".st-keys-filter")!.value).toBe("Save All");
    expect(document.querySelectorAll(".st-key-row")).toHaveLength(1);
  });
});
