import { describe, expect, it } from "vitest";
import {
  ago, anchorOf, buildTree, checkoutPlan, commentableLines, deviceNext, filterPrs, mergeMethods, parsePatch, rangeError, reconstructBase, reviewPayload,
  sanitizeHtml, threadsForFile, toApiComment, toCheck, toSummary, toThread, type MergeInfo, type PrSummary,
} from "../ghmodel";

const pr = (o: Partial<PrSummary>): PrSummary => ({
  number: 1, title: "Fix login", url: "", repo: "o/r", author: "ana", isDraft: false, state: "OPEN", reviewDecision: null, ci: null,
  headRefName: "fix-login", baseRefName: "main", updatedAt: "", ...o,
});

describe("PR list", () => {
  const prs = [
    pr({ number: 1, title: "Fix login", ci: "SUCCESS", reviewDecision: "APPROVED" }),
    pr({ number: 2, title: "Add search", author: "bo", isDraft: true, ci: "FAILURE", headRefName: "feat/search" }),
    pr({ number: 3, title: "Bump rails", author: "dependabot", ci: "PENDING", reviewDecision: "REVIEW_REQUIRED", repo: "o/other", headRefName: "bump-rails" }),
  ];
  const nums = (q: string) => filterPrs(prs, q).map((p) => p.number);

  it("matches free text against title, branch, author and repo", () => {
    expect(nums("")).toEqual([1, 2, 3]);
    expect(nums("login")).toEqual([1]);
    expect(nums("feat/")).toEqual([2]);
    expect(nums("other")).toEqual([3]);
    expect(nums("add SEARCH")).toEqual([2]);
  });

  it("supports qualifiers and negation", () => {
    expect(nums("is:draft")).toEqual([2]);
    expect(nums("is:ready")).toEqual([1, 3]);
    expect(nums("ci:failing")).toEqual([2]);
    expect(nums("ci:pending")).toEqual([3]);
    expect(nums("review:approved")).toEqual([1]);
    expect(nums("review:required")).toEqual([3]);
    expect(nums("author:@bo")).toEqual([2]);
    expect(nums("-author:dependabot")).toEqual([1, 2]);
    expect(nums("#3")).toEqual([3]);
    expect(nums("is:ready ci:passing")).toEqual([1]);
  });

  it("reads GraphQL nodes", () => {
    const s = toSummary({
      number: 9, title: "T", url: "u", isDraft: true, state: "OPEN", updatedAt: "x", headRefName: "h", baseRefName: "main", reviewDecision: "APPROVED",
      repository: { nameWithOwner: "o/r" }, author: null, commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
    });
    expect(s).toMatchObject({ number: 9, author: "ghost", ci: "FAILURE", repo: "o/r", isDraft: true });
    expect(toSummary({ number: 1, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }).ci).toBeNull();
  });

  it("normalizes check runs and status contexts", () => {
    expect(toCheck({ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://x" })).toEqual({ name: "test", state: "success", url: "https://x" });
    expect(toCheck({ __typename: "CheckRun", name: "lint", status: "IN_PROGRESS", conclusion: null }).state).toBe("pending");
    expect(toCheck({ __typename: "CheckRun", name: "a", status: "COMPLETED", conclusion: "TIMED_OUT" }).state).toBe("failure");
    expect(toCheck({ __typename: "CheckRun", name: "a", status: "COMPLETED", conclusion: "SKIPPED" }).state).toBe("skipped");
    expect(toCheck({ __typename: "StatusContext", context: "ci/circle", state: "PENDING", targetUrl: null })).toEqual({ name: "ci/circle", state: "pending", url: null });
    expect(toCheck({ __typename: "StatusContext", context: "x", state: "ERROR" }).state).toBe("failure");
  });
});

const head = "a\nB\nc\nd\nE\nf\n";
const patch = "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -4,3 +4,3 @@\n d\n-e\n+E\n f";

describe("patches", () => {
  it("parses hunks with old and new line numbers", () => {
    const [h1, h2] = parsePatch(patch);
    expect(h1).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 });
    expect(h1.lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([[" ", 1, 1], ["-", 2, null], ["+", null, 2], [" ", 3, 3]]);
    expect(h2.lines[1]).toEqual({ kind: "-", text: "e", oldNo: 5, newNo: null });
    expect(parsePatch(undefined)).toEqual([]);
  });

  it("rebuilds the base file from the head file and the patch", () => {
    expect(reconstructBase(head, patch)).toBe("a\nb\nc\nd\ne\nf\n");
    expect(reconstructBase("new\nfile\n", "@@ -0,0 +1,2 @@\n+new\n+file")).toBe("");
    expect(reconstructBase("", "@@ -1,2 +0,0 @@\n-gone\n-file")).toBe("gone\nfile\n");
    expect(reconstructBase("x\ny\n", "@@ -1 +1,2 @@\n x\n+y")).toBe("x\n");
    expect(reconstructBase("1\n2\n3\nnew\n4\n", "@@ -3,0 +4 @@\n+new")).toBe("1\n2\n3\n4\n");
    expect(reconstructBase("same\n", "")).toBe("same\n");
  });

  it("keeps the final-newline state of each side", () => {
    expect(reconstructBase("a\nb\n", "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b")).toBe("a\nb");
    expect(reconstructBase("a\nb", "@@ -1,2 +1,2 @@\n a\n-b\n+b\n\\ No newline at end of file")).toBe("a\nb\n");
    expect(reconstructBase("a\nc", "@@ -1,2 +1,2 @@\n-b\n+a\n c\n\\ No newline at end of file")).toBe("b\nc");
  });

  it("knows which lines take comments and rejects ranges outside a hunk", () => {
    const hunks = parsePatch(patch);
    expect([...commentableLines(hunks, "RIGHT").keys()]).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...commentableLines(hunks, "LEFT").keys()]).toEqual([1, 2, 3, 4, 5, 6]);
    const sparse = parsePatch("@@ -10,2 +10,3 @@\n x\n+y\n z\n@@ -40,1 +41,1 @@\n-q\n+Q");
    expect(rangeError(sparse, "RIGHT", 10, 12)).toBeNull();
    expect(rangeError(sparse, "RIGHT", 41, 41)).toBeNull();
    expect(rangeError(sparse, "RIGHT", 20, 20)).toMatch(/part of the diff/);
    expect(rangeError(sparse, "RIGHT", 11, 41)).toMatch(/one diff hunk/);
    expect(rangeError(sparse, "LEFT", 11, 11)).toBeNull();
    expect(rangeError(sparse, "LEFT", 12, 12)).toMatch(/part of the diff/);
  });
});

describe("review threads and comments", () => {
  const raw = (o: object) => ({ id: "T", isResolved: false, isOutdated: false, path: "a.rb", line: 3, startLine: null, diffSide: "RIGHT", comments: { nodes: [{ id: "C", databaseId: 7, author: { login: "ana" }, body: "hi", bodyHTML: "<p>hi</p>", createdAt: "" }] }, ...o });

  it("anchors threads to their side and line, and sets outdated ones aside", () => {
    const threads = [toThread(raw({})), toThread(raw({ id: "L", diffSide: "LEFT", line: 2 })), toThread(raw({ id: "O", isOutdated: true })), toThread(raw({ id: "N", line: null })), toThread(raw({ id: "X", path: "b.rb" }))];
    expect(anchorOf(threads[0])).toEqual({ side: "RIGHT", line: 3 });
    expect(anchorOf(threads[1])).toEqual({ side: "LEFT", line: 2 });
    expect(anchorOf(threads[2])).toBeNull();
    const f = threadsForFile(threads, "a.rb");
    expect(f.anchored.map((t) => t.id)).toEqual(["T", "L"]);
    expect(f.outdated.map((t) => t.id)).toEqual(["O", "N"]);
    expect(threads[0].comments[0]).toMatchObject({ databaseId: 7, author: "ana" });
  });

  it("maps pending comments to the API shape", () => {
    expect(toApiComment({ path: "a.rb", side: "RIGHT", line: 4, body: "x" })).toEqual({ path: "a.rb", line: 4, side: "RIGHT", body: "x" });
    expect(toApiComment({ path: "a.rb", side: "LEFT", line: 4, startLine: 2, body: "x" })).toEqual({ path: "a.rb", line: 4, side: "LEFT", body: "x", start_line: 2, start_side: "LEFT" });
    expect(toApiComment({ path: "a.rb", side: "RIGHT", line: 4, startLine: 4, body: "x" })).not.toHaveProperty("start_line");
  });

  it("validates review submissions", () => {
    const pending = [{ path: "a.rb", side: "RIGHT" as const, line: 1, body: "nit" }];
    expect(reviewPayload("sha", "APPROVE", "", [], false)).toEqual({ payload: { commit_id: "sha", event: "APPROVE", body: "", comments: [] } });
    expect(reviewPayload("sha", "COMMENT", "", pending, false).payload?.comments).toHaveLength(1);
    expect(reviewPayload("sha", "COMMENT", " ", [], false).error).toMatch(/Write a comment/);
    expect(reviewPayload("sha", "REQUEST_CHANGES", "", [], false).error).toMatch(/what needs to change/);
    expect(reviewPayload("sha", "APPROVE", "", [], true).error).toMatch(/your own/);
    expect(reviewPayload("sha", "COMMENT", "ok", [], true).payload?.event).toBe("COMMENT");
  });
});

describe("merge and checkout", () => {
  const info = (o: Partial<MergeInfo>): MergeInfo => ({ state: "OPEN", isDraft: false, mergeable: "MERGEABLE", viewerPermission: "WRITE", mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false, ...o });

  it("offers only the methods the repo allows, and only when merging is possible", () => {
    expect(mergeMethods(info({}))).toEqual(["merge", "squash"]);
    expect(mergeMethods(info({ rebaseMergeAllowed: true, mergeCommitAllowed: false }))).toEqual(["squash", "rebase"]);
    expect(mergeMethods(info({ isDraft: true }))).toEqual([]);
    expect(mergeMethods(info({ mergeable: "CONFLICTING" }))).toEqual([]);
    expect(mergeMethods(info({ state: "MERGED" }))).toEqual([]);
    expect(mergeMethods(info({ viewerPermission: "READ" }))).toEqual([]);
    expect(mergeMethods(info({ mergeable: "UNKNOWN", viewerPermission: "ADMIN" }))).toEqual(["merge", "squash"]);
  });

  it("checks out same-repo and fork PR branches", () => {
    expect(checkoutPlan({ number: 5, headRefName: "feat", isCrossRepository: false, headOwner: "o" }, [])).toEqual({
      branch: "feat",
      steps: [["fetch", "origin", "feat"], ["checkout", "-b", "feat", "--track", "origin/feat"]],
    });
    expect(checkoutPlan({ number: 5, headRefName: "feat", isCrossRepository: false, headOwner: "o" }, ["feat"]).steps.slice(1)).toEqual([["checkout", "feat"], ["merge", "--ff-only", "origin/feat"]]);
    const fork = checkoutPlan({ number: 12, headRefName: "patch 1", isCrossRepository: true, headOwner: "kim" }, []);
    expect(fork).toEqual({ branch: "pr/12-kim-patch-1", steps: [["fetch", "origin", "pull/12/head"], ["checkout", "-b", "pr/12-kim-patch-1", "FETCH_HEAD"]] });
    expect(checkoutPlan({ number: 12, headRefName: "patch 1", isCrossRepository: true, headOwner: "kim" }, ["pr/12-kim-patch-1"]).steps[2]).toEqual(["merge", "--ff-only", "FETCH_HEAD"]);
  });
});

describe("misc", () => {
  it("builds a compacted changed-files tree, folders first", () => {
    const tree = buildTree(["app/models/user.rb", "app/models/post.rb", "README.md", "spec/models/user_spec.rb", "app/views/a.erb"]);
    expect(tree.map((n) => n.name)).toEqual(["app", "spec/models", "README.md"]);
    expect(tree[0].children.map((n) => n.name)).toEqual(["models", "views", ]);
    expect(tree[0].children[0].children.map((n) => n.path)).toEqual(["app/models/post.rb", "app/models/user.rb"]);
    expect(tree[1].children[0]).toMatchObject({ name: "user_spec.rb", file: true });
  });

  it("drives the device-flow poll interval", () => {
    expect(deviceNext(5, "pending")).toEqual({ wait: 5 });
    expect(deviceNext(5, "slow_down:15")).toEqual({ wait: 15 });
    expect(deviceNext(5, "slow_down:0")).toEqual({ wait: 10 });
    expect(deviceNext(5, "ok:octo")).toEqual({ done: "octo" });
  });

  it("sanitizes GitHub HTML", () => {
    const div = document.createElement("div");
    div.append(sanitizeHtml(`<p onclick="x()">Hi <a href="javascript:alert(1)">bad</a> <a href="https://github.com">ok</a></p><script>alert(1)</script>
      <img src="x" onerror="alert(1)"><custom><b>kept</b></custom><iframe src="https://e"></iframe><input type="checkbox" checked><style>p{}</style>`));
    expect(div.querySelector("script, iframe, style, custom")).toBeNull();
    expect(div.querySelector("p")!.hasAttribute("onclick")).toBe(false);
    const links = div.querySelectorAll("a");
    expect(links[0].hasAttribute("href")).toBe(false);
    expect(links[1].getAttribute("href")).toBe("https://github.com");
    expect(div.querySelector("img")!.attributes.length).toBe(0);
    expect(div.querySelector("b")!.textContent).toBe("kept");
    expect(div.querySelector("input")!.hasAttribute("disabled")).toBe(true);
  });

  it("formats relative times", () => {
    const now = Date.parse("2026-11-02T12:00:00Z");
    expect(ago("2026-11-02T11:59:30Z", now)).toBe("just now");
    expect(ago("2026-10-30T12:00:00Z", now)).toBe("3 days ago");
    expect(ago("2026-11-02T11:00:00Z", now)).toBe("1 hour ago");
  });
});
