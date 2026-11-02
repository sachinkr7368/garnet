import { ask } from "@tauri-apps/plugin-dialog";
import { diffEditorOptions, languageFor, monaco, saveAll } from "./editor";
import { fileTree } from "./git";
import {
  ago, checkoutPlan, ciIcon, ciLabel, commentableLines, filterPrs, mergeMethods, parsePatch, PR_LIST_FIELDS, rangeError, reconstructBase,
  reviewLabel, reviewPayload, threadsForFile, toApiComment, toCheck, toSummary, toThread, type Check, type MergeMethod, type PendingComment,
  type PrSummary, type ReviewEvent, type Side, type Thread,
} from "./ghmodel";
import { createPullRequest, currentLogin, ensureSignedIn, gh, gql, markdownEditor, modal, onAccountChange, onPullRequestCreated, refreshAccount, remoteRepo, renderHtml, signIn } from "./github";
import { invoke } from "./ipc";
import { isTrusted } from "./settings";
import { root, state } from "./state";
import { h, icon, iconButton, quickPick, toast } from "./ui";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/// Pull Requests tool window: review requested, mine, and the current repo's open PRs.

interface Section {
  id: string;
  title: string;
  query: string;
  items: PrSummary[];
  cursor: string | null;
  more: boolean;
  error: string;
  collapsed: boolean;
}

const filterInput = h("input", { class: "gh-input pr-filter", placeholder: "Filter: text, is:draft, ci:failing, review:approved, author:…", spellcheck: false });
const listEl = h("div", { class: "pr-list" });
export const pullRequestsView = h(
  "div",
  { class: "pr-tool" },
  h(
    "div",
    { class: "view-toolbar" },
    filterInput,
    iconButton("refresh", "Refresh", () => loadPullRequests()),
    iconButton("git-pull-request-create", "Create Pull Request…", () => (state.project ? createPullRequest() : toast("Open a folder first."))),
  ),
  listEl,
);

let sections: Section[] = [];
let loadedFor = "";

async function searchPrs(query: string, after: string | null) {
  const data = await gql<any>(
    `query($q: String!, $after: String) { search(query: $q, type: ISSUE, first: 30, after: $after) {
      pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { ${PR_LIST_FIELDS} } } } }`,
    { q: query, after },
  );
  return { items: (data.search.nodes as any[]).filter((n) => n?.number).map(toSummary), cursor: data.search.pageInfo.endCursor as string | null, more: !!data.search.pageInfo.hasNextPage };
}

export async function loadPullRequests() {
  const status = await refreshAccount();
  if (!status.signedIn) {
    sections = [];
    loadedFor = "";
    listEl.replaceChildren(h("div", { class: "empty" }, "Sign in to GitHub to see pull requests. ", h("button", { class: "btn", onclick: () => signIn().then(() => loadPullRequests()) }, "Sign In…")));
    return;
  }
  const repo = await remoteRepo().catch(() => null);
  const slug = repo ? `${repo.owner}/${repo.repo}` : "";
  const prev = new Map(sections.map((s) => [s.id, s.collapsed]));
  sections = [
    { id: "review", title: "Review requested", query: "is:pr is:open review-requested:@me archived:false sort:updated-desc" },
    { id: "mine", title: "My pull requests", query: "is:pr is:open author:@me archived:false sort:updated-desc" },
    ...(slug ? [{ id: "repo", title: `Open in ${slug}`, query: `is:pr is:open repo:${slug} sort:updated-desc` }] : []),
  ].map((s) => ({ ...s, items: [], cursor: null, more: false, error: "", collapsed: prev.get(s.id) ?? false }));
  loadedFor = `${currentLogin()}|${slug}`;
  listEl.replaceChildren(h("div", { class: "empty" }, "Loading pull requests…"));
  await Promise.all(
    sections.map(async (s) => {
      try {
        Object.assign(s, await searchPrs(s.query, null));
      } catch (e) {
        s.error = errText(e);
      }
    }),
  );
  renderList();
}

async function loadMore(s: Section) {
  try {
    const r = await searchPrs(s.query, s.cursor);
    s.items.push(...r.items);
    s.cursor = r.cursor;
    s.more = r.more;
  } catch (e) {
    toast(errText(e), "error");
  }
  renderList();
}

function prRow(pr: PrSummary, currentSlug: string) {
  return h(
    "div",
    { class: "pr-row", title: pr.url, onclick: () => openPullRequest(pr.repo, pr.number) },
    icon(pr.isDraft ? "git-pull-request-draft" : "git-pull-request", pr.isDraft ? "pr-draft" : "pr-open"),
    h(
      "div",
      { class: "pr-row-main" },
      h("div", { class: "pr-row-title" }, pr.title),
      h("div", { class: "pr-row-meta dim" }, `#${pr.number} · ${pr.author}${pr.repo !== currentSlug ? ` · ${pr.repo}` : ""}${pr.updatedAt ? ` · ${ago(pr.updatedAt)}` : ""}`),
    ),
    pr.isDraft ? h("span", { class: "gh-badge" }, "Draft") : null,
    pr.reviewDecision ? h("span", { class: `gh-badge review-${pr.reviewDecision.toLowerCase()}`, title: reviewLabel(pr.reviewDecision) }, reviewLabel(pr.reviewDecision)) : null,
    h("span", { class: `pr-ci ci-${(pr.ci ?? "none").toLowerCase()}`, title: ciLabel(pr.ci) }, icon(ciIcon(pr.ci))),
  );
}

function renderList() {
  const q = filterInput.value;
  const slug = loadedFor.split("|")[1] ?? "";
  listEl.replaceChildren(
    ...sections.map((s) => {
      const items = filterPrs(s.items, q);
      return h(
        "div",
        { class: "pr-section" },
        h(
          "div",
          { class: "change-head pr-section-head", onclick: () => ((s.collapsed = !s.collapsed), renderList()) },
          icon(s.collapsed ? "chevron-right" : "chevron-down"),
          h("span", {}, `${s.title} · ${q ? `${items.length}/` : ""}${s.items.length}${s.more ? "+" : ""}`),
        ),
        ...(s.collapsed
          ? []
          : [
              ...(s.error ? [h("div", { class: "gh-error pr-pad" }, s.error)] : []),
              ...items.map((pr) => prRow(pr, slug)),
              ...(!s.error && !items.length ? [h("div", { class: "dim pr-pad" }, q ? "No matches." : "None.")] : []),
              ...(s.more ? [h("button", { class: "btn pr-more", onclick: () => loadMore(s) }, "Load more")] : []),
            ]),
      );
    }),
  );
}

filterInput.addEventListener("input", renderList);
onAccountChange(() => loadedFor && loadPullRequests());
onPullRequestCreated(() => loadPullRequests());

/// Shown when the tool window opens; reloads when the account or repository changed.
export async function showPullRequests() {
  const repo = await remoteRepo().catch(() => null);
  if (!loadedFor || loadedFor !== `${currentLogin()}|${repo ? `${repo.owner}/${repo.repo}` : ""}`) loadPullRequests();
}

/// Pull request view, shown over the editor area.

interface PrFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface PrDetail {
  slug: string;
  id: string;
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  bodyHTML: string;
  author: string;
  createdAt: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  isCrossRepository: boolean;
  headRepo: string | null;
  headOwner: string;
  reviewDecision: PrSummary["reviewDecision"];
  ci: PrSummary["ci"];
  checks: Check[];
  commits: { oid: string; short: string; headline: string; date: string; author: string; url: string; ci: PrSummary["ci"] }[];
  commitCount: number;
  threads: Thread[];
  methods: MergeMethod[];
  additions: number;
  deletions: number;
}

const THREAD_FIELDS = `id isResolved isOutdated path line startLine diffSide
  comments(first: 100) { nodes { id databaseId body bodyHTML createdAt author { login } } }`;

async function fetchDetail(slug: string, number: number): Promise<PrDetail> {
  const [owner, name] = slug.split("/");
  const data = await gql<any>(
    `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) {
      viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
      pullRequest(number: $number) {
        id number title url state isDraft mergeable bodyHTML createdAt additions deletions reviewDecision
        author { login } headRefName headRefOid baseRefName isCrossRepository
        headRepository { nameWithOwner } headRepositoryOwner { login }
        commits(last: 100) { totalCount nodes { commit { oid abbreviatedOid messageHeadline committedDate url author { name user { login } } statusCheckRollup { state } } } }
        latest: commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes { __typename
          ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state targetUrl } } } } } } }
        reviewThreads(first: 100) { nodes { ${THREAD_FIELDS} } }
      } } }`,
    { owner, name, number },
  );
  const r = data.repository;
  const p = r.pullRequest;
  const rollup = p.latest.nodes[0]?.commit.statusCheckRollup;
  return {
    slug,
    id: p.id,
    number: p.number,
    title: p.title,
    url: p.url,
    state: p.state,
    isDraft: p.isDraft,
    mergeable: p.mergeable,
    bodyHTML: p.bodyHTML,
    author: p.author?.login ?? "ghost",
    createdAt: p.createdAt,
    headRefName: p.headRefName,
    headRefOid: p.headRefOid,
    baseRefName: p.baseRefName,
    isCrossRepository: p.isCrossRepository,
    headRepo: p.headRepository?.nameWithOwner ?? null,
    headOwner: p.headRepositoryOwner?.login ?? "",
    reviewDecision: p.reviewDecision,
    ci: rollup?.state ?? null,
    checks: (rollup?.contexts.nodes ?? []).map(toCheck),
    commits: p.commits.nodes.map(({ commit: c }: any) => ({
      oid: c.oid, short: c.abbreviatedOid, headline: c.messageHeadline, date: c.committedDate, url: c.url, author: c.author?.user?.login ?? c.author?.name ?? "", ci: c.statusCheckRollup?.state ?? null,
    })),
    commitCount: p.commits.totalCount,
    threads: p.reviewThreads.nodes.map(toThread),
    methods: mergeMethods({ ...p, viewerPermission: r.viewerPermission, mergeCommitAllowed: r.mergeCommitAllowed, squashMergeAllowed: r.squashMergeAllowed, rebaseMergeAllowed: r.rebaseMergeAllowed }),
    additions: p.additions,
    deletions: p.deletions,
  };
}

async function fetchThreads(pr: PrDetail) {
  const [owner, name] = pr.slug.split("/");
  const data = await gql<any>(`query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { ${THREAD_FIELDS} } } } } }`, { owner, name, number: pr.number });
  pr.threads = data.repository.pullRequest.reviewThreads.nodes.map(toThread);
}

const viewEl = h("div", { class: "pr-view", hidden: true });
document.getElementById("editor-area")!.append(viewEl);
viewEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !(e.target as HTMLElement).matches("textarea, input")) closePullRequest();
});

let pr: PrDetail | null = null;
let files: PrFile[] = [];
let tab: "overview" | "commits" | "files" = "overview";
const pending = new Map<string, PendingComment[]>();
const pendingFor = (p: PrDetail) => pending.get(`${p.slug}#${p.number}`) ?? [];
const setPending = (p: PrDetail, list: PendingComment[]) => pending.set(`${p.slug}#${p.number}`, list);

export async function closePullRequest() {
  if (pr && pendingFor(pr).length && !(await ask(`You have ${pendingFor(pr).length} pending review comment(s). They stay until you submit or discard them. Close the view?`, { okLabel: "Close", cancelLabel: "Cancel" }))) return;
  viewEl.hidden = true;
  disposeDiff();
  pr = null;
}

export async function openPullRequest(slug: string, number: number) {
  viewEl.hidden = false;
  viewEl.replaceChildren(h("div", { class: "empty" }, `Loading ${slug}#${number}…`));
  try {
    const [detail, fileList] = await Promise.all([fetchDetail(slug, number), gh<PrFile[]>("GET", `/repos/${slug}/pulls/${number}/files?per_page=100`, undefined, { pages: 30 })]);
    if (pr?.slug !== slug || pr?.number !== number) {
      tab = "overview";
      currentFile = null;
    }
    pr = detail;
    files = fileList;
    renderView();
  } catch (e) {
    viewEl.replaceChildren(h("div", { class: "empty" }, `Could not load ${slug}#${number}: ${errText(e)} `, h("button", { class: "btn", onclick: () => openPullRequest(slug, number) }, "Retry"), " ", h("button", { class: "btn", onclick: closePullRequest }, "Close")));
  }
}

const stateLabel = (p: PrDetail) => (p.state === "MERGED" ? "Merged" : p.state === "CLOSED" ? "Closed" : p.isDraft ? "Draft" : "Open");

function renderView() {
  if (!pr) return;
  const p = pr;
  const count = pendingFor(p).length;
  const header = h(
    "div",
    { class: "pr-header" },
    h(
      "div",
      { class: "pr-title-row" },
      h("span", { class: `pr-state state-${stateLabel(p).toLowerCase()}` }, stateLabel(p)),
      h("span", { class: "pr-title" }, p.title, h("span", { class: "dim" }, ` #${p.number}`)),
      h("span", { class: "spacer" }),
      iconButton("refresh", "Refresh", () => openPullRequest(p.slug, p.number)),
      iconButton("link-external", "Open on GitHub", () => invoke("open_url", { url: p.url })),
      iconButton("close", "Close (Esc)", closePullRequest),
    ),
    h(
      "div",
      { class: "pr-sub dim" },
      `${p.author} wants to merge ${p.commitCount} commit(s) from `,
      h("code", {}, p.isCrossRepository ? `${p.headOwner}:${p.headRefName}` : p.headRefName),
      " into ",
      h("code", {}, p.baseRefName),
      ` · `,
      h("span", { class: `pr-ci ci-${(p.ci ?? "none").toLowerCase()}` }, icon(ciIcon(p.ci)), ` ${ciLabel(p.ci)}`),
      p.reviewDecision ? ` · ${reviewLabel(p.reviewDecision)}` : "",
      p.mergeable === "CONFLICTING" ? " · Has conflicts" : "",
    ),
    h(
      "div",
      { class: "pr-actions" },
      h("button", { class: "btn", onclick: () => checkout(p) }, icon("git-branch"), " Check Out"),
      p.state === "OPEN" ? h("button", { class: `btn${count ? " primary" : ""}`, onclick: () => submitReviewDialog(p) }, icon("comment-discussion"), count ? ` Submit Review (${count} pending)` : " Review…") : null,
      p.methods.length ? h("button", { class: "btn", onclick: () => merge(p) }, icon("git-merge"), " Merge…") : null,
    ),
  );
  const tabs = h(
    "div",
    { class: "gh-tabs pr-tabs" },
    ...(
      [
        ["overview", "Overview"],
        ["commits", `Commits ${p.commitCount}`],
        ["files", `Files ${files.length}`],
      ] as const
    ).map(([id, label]) => h("button", { class: `gh-tab${tab === id ? " active" : ""}`, onclick: () => ((tab = id), renderView()) }, label)),
  );
  const body = h("div", { class: "pr-body" });
  viewEl.replaceChildren(header, tabs, body);
  if (tab !== "files") disposeDiff();
  if (tab === "overview") body.append(overview(p));
  if (tab === "commits") body.append(commitsList(p));
  if (tab === "files") body.append(filesPane(p));
}

function overview(p: PrDetail) {
  const order = { failure: 0, pending: 1, neutral: 2, skipped: 3, success: 4 };
  const checks = [...p.checks].sort((a, b) => order[a.state] - order[b.state]);
  const checkIcon = { success: "pass", failure: "error", pending: "sync", neutral: "circle-outline", skipped: "debug-step-over" };
  const unresolved = p.threads.filter((t) => !t.isResolved).length;
  return h(
    "div",
    { class: "pr-overview" },
    h("div", { class: "pr-meta dim" }, `Opened ${ago(p.createdAt)} · +${p.additions} −${p.deletions} · ${p.threads.length} review thread(s), ${unresolved} unresolved`),
    p.bodyHTML.trim() ? renderHtml(p.bodyHTML, "gh-markdown pr-description") : h("div", { class: "dim pr-description" }, "No description provided."),
    h("div", { class: "pr-heading" }, `Checks (${checks.length})`),
    ...(checks.length
      ? checks.map((c) =>
          h(
            "div",
            { class: `pr-check check-${c.state}` },
            icon(checkIcon[c.state]),
            h("span", {}, c.name),
            h("span", { class: "dim" }, c.state),
            h("span", { class: "spacer" }),
            c.url?.startsWith("https://") ? iconButton("link-external", "Details", () => invoke("open_url", { url: c.url })) : null,
          ),
        )
      : [h("div", { class: "dim" }, "No checks reported for the head commit.")]),
  );
}

function commitsList(p: PrDetail) {
  return h(
    "div",
    { class: "pr-commits" },
    p.commitCount > p.commits.length ? h("div", { class: "dim pr-pad" }, `Showing the last ${p.commits.length} of ${p.commitCount} commits.`) : null,
    ...p.commits.map((c) =>
      h(
        "div",
        { class: "pr-commit", title: "Open on GitHub", onclick: () => invoke("open_url", { url: c.url }) },
        h("code", {}, c.short),
        h("span", { class: "pr-commit-msg" }, c.headline),
        h("span", { class: "dim" }, `${c.author} · ${ago(c.date)}`),
        h("span", { class: `pr-ci ci-${(c.ci ?? "none").toLowerCase()}`, title: ciLabel(c.ci) }, icon(ciIcon(c.ci))),
      ),
    ),
  );
}

/// Files tab: changed-files tree and a side-by-side diff with review threads inline.

let currentFile: string | null = null;
let diffEd: monaco.editor.IStandaloneDiffEditor | null = null;
let diffModels: monaco.editor.ITextModel[] = [];
let zones: (() => void)[] = [];
let diffSubs: monaco.IDisposable[] = [];
const collapsedDirs = new Set<string>();

function disposeDiff() {
  zones.forEach((z) => z());
  zones = [];
  diffSubs.forEach((d) => d.dispose());
  diffSubs = [];
  diffEd?.dispose();
  diffEd = null;
  diffModels.forEach((m) => m.dispose());
  diffModels = [];
}

function filesPane(p: PrDetail) {
  const byPath = new Map(files.map((f) => [f.filename, f]));
  const counts = new Map<string, number>();
  for (const t of p.threads) counts.set(t.path, (counts.get(t.path) ?? 0) + 1);
  for (const c of pendingFor(p)) counts.set(c.path, (counts.get(c.path) ?? 0) + 1);
  const treeEl = h("div", { class: "pr-tree" });
  const diffHost = h("div", { class: "pr-diff" });
  const row = (f: PrFile & { path: string }, depth: number) => {
    const c = counts.get(f.path);
    return h(
      "div",
      { class: `change-row pr-file git-${f.status === "added" ? "added" : f.status === "removed" ? "deleted" : f.status === "renamed" ? "renamed" : "modified"}${currentFile === f.path ? " selected" : ""}`, style: `padding-left:${6 + depth * 14}px`, title: f.path, onclick: () => showFile(p, f, diffHost) },
      icon("file"),
      h("span", { class: "change-name" }, f.path.split("/").pop()!),
      c ? h("span", { class: "gh-badge" }, icon("comment"), ` ${c}`) : null,
      h("span", { class: "pr-stat" }, h("span", { class: "add" }, `+${f.additions}`), " ", h("span", { class: "del" }, `−${f.deletions}`)),
    );
  };
  const entries = files.map((f) => ({ ...f, path: f.filename }));
  const renderTree = () => treeEl.replaceChildren(...fileTree(entries, `pr:${p.slug}#${p.number}`, row, renderTree, collapsedDirs));
  renderTree();
  const first = (currentFile && byPath.get(currentFile)) || files[0];
  if (first) queueMicrotask(() => showFile(p, first, diffHost));
  else diffHost.append(h("div", { class: "empty" }, "No changed files."));
  return h("div", { class: "pr-files" }, treeEl, diffHost);
}

const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");

async function showFile(p: PrDetail, f: PrFile, host: HTMLElement) {
  currentFile = f.filename;
  for (const el of host.parentElement?.querySelectorAll<HTMLElement>(".pr-file") ?? []) el.classList.toggle("selected", el.title === f.filename);
  disposeDiff();
  host.replaceChildren(h("div", { class: "empty" }, `Loading ${f.filename}…`));
  if (!f.patch && f.status !== "renamed") {
    host.replaceChildren(h("div", { class: "empty" }, "GitHub does not show a diff for this file (binary or too large). ", h("button", { class: "btn", onclick: () => invoke("open_url", { url: `${p.url}/files` }) }, "Open on GitHub")));
    return;
  }
  let headText = "";
  try {
    if (f.status !== "removed") headText = await gh<string>("GET", `/repos/${p.headRepo ?? p.slug}/contents/${enc(f.filename)}?ref=${p.headRefOid}`, undefined, { raw: true });
  } catch (e) {
    host.replaceChildren(h("div", { class: "gh-error pr-pad" }, `Could not load ${f.filename}: ${errText(e)}`));
    return;
  }
  if (currentFile !== f.filename || pr !== p) return;
  const baseText = f.status === "added" ? "" : reconstructBase(headText, f.patch);
  const hunks = parsePatch(f.patch);
  const lang = languageFor(f.filename);
  const original = monaco.editor.createModel(baseText, lang);
  const modified = monaco.editor.createModel(headText, lang);
  diffModels = [original, modified];
  const { anchored, outdated } = threadsForFile(p.threads, f.filename);
  const editorHost = h("div", { class: "pr-diff-editor" });
  const selBtn = h("button", { class: "btn", title: "Select lines on either side, then add a comment on them" }, icon("comment"), " Comment on Selection");
  host.replaceChildren(
    h(
      "div",
      { class: "pr-file-head" },
      h("span", { class: "pr-file-path" }, f.previous_filename ? `${f.previous_filename} → ${f.filename}` : f.filename),
      h("span", { class: "pr-stat" }, h("span", { class: "add" }, `+${f.additions}`), " ", h("span", { class: "del" }, `−${f.deletions}`)),
      h("span", { class: "spacer" }),
      p.state === "OPEN" ? selBtn : null,
    ),
    ...(outdated.length ? [h("details", { class: "pr-outdated" }, h("summary", {}, `${outdated.length} outdated thread(s)`), ...outdated.map((t) => threadEl(p, t)))] : []),
    editorHost,
  );
  diffEd = monaco.editor.createDiffEditor(editorHost, {
    ...diffEditorOptions(),
    automaticLayout: true,
    readOnly: true,
    originalEditable: false,
    glyphMargin: true,
    minimap: { enabled: false },
    renderOverviewRuler: false,
  });
  diffEd.setModel({ original, modified });
  const sides: Record<Side, monaco.editor.ICodeEditor> = { LEFT: diffEd.getOriginalEditor(), RIGHT: diffEd.getModifiedEditor() };
  let lastSide: Side = "RIGHT";
  let composer: { side: Side; start: number; end: number } | null = null;

  const renderZones = () => {
    zones.forEach((z) => z());
    zones = [];
    const groups = new Map<string, HTMLElement[]>();
    const add = (side: Side, line: number, el: HTMLElement) => {
      const k = `${side}:${line}`;
      groups.set(k, [...(groups.get(k) ?? []), el]);
    };
    for (const t of anchored) add(t.side, t.line!, threadEl(p, t));
    pendingFor(p)
      .filter((c) => c.path === f.filename)
      .forEach((c) => add(c.side, c.line, pendingEl(p, c, renderZones)));
    if (composer) add(composer.side, composer.end, composerEl(p, f, composer, () => ((composer = null), renderZones())));
    for (const [k, els] of groups) {
      const [side, line] = k.split(":");
      zones.push(addZone(sides[side as Side], Number(line), h("div", { class: "pr-zone" }, ...els)));
    }
  };

  const openComposer = (side: Side, start: number, end: number) => {
    const err = rangeError(hunks, side, start, end);
    if (err) return toast(err, "error");
    composer = { side, start, end };
    renderZones();
  };

  for (const side of ["LEFT", "RIGHT"] as Side[]) {
    const ed = sides[side];
    const lines = commentableLines(hunks, side);
    const hover = ed.createDecorationsCollection();
    diffSubs.push(
      ed.onMouseMove((e) => {
        const line = e.target.position?.lineNumber;
        hover.set(line && lines.has(line) && p.state === "OPEN" ? [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: "codicon codicon-add pr-add-comment" } }] : []);
      }),
      ed.onMouseLeave(() => hover.clear()),
      ed.onDidFocusEditorText(() => (lastSide = side)),
      ed.onMouseDown((e) => {
        const line = e.target.position?.lineNumber;
        if (!line || p.state !== "OPEN" || e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !lines.has(line)) return;
        const sel = ed.getSelection();
        const selEnd = sel && sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel?.endLineNumber;
        if (sel && !sel.isEmpty() && selEnd && line >= sel.startLineNumber && line <= selEnd) openComposer(side, sel.startLineNumber, selEnd);
        else openComposer(side, line, line);
      }),
    );
  }
  selBtn.onclick = () => {
    const sel = sides[lastSide].getSelection();
    if (!sel) return toast("Select lines in the diff first.");
    const end = sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber;
    openComposer(lastSide, sel.startLineNumber, end);
  };
  renderZones();
  const firstThread = anchored[0];
  if (firstThread) sides[firstThread.side].revealLineInCenter(firstThread.line!);
}

/// A view zone reserves space after `line`; an overlay widget positioned on it holds the interactive content.
let zoneSeq = 0;
function addZone(ed: monaco.editor.ICodeEditor, line: number, node: HTMLElement): () => void {
  const id = `pr-zone-${++zoneSeq}`;
  node.style.position = "absolute";
  const layout = () => {
    const info = ed.getLayoutInfo();
    node.style.left = `${info.contentLeft}px`;
    node.style.width = `${Math.max(200, info.contentWidth - info.verticalScrollbarWidth - 12)}px`;
  };
  layout();
  const widget: monaco.editor.IOverlayWidget = { getId: () => id, getDomNode: () => node, getPosition: () => null };
  ed.addOverlayWidget(widget);
  const zone: monaco.editor.IViewZone = { afterLineNumber: line, heightInPx: Math.max(40, node.offsetHeight + 8), domNode: h("div"), onDomNodeTop: (top) => (node.style.top = `${top + 4}px`) };
  let zoneId = "";
  ed.changeViewZones((acc) => void (zoneId = acc.addZone(zone)));
  const ro = new ResizeObserver(() => {
    const height = node.offsetHeight + 8;
    if (height !== zone.heightInPx) {
      zone.heightInPx = height;
      ed.changeViewZones((acc) => acc.layoutZone(zoneId));
    }
  });
  ro.observe(node);
  const sub = ed.onDidLayoutChange(layout);
  return () => {
    ro.disconnect();
    sub.dispose();
    ed.changeViewZones((acc) => acc.removeZone(zoneId));
    ed.removeOverlayWidget(widget);
  };
}

function commentEl(c: Thread["comments"][number]) {
  return h("div", { class: "pr-comment" }, h("div", { class: "pr-comment-head" }, h("b", {}, c.author), h("span", { class: "dim" }, ` · ${ago(c.createdAt)}`)), renderHtml(c.bodyHTML));
}

function threadEl(p: PrDetail, t: Thread): HTMLElement {
  const el = h("div", { class: `pr-thread${t.isResolved ? " resolved" : ""}` });
  const render = (expanded: boolean) => {
    const range = t.startLine && t.startLine !== t.line ? `lines ${t.startLine}–${t.line}` : t.line ? `line ${t.line}` : "outdated";
    const head = h(
      "div",
      { class: "pr-thread-head" },
      h("span", { class: "dim" }, `${t.side === "LEFT" ? "Base" : "Head"} ${range}${t.isResolved ? " · resolved" : ""}${t.isOutdated ? " · outdated" : ""}`),
      h("span", { class: "spacer" }),
      t.isResolved ? h("button", { class: "btn small", onclick: () => render(!expanded) }, expanded ? "Collapse" : `Show ${t.comments.length} comment(s)`) : null,
      p.state === "OPEN" || t.isResolved ? h("button", { class: "btn small", onclick: () => resolveThread(p, t, !t.isResolved) }, t.isResolved ? "Unresolve" : "Resolve") : null,
    );
    if (t.isResolved && !expanded) return el.replaceChildren(head);
    const reply = h("textarea", { class: "gh-textarea small", placeholder: "Reply…", rows: 1 });
    const send = h("button", { class: "btn small primary", hidden: true }, "Reply");
    reply.addEventListener("focus", () => ((reply.rows = 3), (send.hidden = false)));
    send.onclick = async () => {
      if (!reply.value.trim()) return;
      send.disabled = true;
      try {
        await gh("POST", `/repos/${p.slug}/pulls/${p.number}/comments/${t.comments[0].databaseId}/replies`, { body: reply.value });
        await refreshThreads(p);
      } catch (e) {
        send.disabled = false;
        toast(errText(e), "error");
      }
    };
    el.replaceChildren(head, ...t.comments.map(commentEl), h("div", { class: "pr-reply" }, reply, send));
  };
  render(false);
  return el;
}

function pendingEl(p: PrDetail, c: PendingComment, rerender: () => void) {
  return h(
    "div",
    { class: "pr-thread pending" },
    h(
      "div",
      { class: "pr-thread-head" },
      h("span", { class: "gh-badge" }, "Pending"),
      h("span", { class: "dim" }, c.startLine && c.startLine !== c.line ? ` lines ${c.startLine}–${c.line}` : ` line ${c.line}`),
      h("span", { class: "spacer" }),
      h("button", { class: "btn small", onclick: () => (setPending(p, pendingFor(p).filter((x) => x !== c)), rerender(), renderActions()) }, "Discard"),
    ),
    h("div", { class: "pr-comment pr-pending-body" }, c.body),
  );
}

function composerEl(p: PrDetail, f: PrFile, at: { side: Side; start: number; end: number }, close: () => void) {
  const text = h("textarea", { class: "gh-textarea", placeholder: "Leave a comment (Markdown)", rows: 4 });
  const error = h("div", { class: "gh-error" });
  const comment = (): PendingComment => ({ path: f.filename, side: at.side, line: at.end, ...(at.start !== at.end ? { startLine: at.start } : {}), body: text.value });
  const single = async () => {
    if (!text.value.trim()) return;
    try {
      await gh("POST", `/repos/${p.slug}/pulls/${p.number}/comments`, { ...toApiComment(comment()), commit_id: p.headRefOid });
      close();
      await refreshThreads(p);
    } catch (e) {
      error.textContent = errText(e);
    }
  };
  const addPending = () => {
    if (!text.value.trim()) return;
    setPending(p, [...pendingFor(p), comment()]);
    close();
    renderActions();
  };
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.metaKey) addPending();
    if (e.key === "Escape") close();
  });
  queueMicrotask(() => text.focus());
  return h(
    "div",
    { class: "pr-thread composer" },
    h("div", { class: "pr-thread-head dim" }, `New comment on ${at.side === "LEFT" ? "base" : "head"} ${at.start !== at.end ? `lines ${at.start}–${at.end}` : `line ${at.end}`}`),
    text,
    error,
    h(
      "div",
      { class: "pr-reply" },
      h("button", { class: "btn small", onclick: close }, "Cancel"),
      h("button", { class: "btn small", onclick: single }, "Add Single Comment"),
      h("button", { class: "btn small primary", title: "⌘↩", onclick: addPending }, pendingFor(p).length ? "Add Review Comment" : "Start a Review"),
    ),
  );
}

/// Updates only the header buttons (pending count) without rebuilding the diff.
function renderActions() {
  if (!pr) return;
  const btn = [...viewEl.querySelectorAll<HTMLButtonElement>(".pr-actions .btn")].find((b) => b.textContent?.includes("Review"));
  const count = pendingFor(pr).length;
  if (!btn) return;
  btn.classList.toggle("primary", count > 0);
  btn.replaceChildren(icon("comment-discussion"), count ? ` Submit Review (${count} pending)` : " Review…");
}

async function refreshThreads(p: PrDetail) {
  try {
    await fetchThreads(p);
  } catch (e) {
    toast(errText(e), "error");
  }
  if (pr === p) renderView();
}

async function resolveThread(p: PrDetail, t: Thread, resolve: boolean) {
  try {
    await gql(`mutation($id: ID!) { ${resolve ? "resolveReviewThread" : "unresolveReviewThread"}(input: { threadId: $id }) { thread { id isResolved } } }`, { id: t.id });
    await refreshThreads(p);
  } catch (e) {
    toast(errText(e), "error");
  }
}

/// Review, merge, checkout

function submitReviewDialog(p: PrDetail) {
  const isAuthor = p.author === currentLogin();
  const md = markdownEditor("", p.slug, "Leave a summary comment (optional for Approve)");
  const opts: [ReviewEvent, string, string][] = [
    ["COMMENT", "Comment", "Submit general feedback without explicit approval."],
    ["APPROVE", "Approve", "Submit feedback and approve merging these changes."],
    ["REQUEST_CHANGES", "Request changes", "Submit feedback that must be addressed before merging."],
  ];
  const radios = opts.map(([ev, label, desc], i) => {
    const r = h("input", { type: "radio", name: "review-event", value: ev, checked: i === 0, disabled: isAuthor && ev !== "COMMENT" });
    return { r, el: h("label", { class: "rc-check pr-review-opt" }, r, h("b", {}, label), h("span", { class: "dim" }, ` ${desc}`)) };
  });
  const error = h("div", { class: "gh-error" });
  const count = pendingFor(p).length;
  const submitBtn = h("button", { class: "btn primary", onclick: () => submit() }, "Submit Review");
  const discardBtn = count ? h("button", { class: "btn", onclick: async () => {
    if (!(await ask(`Discard ${count} pending comment(s)?`, { kind: "warning", okLabel: "Discard", cancelLabel: "Cancel" }))) return;
    setPending(p, []);
    m.close();
    renderView();
  } }, "Discard Pending") : null;
  const body = h(
    "div",
    { class: "rc-form" },
    h("div", { class: "rc-field gh-grow" }, md.el),
    ...radios.map((x) => x.el),
    h("div", { class: "dim" }, count ? `${count} pending line comment(s) will be submitted with this review.` : "No pending line comments."),
    isAuthor ? h("div", { class: "dim" }, "You opened this pull request, so you can only comment.") : null,
    error,
  );
  const m = modal(`Submit Review · #${p.number}`, "comment-discussion", body, [...(discardBtn ? [discardBtn] : []), h("button", { class: "btn", onclick: () => m.close() }, "Cancel"), submitBtn], "gh-pr-create");
  md.area.focus();
  async function submit() {
    const event = (radios.find((x) => x.r.checked)?.r.value ?? "COMMENT") as ReviewEvent;
    const res = reviewPayload(p.headRefOid, event, md.value(), pendingFor(p), isAuthor);
    if (res.error) return (error.textContent = res.error);
    submitBtn.disabled = true;
    try {
      await gh("POST", `/repos/${p.slug}/pulls/${p.number}/reviews`, res.payload);
      setPending(p, []);
      m.close();
      toast(`Review submitted on #${p.number}.`);
      await openPullRequest(p.slug, p.number);
    } catch (e) {
      error.textContent = errText(e);
      submitBtn.disabled = false;
    }
  }
}

const METHOD_LABEL: Record<MergeMethod, string> = { merge: "Create a merge commit", squash: "Squash and merge", rebase: "Rebase and merge" };

function merge(p: PrDetail) {
  quickPick({
    placeholder: `Merge #${p.number} into ${p.baseRefName}`,
    items: p.methods.map((m) => ({ label: METHOD_LABEL[m], icon: "git-merge", data: m })),
    onAccept: async (item) => {
      const method = item?.data as MergeMethod | undefined;
      if (!method) return;
      const ok = await ask(`${METHOD_LABEL[method]}: merge #${p.number} "${p.title}" from ${p.headRefName} into ${p.baseRefName} on GitHub?\n\nThis changes ${p.baseRefName} for everyone and cannot be undone from Garnet.`, {
        title: "Merge Pull Request",
        kind: "warning",
        okLabel: "Merge",
        cancelLabel: "Cancel",
      });
      if (!ok) return;
      try {
        await gh("PUT", `/repos/${p.slug}/pulls/${p.number}/merge`, { merge_method: method, sha: p.headRefOid });
        toast(`Merged #${p.number} into ${p.baseRefName}.`);
        await openPullRequest(p.slug, p.number);
        loadPullRequests();
      } catch (e) {
        toast(`Merge failed: ${errText(e)}`, "error");
      }
    },
  });
}

async function checkout(p: PrDetail) {
  if (!state.project?.git) return toast("Open the repository's project first.", "error");
  if (!isTrusted()) return toast("Trust the project to use Git.", "error");
  const repo = await remoteRepo();
  if (!repo || `${repo.owner}/${repo.repo}`.toLowerCase() !== p.slug.toLowerCase()) return toast(`This project's origin is not ${p.slug}. Open a clone of ${p.slug} to check out the pull request.`, "error");
  const git = (...args: string[]) => invoke<string>("git_run", { root: root(), args });
  await saveAll();
  if ((await git("status", "--porcelain", "--untracked-files=no")).trim()) return toast("You have uncommitted changes. Commit or stash them before checking out the pull request.", "error");
  const local = (await git("for-each-ref", "--format=%(refname:short)", "refs/heads")).split("\n").filter(Boolean);
  const plan = checkoutPlan(p, local);
  try {
    for (const step of plan.steps) await git(...step);
    toast(`Checked out ${plan.branch}.`);
  } catch (e) {
    toast(`Checkout failed: ${errText(e)}`, "error");
  }
}

/// Command: pick any PR of the current repo by number or title.
export async function openPullRequestByNumber() {
  if (!(await ensureSignedIn())) return;
  const repo = await remoteRepo();
  if (!repo) return toast("The origin remote is not a GitHub repository.", "error");
  const slug = `${repo.owner}/${repo.repo}`;
  const { items } = await searchPrs(`is:pr repo:${slug} sort:updated-desc`, null).catch((e) => (toast(errText(e), "error"), { items: [] as PrSummary[] }));
  quickPick({
    placeholder: `Pull requests in ${slug} (type a number or title)`,
    items: items.map((x) => ({ label: `#${x.number} ${x.title}`, description: `${x.author} · ${x.state.toLowerCase()}`, icon: "git-pull-request", data: x.number })),
    onAccept: (item, q) => {
      const n = (item?.data as number | undefined) ?? Number(q.replace(/^#/, ""));
      if (n) openPullRequest(slug, n);
    },
  });
}
