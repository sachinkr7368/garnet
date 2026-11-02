import { openFile } from "./editor";
import { api } from "./ipc";
import { askTrust, setting } from "./settings";
import { abs, root, shellQuote, state } from "./state";
import { h, icon, quickPick, modal, toast } from "./ui";

/// Run Rails Generator: generator list and options from `bin/rails generate --help`, preview with --pretend.

export interface GeneratorOption {
  name: string;
  alias?: string;
  type: "boolean" | "string" | "array";
  default?: string;
  description: string;
  values?: string[];
}

export interface GeneratorHelp {
  usage: string;
  args: string;
  options: GeneratorOption[];
  description: string;
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/// Generator names grouped as `bin/rails generate` prints them after "Please choose a generator below."
export function parseGeneratorList(out: string): { group: string; name: string }[] {
  const text = stripAnsi(out);
  const start = text.indexOf("Please choose a generator below.");
  if (start < 0) return [];
  const list: { group: string; name: string }[] = [];
  let group = "";
  for (const line of text.slice(start).split("\n").slice(1)) {
    const g = line.match(/^(\S[^:]*):\s*$/);
    if (g) group = g[1];
    const m = line.match(/^ {2}([\w:-]+)\s*$/);
    if (m && group) list.push({ group, name: m[1] });
  }
  return list;
}

const SKIP_OPTIONS = new Set(["help", "pretend", "quiet", "skip-namespace", "skip-collision-check", "no-color"]);

/// Usage, positional arguments and options from `bin/rails generate <name> --help`.
export function parseGeneratorHelp(out: string): GeneratorHelp {
  const lines = stripAnsi(out).split("\n");
  const usageIdx = lines.findIndex((l) => /^Usage:/.test(l));
  const usage = usageIdx >= 0 ? (lines[usageIdx + 1] ?? "").trim() : "";
  const args = usage.replace(/^\S+\s+(?:generate|g)\s+\S+\s*/, "").replace(/\s*\[options\]\s*$/, "");
  const options: GeneratorOption[] = [];
  let section = "";
  let last: GeneratorOption | null = null;
  const descLines: string[] = [];
  for (const line of lines) {
    const header = line.match(/^(\S[\w ]*):\s*$/);
    if (header) {
      section = header[1];
      last = null;
      continue;
    }
    if (section === "Description") {
      descLines.push(line.replace(/^ {4}/, ""));
      continue;
    }
    if (!/options$/i.test(section)) continue;
    const cont = line.match(/^\s+#\s?(.*)$/);
    if (cont && last) {
      const d = cont[1].match(/^Default:\s*(.*)$/);
      const v = cont[1].match(/^Possible values:\s*(.*)$/);
      if (d) last.default = d[1].trim();
      else if (v) last.values = v[1].split(",").map((x) => x.trim()).filter(Boolean);
      else last.description += ` ${cont[1].trim()}`;
      continue;
    }
    const m = line.match(/^\s+(?:-(\w),\s+)?\[?--([\w-]+)(?:=([^\]\s]+(?:\s[^\]\s#]+)*))?\]?(?:,\s*\[--(?:no|skip)-[\w-]+\])*\s*(?:#\s?(.*))?$/);
    if (!m) continue;
    const [, alias, name, value, description = ""] = m;
    last = null;
    if (SKIP_OPTIONS.has(name)) continue;
    const type = !value ? "boolean" : /\s/.test(value) ? "array" : "string";
    last = { name, ...(alias ? { alias } : {}), type, description: description.trim() };
    options.push(last);
  }
  for (const o of options) if (o.type === "boolean" && o.default === undefined) o.default = "false";
  return { usage, args, options, description: descLines.join("\n").trim() };
}

/// Shell words for `bin/rails generate`: options are only passed when they differ from the default.
export function generatorArgs(generator: string, args: string, values: Record<string, string | boolean>, options: GeneratorOption[], pretend = false): string {
  const parts = ["bin/rails", "generate", generator, ...splitArgs(args).map(shellQuote)];
  for (const o of options) {
    const v = values[o.name];
    if (v === undefined) continue;
    if (o.type === "boolean") {
      const def = o.default === "true";
      if (v !== def) parts.push(v ? `--${o.name}` : `--no-${o.name}`);
    } else if (typeof v === "string" && v.trim() && v.trim() !== (o.default ?? "")) {
      parts.push(o.type === "array" ? `--${o.name}=${splitArgs(v).map(shellQuote).join(" ")}` : `--${o.name}=${shellQuote(v.trim())}`);
    }
  }
  if (pretend) parts.push("--pretend");
  return parts.join(" ");
}

/// Splits on whitespace, honouring "double" and 'single' quotes.
export function splitArgs(s: string): string[] {
  return [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/// Files Rails reports as created (or overwritten) by a generator run.
export function createdFiles(out: string): string[] {
  const files: string[] = [];
  for (const line of stripAnsi(out).split("\n")) {
    const m = line.match(/^\s*(create|force)\s+(\S.*?)\s*$/);
    if (m && !m[2].endsWith("/") && /\.[\w]+$/.test(m[2])) files.push(m[2]);
  }
  return [...new Set(files)];
}

/// Dialog

const capture = (cmd: string, secs = 180) => api.runCapture(root(), `RAILS_ENV=${shellQuote(setting<string>("rails.environment"))} ${cmd} 2>&1`, secs);
let generatorCache: { group: string; name: string }[] | null = null;

export async function runRailsGenerator() {
  if (!state.project?.rails) return toast("Not a Rails project.");
  if (!(await askTrust())) return;
  let list = generatorCache;
  if (!list) {
    toast("Loading generators (bin/rails generate --help)…");
    try {
      list = parseGeneratorList(await capture("bin/rails generate --help"));
    } catch (e) {
      return toast(`Cannot list generators: ${e}`, "error");
    }
    if (!list.length) return toast("bin/rails generate printed no generators.", "error");
    generatorCache = list;
  }
  quickPick({
    placeholder: "Run Rails Generator",
    items: list.map((g) => ({ label: g.name, description: g.group, icon: "wand", data: g.name })),
    onAccept: (item) => item && openGeneratorDialog(item.data as string),
  });
}

async function openGeneratorDialog(generator: string) {
  let help: GeneratorHelp;
  try {
    help = parseGeneratorHelp(await capture(`bin/rails generate ${shellQuote(generator)} --help`));
  } catch (e) {
    return toast(`Cannot read options of ${generator}: ${e}`, "error");
  }
  const values: Record<string, string | boolean> = {};
  const argsInput = h("input", { class: "search-input", placeholder: help.args || "arguments", spellcheck: false });
  const preview = h("code", { class: "rc-preview" });
  const output = h("pre", { class: "gen-output" });
  const update = () => (preview.textContent = `$ ${generatorArgs(generator, argsInput.value, values, help.options)}`);
  argsInput.oninput = update;

  const optionRow = (o: GeneratorOption) => {
    const label = `--${o.name}${o.alias ? ` (-${o.alias})` : ""}`;
    if (o.type === "boolean") {
      const box = h("input", { type: "checkbox", checked: o.default === "true" });
      box.onchange = () => ((values[o.name] = box.checked), update());
      return h("label", { class: "rc-check", title: o.description }, box, ` ${label}`, h("small", { class: "dim" }, `  ${o.description}`));
    }
    const input: HTMLInputElement | HTMLSelectElement = o.values
      ? h("select", { class: "run-select" }, ...["", ...o.values].map((v) => h("option", { value: v, selected: v === (o.default ?? "") }, v || "(default)")))
      : h("input", { class: "search-input", placeholder: o.default ?? (o.type === "array" ? "space separated" : ""), spellcheck: false });
    input.oninput = input.onchange = () => ((values[o.name] = input.value), update());
    return h("label", { class: "rc-field" }, h("span", {}, label), input, h("small", { class: "dim" }, o.description + (o.default ? ` (default: ${o.default})` : "")));
  };

  const run = async (pretend: boolean) => {
    if (!splitArgs(argsInput.value).length && /NAME/.test(help.args)) return toast("Enter the arguments (e.g. the NAME).", "error");
    const cmd = generatorArgs(generator, argsInput.value, values, help.options, pretend);
    output.textContent = `$ ${cmd}\n`;
    buttons.forEach((b) => (b.disabled = true));
    try {
      const out = await capture(cmd, 600);
      output.textContent += out;
      if (!pretend) {
        const created = createdFiles(out);
        close();
        toast(created.length ? `${generator}: created ${created.length} file(s).` : `${generator} finished.`);
        for (const f of created.slice(0, 15)) await openFile(abs(f)).catch(() => {});
      }
    } catch (e) {
      output.textContent += String(e);
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  };

  const buttons = [
    h("button", { class: "btn", onclick: () => close() }, "Cancel"),
    h("button", { class: "btn", onclick: () => run(true) }, "Preview (--pretend)"),
    h("button", { class: "btn primary", onclick: () => run(false) }, "Run"),
  ];
  const dialog = h(
    "div",
    { class: "rc-dialog gen-dialog" },
    h("div", { class: "rc-title" }, icon("wand"), ` Rails Generator: ${generator}`),
    h(
      "div",
      { class: "rc-form gen-form" },
      help.usage ? h("small", { class: "dim" }, help.usage) : null,
      h("label", { class: "rc-field" }, h("span", {}, "Arguments"), argsInput, help.args ? h("small", { class: "dim" }, help.args) : null),
      ...help.options.map(optionRow),
      help.description ? h("details", {}, h("summary", {}, "Description"), h("pre", { class: "gen-output" }, help.description)) : null,
      preview,
      output,
    ),
    h("div", { class: "rc-actions" }, ...buttons),
  );
  const backdrop = modal(dialog, () => close(), { autofocus: argsInput });
  const close = () => backdrop.remove();
  update();
  argsInput.focus();
}
