/// In-memory stand-in for the Tauri backend (`src/ipc.ts`), used by every vitest file.
export const fake = {
  files: new Map<string, string>(),
  config: new Map<string, string>(),
  trustedFlag: false,
  calls: [] as string[],
  /// Stdout for `api.runCapture(root, command)`; defaults to "".
  capture: (_command: string): string => "",
  /// Result for `invoke(cmd, args)`; defaults to null.
  invokeResult: (_cmd: string, _args?: any): unknown => null,
  reset() {
    this.files.clear();
    this.config.clear();
    this.calls.length = 0;
    this.capture = () => "";
    this.invokeResult = () => null;
    this.trustedFlag = false;
  },
};

const missing = (path: string) => Promise.reject(new Error(`No such file: ${path}`));

export class Channel<T> {
  onmessage: (m: T) => void = () => {};
}
export const invoke = async (cmd: string, args?: any): Promise<any> => {
  fake.calls.push(cmd);
  return fake.invokeResult(cmd, args);
};

export const api = new Proxy(
  {
    readFile: (path: string) => (fake.files.has(path) ? Promise.resolve(fake.files.get(path)!) : missing(path)),
    writeFile: async (path: string, content: string) => void fake.files.set(path, content),
    createPath: async () => {},
    deletePath: async (path: string) => void fake.files.delete(path),
    configRead: async (name: string) => fake.config.get(name) ?? null,
    configWrite: async (name: string, content: string) => void fake.config.set(name, content),
    configPath: async (name: string) => `/config/${name}`,
    canonicalPath: async (path: string) => path.replace(/\/+$/, ""),
    gitSetTrusted: async (t: boolean) => void (fake.trustedFlag = t),
    runCapture: async (_root: string, command: string) => fake.capture(command),
    indexFiles: async () => [...fake.files.keys()],
  } as Record<string, (...a: any[]) => Promise<any>>,
  {
    get(target, key: string) {
      return (...args: unknown[]) => {
        fake.calls.push(`api.${key}`);
        return target[key] ? target[key](...args) : Promise.resolve(null);
      };
    },
  },
);
