/// Stand-in for `src/editor.ts` so modules that touch Monaco at import time load under jsdom.
class Range {
  constructor(
    public startLineNumber: number,
    public startColumn: number,
    public endLineNumber: number,
    public endColumn: number,
  ) {}
  toJSON() {
    return { ...this };
  }
}

function deep(path: string): any {
  const fn = () => deep(`${path}()`);
  return new Proxy(fn, {
    get: (_t, key) => (key === "then" ? undefined : key === Symbol.toPrimitive ? () => path : deep(`${path}.${String(key)}`)),
    apply: () => deep(`${path}()`),
    construct: () => deep(`new ${path}`),
  });
}

const base: Record<string, unknown> = { Range };
export const monaco: any = new Proxy(base, { get: (t, k: string) => (k in t ? t[k] : deep(`monaco.${k}`)) });
const emitter = () => ({ on: () => {}, emit: () => {} });
export const events = new Proxy({} as Record<string, ReturnType<typeof emitter>>, { get: () => emitter() });
export const editor = deep("editor");
export const activeTab = () => null;
export const activeViewTab = (): { key: string } | null => null;
export const allTabs = () => [];
export const openFile = async () => {};
export const ensureModel = async () => null;
export const handlePathMoved = () => {};
export const handleFsChanged = async (_paths: string[]) => {};
export const uriFor = (p: string) => ({ toString: () => `file://${p}` });
export const saveAll = async () => {};
export const languageFor = () => "plaintext";
export const encodingOf = (_path: string): string | undefined => undefined;
export const bufferMeta = (_path: string): { encoding: string; bom: boolean } | undefined => undefined;
export const diffEditorOptions = () => ({});
export const viewTabs: { key: string; title: string; view: { el: HTMLElement; onClose?: () => void } }[] = [];
export const findViewTab = (key: string) => viewTabs.find((t) => t.key === key);
export const openViewTab = (key: string, title: string, view: { el: HTMLElement; onClose?: () => void }) => {
  let t = findViewTab(key);
  if (!t) viewTabs.push((t = { key, title, view }));
  return t;
};
export const retitleViewTab = (key: string, title: string, _tooltip?: string) => {
  const t = findViewTab(key);
  if (t) t.title = title;
};
export const activate = () => {};
export const closeTab = async (t: (typeof viewTabs)[number]) => {
  const i = viewTabs.indexOf(t);
  if (i >= 0) viewTabs.splice(i, 1), t.view.onClose?.();
  return true;
};
