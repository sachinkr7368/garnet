import { activeTab, editor } from "./editor";
import { invoke } from "./ipc";
import { configList, launch, newConfig, runs } from "./run";
import { state } from "./state";
import { bottom, toast } from "./ui";

/// Send Selection to Rails Console (⌘⇧↩): selection, or the current line, into the running console.

/// Text as typed into IRB: multi-line input is wrapped in bracketed paste so it arrives as one entry.
export function consoleInput(text: string): string {
  const body = text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  return body.includes("\n") ? `\x1b[200~${body}\x1b[201~\r` : `${body}\r`;
}

/// True once the console shows an input prompt (irb, pry or the Rails app prompt).
export const looksLikePrompt = (line: string) => /(?:>|\*|\?|")\s*$/.test(line.trimEnd()) && /(irb|pry|\(\w[\w-]*\)|>>|\d+:\d+)/.test(line);

function consoleConfig() {
  return configList().find((c) => c.type === "rails-console") ?? newConfig("rails-console", "Rails console");
}

const runningConsole = (name: string) => runs.items.find((i) => (i.title === name || i.title === `${name} (debug)`) && !i.view.exited);

export async function sendToRailsConsole() {
  if (!state.project?.rails) return toast("Not a Rails project.");
  const tab = activeTab();
  const model = editor.getModel();
  const sel = editor.getSelection();
  if (!tab || !model || !sel) return toast("Open a file and select code to send.");
  const text = sel.isEmpty() ? model.getLineContent(sel.startLineNumber) : model.getValueInRange(sel);
  if (!text.trim()) return;
  const cfg = consoleConfig();
  let item = runningConsole(cfg.name);
  if (!item) {
    await launch(cfg, "run");
    item = runningConsole(cfg.name);
    if (!item) return;
    const view = item.view;
    const deadline = Date.now() + 120_000;
    toast("Starting the Rails console; the selection is sent once it is ready.");
    while (!view.exited && Date.now() < deadline) {
      const buf = view.term.buffer.active;
      const line = buf.getLine(buf.cursorY + buf.baseY)?.translateToString(true) ?? "";
      if (view.id !== null && looksLikePrompt(line)) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    if (view.exited || Date.now() >= deadline) return toast("The Rails console did not start; see the Run panel.", "error");
  }
  bottom.show("run");
  runs.select(item);
  await invoke("pty_write", { id: item.view.id, data: consoleInput(text) });
}
