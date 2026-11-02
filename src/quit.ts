import { message } from "@tauri-apps/plugin-dialog";

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
