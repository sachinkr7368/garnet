import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../editor", async () => await import("./fakeEditor"));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.1.0" }));

import { fake } from "./fakeIpc";
import { parseMigrateStatus } from "../migrations";
import { consoleInput, looksLikePrompt } from "../railsconsole";
import { buildRailsTree } from "../railsview";
import { loadSettings } from "../settings";
import { checkForUpdates, dueForCheck, isNewer } from "../update";

describe("migrations", () => {
  const files = ["db/migrate/20240101000000_create_posts.rb", "db/migrate/20240102000000_add_body_to_posts.rb", "db/cache_migrate/20240103000000_create_cache.rb"];

  it("parses db:migrate:status, including multiple databases and missing files", () => {
    const out = `
database: storage/development.sqlite3

 Status   Migration ID    Migration Name
--------------------------------------------------
   up     20240101000000  Create posts
  down    20240102000000  Add body to posts
   up     20230101000000  ********** NO FILE **********

database: storage/development_cache.sqlite3

 Status   Migration ID    Migration Name
--------------------------------------------------
  down    20240103000000  Create cache
`;
    expect(parseMigrateStatus(out, files)).toEqual([
      { database: "storage/development.sqlite3", status: "up", version: "20240101000000", name: "Create posts", file: files[0] },
      { database: "storage/development.sqlite3", status: "down", version: "20240102000000", name: "Add body to posts", file: files[1] },
      { database: "storage/development.sqlite3", status: "up", version: "20230101000000", name: "********** NO FILE **********", file: null },
      { database: "storage/development_cache.sqlite3", status: "down", version: "20240103000000", name: "Create cache", file: files[2] },
    ]);
  });
});

describe("multi-database migrations", () => {
  it("maps a version to the migration in that database's directory", () => {
    const files = ["db/animals_migrate/20240101000000_create_dogs.rb", "db/migrate/20240101000000_create_posts.rb"];
    const out = "database: blog_development\n up     20240101000000  Create posts\n\ndatabase: animals_development\n up     20240101000000  Create dogs\n";
    expect(parseMigrateStatus(out, files).map((r) => r.file)).toEqual([files[1], files[0]]);
  });
});

describe("Rails project view", () => {
  it("groups files logically, folders first, migrations newest first", () => {
    const tree = buildRailsTree([
      "app/models/post.rb",
      "app/models/concerns/taggable.rb",
      "app/controllers/posts_controller.rb",
      "app/views/posts/index.html.erb",
      "app/helpers/posts_helper.rb",
      "app/mailers/post_mailer.rb",
      "app/jobs/cleanup_job.rb",
      "db/migrate/20240101000000_create_posts.rb",
      "db/migrate/20240201000000_add_body_to_posts.rb",
      "spec/models/post_spec.rb",
      "config/routes.rb",
    ]);
    expect(tree.map((g) => g.label)).toEqual(["Models", "Controllers", "Views", "Helpers", "Mailers", "Jobs", "Migrations", "Specs"]);
    expect(tree[0].children.map((c) => c.label)).toEqual(["concerns", "post.rb"]);
    expect(tree[2].children[0]).toMatchObject({ label: "posts", children: [{ label: "index.html.erb", path: "app/views/posts/index.html.erb" }] });
    expect(tree[6].children.map((c) => [c.label, c.detail])).toEqual([
      ["add_body_to_posts", "20240201000000"],
      ["create_posts", "20240101000000"],
    ]);
  });
});

describe("Rails console", () => {
  it("sends one line as is and multi-line code as a bracketed paste", () => {
    expect(consoleInput("Post.count\n")).toBe("Post.count\r");
    expect(consoleInput("def x\n  1\nend")).toBe("\x1b[200~def x\n  1\nend\x1b[201~\r");
  });

  it.each([
    ["blog(dev)> ", true],
    ["irb(main):001:0> ", true],
    ["[1] pry(main)> ", true],
    ["Loading development environment (Rails 8.0.1)", false],
    ["", false],
  ])("prompt %j → %s", (line, ok) => expect(looksLikePrompt(line)).toBe(ok));
});

describe("update check", () => {
  beforeEach(() => fake.reset());

  it("compares versions", () => {
    expect(isNewer("v0.2.0", "0.1.9")).toBe(true);
    expect(isNewer("v0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("v0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.1.0", "0.2.0")).toBe(false);
    expect(isNewer("v1.0.0-beta", "0.9.9")).toBe(true);
  });

  it("checks at most once a day", () => {
    expect(dueForCheck(undefined, 1000)).toBe(true);
    expect(dueForCheck(1000, 1000 + 3600_000)).toBe(false);
    expect(dueForCheck(1000, 1000 + 24 * 3600_000)).toBe(true);
  });

  it("is off by default and makes no request", async () => {
    await loadSettings(null);
    await checkForUpdates(Date.now(), "0.1.0");
    expect(fake.calls).not.toContain("latest_release");
  });

  it("when enabled, asks GitHub once a day and shows the release link", async () => {
    fake.invokeResult = (cmd) => (cmd === "latest_release" ? ["v0.2.0", "https://github.com/sachinkr7368/garnet/releases/tag/v0.2.0"] : null);
    fake.config.set("settings.json", JSON.stringify({ "updates.checkForUpdates": true }));
    await loadSettings(null);
    const now = Date.now();
    await checkForUpdates(now, "0.1.0");
    expect(fake.calls.filter((c) => c === "latest_release")).toHaveLength(1);
    expect(document.querySelector(".toast")?.textContent).toContain("Garnet 0.2.0 is available");
    await checkForUpdates(now + 3600_000, "0.1.0");
    expect(fake.calls.filter((c) => c === "latest_release")).toHaveLength(1);
  });
});
