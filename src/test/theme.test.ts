import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { isDarkTheme, loadSettings, onSettingsChange, setting, toggleTheme, updateSetting } from "../settings";
import { contrast, EDITOR_BG, monacoTheme, resolveTheme, SYNTAX, TERMINAL, toggledAppearance } from "../theme";
import { fake } from "./fakeIpc";
import { emitWindowTheme, setSystemDark, windowTheme } from "./setup";

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("theme resolution", () => {
  it("follows the system only for the system preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("bogus", true)).toBe("dark");
    expect(toggledAppearance("dark")).toBe("light");
    expect(toggledAppearance("light")).toBe("dark");
  });
});

describe("appearance setting", () => {
  beforeEach(async () => {
    fake.reset();
    setSystemDark(false);
    emitWindowTheme("light");
    await loadSettings(null);
  });

  it("defaults to System and switches live with macOS, through prefers-color-scheme and the Tauri window", async () => {
    expect(setting("appearance.theme")).toBe("system");
    let changes = 0;
    onSettingsChange(() => changes++);
    expect(document.documentElement.dataset.theme).toBe("light");
    setSystemDark(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(changes).toBe(1);
    emitWindowTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(changes).toBe(2);
    emitWindowTheme("light");
    expect(changes).toBe(2);
  });

  it("ignores macOS changes when pinned, and hands the window back to macOS for System", async () => {
    await updateSetting("appearance.theme", "dark");
    expect(windowTheme.set.at(-1)).toBe("dark");
    setSystemDark(false);
    emitWindowTheme("light");
    expect(document.documentElement.dataset.theme).toBe("dark");
    await updateSetting("appearance.theme", "system");
    expect(windowTheme.set.at(-1)).toBeNull();
    await settle();
    expect(isDarkTheme()).toBe(false);
  });

  it("Toggle theme pins the opposite of what is on screen", async () => {
    setSystemDark(true);
    await toggleTheme();
    expect(setting("appearance.theme")).toBe("light");
    expect(JSON.parse(fake.config.get("settings.json")!)["appearance.theme"]).toBe("light");
    await toggleTheme();
    expect(setting("appearance.theme")).toBe("dark");
    expect(isDarkTheme()).toBe(true);
  });
});

describe("palettes", () => {
  it("computes WCAG contrast", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
  });

  for (const t of ["dark", "light"] as const) {
    it(`${t}: every syntax and semantic-token color is readable (≥ 4.5:1)`, () => {
      const low = Object.entries(SYNTAX[t]).filter(([, c]) => contrast(c, EDITOR_BG[t]) < 4.5);
      expect(low).toEqual([]);
    });

    it(`${t}: terminal foreground and all 16 ANSI colors are readable (≥ 3:1)`, () => {
      const { background, selectionBackground: _s, cursor: _c, ...fg } = TERMINAL[t] as Record<string, string>;
      expect(contrast(fg.foreground, background)).toBeGreaterThanOrEqual(7);
      expect(Object.keys(fg)).toHaveLength(17);
      expect(Object.entries(fg).filter(([, c]) => contrast(c, background) < 3)).toEqual([]);
    });

    it(`${t}: Monaco theme has diff colors and rules for ruby-lsp semantic tokens`, () => {
      const theme = monacoTheme(t);
      expect(theme.base).toBe(t === "dark" ? "vs-dark" : "vs");
      expect(theme.colors["diffEditor.insertedTextBackground"]).toBeTruthy();
      expect(theme.colors["diffEditor.removedTextBackground"]).toBeTruthy();
      const tokens = theme.rules.map((r) => r.token);
      for (const tok of ["namespace", "class", "method", "parameter", "property", "variable", "enumMember", "comment", "keyword", "string"]) expect(tokens).toContain(tok);
    });
  }

  it("UI chrome colors in styles.css are readable in both themes", () => {
    const css = readFileSync(`${process.cwd()}/src/styles.css`, "utf8");
    const block = (sel: string) => {
      const body = css.slice(css.indexOf(sel), css.indexOf("}", css.indexOf(sel)));
      return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
    };
    for (const sel of ['[data-theme="dark"] {', '[data-theme="light"] {']) {
      const v = block(sel);
      for (const bg of ["bg", "panel", "panel-2", "hover"]) {
        expect(contrast(v.text, v[bg]), `${sel} text on ${bg}`).toBeGreaterThanOrEqual(7);
        expect(contrast(v.dim, v[bg]), `${sel} dim on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(v.purple, v.panel), `${sel} purple (debugger variable names)`).toBeGreaterThanOrEqual(4.5);
      for (const k of ["accent", "added", "modified", "deleted", "warn", "folder", "yellow", "blue", "breakpoint"])
        expect(contrast(v[k], v.panel), `${sel} --${k}`).toBeGreaterThanOrEqual(3);
    }
  });
});
