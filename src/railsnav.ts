import { pluralize, singularize, underscore } from "./inflect";

/// Pure resolution logic behind Rails navigation (partials, i18n keys, routes, actions, associations, factories).

export interface Token {
  value: string;
  start: number;
  end: number;
}

/// The quoted string literal (single or double quotes, no interpolation needed) containing 0-based column `col`.
export function stringAt(line: string, col: number): Token | null {
  const re = /(["'])((?:\\.|(?!\1).)*)\1/g;
  for (const m of line.matchAll(re)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (col >= start && col < end) return { value: m[2], start, end };
  }
  return null;
}

/// The `:symbol` (or `symbol:` hash key) containing column `col`.
export function symbolAt(line: string, col: number): Token | null {
  for (const m of line.matchAll(/(?<![:\w]):(\w+[?!]?)/g)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (col >= start && col < end) return { value: m[1], start, end };
  }
  return null;
}

const stripComment = (line: string) => line.replace(/(^|\s)#(?![{]).*$/, "$1");

/// Partials

/// Name of the partial rendered at `col`: `render "x"`, `render partial: "a/b"`, `render(:partial => 'x')`, `render @posts`.
export function partialAt(line: string, col: number): string | null {
  const s = stringAt(line, col);
  if (s) {
    const before = line.slice(0, s.start);
    if (/\brender\s*\(?\s*$/.test(before) || (/\brender\b/.test(before) && /(?:\bpartial:\s*|:partial\s*=>\s*)$/.test(before))) return s.value;
    return null;
  }
  for (const m of line.matchAll(/\brender\s*\(?\s*@(\w+)/g)) {
    const start = m.index! + m[0].indexOf("@");
    if (col >= start && col < start + m[1].length + 1) {
      const plural = pluralize(singularize(m[1]));
      return `${plural}/${singularize(m[1])}`;
    }
  }
  return null;
}

/// Folder whose partials a bare `render "x"` finds from this file (views folder or controller's views).
export function viewsDirFor(currentRel: string): string {
  const view = currentRel.match(/^app\/views\/(.+)\/[^/]+$/);
  if (view) return `app/views/${view[1]}`;
  const ctrl = currentRel.match(/^app\/controllers\/(.+)_controller\.rb$/);
  if (ctrl) return `app/views/${ctrl[1]}`;
  const mailer = currentRel.match(/^app\/mailers\/(.+)\.rb$/);
  if (mailer) return `app/views/${mailer[1]}`;
  return "app/views/application";
}

const FORMAT_ORDER = [".html.erb", ".erb", ".html.haml", ".haml", ".html.slim", ".slim", ".turbo_stream.erb", ".json.jbuilder"];
const formatRank = (path: string) => {
  const i = FORMAT_ORDER.findIndex((ext) => path.endsWith(ext));
  return i < 0 ? FORMAT_ORDER.length : i;
};

/// Partial files for `render name` from `currentRel`, best match first.
export function resolvePartial(name: string, currentRel: string, files: string[]): string[] {
  const clean = name.replace(/^\//, "");
  const slash = clean.lastIndexOf("/");
  const dirs = slash >= 0 ? [`app/views/${clean.slice(0, slash)}`] : [viewsDirFor(currentRel), "app/views/application"];
  const base = `_${slash >= 0 ? clean.slice(slash + 1) : clean}.`;
  for (const dir of dirs) {
    const hits = files.filter((f) => f.startsWith(`${dir}/${base}`) && !f.slice(dir.length + 1).includes("/"));
    if (hits.length) return hits.sort((a, b) => formatRank(a) - formatRank(b));
  }
  return [];
}

/// I18n

export interface I18nCall {
  key: string;
  line: number;
  start: number;
  end: number;
  hasDefault: boolean;
}

const T_CALL = /\b(?:I18n\.)?(?:t|translate)\s*\(?\s*(["'])([\w.\-?!]*)\1([^\n]*)/g;

/// Every `t("...")` / `I18n.t('...')` with a literal key (lines 1-based, columns 0-based, key without quotes).
export function i18nCalls(text: string): I18nCall[] {
  const out: I18nCall[] = [];
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(T_CALL)) {
      if (m.index! > 0 && /[\w.:]/.test(line[m.index! - 1]) && !line.slice(0, m.index!).endsWith("I18n.")) continue;
      const start = m.index! + m[0].indexOf(m[1]) + 1;
      out.push({ key: m[2], line: i + 1, start, end: start + m[2].length, hasDefault: /\b(default|scope):/.test(m[3]) });
    }
  });
  return out;
}

export function i18nKeyAt(line: string, col: number): string | null {
  return i18nCalls(line).find((c) => col >= c.start - 1 && col <= c.end)?.key ?? null;
}

/// Full key for a possibly lazy (".title") key, as Rails resolves it from views and controller actions.
export function absoluteKey(key: string, currentRel: string, action?: string | null): string | null {
  if (!key.startsWith(".")) return key || null;
  const view = currentRel.match(/^app\/views\/(.+)\/_?([^/.]+)[^/]*$/);
  if (view) return `${view[1].replace(/\//g, ".")}.${view[2]}${key}`;
  const ctrl = currentRel.match(/^app\/(?:controllers\/(.+)_controller|mailers\/(.+))\.rb$/);
  if (ctrl && action) return `${(ctrl[1] ?? ctrl[2]).replace(/\//g, ".")}.${action}${key}`;
  return null;
}

/// Name of the method enclosing 0-based line `index` (`def name`), for lazy lookups in controllers.
export function enclosingDef(lines: string[], index: number): string | null {
  for (let i = index; i >= 0; i--) {
    const m = lines[i].match(/^\s*def\s+(?:self\.)?(\w+[?!]?)/);
    if (m) return m[1];
    if (i < index && /^\s{0,2}(class|module)\b/.test(lines[i])) return null;
  }
  return null;
}

export interface LocaleEntry {
  path: string;
  line: number;
  value: string;
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length > 1) return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n");
  if (t.startsWith("'") && t.endsWith("'") && t.length > 1) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

function splitKey(rest: string): [string, string] | null {
  const q = rest.match(/^(["'])(.*?)\1\s*:(?:\s+(.*))?$/);
  if (q) return [q[2], q[3] ?? ""];
  const m = rest.match(/^([^:#][^:]*?)\s*:(?:\s+(.*))?$/);
  return m ? [m[1].trim(), m[2] ?? ""] : null;
}

/// Flattens a Rails locale YAML file into "en.posts.index.title" → {line, value}. Handles nested maps, quoted
/// keys and values, comments, block scalars (| and >) and lists; anchors/merge keys are kept as plain values.
export function parseLocaleYaml(text: string): Map<string, { line: number; value: string }> {
  const out = new Map<string, { line: number; value: string }>();
  const stack: { indent: number; key: string }[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || /^\s*#/.test(raw) || /^(---|\.\.\.)\s*$/.test(raw)) continue;
    const indent = raw.match(/^ */)![0].length;
    const rest = raw.slice(indent);
    if (rest.startsWith("- ")) continue;
    const kv = splitKey(rest.replace(/\s+#\s.*$/, ""));
    if (!kv) continue;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const [key, value] = kv;
    if (key === "<<") continue;
    const full = [...stack.map((s) => s.key), key].join(".");
    const v = value.replace(/^&\w+\s*/, "").trim();
    if (/^[|>][-+]?\d*$/.test(v)) {
      const block: string[] = [];
      let j = i + 1;
      for (; j < lines.length && (!lines[j].trim() || lines[j].match(/^ */)![0].length > indent); j++) block.push(lines[j]);
      const min = Math.min(...block.filter((b) => b.trim()).map((b) => b.match(/^ */)![0].length));
      const body = block.map((b) => b.slice(Number.isFinite(min) ? min : 0)).join(v.startsWith(">") ? " " : "\n").trim();
      out.set(full, { line: i + 1, value: body });
      i = j - 1;
    } else if (v) {
      out.set(full, { line: i + 1, value: unquote(v) });
    } else {
      const next = lines.slice(i + 1).find((l) => l.trim() && !/^\s*#/.test(l));
      if (next && /^\s*- /.test(next)) {
        const items: string[] = [];
        for (let j = i + 1; j < lines.length && (/^\s*- /.test(lines[j]) || !lines[j].trim()); j++) if (lines[j].trim()) items.push(unquote(lines[j].replace(/^\s*- /, "")));
        out.set(full, { line: i + 1, value: `[${items.join(", ")}]` });
      }
      stack.push({ indent, key });
    }
  }
  return out;
}

export type LocaleIndex = Map<string, LocaleEntry>;

export function buildLocaleIndex(files: { path: string; text: string }[]): LocaleIndex {
  const index: LocaleIndex = new Map();
  for (const f of files) for (const [key, e] of parseLocaleYaml(f.text)) index.set(key, { path: f.path, line: e.line, value: e.value });
  return index;
}

export const localesOf = (index: LocaleIndex) => [...new Set([...index.keys()].map((k) => k.split(".")[0]))].sort();

/// Entry for `key` in `locale`; "namespace" when the key names a subtree (a hash of translations).
export function lookupKey(index: LocaleIndex, locale: string, key: string): LocaleEntry | "namespace" | null {
  const full = `${locale}.${key}`;
  const hit = index.get(full);
  if (hit) return hit;
  for (const k of index.keys()) if (k.startsWith(`${full}.`)) return "namespace";
  return null;
}

export function defaultLocale(applicationRb: string): string {
  return applicationRb.match(/^\s*config\.i18n\.default_locale\s*=\s*[:"']?([\w-]+)/m)?.[1] ?? "en";
}

/// Routes

export interface RouteTarget {
  controller: string;
  action?: string;
}

const resourceController = (kind: string, name: string, rest: string) => {
  const explicit = rest.match(/\bcontroller:\s*[:"']([\w/]+)/)?.[1];
  return explicit ?? (kind === "resource" ? pluralize(name) : name);
};

/// Controller (and action) referenced at 0-based `index`/`col` in config/routes.rb, honouring enclosing
/// `namespace`, `scope module:` and `resources ... do` blocks.
export function routeTargetAt(lines: string[], index: number, col: number): RouteTarget | null {
  const stack: { module?: string; resource?: string }[] = [];
  for (let i = 0; i < index; i++) {
    const line = stripComment(lines[i]);
    if (/^\s*end\b/.test(line)) {
      stack.pop();
      continue;
    }
    if (!/\bdo(\s*\|[^|]*\|)?\s*$/.test(line)) continue;
    const ns = line.match(/^\s*namespace\s+[:"'](\w+)/);
    const scope = line.match(/^\s*scope\b.*\bmodule:\s*[:"'](\w+)/);
    const res = line.match(/^\s*(resources?)\s+:(\w+)(.*)$/);
    if (ns) stack.push({ module: ns[1] });
    else if (scope) stack.push({ module: scope[1] });
    else if (res) stack.push({ resource: resourceController(res[1], res[2], res[3]) });
    else stack.push({});
  }
  const modules = stack.flatMap((s) => (s.module ? [s.module] : []));
  const prefix = (c: string) => [...modules, c].join("/");
  const line = lines[index] ?? "";
  const str = stringAt(line, col);
  if (str) {
    const m = str.value.match(/^([\w/]+)#(\w+)$/);
    if (m) return { controller: prefix(m[1]), action: m[2] };
    const ctrl = line.slice(0, str.start).match(/\bcontroller:\s*$/);
    if (ctrl) return { controller: prefix(str.value) };
    return null;
  }
  const sym = symbolAt(line, col);
  if (!sym) return null;
  const res = line.match(/^\s*(resources?)\s+:(\w+)(.*)$/);
  if (res) {
    const controller = prefix(resourceController(res[1], res[2], res[3]));
    if (sym.value === res[2]) return { controller };
    return /\b(only|except):/.test(res[3]) ? { controller, action: sym.value } : null;
  }
  const verb = line.match(/^\s*(get|post|patch|put|delete|match)\s+:(\w+)/);
  const resource = [...stack].reverse().find((s) => s.resource)?.resource;
  if (verb && sym.value === verb[2] && resource) return { controller: prefix(resource), action: verb[2] };
  return null;
}

export const controllerFile = (controller: string) => `app/controllers/${controller}_controller.rb`;

/// Controller actions → views

export function actionDefAt(line: string, col: number): string | null {
  const m = line.match(/^(\s*def\s+)(\w+[?!]?)/);
  if (!m || col < m[1].length || col > m[1].length + m[2].length) return null;
  return m[2];
}

export function viewsForAction(controllerRel: string, action: string, files: string[]): string[] {
  const ctrl = controllerRel.match(/^app\/controllers\/(.+)_controller\.rb$/);
  const mailer = controllerRel.match(/^app\/mailers\/(.+)\.rb$/);
  const dir = ctrl ? ctrl[1] : mailer?.[1];
  if (!dir) return [];
  const prefix = `app/views/${dir}/${action}.`;
  return files.filter((f) => f.startsWith(prefix)).sort((a, b) => formatRank(a) - formatRank(b));
}

/// Associations and factories → models

const classOption = (rest: string) => rest.match(/\bclass(?:_name)?:\s*(?:["']([\w:]+)["']|([A-Z][\w:]*)|:(\w+))/);

export function associationModelAt(line: string, col: number): string | null {
  const m = stripComment(line).match(/^(\s*(has_many|has_one|belongs_to|has_and_belongs_to_many)\s+:)(\w+)(.*)$/);
  if (!m || col < m[1].length - 1 || col > m[1].length + m[3].length) return null;
  const cls = classOption(m[4]);
  if (cls) return underscore(cls[1] ?? cls[2] ?? cls[3]);
  return m[2] === "has_many" || m[2] === "has_and_belongs_to_many" ? singularize(m[3]) : m[3];
}

export function factoryModelAt(line: string, col: number): string | null {
  const m = stripComment(line).match(/^(\s*factory\s+[:"']?)(\w+)(.*)$/);
  if (!m || col < m[1].length - 1 || col > m[1].length + m[2].length) return null;
  const cls = classOption(m[3]);
  return cls ? underscore(cls[1] ?? cls[2] ?? cls[3]) : m[2];
}

/// app/models path for a model name, falling back to a namespaced file with the same basename.
export function modelFile(model: string, files: string[]): string | null {
  const direct = `app/models/${model}.rb`;
  if (files.includes(direct)) return direct;
  const base = model.split("/").pop();
  return files.find((f) => f.startsWith("app/models/") && f.endsWith(`/${base}.rb`)) ?? null;
}
