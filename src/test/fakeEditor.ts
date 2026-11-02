/// Stand-in for `src/editor.ts` so modules that touch Monaco at import time load under jsdom.
class Range {
  constructor(
    public startLineNumber: number,
    public startColumn: number,
    public endLineNumber: number,
    public endColumn: number,
  ) {}
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
export const allTabs = () => [];
export const openFile = async () => {};
export const ensureModel = async () => null;
export const handlePathMoved = () => {};
export const uriFor = (p: string) => ({ toString: () => `file://${p}` });
export const saveAll = async () => {};
export const languageFor = () => "plaintext";
export const diffEditorOptions = () => ({});
