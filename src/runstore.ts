/// Where run configurations live. By default they are kept in Garnet's own config dir (keyed by project path),
/// together with the selected configuration, so Garnet never writes into the repository. A configuration marked
/// `shared` ("Store as project file") is written to `<project>/.garnet/run.json` for the team, and only when such a
/// configuration is edited; that file is read only for trusted projects and never deleted.

import { api } from "./ipc";
import { modifyConfig } from "./settings";

export const STATE_FILE = "run-configs.json";
export const projectFile = (root: string) => `${root}/.garnet/run.json`;

export interface Stored<T> {
  selected: string;
  configurations: T[];
}

type Shareable = { name: string; shared?: boolean };

/// Shared (project file) entries first, then local ones; a local entry with a shared entry's name is dropped.
export function mergeConfigs<T extends Shareable>(local: T[], shared: T[]): T[] {
  const names = new Set(shared.map((c) => c.name));
  return [...shared.map((c) => ({ ...c, shared: true })), ...local.filter((c) => !names.has(c.name)).map((c) => ({ ...c, shared: false }))];
}

/// Splits the edited list back into the two stores; the `shared` flag itself is not persisted.
export function splitConfigs<T extends Shareable>(list: T[]): { local: Omit<T, "shared">[]; shared: Omit<T, "shared">[] } {
  const strip = ({ shared: _, ...c }: T) => c;
  return { local: list.filter((c) => !c.shared).map(strip), shared: list.filter((c) => c.shared).map(strip) };
}

async function readAll(): Promise<Record<string, Stored<unknown>>> {
  try {
    const raw = await api.configRead(STATE_FILE);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export async function readLocal(root: string): Promise<Stored<unknown> | null> {
  const entry = (await readAll())[root];
  if (!entry || typeof entry !== "object" || !Array.isArray(entry.configurations)) return null;
  return { selected: typeof entry.selected === "string" ? entry.selected : "", configurations: entry.configurations };
}

export async function writeLocal(root: string, value: Stored<unknown>) {
  await modifyConfig<Record<string, unknown>>(STATE_FILE, {}, (all) => ({ ...all, [root]: value }));
}

/// New .garnet/run.json text for the edited shared configurations, or null when they are unchanged (nothing to
/// write). Unchanged entries keep their original JSON; unknown keys and entries Garnet could not read are kept.
export function projectFileText<T extends { name: string }>(raw: Record<string, unknown> | null, original: T[], shared: T[]): string | null {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (same(original, shared)) return null;
  const entries = Array.isArray(raw?.configurations) ? (raw.configurations as unknown[]) : [];
  const named = (e: unknown) => (e && typeof e === "object" && typeof (e as { name?: unknown }).name === "string" ? (e as { name: string }).name : null);
  const known = new Set(original.map((c) => c.name));
  const configurations = [
    ...shared.map((c) => {
      const entry = entries.find((e) => named(e) === c.name);
      const before = original.find((o) => o.name === c.name);
      if (entry && before && same(before, c)) return entry;
      return { ...(entry && typeof entry === "object" ? entry : {}), ...c };
    }),
    ...entries.filter((e) => !known.has(named(e) ?? "")),
  ];
  return JSON.stringify({ ...(raw ?? {}), configurations }, null, 2) + "\n";
}
