import { ask } from "@tauri-apps/plugin-dialog";
import { allCommands, captureNextKey, formatKey, keymap, keysFor, runCommand } from "./commands";
import { openFile } from "./editor";
import { api } from "./ipc";
import { managersDetected } from "./run";
import { globalOnly, onSettingsChange, projectSettingsPath, SCHEMA, scopeValue, setting, settingsPath, updateSetting, type SettingDef } from "./settings";
import { root, state } from "./state";
import { fuzzyScore, h, icon, iconButton, toast } from "./ui";

type Scope = "global" | "project";

const PAGE_ORDER = ["Appearance", "Keymap", "Editor", "File Types", "Version Control", "Languages", "Rails", "Testing", "Run and Debug", "Terminal"];

let backdrop: HTMLElement | null = null;
let rerender: (() => void) | null = null;
onSettingsChange(() => rerender?.());

export function openSettingsWindow(initialPage = "Appearance") {
  if (backdrop) return;
  let page = initialPage;
  let scope: Scope = "global";
  let query = "";

  const search = h("input", { class: "search-input", placeholder: "Search settings", spellcheck: false });
  const tree = h("div", { class: "st-tree" });
  const body = h("div", { class: "st-page" });
  const scopeSel = h(
    "select",
    { class: "run-select", title: "Where changes are saved" },
    h("option", { value: "global" }, "Global (all projects)"),
    state.project ? h("option", { value: "project" }, `This project (.garnet/settings.json)`) : null,
  );
  scopeSel.onchange = () => ((scope = scopeSel.value as Scope), render());
  search.oninput = () => ((query = search.value), render());

  const pages = [...new Set(["Keymap", ...SCHEMA.filter((d) => !d.key.startsWith("keymap.")).map((d) => d.page)])].sort(
    (a, b) => PAGE_ORDER.indexOf(a.split("/")[0]) - PAGE_ORDER.indexOf(b.split("/")[0]) || a.localeCompare(b),
  );

  const renderTree = () => {
    const seen = new Set<string>();
    const rows: HTMLElement[] = [];
    for (const p of pages) {
      const parts = p.split("/");
      for (let i = 0; i < parts.length; i++) {
        const path = parts.slice(0, i + 1).join("/");
        if (seen.has(path)) continue;
        seen.add(path);
        const selectable = pages.includes(path) || pages.some((x) => x.startsWith(path + "/"));
        rows.push(
          h(
            "div",
            {
              class: `st-node${page === path ? " selected" : ""}`,
              style: `padding-left:${10 + i * 14}px`,
              onclick: () => selectable && ((page = pages.includes(path) ? path : pages.find((x) => x.startsWith(path + "/"))!), (query = ""), (search.value = ""), render()),
            },
            parts[i],
          ),
        );
      }
    }
    tree.replaceChildren(...rows);
  };

  const render = () => {
    renderTree();
    if (query.trim()) {
      const hits = SCHEMA.filter((d) => !d.key.startsWith("keymap.") && fuzzyScore(query, `${d.page} ${d.label} ${d.key} ${d.description ?? ""}`) !== null);
      const groups = new Map<string, SettingDef[]>();
      for (const d of hits) groups.set(d.page, [...(groups.get(d.page) ?? []), d]);
      body.replaceChildren(
        ...(groups.size ? [] : [h("div", { class: "empty" }, "No matching settings.")]),
        ...[...groups].flatMap(([p, defs]) => [h("div", { class: "st-group" }, p.replace(/\//g, " › ")), ...defs.map((d) => row(d, scope))]),
      );
      return;
    }
    if (page === "Keymap") return body.replaceChildren(...keymapPage(scope));
    const defs = SCHEMA.filter((d) => d.page === page);
    body.replaceChildren(h("div", { class: "st-title" }, page.replace(/\//g, " › ")), ...pageIntro(page), ...defs.map((d) => row(d, scope)));
  };
  rerender = render;

  const close = () => {
    backdrop?.remove();
    backdrop = null;
    rerender = null;
  };
  const dialog = h(
    "div",
    { class: "st-dialog" },
    h("div", { class: "rc-title" }, icon("settings-gear"), " Settings", h("span", { class: "spacer" }), h("span", { class: "dim" }, "Save changes to"), scopeSel),
    h("div", { class: "rc-body" }, h("div", { class: "st-side" }, h("div", { class: "st-search" }, search), tree), body),
    h(
      "div",
      { class: "rc-actions" },
      h("button", { class: "btn", onclick: async () => (close(), openFile(await settingsPath())) }, "Edit settings.json"),
      state.project
        ? h(
            "button",
            {
              class: "btn",
              onclick: async () => {
                const p = projectSettingsPath()!;
                await api.createPath(`${root()}/.garnet`, true).catch(() => {});
                await api.readFile(p).catch(() => api.writeFile(p, "{}\n"));
                close();
                openFile(p);
              },
            },
            "Edit project settings.json",
          )
        : null,
      h("span", { class: "spacer" }),
      h("button", { class: "btn primary", onclick: close }, "Done"),
    ),
  );
  backdrop = h("div", { class: "qp-backdrop", onmousedown: (e: MouseEvent) => e.target === backdrop && close() }, dialog);
  backdrop.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (e.target as HTMLElement).tagName !== "TEXTAREA") close();
  });
  document.getElementById("overlay-root")!.append(backdrop);
  render();
  search.focus();
}

function pageIntro(page: string): HTMLElement[] {
  if (page === "Languages/Ruby" && state.project) {
    const info = h("div", { class: "st-info" }, "Detecting Ruby…");
    api
      .runCapture(root(), "echo \"$(ruby -v 2>&1) at $(command -v ruby)\"; bundle -v 2>/dev/null; command -v ruby-lsp >/dev/null && echo \"ruby-lsp $(ruby-lsp --version 2>/dev/null)\"", 20)
      .then((out) => {
        const managers = managersDetected();
        info.replaceChildren(
          h("div", {}, h("b", {}, "Interpreter (from your login shell in this project): "), out.split("\n")[0]),
          ...out.split("\n").slice(1).filter(Boolean).map((l) => h("div", {}, l)),
          h("div", {}, h("b", {}, "Version managers found: "), managers.length ? managers.join(", ") : "none"),
          h("div", { class: "dim" }, "Garnet runs Ruby through your login shell, so .ruby-version / .tool-versions are honored automatically. Pick a manager here only to force `rbenv exec` / `asdf exec` / `chruby-exec` / `rvm do` / `mise exec`."),
        );
      })
      .catch((e) => (info.textContent = `Could not run ruby: ${e}`));
    return [info];
  }
  if (page.startsWith("Editor/Code Style"))
    return [h("div", { class: "st-info dim" }, "Project .editorconfig and .rubocop.yml override these values when the options below are on.")];
  return [];
}

function row(d: SettingDef, scope: Scope): HTMLElement {
  if (scope === "project" && globalOnly(d.key))
    return h(
      "div",
      { class: "st-row", title: d.key },
      h("div", { class: "st-label" }, h("span", {}, d.label)),
      h("small", { class: "dim st-desc" }, "Global only: this setting controls which programs run, so a project cannot override it."),
    );
  const own = scopeValue(scope, d.key);
  const value = own !== undefined ? own : setting(d.key);
  const commit = (v: unknown) => updateSetting(d.key, v, scope).catch((e) => toast(String(e), "error"));
  let control: HTMLElement;
  switch (d.type) {
    case "boolean": {
      const box = h("input", { type: "checkbox", checked: !!value });
      box.onchange = () => commit(box.checked);
      control = box;
      break;
    }
    case "number": {
      const input = h("input", { class: "search-input st-num", type: "number", value: String(value), min: d.min, max: d.max });
      input.onchange = () => {
        const n = Number(input.value);
        if (Number.isFinite(n) && (d.min === undefined || n >= d.min) && (d.max === undefined || n <= d.max)) commit(n);
        else {
          toast(`${d.label} must be between ${d.min} and ${d.max}.`, "error");
          input.value = String(value);
        }
      };
      control = input;
      break;
    }
    case "enum": {
      const sel = h("select", { class: "run-select" }, ...(d.options ?? []).map((o) => h("option", { value: o, selected: o === value }, o)));
      sel.onchange = () => commit(sel.value);
      control = sel;
      break;
    }
    case "map": {
      const text = Object.entries((value as Record<string, string>) ?? {}).map(([k, v]) => `${k} = ${v}`).join("\n");
      const area = h("textarea", { class: "commit-message", rows: 4, spellcheck: false, placeholder: "key = value" }, text);
      area.onchange = () => commit(Object.fromEntries(area.value.split("\n").map((l) => l.split(/\s*=\s*/, 2).map((x) => x.trim())).filter((kv) => kv[0] && kv[1] !== undefined)));
      control = area;
      break;
    }
    case "list": {
      const area = h("textarea", { class: "commit-message", rows: 3, spellcheck: false, placeholder: "one per line" }, ((value as string[]) ?? []).join("\n"));
      area.onchange = () => commit(area.value.split("\n").map((l) => l.trim()).filter(Boolean));
      control = area;
      break;
    }
    default: {
      const input = h("input", { class: "search-input", value: String(value ?? ""), spellcheck: false });
      input.onchange = () => commit(input.value);
      control = input;
    }
  }
  const inherited = own === undefined && scope === "project" && scopeValue("global", d.key) !== undefined;
  return h(
    "div",
    { class: `st-row${own !== undefined ? " modified" : ""}`, title: d.key },
    h(
      "div",
      { class: "st-label" },
      h("span", {}, d.label),
      own !== undefined ? iconButton("discard", scope === "project" ? "Remove project override" : "Reset to default", () => updateSetting(d.key, undefined, scope)) : null,
      inherited ? h("small", { class: "dim" }, "(from global)") : null,
    ),
    control,
    d.description ? h("small", { class: "dim st-desc" }, d.description) : null,
  );
}

function keymapPage(scope: Scope): HTMLElement[] {
  const filter = h("input", { class: "search-input", placeholder: "Search actions or press keys in the box on the right", spellcheck: false });
  const byKey = h("button", { class: "btn", title: "Find the action bound to a keystroke" }, "Find by shortcut");
  const list = h("div", { class: "st-keys" });
  const preset = h("select", { class: "run-select" }, h("option", { value: "rubymine", selected: setting("keymap.preset") === "rubymine" }, "RubyMine-compatible (macOS)"), h("option", { value: "vscode", selected: setting("keymap.preset") === "vscode" }, "VS Code-style"));
  preset.onchange = () => updateSetting("keymap.preset", preset.value, scope);
  let keyFilter = "";
  byKey.onclick = () => {
    byKey.textContent = "Press a shortcut…";
    captureNextKey((k) => {
      keyFilter = k;
      byKey.textContent = k ? `Shortcut: ${formatKey(k)} (click to change)` : "Find by shortcut";
      renderList();
    });
  };

  const bindings = () => ({ ...(setting<Record<string, string>>("keymap.bindings") ?? {}) });
  const removed = () => [...(setting<string[]>("keymap.removed") ?? [])];

  const removeKey = async (key: string) => {
    const b = bindings();
    if (key in b) {
      delete b[key];
      await updateSetting("keymap.bindings", b, scope);
    }
    if (keymap().has(key)) await updateSetting("keymap.removed", [...new Set([...removed(), key])], scope);
  };

  const addKey = (id: string, title: string, btn: HTMLElement) => {
    btn.textContent = "Press keys…";
    captureNextKey(async (key) => {
      if (!key) return renderList();
      const existing = keymap().get(key);
      if (existing && existing !== id) {
        const other = allCommands().find((c) => c.id === existing)?.title ?? existing;
        if (!(await ask(`${formatKey(key)} is already assigned to “${other}”. Reassign it to “${title}”?`, { kind: "warning", okLabel: "Reassign", cancelLabel: "Cancel" }))) return renderList();
      }
      await updateSetting("keymap.removed", removed().filter((k) => k !== key), scope);
      await updateSetting("keymap.bindings", { ...bindings(), [key]: id }, scope);
    });
  };

  const renderList = () => {
    const q = filter.value;
    const map = keymap();
    list.replaceChildren(
      ...allCommands()
        .filter((c) => (!q || fuzzyScore(q, c.title) !== null) && (!keyFilter || map.get(keyFilter) === c.id))
        .map((c) => {
          const keys = keysFor(c.id);
          const add = h("button", { class: "btn small" }, "+ Add shortcut");
          add.onclick = () => addKey(c.id, c.title, add);
          return h(
            "div",
            { class: "st-key-row" },
            h("span", { class: "st-key-title" }, c.title),
            h("span", { class: "st-chips" }, ...keys.map((k) => h("span", { class: "chip" }, formatKey(k), h("button", { class: "chip-x", title: "Remove", onclick: () => removeKey(k) }, "×"))), add),
          );
        }),
    );
  };
  filter.oninput = renderList;
  renderList();
  return [
    h("div", { class: "st-title" }, "Keymap"),
    h("div", { class: "st-row" }, h("div", { class: "st-label" }, h("span", {}, "Preset")), preset),
    h("div", { class: "search-bar st-keys-bar" }, filter, byKey, h("button", { class: "btn", onclick: async () => (await updateSetting("keymap.bindings", undefined, scope), updateSetting("keymap.removed", undefined, scope)) }, "Reset customizations"), h("button", { class: "btn", onclick: () => runCommand("importKeymap") }, "Import JetBrains XML…")),
    list,
  ];
}
