import { ask } from "@tauri-apps/plugin-dialog";
import { openFile } from "./editor";
import { api } from "./ipc";
import { runInPanel } from "./run";
import { askTrust, setting } from "./settings";
import { abs, root, shellQuote, state } from "./state";
import { bottom, h, iconButton, toast } from "./ui";

/// Migrations tool window: `bin/rails db:migrate:status`, migrate / rollback / redo with confirmation.

export interface MigrationRow {
  database: string;
  status: "up" | "down";
  version: string;
  name: string;
  file: string | null;
}

export function parseMigrateStatus(out: string, files: string[]): MigrationRow[] {
  const rows: MigrationRow[] = [];
  let database = "";
  for (const line of out.replace(/\x1b\[[0-9;]*m/g, "").split("\n")) {
    const db = line.match(/^database:\s*(.+?)\s*$/);
    if (db) database = db[1];
    const m = line.match(/^\s*(up|down)\s+(\d{3,})\s+(.*?)\s*$/);
    if (!m) continue;
    // Multi-database apps keep each database's migrations in db/<name>_migrate; the same version can exist in several.
    const candidates = files.filter((f) => /^db\/(?:\w+_)?migrate\//.test(f) && f.split("/").pop()!.startsWith(`${m[2]}_`));
    const dir = (f: string) => f.match(/^db\/(?:(\w+)_)?migrate\//)?.[1] ?? "";
    const file = candidates.find((f) => dir(f) && database.includes(dir(f))) ?? candidates.find((f) => !dir(f)) ?? candidates[0] ?? null;
    rows.push({ database, status: m[1] as "up" | "down", version: m[2], name: m[3], file });
  }
  return rows;
}

const table = h("div", { class: "migrations" });
const summary = h("span", { class: "search-summary" });
let rows: MigrationRow[] = [];
let busy = false;

export const migrationsView = h(
  "div",
  { class: "migrations-view" },
  h(
    "div",
    { class: "search-bar" },
    iconButton("refresh", "Refresh (bin/rails db:migrate:status)", () => loadMigrations()),
    iconButton("run-all", "Migrate (db:migrate)", () => migrate("db:migrate", "Run all pending migrations")),
    iconButton("discard", "Rollback (db:rollback)", () => migrate("db:rollback", "Roll back the last migration")),
    iconButton("debug-restart", "Redo (db:migrate:redo)", () => migrate("db:migrate:redo", "Roll back and re-run the last migration")),
    summary,
  ),
  table,
);

const env = () => setting<string>("rails.environment");

export async function loadMigrations() {
  if (!state.project?.rails) return table.replaceChildren(h("div", { class: "empty" }, "Not a Rails project."));
  if (!(await askTrust())) return;
  summary.textContent = "Running bin/rails db:migrate:status…";
  try {
    const [out, files] = await Promise.all([api.runCapture(root(), `RAILS_ENV=${shellQuote(env())} bin/rails db:migrate:status 2>&1`, 180), api.indexFiles()]);
    rows = parseMigrateStatus(out, files);
    const pending = rows.filter((r) => r.status === "down").length;
    summary.textContent = `${rows.length} migrations · ${pending} pending · RAILS_ENV=${env()}`;
  } catch (e) {
    summary.textContent = "";
    table.replaceChildren(h("pre", { class: "error-text" }, String(e)));
    return;
  }
  render();
}

function render() {
  const multi = new Set(rows.map((r) => r.database)).size > 1;
  table.replaceChildren(
    ...[...rows].reverse().map((r) =>
      h(
        "div",
        { class: `migration-row ${r.status}`, ondblclick: () => r.file && openFile(abs(r.file)), title: r.file ?? "No migration file for this version" },
        h("span", { class: `migration-status ${r.status}` }, r.status),
        h("span", { class: "migration-version" }, r.version),
        h("span", { class: "migration-name" }, r.name),
        multi ? h("span", { class: "dim" }, r.database) : null,
        h(
          "span",
          { class: "migration-actions" },
          r.file ? iconButton("go-to-file", "Open file", () => openFile(abs(r.file!))) : null,
          r.status === "down"
            ? iconButton("arrow-up", "Migrate up (db:migrate:up)", () => migrate(`db:migrate:up VERSION=${r.version}`, `Apply ${r.version} ${r.name}`))
            : iconButton("arrow-down", "Migrate down (db:migrate:down)", () => migrate(`db:migrate:down VERSION=${r.version}`, `Revert ${r.version} ${r.name}`)),
        ),
      ),
    ),
  );
  if (!rows.length) table.replaceChildren(h("div", { class: "empty" }, "No migrations."));
}

async function migrate(task: string, what: string) {
  if (!state.project?.rails || busy || !(await askTrust())) return;
  const ok = await ask(`${what}?\n\n$ bin/rails ${task}\nRAILS_ENV=${env()}${env() !== "development" ? "\n\nThis is not the development environment." : ""}`, {
    title: "Run Migration",
    kind: "warning",
    okLabel: "Run",
    cancelLabel: "Cancel",
  });
  if (!ok) return;
  busy = true;
  const item = runInPanel(`rails ${task.split(" ")[0]}`, `bin/rails ${task}`, {
    env: { RAILS_ENV: env() },
    onExit: (code) => {
      busy = false;
      if (code === 0) return bottom.show("migrations");
      toast(`bin/rails ${task} failed; see the Run panel.`, "error");
      loadMigrations();
    },
  });
  if (!item) busy = false;
}
