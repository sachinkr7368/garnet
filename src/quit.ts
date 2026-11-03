import { listen } from "@tauri-apps/api/event";
import { message } from "@tauri-apps/plugin-dialog";
import { invoke } from "./ipc";
import { toast } from "./ui";

/// RubyMine's quit check: one prompt listing every unsaved file. True when it is fine to quit.
export async function confirmQuit(unsaved: string[], saveAll: () => Promise<boolean>): Promise<boolean> {
  if (!unsaved.length) return true;
  const list = unsaved.slice(0, 8).join("\n") + (unsaved.length > 8 ? `\n… and ${unsaved.length - 8} more` : "");
  const answer = await message(`Save changes before quitting?\n\n${list}`, {
    title: "Unsaved Changes",
    kind: "warning",
    buttons: { yes: "Save All", no: "Don't Save", cancel: "Cancel" },
  });
  if (answer === "Save All" || answer === "Yes") return saveAll();
  return answer === "Don't Save" || answer === "No";
}

export interface QuitHooks {
  unsaved: () => string[];
  saveAll: () => Promise<boolean>;
  /// Session, breakpoints and the like; false keeps Garnet open.
  persist: () => Promise<boolean>;
}

let quitting = false;

/// Asks about unsaved files, saves what Garnet keeps between runs, then tells the backend to quit or stay open.
export async function quitFlow(hooks: QuitHooks) {
  if (quitting) return;
  quitting = true;
  let ok = false;
  try {
    ok = await confirmQuit(hooks.unsaved(), hooks.saveAll);
    if (ok && !(await hooks.persist().catch(() => false))) {
      ok = false;
      toast("Garnet could not save its session or breakpoints, so it stayed open. Fix the problem shown, then quit again.", "error");
    }
  } catch (e) {
    ok = false;
    toast(`Quit failed: ${e}`, "error");
  } finally {
    quitting = false;
    await invoke("quit_now", { quit: ok }).catch(() => {});
  }
}

/// Close button, ⌘Q, Dock Quit and logout reach the frontend as "close-requested". Each is acknowledged at once, so
/// the backend knows the frontend is alive and never forces the window shut under the prompt or a running Save All.
export async function listenForQuit(hooks: QuitHooks) {
  await listen("close-requested", () => {
    void invoke("close_ack").catch(() => {});
    void quitFlow(hooks);
  });
  await invoke("frontend_ready").catch(() => {});
}
