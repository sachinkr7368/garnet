import { api } from "./ipc";
import { modifyConfig } from "./settings";
import { toast } from "./ui";

export interface Buffer {
  path: string;
  text: string;
  /// How the buffer saves back (absent in backups from before 0.2.4: the file's own encoding is used).
  encoding?: string;
  bom?: boolean;
}

const FILE = "unsaved.json";
let last = "";
/// Backups from the last run that the user has not restored or discarded yet; kept in every backup until then.
let pending: { root: string; buffers: Buffer[] } | null = null;

/// Hot exit: the project's unsaved buffers, so a crash, force quit or power loss does not lose them.
export async function backupUnsaved(root: string, buffers: Buffer[]): Promise<boolean> {
  const current = new Set(buffers.map((b) => b.path));
  const all = [...(pending?.root === root ? pending.buffers.filter((b) => !current.has(b.path)) : []), ...buffers];
  const key = `${root}\n${JSON.stringify(all)}`;
  if (key === last) return true;
  const ok = await modifyConfig<Record<string, Buffer[]>>(FILE, {}, (stored) => {
    const next = { ...stored };
    if (all.length) next[root] = all;
    else delete next[root];
    return next;
  });
  if (ok) last = key;
  return ok;
}

/// Offers the buffers backed up for this project when Garnet last stopped without saving them.
export async function offerRestore(root: string, restore: (b: Buffer) => Promise<boolean>) {
  let saved: Buffer[] = [];
  try {
    const stored = JSON.parse((await api.configRead(FILE).catch(() => null)) ?? "{}")[root];
    saved = Array.isArray(stored) ? stored.filter((b) => b && typeof b.path === "string" && typeof b.text === "string") : [];
  } catch {
    return;
  }
  if (!saved.length) return;
  pending = { root, buffers: saved };
  const done = () => {
    pending = null;
    last = "";
  };
  toast(`${saved.length === 1 ? "1 file" : `${saved.length} files`} had unsaved changes when Garnet last closed.`, "info", [
    {
      label: "Restore",
      run: async () => {
        for (const b of saved) await restore(b).catch(() => false);
        done();
      },
    },
    { label: "Discard", run: () => (done(), void backupUnsaved(root, [])) },
  ]);
}
