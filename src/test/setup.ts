import { readFileSync } from "node:fs";
import { vi } from "vitest";
import { fake } from "./fakeIpc";

const html = readFileSync(`${process.cwd()}/index.html`, "utf8");
document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>")).replace(/<script[\s\S]*?<\/script>/g, "");

const media = { dark: false, listeners: new Set<(e: { matches: boolean }) => void>() };
export const setSystemDark = (dark: boolean) => {
  media.dark = dark;
  media.listeners.forEach((fn) => fn({ matches: dark }));
};
window.matchMedia = ((query: string) => ({
  get matches() {
    return query.includes("dark") ? media.dark : false;
  },
  media: query,
  addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => media.listeners.add(fn),
  removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => media.listeners.delete(fn),
})) as unknown as typeof window.matchMedia;
HTMLCanvasElement.prototype.getContext = (() => null) as never;
(globalThis as any).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(async () => false), message: vi.fn(async () => {}), open: vi.fn(async () => null), save: vi.fn(async () => null) }));
vi.mock("../ipc", async () => await import("./fakeIpc"));

export { fake };
