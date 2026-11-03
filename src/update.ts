import { getVersion } from "@tauri-apps/api/app";
import { api, invoke } from "./ipc";
import { modifyConfig, onSettingsChange, setting } from "./settings";
import { toast } from "./ui";

/// Opt-in update check (Settings › Updates): at most once a day, GitHub Releases API, never downloads anything.

const DAY = 24 * 60 * 60 * 1000;
const STORE = "update-check.json";

/// True when release tag `latest` (e.g. "v0.3.1") is a higher version than `current`.
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/i, "").split(/[-+]/)[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [a, b] = [parse(latest), parse(current)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export const dueForCheck = (last: number | undefined, now: number) => !last || now - last >= DAY;

let inFlight: Promise<void> | null = null;

export function checkForUpdates(now = Date.now(), current?: string): Promise<void> {
  inFlight ??= check(now, current).finally(() => (inFlight = null));
  return inFlight;
}

async function check(now: number, current?: string): Promise<void> {
  if (!setting<boolean>("updates.checkForUpdates")) return;
  let last: number | undefined;
  try {
    last = JSON.parse((await api.configRead(STORE)) ?? "{}").last;
  } catch {
    last = undefined;
  }
  if (!dueForCheck(last, now)) return;
  await modifyConfig<Record<string, unknown>>(STORE, {}, () => ({ last: now }));
  let tag: string;
  let url: string;
  try {
    [tag, url] = await invoke<[string, string]>("latest_release");
  } catch {
    return;
  }
  const version = current ?? (await getVersion());
  if (!isNewer(tag, version)) return;
  toast(`Garnet ${tag.replace(/^v/i, "")} is available (you have ${version}).`, "info", [{ label: "Open release page", run: () => void invoke("open_url", { url }) }]);
}

let enabled = false;
onSettingsChange(() => {
  const now = !!setting<boolean>("updates.checkForUpdates");
  if (now && !enabled) checkForUpdates();
  enabled = now;
});
export const initUpdateCheck = () => {
  enabled = !!setting<boolean>("updates.checkForUpdates");
  return checkForUpdates();
};
