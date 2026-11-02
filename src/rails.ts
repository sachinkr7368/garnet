import { activeTab, monaco, openFile } from "./editor";
import { api } from "./ipc";
import { abs, rel, root, state } from "./state";
import { h, iconButton, quickPick, toast } from "./ui";

// ponytail: naive English inflection covers Rails' common cases; irregular nouns fall back to plain "s".
const IRREGULAR: Record<string, string> = { person: "people", man: "men", child: "children", mouse: "mice", datum: "data" };

export function pluralize(word: string): string {
  if (IRREGULAR[word]) return IRREGULAR[word];
  if (/(s|x|z|ch|sh)$/.test(word)) return word + "es";
  if (/[^aeiou]y$/.test(word)) return word.slice(0, -1) + "ies";
  return word + "s";
}

export function singularize(word: string): string {
  const irregular = Object.entries(IRREGULAR).find(([, p]) => p === word);
  if (irregular) return irregular[0];
  if (/ies$/.test(word)) return word.slice(0, -3) + "y";
  if (/(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (/ss$/.test(word)) return word;
  if (/s$/.test(word)) return word.slice(0, -1);
  return word;
}

/// Resource name (e.g. "admin/user") from a project-relative path.
export function resourceOf(path: string): string | null {
  const patterns: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/^app\/models\/(.+)\.rb$/, (m) => m[1]],
    [/^app\/controllers\/(.+)_controller\.rb$/, (m) => singularPath(m[1])],
    [/^app\/views\/(.+)\/[^/]+$/, (m) => singularPath(m[1])],
    [/^app\/helpers\/(.+)_helper\.rb$/, (m) => singularPath(m[1])],
    [/^app\/(?:serializers|policies|decorators|jobs|mailers|services|presenters)\/(.+?)(?:_serializer|_policy|_decorator|_job|_mailer|_service|_presenter)?\.rb$/, (m) => m[1]],
    [/^(?:spec|test)\/(?:models|factories|policies|serializers|services|jobs|mailers)\/(.+?)(?:_spec|_test)?\.rb$/, (m) => singularPath(m[1])],
    [/^(?:spec|test)\/(?:controllers|requests|integration|system|helpers)\/(.+?)(?:_controller)?(?:_spec|_test)\.rb$/, (m) => singularPath(m[1])],
    [/^db\/migrate\/\d+_(?:create|add_\w+_to|remove_\w+_from|change_\w+_in)_(\w+)\.rb$/, (m) => singularize(m[1])],
  ];
  for (const [re, f] of patterns) {
    const m = path.match(re);
    if (m) return f(m);
  }
  return null;
}

function singularPath(p: string) {
  const parts = p.split("/");
  parts[parts.length - 1] = singularize(parts[parts.length - 1]);
  return parts.join("/");
}

export function relatedFiles(path: string, files: string[]): { kind: string; path: string }[] {
  const resource = resourceOf(path);
  if (!resource) return [];
  const name = resource.split("/").pop()!;
  const plural = resource.replace(/[^/]+$/, pluralize(name));
  const pluralName = pluralize(name);
  const rules: [string, RegExp][] = [
    ["Model", new RegExp(`^app/models/${resource}\\.rb$`)],
    ["Controller", new RegExp(`^app/controllers/(?:\\w+/)?${plural}_controller\\.rb$`)],
    ["View", new RegExp(`^app/views/${plural}/[^/]+$`)],
    ["Helper", new RegExp(`^app/helpers/${plural}_helper\\.rb$`)],
    ["Serializer / policy / job", new RegExp(`^app/(?:serializers|policies|decorators|jobs|mailers|services|presenters)/${resource}_\\w+\\.rb$`)],
    ["Spec", new RegExp(`^spec/(?:models|controllers|requests|policies|serializers|helpers|system|jobs|services)/(?:${resource}|${plural}(?:_controller)?)_spec\\.rb$`)],
    ["Test", new RegExp(`^test/(?:models|controllers|integration|system|helpers|jobs)/(?:${resource}|${plural}(?:_controller)?)_test\\.rb$`)],
    ["Factory / fixture", new RegExp(`^(?:spec|test)/(?:factories|fixtures)/(?:${name}|${pluralName})\\.(?:rb|yml)$`)],
    ["Migration", new RegExp(`^db/migrate/\\d+_\\w*_${pluralName}(?:_\\w+)?\\.rb$`)],
  ];
  const current = rel(path);
  const out: { kind: string; path: string }[] = [];
  for (const f of files) {
    if (f === current) continue;
    const rule = rules.find(([, re]) => re.test(f));
    if (rule) out.push({ kind: rule[0], path: f });
  }
  const order = rules.map(([k]) => k);
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.path.localeCompare(a.path));
}

export async function showRelated() {
  const t = activeTab();
  if (!t) return toast("Open a file first.");
  const files = await api.indexFiles();
  const related = relatedFiles(rel(t.path), files);
  if (!related.length) return toast(`No related files found for ${rel(t.path)}.`);
  quickPick({
    placeholder: "Related files",
    items: related.map((r) => ({ label: r.path.split("/").pop()!, description: r.path, detail: r.kind, data: r.path })),
    onAccept: (item) => item && openFile(abs(item.data as string)),
  });
}

/// Routes tool window

interface Route {
  name: string;
  verb: string;
  uri: string;
  action: string;
}

const filter = h("input", { class: "search-input", placeholder: "Filter routes (path, controller#action, name)", spellcheck: false });
const table = h("div", { class: "routes" });
const routesSummary = h("span", { class: "search-summary" });
let routes: Route[] = [];

export const routesView = h(
  "div",
  { class: "routes-view" },
  h("div", { class: "search-bar" }, filter, iconButton("refresh", "Load routes (bin/rails routes)", () => loadRoutes()), routesSummary),
  table,
);
filter.addEventListener("input", () => renderRoutes());

export function parseExpandedRoutes(out: string): Route[] {
  const list: Route[] = [];
  let cur: Partial<Route> | null = null;
  for (const line of out.split("\n")) {
    if (/^--\[ Route \d+ \]/.test(line)) {
      if (cur) list.push(cur as Route);
      cur = { name: "", verb: "", uri: "", action: "" };
      continue;
    }
    const m = line.match(/^(Prefix|Verb|URI|Controller#Action)\s*\|\s?(.*)$/);
    if (!m || !cur) continue;
    const key = ({ Prefix: "name", Verb: "verb", URI: "uri", "Controller#Action": "action" } as const)[m[1] as "Prefix"];
    cur[key] = m[2].trim();
  }
  if (cur) list.push(cur as Route);
  return list;
}

export async function loadRoutes() {
  if (!state.project?.rails) return table.replaceChildren(h("div", { class: "empty" }, "Not a Rails project."));
  routesSummary.textContent = "Running bin/rails routes…";
  try {
    routes = parseExpandedRoutes(await api.runCapture(root(), "bin/rails routes --expanded", 180));
    routesSummary.textContent = `${routes.length} routes`;
  } catch (e) {
    routesSummary.textContent = "";
    table.replaceChildren(h("pre", { class: "error-text" }, String(e)));
    return;
  }
  renderRoutes();
}

function renderRoutes() {
  const q = filter.value.toLowerCase();
  const shown = routes.filter((r) => !q || `${r.name} ${r.verb} ${r.uri} ${r.action}`.toLowerCase().includes(q)).slice(0, 1000);
  table.replaceChildren(
    ...shown.map((r) =>
      h(
        "div",
        { class: "route-row", onclick: () => openAction(r.action) },
        h("span", { class: `verb verb-${r.verb.split("|")[0].toLowerCase()}` }, r.verb || "—"),
        h("span", { class: "route-uri" }, r.uri),
        h("span", { class: "route-action" }, r.action),
        h("span", { class: "dim" }, r.name),
      ),
    ),
  );
}

async function openAction(action: string) {
  const m = action.match(/^([\w/]+)#(\w+)/);
  if (!m) return toast(`${action} is not a controller action (engine, redirect or Rack app).`);
  const path = abs(`app/controllers/${m[1]}_controller.rb`);
  await openFile(path);
  const model = monaco.editor.getModel(monaco.Uri.file(path));
  const hit = model?.findMatches(`^\\s*def ${m[2]}\\b`, false, true, true, null, false)[0];
  if (hit) openFile(path, { line: hit.range.startLineNumber, column: hit.range.startColumn });
}

/// Jumps between a file and its spec/test (and back), like "Go to Test".
export async function goToTest() {
  const t = activeTab();
  if (!t) return toast("Open a file first.");
  const files = await api.indexFiles();
  const path = rel(t.path);
  const isTest = /(_spec|_test)\.rb$/.test(path);
  const related = relatedFiles(path, files).filter((r) => (isTest ? !["Spec", "Test", "Factory / fixture"].includes(r.kind) : r.kind === "Spec" || r.kind === "Test"));
  const direct = isTest
    ? files.filter((f) => f === path.replace(/^(spec|test)\//, "app/").replace(/_(spec|test)\.rb$/, ".rb") || f === path.replace(/^(spec|test)\/lib\//, "lib/").replace(/_(spec|test)\.rb$/, ".rb"))
    : files.filter((f) => f === path.replace(/^app\//, "spec/").replace(/\.rb$/, "_spec.rb") || f === path.replace(/^app\//, "test/").replace(/\.rb$/, "_test.rb") || f === path.replace(/^lib\//, "spec/lib/").replace(/\.rb$/, "_spec.rb"));
  const targets = [...new Set([...direct, ...related.map((r) => r.path)])];
  if (!targets.length) return toast(isTest ? "No subject file found for this test." : `No spec or test found for ${path}.`);
  if (targets.length === 1) return openFile(abs(targets[0]));
  quickPick({
    placeholder: isTest ? "Go to subject" : "Go to test",
    items: targets.map((p) => ({ label: p.split("/").pop()!, description: p, data: p })),
    onAccept: (item) => item && openFile(abs(item.data as string)),
  });
}
