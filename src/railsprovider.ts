import { listen } from "@tauri-apps/api/event";
import { events, monaco } from "./editor";
import { api } from "./ipc";
import {
  absoluteKey, actionDefAt, associationModelAt, buildLocaleIndex, controllerFile, defaultLocale, enclosingDef, factoryModelAt, i18nCalls, i18nKeyAt, localesOf,
  lookupKey, modelFile, partialAt, resolvePartial, routeTargetAt, viewsForAction, type LocaleIndex,
} from "./railsnav";
import { abs, rel, state } from "./state";

/// Monaco wiring for Rails navigation: Cmd+click / Go to Declaration targets, i18n hovers and missing-key warnings.

const LANGS = ["ruby", "erb", "haml", "slim"];
const OWNER = "rails-i18n";

let files: Promise<string[]> | null = null;
let locales: Promise<{ index: LocaleIndex; locale: string }> | null = null;

const projectFiles = () => (files ??= api.indexFiles().catch(() => []));

function localeIndex() {
  locales ??= (async () => {
    const list = (await projectFiles()).filter((f) => /^config\/locales\/.+\.ya?ml$/.test(f));
    const texts = await Promise.all(list.map(async (path) => ({ path, text: await api.readFile(abs(path)).catch(() => "") })));
    const app = await api.readFile(abs("config/application.rb")).catch(() => "");
    return { index: buildLocaleIndex(texts), locale: defaultLocale(app) };
  })();
  return locales;
}

async function lineOf(path: string, re: RegExp): Promise<number> {
  const text = await api.readFile(abs(path)).catch(() => "");
  const i = text.split("\n").findIndex((l) => re.test(l));
  return i < 0 ? 1 : i + 1;
}

const location = (path: string, line = 1): monaco.languages.Location => ({ uri: monaco.Uri.file(abs(path)), range: new monaco.Range(line, 1, line, 1) });

async function targets(model: monaco.editor.ITextModel, pos: monaco.Position): Promise<monaco.languages.Location[]> {
  if (!state.project?.rails || model.uri.scheme !== "file") return [];
  const current = rel(model.uri.fsPath);
  const line = model.getLineContent(pos.lineNumber);
  const col = pos.column - 1;
  const list = await projectFiles();

  const partial = partialAt(line, col);
  if (partial) return resolvePartial(partial, current, list).map((p) => location(p));

  const key = i18nKeyAt(line, col);
  if (key) {
    const full = absoluteKey(key, current, enclosingDef(model.getLinesContent(), pos.lineNumber - 1));
    if (!full) return [];
    const { index, locale } = await localeIndex();
    return [locale, ...localesOf(index).filter((l) => l !== locale)].flatMap((l) => {
      const hit = lookupKey(index, l, full);
      return hit && hit !== "namespace" ? [location(hit.path, hit.line)] : [];
    });
  }

  if (current === "config/routes.rb") {
    const t = routeTargetAt(model.getLinesContent(), pos.lineNumber - 1, col);
    if (!t) return [];
    const file = controllerFile(t.controller);
    if (!list.includes(file)) return [];
    return [location(file, t.action ? await lineOf(file, new RegExp(`^\\s*def\\s+${t.action}\\b`)) : 1)];
  }

  const action = /^app\/(controllers|mailers)\//.test(current) ? actionDefAt(line, col) : null;
  if (action) return viewsForAction(current, action, list).map((p) => location(p));

  const model_ = current.startsWith("app/models/") ? associationModelAt(line, col) : /^(spec|test)\/factories\//.test(current) ? factoryModelAt(line, col) : null;
  if (model_) {
    const file = modelFile(model_, list);
    return file ? [location(file)] : [];
  }
  return [];
}

async function hover(model: monaco.editor.ITextModel, pos: monaco.Position): Promise<monaco.languages.Hover | null> {
  if (!state.project?.rails || model.uri.scheme !== "file") return null;
  const line = model.getLineContent(pos.lineNumber);
  const call = i18nCalls(line).find((c) => pos.column - 1 >= c.start - 1 && pos.column - 1 <= c.end);
  if (!call) return null;
  const full = absoluteKey(call.key, rel(model.uri.fsPath), enclosingDef(model.getLinesContent(), pos.lineNumber - 1));
  if (!full) return null;
  const { index, locale } = await localeIndex();
  const rows = [locale, ...localesOf(index).filter((l) => l !== locale)].map((l) => {
    const hit = lookupKey(index, l, full);
    const text = hit === "namespace" ? "_(group of translations)_" : hit ? `${hit.value.replace(/[\\`*_[\]<>]/g, "\\$&")}` : "_missing_";
    return `**${l}**: ${text}`;
  });
  return {
    range: new monaco.Range(pos.lineNumber, call.start + 1, pos.lineNumber, call.end + 1),
    contents: [{ value: `\`${full}\`` }, { value: rows.join("  \n") }],
  };
}

async function checkKeys(model: monaco.editor.ITextModel) {
  if (model.isDisposed() || !state.project?.rails || model.uri.scheme !== "file" || !LANGS.includes(model.getLanguageId())) return;
  const current = rel(model.uri.fsPath);
  if (!current.startsWith("app/")) return;
  const { index, locale } = await localeIndex();
  if (model.isDisposed()) return;
  if (!index.size) return monaco.editor.setModelMarkers(model, OWNER, []);
  const lines = model.getLinesContent();
  const markers = i18nCalls(model.getValue()).flatMap((c) => {
    if (c.hasDefault) return [];
    const full = absoluteKey(c.key, current, enclosingDef(lines, c.line - 1));
    if (!full || lookupKey(index, locale, full)) return [];
    return [{ severity: monaco.MarkerSeverity.Warning, message: `Missing translation: ${locale}.${full}`, startLineNumber: c.line, startColumn: c.start + 1, endLineNumber: c.line, endColumn: c.end + 1, source: "i18n" }];
  });
  monaco.editor.setModelMarkers(model, OWNER, markers);
}

for (const lang of LANGS) {
  monaco.languages.registerDefinitionProvider(lang, { provideDefinition: (model, pos) => targets(model, pos) });
  monaco.languages.registerHoverProvider(lang, { provideHover: (model, pos) => hover(model, pos) });
}

const timers = new WeakMap<monaco.editor.ITextModel, number>();
events.modelOpened.on((model) => {
  checkKeys(model);
  model.onDidChangeContent(() => {
    clearTimeout(timers.get(model));
    timers.set(model, window.setTimeout(() => checkKeys(model), 500));
  });
});

listen<{ paths: string[]; structural: boolean }>("fs-changed", (e) => {
  if (e.payload.structural) files = null;
  if (e.payload.structural || e.payload.paths.some((p) => /\/config\/(locales\/|application\.rb$)/.test(p))) {
    locales = null;
    for (const model of monaco.editor.getModels()) checkKeys(model);
  }
});
listen("index-ready", () => {
  files = null;
  locales = null;
});
