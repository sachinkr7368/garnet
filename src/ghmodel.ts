/// Pure GitHub logic: PR list filtering, patch parsing, comment anchoring, review payloads, merge rules, HTML sanitizing.

export type Ci = "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED" | null;
export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
export type Side = "LEFT" | "RIGHT";

export interface PrSummary {
  number: number;
  title: string;
  url: string;
  repo: string;
  author: string;
  isDraft: boolean;
  state: string;
  reviewDecision: ReviewDecision;
  ci: Ci;
  headRefName: string;
  baseRefName: string;
  updatedAt: string;
}

/// GraphQL fragment for list rows; `toSummary` reads it.
export const PR_LIST_FIELDS = `number title url isDraft state updatedAt headRefName baseRefName reviewDecision
  repository { nameWithOwner } author { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

export function toSummary(n: any): PrSummary {
  return {
    number: n.number,
    title: n.title,
    url: n.url,
    repo: n.repository?.nameWithOwner ?? "",
    author: n.author?.login ?? "ghost",
    isDraft: !!n.isDraft,
    state: n.state,
    reviewDecision: n.reviewDecision ?? null,
    ci: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
    headRefName: n.headRefName ?? "",
    baseRefName: n.baseRefName ?? "",
    updatedAt: n.updatedAt ?? "",
  };
}

const CI_WORDS: Record<string, Ci[]> = { failing: ["FAILURE", "ERROR"], failure: ["FAILURE", "ERROR"], passing: ["SUCCESS"], success: ["SUCCESS"], pending: ["PENDING", "EXPECTED"], none: [null] };
const REVIEW_WORDS: Record<string, ReviewDecision[]> = { approved: ["APPROVED"], changes: ["CHANGES_REQUESTED"], required: ["REVIEW_REQUIRED"], none: [null] };

/// Filters a PR list by a query: free words match title/branch/author/repo; qualifiers `is:draft`, `is:ready`,
/// `ci:failing|passing|pending|none`, `review:approved|changes|required|none`, `author:login`, `#123`.
export function filterPrs(prs: PrSummary[], query: string): PrSummary[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return prs.filter((pr) =>
    terms.every((t) => {
      const neg = t.startsWith("-") && t.length > 1;
      const term = neg ? t.slice(1) : t;
      const [k, v] = term.includes(":") ? [term.slice(0, term.indexOf(":")), term.slice(term.indexOf(":") + 1)] : ["", term];
      let hit: boolean;
      if (k === "is" && (v === "draft" || v === "ready")) hit = pr.isDraft === (v === "draft");
      else if (k === "ci" && CI_WORDS[v]) hit = CI_WORDS[v].includes(pr.ci);
      else if (k === "review" && REVIEW_WORDS[v]) hit = REVIEW_WORDS[v].includes(pr.reviewDecision);
      else if (k === "author") hit = pr.author.toLowerCase() === v.replace(/^@/, "");
      else if (/^#\d+$/.test(term)) hit = pr.number === Number(term.slice(1));
      else hit = [pr.title, pr.headRefName, pr.author, pr.repo, String(pr.number)].some((f) => f.toLowerCase().includes(term));
      return neg ? !hit : hit;
    }),
  );
}

const CI_LABEL: Record<string, string> = { SUCCESS: "Checks passed", FAILURE: "Checks failed", ERROR: "Checks errored", PENDING: "Checks running", EXPECTED: "Checks expected" };
const CI_ICON: Record<string, string> = { SUCCESS: "pass", FAILURE: "error", ERROR: "error", PENDING: "sync", EXPECTED: "circle-outline" };
const REVIEW_LABEL: Record<string, string> = { APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", REVIEW_REQUIRED: "Review required" };
export const ciLabel = (ci: Ci) => CI_LABEL[ci ?? ""] ?? "No checks";
export const ciIcon = (ci: Ci) => CI_ICON[ci ?? ""] ?? "circle-slash";
export const reviewLabel = (r: ReviewDecision) => REVIEW_LABEL[r ?? ""] ?? "";

export interface Check {
  name: string;
  state: "success" | "failure" | "pending" | "neutral" | "skipped";
  url: string | null;
}

/// Normalizes a statusCheckRollup context (CheckRun or StatusContext).
export function toCheck(c: any): Check {
  if (c.__typename === "StatusContext") {
    const s = String(c.state).toLowerCase();
    return { name: c.context, url: c.targetUrl ?? null, state: s === "success" ? "success" : s === "pending" || s === "expected" ? "pending" : "failure" };
  }
  const conclusion = String(c.conclusion ?? "").toLowerCase();
  const state: Check["state"] =
    c.status !== "COMPLETED" ? "pending"
    : conclusion === "success" ? "success"
    : conclusion === "neutral" ? "neutral"
    : conclusion === "skipped" ? "skipped"
    : "failure";
  return { name: c.name, url: c.detailsUrl ?? null, state };
}

/// Unified diff (the `patch` of a PR file)

export interface DiffLine {
  kind: " " | "+" | "-";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
  oldNoNewline: boolean;
  newNoNewline: boolean;
}

export function parsePatch(patch: string | undefined | null): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let last: DiffLine | null = null;
  for (const raw of (patch ?? "").split("\n")) {
    const m = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      cur = { oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4], lines: [], oldNoNewline: false, newNoNewline: false };
      hunks.push(cur);
      oldNo = cur.oldStart;
      newNo = cur.newStart;
      last = null;
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith("\\")) {
      if (last?.kind !== "+") cur.oldNoNewline = true;
      if (last?.kind !== "-") cur.newNoNewline = true;
      continue;
    }
    const kind = raw[0] as DiffLine["kind"];
    if (kind !== " " && kind !== "+" && kind !== "-") continue;
    last = { kind, text: raw.slice(1), oldNo: kind === "+" ? null : oldNo++, newNo: kind === "-" ? null : newNo++ };
    cur.lines.push(last);
  }
  return hunks;
}

const splitLines = (text: string) => {
  const nl = text.endsWith("\n");
  const lines = text.split("\n");
  if (nl || text === "") lines.pop();
  return { lines, nl };
};

/// Rebuilds the base (merge-base) version of a file from its head version and the PR patch.
export function reconstructBase(head: string, patch: string | null | undefined): string {
  const hunks = parsePatch(patch);
  const { lines, nl } = splitLines(head);
  const out: string[] = [];
  let pos = 0;
  let oldNoNl = false;
  let newNoNl = false;
  for (const hk of hunks) {
    const start = hk.newLines === 0 ? hk.newStart : hk.newStart - 1;
    while (pos < start && pos < lines.length) out.push(lines[pos++]);
    for (const l of hk.lines) {
      if (l.kind === " ") out.push(lines[pos++] ?? l.text);
      else if (l.kind === "+") pos++;
      else out.push(l.text);
    }
    oldNoNl ||= hk.oldNoNewline;
    newNoNl ||= hk.newNoNewline;
  }
  while (pos < lines.length) out.push(lines[pos++]);
  if (!out.length) return "";
  const baseNl = oldNoNl ? false : newNoNl || head === "" ? true : nl;
  return out.join("\n") + (baseNl ? "\n" : "");
}

/// Lines GitHub accepts review comments on, per side, mapped to their hunk index.
export function commentableLines(hunks: Hunk[], side: Side): Map<number, number> {
  const map = new Map<number, number>();
  hunks.forEach((hk, i) => {
    for (const l of hk.lines) {
      const no = side === "RIGHT" ? l.newNo : l.oldNo;
      if (no !== null) map.set(no, i);
    }
  });
  return map;
}

/// Why a comment on `start..end` of `side` would be rejected, or null when it is valid.
export function rangeError(hunks: Hunk[], side: Side, start: number, end: number): string | null {
  const lines = commentableLines(hunks, side);
  if (!lines.has(start) || !lines.has(end)) return "Comments can only be added on lines that are part of the diff.";
  if (lines.get(start) !== lines.get(end)) return "A multi-line comment must stay within one diff hunk.";
  return null;
}

/// Review threads

export interface Comment {
  id: string;
  databaseId: number;
  author: string;
  body: string;
  bodyHTML: string;
  createdAt: string;
}
export interface Thread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  startLine: number | null;
  side: Side;
  comments: Comment[];
}

export function toThread(t: any): Thread {
  return {
    id: t.id,
    isResolved: !!t.isResolved,
    isOutdated: !!t.isOutdated,
    path: t.path,
    line: t.line ?? null,
    startLine: t.startLine ?? null,
    side: t.diffSide === "LEFT" ? "LEFT" : "RIGHT",
    comments: (t.comments?.nodes ?? []).map((c: any) => ({
      id: c.id,
      databaseId: c.databaseId,
      author: c.author?.login ?? "ghost",
      body: c.body ?? "",
      bodyHTML: c.bodyHTML ?? "",
      createdAt: c.createdAt ?? "",
    })),
  };
}

/// Where a thread is drawn in the diff: the line it ends on, on its side. Outdated threads have no anchor.
export function anchorOf(t: Thread): { side: Side; line: number } | null {
  return t.line && !t.isOutdated ? { side: t.side, line: t.line } : null;
}

export function threadsForFile(threads: Thread[], path: string) {
  const mine = threads.filter((t) => t.path === path);
  return { anchored: mine.filter((t) => anchorOf(t)), outdated: mine.filter((t) => !anchorOf(t)) };
}

export interface PendingComment {
  path: string;
  side: Side;
  line: number;
  startLine?: number;
  body: string;
}

/// Pending comments in the shape `POST /pulls/{n}/reviews` and `POST /pulls/{n}/comments` expect.
export function toApiComment(c: PendingComment) {
  const multi = c.startLine !== undefined && c.startLine !== c.line;
  return { path: c.path, line: c.line, side: c.side, body: c.body, ...(multi ? { start_line: c.startLine, start_side: c.side } : {}) };
}

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/// Body of a review submission, or an error message when GitHub would reject it.
export function reviewPayload(commitId: string, event: ReviewEvent, body: string, pending: PendingComment[], isAuthor: boolean) {
  if (isAuthor && event !== "COMMENT") return { error: "You can't approve or request changes on your own pull request." };
  if (event !== "APPROVE" && !body.trim() && !pending.length) return { error: event === "COMMENT" ? "Write a comment or add line comments first." : "Explain what needs to change." };
  return { payload: { commit_id: commitId, event, body: body.trim(), comments: pending.map(toApiComment) } };
}

/// Merge

export type MergeMethod = "merge" | "squash" | "rebase";
export interface MergeInfo {
  state: string;
  isDraft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  viewerPermission: string | null;
  mergeCommitAllowed: boolean;
  squashMergeAllowed: boolean;
  rebaseMergeAllowed: boolean;
}

/// Merge methods to offer; empty when the viewer can't merge this PR right now.
export function mergeMethods(m: MergeInfo): MergeMethod[] {
  if (m.state !== "OPEN" || m.isDraft || m.mergeable === "CONFLICTING") return [];
  if (!["ADMIN", "MAINTAIN", "WRITE"].includes(m.viewerPermission ?? "")) return [];
  return ([["merge", m.mergeCommitAllowed], ["squash", m.squashMergeAllowed], ["rebase", m.rebaseMergeAllowed]] as const).filter(([, ok]) => ok).map(([k]) => k);
}

/// Git commands that check out a PR head locally. Fork PRs come from `pull/<n>/head` on the base remote.
export function checkoutPlan(pr: { number: number; headRefName: string; isCrossRepository: boolean; headOwner: string }, localBranches: string[]): { branch: string; steps: string[][] } {
  if (!pr.isCrossRepository) {
    const b = pr.headRefName;
    return {
      branch: b,
      steps: [["fetch", "origin", b], ...(localBranches.includes(b) ? [["checkout", b], ["merge", "--ff-only", `origin/${b}`]] : [["checkout", "-b", b, "--track", `origin/${b}`]])],
    };
  }
  const b = `pr/${pr.number}-${pr.headOwner}-${pr.headRefName}`.replace(/[^\w./-]+/g, "-");
  return {
    branch: b,
    steps: [["fetch", "origin", `pull/${pr.number}/head`], ...(localBranches.includes(b) ? [["checkout", b], ["merge", "--ff-only", "FETCH_HEAD"]] : [["checkout", "-b", b, "FETCH_HEAD"]])],
  };
}

/// Device flow: what to do after one poll response from `github_device_poll`.
export function deviceNext(interval: number, response: string): { done: string } | { wait: number } {
  if (response.startsWith("ok:")) return { done: response.slice(3) };
  if (response.startsWith("slow_down:")) return { wait: Math.max(interval + 5, Number(response.slice(10)) || 0) };
  return { wait: interval };
}

/// HTML from GitHub (bodyHTML, /markdown) is sanitized again before it touches the DOM.

const TAGS = new Set("a abbr b blockquote br code dd del details div dl dt em h1 h2 h3 h4 h5 h6 hr i img ins kbd li ol p pre q s samp span strike strong sub summary sup table tbody td tfoot th thead tr tt ul input g-emoji".split(" "));
const ATTRS = new Set(["href", "src", "alt", "title", "colspan", "rowspan", "align", "type", "checked", "disabled", "open", "lang"]);

export function sanitizeHtml(html: string): DocumentFragment {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const walk = (el: Element) => {
    for (const child of [...el.children]) {
      const tag = child.tagName.toLowerCase();
      if (!TAGS.has(tag)) {
        if (["script", "style", "iframe", "object", "embed", "form", "svg", "math", "link", "meta", "template"].includes(tag)) child.remove();
        else {
          walk(child);
          child.replaceWith(...child.childNodes);
        }
        continue;
      }
      for (const a of [...child.attributes]) {
        const name = a.name.toLowerCase();
        const v = a.value.trim().toLowerCase();
        const badUrl = (name === "href" || name === "src") && !/^(https?:|mailto:|#)/.test(v);
        if (!ATTRS.has(name) || badUrl || (tag === "input" && name === "type" && v !== "checkbox")) child.removeAttribute(a.name);
      }
      if (tag === "input") child.setAttribute("disabled", "");
      walk(child);
    }
  };
  walk(tpl.content as unknown as Element);
  return tpl.content;
}

/// Relative time for list rows ("3 days ago").
export function ago(iso: string, now = Date.now()) {
  const s = (now - Date.parse(iso)) / 1000;
  const units: [number, string][] = [[31536000, "year"], [2592000, "month"], [86400, "day"], [3600, "hour"], [60, "minute"]];
  for (const [n, u] of units) if (s >= n) return `${Math.floor(s / n)} ${u}${Math.floor(s / n) > 1 ? "s" : ""} ago`;
  return "just now";
}

/// Clone input: `owner/name` or a git URL. `explicit` is true for URLs (no search needed).
export function cloneUrl(input: string): { url: string; name: string; explicit: boolean } | null {
  const s = input.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(s) && !s.startsWith(".")) return { url: `https://github.com/${s.replace(/\.git$/, "")}.git`, name: s.split("/")[1].replace(/\.git$/, ""), explicit: false };
  if (/^(https:\/\/|ssh:\/\/|git@)[^\s]+$/.test(s)) {
    const name = s.replace(/\/+$/, "").split(/[/:]/).pop()!.replace(/\.git$/, "");
    return name ? { url: s, name, explicit: true } : null;
  }
  return null;
}

/// Overall clone progress (0-100) from a `git clone --progress` line.
export function cloneProgress(line: string): { phase: string; percent: number } | null {
  const m = line.match(/^(Receiving objects|Resolving deltas|Updating files):\s+(\d+)%/);
  if (!m) return null;
  const p = Number(m[2]);
  const [from, span] = m[1] === "Receiving objects" ? [0, 80] : m[1] === "Resolving deltas" ? [80, 15] : [95, 5];
  return { phase: m[1], percent: Math.round(from + (span * p) / 100) };
}
