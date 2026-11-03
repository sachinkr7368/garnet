import { beforeEach, describe, expect, it } from "vitest";
import { fake } from "./fakeIpc";
import { vi } from "vitest";

vi.mock("../editor", () => import("./fakeEditor"));
const { run, searchView, searchError, replaceInFiles } = await import("../search");

type Ev = { type: "file"; path: string; matches: { line: number; text: string; ranges: [number, number][]; replacements?: string[] }[]; truncated?: boolean } | { type: "done"; total: number; truncated: boolean };
const channels: { onmessage: (e: Ev) => void }[] = [];
const input = () => searchView.querySelector<HTMLInputElement>("input.search-input")!;
const include = () => searchView.querySelector<HTMLInputElement>("input.search-include")!;
const summary = () => searchView.querySelector(".search-summary")!;
const badges = () => [...searchView.querySelectorAll(".result-file .badge")].map((b) => b.textContent);

beforeEach(() => {
  fake.reset();
  channels.length = 0;
  fake.handlers.set("search_text", (a) => void channels.push(a.onEvent));
  input().value = "foo";
  include().value = "";
});

describe("find in files", () => {
  it("ignores events from a superseded search (B9)", () => {
    replaceInFiles();
    const replaceBox = searchView.querySelector<HTMLInputElement>(".replace-bar input")!;
    replaceBox.value = "old";
    run();
    replaceBox.value = "new";
    run();
    const [stale, current] = channels.slice(-2);
    stale.onmessage({ type: "file", path: "/p/a.rb", matches: [{ line: 1, text: "foo", ranges: [[0, 3]], replacements: ["old"] }] });
    current.onmessage({ type: "file", path: "/p/b.rb", matches: [{ line: 1, text: "foo", ranges: [[0, 3]], replacements: ["new"] }] });
    stale.onmessage({ type: "done", total: 99, truncated: false });
    expect([...searchView.querySelectorAll(".result-name")].map((e) => e.textContent)).toEqual(["b.rb"]);
    expect(searchView.querySelector("ins")!.textContent).toBe("new");
    expect(summary().textContent).toBe("Searching…");
  });

  it("counts matches rather than lines and marks files with unlisted matches (B52, B45)", () => {
    run();
    const ch = channels.at(-1)!;
    ch.onmessage({ type: "file", path: "/p/a.txt", matches: [{ line: 1, text: "foo foo foo", ranges: [[0, 3], [4, 7], [8, 11]] }, { line: 2, text: "foo", ranges: [[0, 3]] }] });
    ch.onmessage({ type: "file", path: "/p/b.txt", matches: [{ line: 1, text: "foo", ranges: [[0, 3]] }], truncated: true });
    ch.onmessage({ type: "done", total: 5, truncated: false });
    expect(badges()).toEqual(["4", "1+"]);
    expect(summary().textContent).toMatch(/^5\+ matches in 2 files/);
    expect(searchView.querySelector(".result-more")).toBeTruthy();
  });

  it("shows a one-line regex error and marks the field (B53)", async () => {
    fake.handlers.set("search_text", () => Promise.reject("regex parse error:\n    (?:foo()\n    ^\nerror: unclosed group"));
    run();
    await new Promise((r) => setTimeout(r));
    expect(summary().textContent).toBe("Invalid regular expression: unclosed group");
    expect(input().classList.contains("invalid")).toBe(true);
    expect(searchError("boom")).toBe("boom");
  });

  it("hints that gitignored files are skipped when an include pattern finds nothing (B54)", () => {
    include().value = "tmp/**";
    run();
    channels.at(-1)!.onmessage({ type: "done", total: 0, truncated: false });
    expect(searchView.querySelector(".results")!.textContent).toContain(".gitignore");
  });

  it("never replaces with text other than what the matches were listed for (review 11)", async () => {
    replaceInFiles();
    const box = searchView.querySelector<HTMLInputElement>(".replace-bar input")!;
    const all = [...searchView.querySelectorAll<HTMLButtonElement>(".replace-bar button")].find((b) => b.textContent === "Replace All")!;
    box.value = "one";
    run();
    const ch = channels.at(-1)!;
    expect(all.disabled).toBe(true);
    ch.onmessage({ type: "file", path: "/p/a.rb", matches: [{ line: 1, text: "foo", ranges: [[0, 3]], replacements: ["one"] }] });
    ch.onmessage({ type: "done", total: 1, truncated: false });
    expect(all.disabled).toBe(false);
    box.value = "two";
    box.dispatchEvent(new Event("input"));
    expect(all.disabled).toBe(true);
    // Even if the button is forced, a stale list is refused before anything is written.
    all.disabled = false;
    all.click();
    await new Promise((r) => setTimeout(r));
    expect(fake.calls).not.toContain("replace_in_file");
    expect(document.querySelector(".toast-msg")?.textContent).toContain("changed since these matches were listed");
  });
});
