import { beforeEach, describe, expect, it, vi } from "vitest";
const ed = vi.hoisted(() => ({ getModel: (() => null) as () => unknown, getSelection: (() => null) as () => unknown }));
vi.mock("../editor", async () => {
  const fakeEd = await import("./fakeEditor");
  return { ...fakeEd, editor: new Proxy(fakeEd.editor, { get: (t, k) => (k in ed ? (ed as any)[k] : t[k]) }) };
});
vi.mock("../git", () => ({ refreshGit: vi.fn() }));
Element.prototype.scrollIntoView ??= () => {};

import { ask } from "@tauri-apps/plugin-dialog";
import { cloneDialog, createGist, createPullRequest, gh, GhError, signIn, toGhError } from "../github";
import { cloneProgress, cloneUrl } from "../ghmodel";
import { loadPullRequests, openPullRequest, pullRequestsView } from "../prs";
import { loadSettings, trustProject, updateSetting } from "../settings";
import { state } from "../state";
import { pushCurrent } from "../toolbar";
import { fake } from "./fakeIpc";

const ROOT = "/work/app";
const overlay = () => document.getElementById("overlay-root")!;
const button = (text: string, scope: ParentNode = overlay()) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim().startsWith(text));
const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 5) => {
  for (let i = 0; i < n; i++) await flush();
};

type Route = (args: any) => unknown;
function github(routes: Record<string, Route>) {
  fake.handlers.set("github_api", (a) => {
    const key = `${a.method} ${a.path}`;
    const route = routes[key];
    if (!route) throw new Error(`unexpected ${key}`);
    return route(a);
  });
}
const apiCalls = (method: string, path: string) => fake.invocations.filter((i) => i.cmd === "github_api" && i.args.method === method && i.args.path === path);
function gitRoutes(routes: Record<string, string | Error>) {
  fake.handlers.set("git_run", ({ args }: { args: string[] }) => {
    const key = args.join(" ");
    const hit = Object.entries(routes).find(([k]) => key.startsWith(k));
    if (!hit) return "";
    if (hit[1] instanceof Error) throw hit[1];
    return hit[1];
  });
}
const gitCalls = () => fake.invocations.filter((i) => i.cmd === "git_run").map((i) => (i.args.args as string[]).join(" "));
const signedIn = (login: string | null = "octo", extra: object = {}) =>
  fake.handlers.set("github_auth_status", () => ({ login, signedIn: !!login, ghAvailable: false, buildClientId: null, ...extra }));

beforeEach(async () => {
  fake.reset();
  overlay().replaceChildren();
  vi.mocked(ask).mockReset().mockResolvedValue(false);
  state.project = { root: ROOT, name: "app", git: true, rails: false, rspec: false, minitest: false, binRspec: false, debugBundled: false };
  await loadSettings(ROOT);
  await trustProject(ROOT, true);
});

describe("API errors", () => {
  it("classifies prefixed errors and offers sign-in on 401", () => {
    const auth = toGhError("AUTH: GitHub rejected the saved token");
    expect(auth).toBeInstanceOf(GhError);
    expect([auth.kind, auth.message]).toEqual(["auth", "GitHub rejected the saved token"]);
    expect(button("Sign In…")).toBeTruthy();
    expect(toGhError(new Error("RATE: limit")).kind).toBe("rate");
    expect(toGhError("OFFLINE: no network")).toMatchObject({ kind: "offline", message: "no network" });
    expect(toGhError("GitHub 422: nope")).toMatchObject({ kind: "other", message: "GitHub 422: nope" });
  });

  it("passes raw and paging options to the backend", async () => {
    fake.handlers.set("github_api", () => "text");
    await gh("GET", "/x", undefined, { raw: true, pages: 3 });
    expect(fake.invocations.at(-1)!.args).toEqual({ method: "GET", path: "/x", body: null, raw: true, pages: 3 });
    fake.handlers.set("github_api", () => Promise.reject("OFFLINE: down"));
    await expect(gh("GET", "/x")).rejects.toMatchObject({ kind: "offline" });
  });
});

describe("sign in", () => {
  it("offers only a personal access token when gh and an OAuth client id are missing", async () => {
    signedIn(null);
    const done = signIn();
    await settle();
    expect(button("Sign in with Browser")).toBeUndefined();
    expect(button("Use gh Account")).toBeUndefined();
    expect(overlay().textContent).toContain("Pull requests (read and write)");
    fake.handlers.set("github_store_token", ({ token }) => (token === "ghp_abc" ? "octo" : Promise.reject("bad")));
    overlay().querySelector<HTMLInputElement>("input[type=password]")!.value = "ghp_abc";
    button("Sign In")!.click();
    await expect(done).resolves.toBe(true);
    expect(overlay().querySelector(".gh-dialog")).toBeNull();
  });

  it("shows a rejected token inline and keeps the dialog open", async () => {
    signedIn(null);
    signIn();
    await settle();
    fake.handlers.set("github_store_token", () => Promise.reject("AUTH: GitHub rejected the saved token (expired or revoked). Sign in again."));
    overlay().querySelector<HTMLInputElement>("input[type=password]")!.value = "ghp_bad";
    button("Sign In")!.click();
    await settle();
    expect(overlay().querySelector(".gh-signin .gh-error")!.textContent).toContain("rejected");
  });

  it("reuses the gh token and offers the browser when a client id is configured", async () => {
    signedIn(null, { ghAvailable: true });
    await updateSetting("github.oauthClientId", "Iv1.abc");
    const done = signIn();
    await settle();
    expect(button("Sign in with Browser")).toBeTruthy();
    fake.handlers.set("github_use_gh_token", () => "octo");
    button("Use gh Account")!.click();
    await expect(done).resolves.toBe(true);
    await updateSetting("github.oauthClientId", "");
  });

  it("runs the device flow until GitHub returns a token", async () => {
    vi.useFakeTimers();
    signedIn(null, { buildClientId: "Iv1.build" });
    fake.handlers.set("github_device_start", ({ clientId }) => ({ deviceCode: "dc", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", interval: 1, expiresIn: 60, clientId }));
    const polls = ["pending", "slow_down:3", "ok:octo"];
    fake.handlers.set("github_device_poll", () => polls.shift());
    const done = signIn();
    await vi.advanceTimersByTimeAsync(0);
    button("Sign in with Browser")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(overlay().querySelector(".gh-code")!.textContent).toBe("ABCD-1234");
    expect(fake.invocations.find((i) => i.cmd === "open_url")!.args.url).toBe("https://github.com/login/device");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(polls).toEqual(["ok:octo"]);
    await vi.advanceTimersByTimeAsync(6000);
    await expect(done).resolves.toBe(true);
    expect(fake.invocations.find((i) => i.cmd === "github_device_start")!.args.clientId).toBe("Iv1.build");
    vi.useRealTimers();
  });
});

describe("create pull request", () => {
  beforeEach(() => signedIn());

  it("pushes an unpushed branch, then creates the PR with a multi-line markdown body", async () => {
    gitRoutes({
      "remote get-url origin": "git@github.com:o/r.git\n",
      "rev-parse --abbrev-ref HEAD": "feat\n",
      "rev-parse --abbrev-ref @{upstream}": new Error("no upstream"),
      "log -1 --format=%s": "Add search\n",
      "log -1 --format=%b": "Longer body\n",
    });
    let created: any;
    github({
      "GET /repos/o/r": () => ({ default_branch: "main" }),
      "GET /repos/o/r/branches?per_page=100": (a) => (expect(a.pages).toBe(5), [{ name: "main" }, { name: "feat" }, { name: "release" }]),
      "POST /repos/o/r/pulls": (a) => ((created = a.body), { number: 12, html_url: "https://github.com/o/r/pull/12" }),
    });
    vi.mocked(ask).mockResolvedValueOnce(true);
    await createPullRequest();
    expect(gitCalls()).toContain("push --set-upstream origin feat");
    const dialog = overlay().querySelector(".gh-dialog")!;
    const select = dialog.querySelector("select")!;
    expect([...select.options].map((o) => o.value)).toEqual(["main", "release"]);
    expect(dialog.querySelector<HTMLInputElement>("input.gh-input")!.value).toBe("Add search");
    const area = dialog.querySelector("textarea")!;
    expect(area.value).toBe("Longer body");
    area.value = "## Summary\n\n- one\n- two";
    dialog.querySelector<HTMLInputElement>("input[type=checkbox]")!.checked = true;
    button("Create Pull Request")!.click();
    await settle();
    expect(created).toEqual({ title: "Add search", head: "feat", base: "main", body: "## Summary\n\n- one\n- two", draft: true });
    expect(overlay().querySelector(".gh-dialog")).toBeNull();
  });

  it("renders the preview through GitHub's markdown API and keeps errors in the dialog", async () => {
    gitRoutes({ "remote get-url origin": "https://github.com/o/r.git", "rev-parse --abbrev-ref HEAD": "feat", "rev-parse --abbrev-ref @{upstream}": "origin/feat", "rev-list --count": "0", "log -1 --format=%s": "T" });
    github({
      "GET /repos/o/r": () => ({ default_branch: "main" }),
      "GET /repos/o/r/branches?per_page=100": () => [{ name: "main" }],
      "POST /markdown": (a) => (expect(a).toMatchObject({ raw: true, body: { text: "**hi**", mode: "gfm", context: "o/r" } }), "<p><strong>hi</strong><script>x</script></p>"),
      "POST /repos/o/r/pulls": () => Promise.reject("GitHub 422: Validation Failed (A pull request already exists for o:feat.)"),
    });
    await createPullRequest();
    const dialog = overlay().querySelector(".gh-dialog")!;
    dialog.querySelector("textarea")!.value = "**hi**";
    button("Preview", dialog)!.click();
    await settle();
    expect(dialog.querySelector(".gh-preview strong")!.textContent).toBe("hi");
    expect(dialog.querySelector(".gh-preview script")).toBeNull();
    button("Create Pull Request")!.click();
    await settle();
    expect(dialog.querySelector(".gh-error")!.textContent).toContain("already exists");
    expect(overlay().querySelector(".gh-dialog")).toBeTruthy();
  });

  it("refuses to open a PR from the default branch", async () => {
    gitRoutes({ "remote get-url origin": "https://github.com/o/r", "rev-parse --abbrev-ref HEAD": "main" });
    github({ "GET /repos/o/r": () => ({ default_branch: "main" }) });
    await createPullRequest();
    expect(overlay().textContent).toContain("create a feature branch first");
    expect(apiCalls("POST", "/repos/o/r/pulls")).toHaveLength(0);
  });
});

describe("gists, push", () => {
  it("creates a secret gist from the selection", async () => {
    signedIn();
    ed.getModel = () => ({ uri: { fsPath: "/work/app/a.rb" }, getValueInRange: () => "puts 1" });
    ed.getSelection = () => ({ isEmpty: () => false });
    let sent: any;
    github({ "POST /gists": (a) => ((sent = a.body), { html_url: "https://gist.github.com/1" }) });
    await createGist();
    button("Create Gist")!.click();
    await settle();
    expect(sent).toEqual({ description: "", public: false, files: { "a.rb": { content: "puts 1" } } });
  });

  it("pushes with an upstream when the branch has none", async () => {
    gitRoutes({ "for-each-ref": "refs/heads/feat\t*\t\t\n" });
    await pushCurrent();
    await settle();
    expect(gitCalls()).toContain("push --set-upstream origin feat");
    fake.invocations.length = 0;
    gitRoutes({ "for-each-ref": "refs/heads/feat\t*\torigin/feat\t[ahead 1]\n" });
    await pushCurrent();
    await settle();
    expect(gitCalls()).toContain("push");
  });
});

describe("clone", () => {
  it("parses clone input and progress", () => {
    expect(cloneUrl("rails/rails")).toEqual({ url: "https://github.com/rails/rails.git", name: "rails", explicit: false });
    expect(cloneUrl("git@github.com:o/r.git")).toEqual({ url: "git@github.com:o/r.git", name: "r", explicit: true });
    expect(cloneUrl("https://github.com/o/r/")).toMatchObject({ name: "r", explicit: true });
    expect(cloneUrl("search words")).toBeNull();
    expect(cloneProgress("Receiving objects:  50% (5/10)")).toEqual({ phase: "Receiving objects", percent: 40 });
    expect(cloneProgress("Resolving deltas: 100% (3/3), done.")).toEqual({ phase: "Resolving deltas", percent: 95 });
    expect(cloneProgress("remote: Counting objects: 10%")).toBeNull();
  });

  it("lists my repositories, searches GitHub, clones with progress and opens the project", async () => {
    signedIn();
    localStorage.removeItem("garnet.cloneParent");
    github({
      "GET /user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member": () => [
        { full_name: "octo/blog", description: "My blog", private: true, clone_url: "https://github.com/octo/blog.git", stargazers_count: 0 },
        { full_name: "acme/api", description: null, private: false, clone_url: "https://github.com/acme/api.git", stargazers_count: 3 },
      ],
      "GET /search/repositories?q=blo&per_page=30": () => ({ items: [{ full_name: "other/blog-engine", description: "", private: false, clone_url: "https://github.com/other/blog-engine.git", stargazers_count: 9 }] }),
    });
    const opened: string[] = [];
    await cloneDialog((p) => opened.push(p));
    await settle();
    const dialog = overlay().querySelector(".gh-dialog")!;
    expect([...dialog.querySelectorAll(".gh-repo-name")].map((e) => e.textContent)).toEqual(["octo/blog", "acme/api"]);
    const search = dialog.querySelector<HTMLInputElement>("input.gh-input")!;
    search.value = "blo";
    search.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 400));
    await settle();
    expect([...dialog.querySelectorAll(".gh-repo-name")].map((e) => e.textContent)).toEqual(["octo/blog", "other/blog-engine"]);
    (dialog.querySelector(".gh-repo") as HTMLElement).click();
    const [, parent, name] = [...dialog.querySelectorAll<HTMLInputElement>("input.gh-input")];
    expect(parent.value).toBe("/work");
    expect(name.value).toBe("blog");
    fake.handlers.set("github_clone", (a) => {
      a.onProgress.onmessage("Receiving objects: 100% (10/10), done.");
      return null;
    });
    button("Clone")!.click();
    await settle();
    const call = fake.invocations.find((i) => i.cmd === "github_clone")!;
    expect([call.args.url, call.args.dest]).toEqual(["https://github.com/octo/blog.git", "/work/blog"]);
    expect(opened).toEqual(["/work/blog"]);
    expect(localStorage.getItem("garnet.cloneParent")).toBe("/work");
  });

  it("keeps the dialog open with the error when cloning fails", async () => {
    signedIn(null);
    github({});
    await cloneDialog(() => {});
    const dialog = overlay().querySelector(".gh-dialog")!;
    expect(dialog.textContent).toContain("to list your and your organizations' repositories");
    const search = dialog.querySelector<HTMLInputElement>("input.gh-input")!;
    search.value = "https://github.com/o/r.git";
    search.dispatchEvent(new Event("input"));
    (dialog.querySelector(".gh-repo") as HTMLElement).click();
    fake.handlers.set("github_clone", () => Promise.reject("/work/r already exists."));
    button("Clone")!.click();
    await settle();
    expect(dialog.querySelector(".gh-error")!.textContent).toContain("already exists");
    expect(overlay().querySelector(".gh-dialog")).toBeTruthy();
  });
});

const listNode = (o: object) => ({
  number: 1, title: "PR", url: "https://github.com/o/r/pull/1", isDraft: false, state: "OPEN", updatedAt: "2026-11-01T00:00:00Z", headRefName: "h", baseRefName: "main",
  reviewDecision: null, repository: { nameWithOwner: "o/r" }, author: { login: "ana" }, commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] }, ...o,
});

describe("pull requests tool window", () => {
  it("asks to sign in when signed out", async () => {
    signedIn(null);
    await loadPullRequests();
    expect(pullRequestsView.textContent).toContain("Sign in to GitHub to see pull requests");
  });

  it("loads the three lists, filters them and pages", async () => {
    signedIn();
    gitRoutes({ "remote get-url origin": "https://github.com/o/r.git" });
    const queries: string[] = [];
    fake.handlers.set("github_graphql", ({ variables }) => {
      queries.push(`${variables.q}|${variables.after ?? ""}`);
      const nodes =
        variables.q.includes("review-requested") ? [listNode({ number: 4, title: "Review me", reviewDecision: "REVIEW_REQUIRED" })]
        : variables.q.includes("author:@me") ? [listNode({ number: 5, title: "Mine draft", isDraft: true, author: { login: "octo" } })]
        : variables.after ? [listNode({ number: 9, title: "Older" })]
        : [listNode({ number: 6, title: "Fix login" }), listNode({ number: 7, title: "Bump gems", commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] } })];
      return { search: { nodes, pageInfo: { hasNextPage: variables.q.includes("repo:") && !variables.after, endCursor: "c1" } } };
    });
    await loadPullRequests();
    const titles = () => [...pullRequestsView.querySelectorAll(".pr-row-title")].map((e) => e.textContent);
    expect(titles()).toEqual(["Review me", "Mine draft", "Fix login", "Bump gems"]);
    expect(queries.some((q) => q.startsWith("is:pr is:open repo:o/r"))).toBe(true);
    expect(pullRequestsView.textContent).toContain("Open in o/r · 2+");
    const filter = pullRequestsView.querySelector<HTMLInputElement>(".pr-filter")!;
    filter.value = "ci:failing";
    filter.dispatchEvent(new Event("input"));
    expect(titles()).toEqual(["Bump gems"]);
    filter.value = "";
    filter.dispatchEvent(new Event("input"));
    button("Load more", pullRequestsView)!.click();
    await settle();
    expect(titles()).toContain("Older");
    expect(queries).toContain("is:pr is:open repo:o/r sort:updated-desc|c1");
  });
});

const detail = (o: object = {}, repo: object = {}) => ({
  repository: {
    viewerPermission: "WRITE", mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: false, ...repo,
    pullRequest: {
      id: "PR_1", number: 7, title: "Add search", url: "https://github.com/o/r/pull/7", state: "OPEN", isDraft: false, mergeable: "MERGEABLE",
      bodyHTML: "<p>Adds <b>search</b></p><img src=x onerror=alert(1)>", createdAt: "2026-11-01T00:00:00Z", additions: 10, deletions: 2, reviewDecision: "APPROVED",
      author: { login: "ana" }, headRefName: "feat", headRefOid: "abc123", baseRefName: "main", isCrossRepository: false,
      headRepository: { nameWithOwner: "o/r" }, headRepositoryOwner: { login: "o" },
      commits: { totalCount: 1, nodes: [{ commit: { oid: "abc123", abbreviatedOid: "abc", messageHeadline: "Add search", committedDate: "2026-11-01T00:00:00Z", url: "https://github.com/o/r/commit/abc123", author: { name: "Ana", user: { login: "ana" } }, statusCheckRollup: { state: "SUCCESS" } } }] },
      latest: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: { nodes: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci" }, { __typename: "StatusContext", context: "lint", state: "SUCCESS", targetUrl: null }] } } } }] },
      reviewThreads: { nodes: [] },
      ...o,
    },
  },
});

describe("pull request view", () => {
  beforeEach(() => {
    signedIn();
    github({ "GET /repos/o/r/pulls/7/files?per_page=100": (a) => (expect(a.pages).toBe(30), [{ filename: "app/a.rb", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" }]) });
  });
  const view = () => document.querySelector<HTMLElement>(".pr-view")!;

  it("shows the description sanitized, checks failing first, and commits", async () => {
    fake.handlers.set("github_graphql", () => detail());
    await openPullRequest("o/r", 7);
    expect(view().hidden).toBe(false);
    expect(view().querySelector(".pr-title")!.textContent).toBe("Add search #7");
    expect(view().querySelector(".pr-description b")!.textContent).toBe("search");
    expect(view().querySelector(".pr-description img")!.hasAttribute("onerror")).toBe(false);
    expect([...view().querySelectorAll(".pr-check")].map((e) => e.className)).toEqual(["pr-check check-failure", "pr-check check-success"]);
    button("Commits 1", view())!.click();
    expect(view().querySelector(".pr-commit-msg")!.textContent).toBe("Add search");
    expect(button("Files 1", view())).toBeTruthy();
  });

  it("merges only after confirmation, with the head sha", async () => {
    fake.handlers.set("github_graphql", () => detail());
    await openPullRequest("o/r", 7);
    let merged: any;
    github({
      "GET /repos/o/r/pulls/7/files?per_page=100": () => [],
      "PUT /repos/o/r/pulls/7/merge": (a) => ((merged = a.body), { merged: true }),
    });
    button("Merge…", view())!.click();
    await settle();
    const items = [...overlay().querySelectorAll(".qp-item")].map((e) => e.textContent);
    expect(items).toEqual(["Squash and merge"]);
    overlay().querySelector<HTMLElement>(".qp-item")!.dispatchEvent(new MouseEvent("mousedown"));
    await settle();
    expect(vi.mocked(ask)).toHaveBeenCalledWith(expect.stringContaining("cannot be undone"), expect.objectContaining({ okLabel: "Merge" }));
    expect(merged).toBeUndefined();
    vi.mocked(ask).mockResolvedValueOnce(true);
    button("Merge…", view())!.click();
    await settle();
    overlay().querySelector<HTMLElement>(".qp-item")!.dispatchEvent(new MouseEvent("mousedown"));
    await settle(10);
    expect(merged).toEqual({ merge_method: "squash", sha: "abc123" });
  });

  it("hides merge when the viewer can't merge, and blocks approving your own PR", async () => {
    fake.handlers.set("github_graphql", () => detail({ author: { login: "octo" } }, { viewerPermission: "READ" }));
    await openPullRequest("o/r", 7);
    expect(button("Merge…", view())).toBeUndefined();
    button("Review…", view())!.click();
    const radios = [...overlay().querySelectorAll<HTMLInputElement>("input[name=review-event]")];
    expect(radios.map((r) => r.disabled)).toEqual([false, true, true]);
    github({ "POST /repos/o/r/pulls/7/reviews": () => ({}) });
    button("Submit Review")!.click();
    await settle();
    expect(overlay().querySelector(".gh-dialog .gh-error")!.textContent).toMatch(/Write a comment/);
  });

  it("checks out a same-repo PR branch after checking for local changes", async () => {
    fake.handlers.set("github_graphql", () => detail());
    gitRoutes({ "remote get-url origin": "https://github.com/o/r.git", "status --porcelain": "", "for-each-ref": "main\n" });
    await openPullRequest("o/r", 7);
    button("Check Out", view())!.click();
    await settle(10);
    expect(gitCalls()).toEqual(expect.arrayContaining(["fetch origin feat", "checkout -b feat --track origin/feat"]));
    fake.invocations.length = 0;
    gitRoutes({ "remote get-url origin": "https://github.com/o/r.git", "status --porcelain": " M app.rb\n" });
    button("Check Out", view())!.click();
    await settle(10);
    expect(gitCalls().some((c) => c.startsWith("fetch"))).toBe(false);
    expect(overlay().textContent).toContain("uncommitted changes");
  });
});
