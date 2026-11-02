import type { ProjectInfo } from "./ipc";

export const state: { project: ProjectInfo | null } = { project: null };

export function root(): string {
  if (!state.project) throw new Error("No project open");
  return state.project.root;
}

export function rel(path: string): string {
  const r = state.project?.root;
  return r && path.startsWith(r + "/") ? path.slice(r.length + 1) : path;
}

export function abs(relative: string): string {
  if (relative.startsWith("/")) return relative;
  return `${root()}/${relative.replace(/^\.\//, "")}`;
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

export function shellQuote(s: string): string {
  return /^[\w./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let t: number | undefined;
  return (...args: A) => {
    clearTimeout(t);
    t = window.setTimeout(() => fn(...args), ms);
  };
}
