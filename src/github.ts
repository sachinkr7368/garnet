import "./github.css";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { activeTab, editor } from "./editor";
import { cloneProgress, cloneUrl, deviceNext, sanitizeHtml } from "./ghmodel";
import { api, Channel, invoke } from "./ipc";
import { setting } from "./settings";
import { basename, dirname, rel, root, state } from "./state";
import { fuzzyFilter, h, icon, modal as modalBackdrop, quickPick, statusSlot, toast } from "./ui";

/// API access. Errors from Rust carry an `AUTH:`, `RATE:` or `OFFLINE:` prefix.

export class GhError extends Error {
  constructor(
    message: string,
    public kind: "auth" | "rate" | "offline" | "other",
  ) {
    super(message);
  }
}

export function toGhError(e: unknown): GhError {
  const s = String(e instanceof Error ? e.message : e);
  const m = s.match(/^(AUTH|RATE|OFFLINE):\s*/);
  const kind = m ? (m[1].toLowerCase() as GhError["kind"]) : "other";
  const err = new GhError(m ? s.slice(m[0].length) : s, kind);
  if (kind === "auth") {
    refreshAccount();
    toast(err.message, "error", [{ label: "Sign In…", run: () => signIn() }]);
  }
  return err;
}

export async function gh<T = any>(method: string, path: string, body?: unknown, opts: { raw?: boolean; pages?: number } = {}): Promise<T> {
  try {
    return await invoke<T>("github_api", { method, path, body: body === undefined ? null : body, raw: opts.raw ?? false, pages: opts.pages ?? 1 });
  } catch (e) {
    throw toGhError(e);
  }
}

export async function gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  try {
    return await invoke<T>("github_graphql", { query, variables });
  } catch (e) {
    throw toGhError(e);
  }
}

const git = (...args: string[]) => api.git(root(), ...args);

export async function remoteRepo(): Promise<{ owner: string; repo: string } | null> {
  if (!state.project?.git) return null;
  const url = (await git("remote", "get-url", "origin").catch(() => "")).trim();
  const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/// Account

interface AuthStatus {
  login: string | null;
  signedIn: boolean;
  ghAvailable: boolean;
  buildClientId: string | null;
}

let login: string | null = null;
export const currentLogin = () => login;
const accountListeners: (() => void)[] = [];
export const onAccountChange = (fn: () => void) => accountListeners.push(fn);

const accountSlot = statusSlot("github", "right", () => accountMenu());

export async function refreshAccount(): Promise<AuthStatus> {
  const s = (await invoke<AuthStatus | null>("github_auth_status").catch(() => null)) ?? { login: null, signedIn: false, ghAvailable: false, buildClientId: null };
  const changed = s.login !== login;
  login = s.signedIn ? s.login : null;
  accountSlot.replaceChildren(icon("github"), ` ${login ?? (s.signedIn ? "GitHub" : "Sign in")}`);
  accountSlot.title = login ? `Signed in to GitHub as ${login}` : s.signedIn ? "GitHub token saved but not verified (offline?)" : "Sign in to GitHub";
  if (changed) accountListeners.forEach((fn) => fn());
  return s;
}

function accountMenu() {
  if (!login) return signIn();
  quickPick({
    placeholder: `GitHub: signed in as ${login}`,
    items: [
      { label: "Open Profile on GitHub", icon: "link-external", data: "profile" },
      { label: "Switch Account…", icon: "account", data: "switch" },
      { label: "Sign Out", icon: "sign-out", data: "out" },
    ],
    onAccept: (item) => {
      if (item?.data === "profile") invoke("open_url", { url: `https://github.com/${login}` });
      if (item?.data === "switch") signIn();
      if (item?.data === "out") signOut();
    },
  });
}

export async function signOut() {
  if (!(await ask("Sign out of GitHub? The token is removed from the macOS Keychain.", { okLabel: "Sign Out", cancelLabel: "Cancel" }))) return;
  await invoke("github_sign_out");
  await refreshAccount();
  toast("Signed out of GitHub.");
}

/// Command entry point: sign in, or offer sign-out when already signed in.
export async function githubSignIn() {
  const s = await refreshAccount();
  if (s.signedIn) return accountMenu();
  return signIn();
}

export async function ensureSignedIn(): Promise<boolean> {
  if ((await refreshAccount()).signedIn) return true;
  return signIn();
}

/// A small modal using the run-configuration dialog chrome.
export function modal(title: string, iconName: string, body: HTMLElement, actions: HTMLElement[], cls = "") {
  let onClose = () => {};
  const dialog = h(
    "div",
    { class: `rc-dialog gh-dialog ${cls}` },
    h("div", { class: "rc-title" }, icon(iconName), ` ${title}`),
    h("div", { class: "gh-dialog-body" }, body),
    h("div", { class: "rc-actions" }, ...actions),
  );
  let locked = false;
  const backdrop = modalBackdrop(dialog, () => close(), { locked: () => locked });
  const close = () => {
    backdrop.remove();
    onClose();
  };
  return {
    close,
    dialog,
    lock: (v: boolean) => void (locked = v),
    onClose: (fn: () => void) => void (onClose = fn),
  };
}

const PAT_URL = "https://github.com/settings/personal-access-tokens/new";

/// Sign-in dialog: GitHub CLI token, browser (OAuth device flow) when a client id is configured, or a pasted token.
export function signIn(): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = async (who: string) => {
      done = true;
      m.close();
      await refreshAccount();
      toast(`Signed in to GitHub as ${who}.`);
    };
    const error = h("div", { class: "gh-error" });
    const fail = (e: unknown) => (error.textContent = toGhError(e).message);
    const body = h("div", { class: "gh-signin" }, h("div", { class: "dim" }, "Checking for an existing GitHub CLI login…"));
    const m = modal("Sign in to GitHub", "github", body, [h("button", { class: "btn", onclick: () => m.close() }, "Cancel")], "gh-small");
    let cancelled = false;
    m.onClose(() => {
      cancelled = true;
      resolve(done);
    });

    invoke<AuthStatus>("github_auth_status").then((s) => {
      const clientId = s.buildClientId || setting<string>("github.oauthClientId").trim();
      const tokenInput = h("input", { class: "gh-input", type: "password", placeholder: "github_pat_… or ghp_…", spellcheck: false, autocomplete: "off" });
      const saveToken = async () => {
        if (!tokenInput.value.trim()) return;
        error.textContent = "";
        try {
          await finish(await invoke<string>("github_store_token", { token: tokenInput.value }));
        } catch (e) {
          fail(e);
        }
      };
      tokenInput.addEventListener("keydown", (e) => e.key === "Enter" && saveToken());
      const options: HTMLElement[] = [];
      if (s.ghAvailable)
        options.push(
          h(
            "div",
            { class: "gh-option" },
            h("div", {}, h("b", {}, "GitHub CLI"), h("div", { class: "dim" }, "Reuse the account you are logged in to with gh. Its token is copied into your Keychain.")),
            h("button", { class: "btn primary", onclick: () => invoke<string>("github_use_gh_token").then(finish, fail) }, "Use gh Account"),
          ),
        );
      if (clientId)
        options.push(
          h(
            "div",
            { class: "gh-option" },
            h("div", {}, h("b", {}, "Browser"), h("div", { class: "dim" }, "Authorize Garnet on github.com with a one-time code.")),
            h("button", { class: `btn${s.ghAvailable ? "" : " primary"}`, onclick: () => deviceFlow(clientId) }, "Sign in with Browser"),
          ),
        );
      options.push(
        h(
          "div",
          { class: "gh-option column" },
          h("b", {}, "Personal access token"),
          h(
            "div",
            { class: "dim" },
            "Create a fine-grained token with repository permissions Contents (read and write), Pull requests (read and write), Commit statuses (read), Checks (read) and Metadata (read), plus account permission Gists (read and write). A classic token needs the scopes repo, read:org and gist. It is stored in your macOS Keychain only.",
          ),
          h("div", { class: "gh-row" }, tokenInput, h("button", { class: "btn", onclick: saveToken }, "Sign In"), h("button", { class: "btn", onclick: () => invoke("open_url", { url: PAT_URL }) }, "Create Token…")),
        ),
      );
      body.replaceChildren(...options, error);
      (s.ghAvailable || clientId ? (options[0].querySelector("button") as HTMLElement) : tokenInput).focus();
    });

    async function deviceFlow(clientId: string) {
      error.textContent = "";
      try {
        const code = await invoke<{ deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresIn: number }>("github_device_start", { clientId });
        const status = h("div", { class: "dim" }, "Waiting for you to authorize Garnet on GitHub…");
        const openPage = () => {
          navigator.clipboard?.writeText(code.userCode).catch(() => {});
          invoke("open_url", { url: code.verificationUri });
        };
        body.replaceChildren(
          h("div", { class: "gh-device" }, h("div", { class: "dim" }, "Enter this code on GitHub:"), h("div", { class: "gh-code" }, code.userCode), h("button", { class: "btn primary", onclick: openPage }, "Copy Code and Open GitHub"), status),
          error,
        );
        openPage();
        let interval = code.interval;
        const deadline = Date.now() + code.expiresIn * 1000;
        while (!cancelled && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, interval * 1000));
          if (cancelled) return;
          const next = deviceNext(interval, await invoke<string>("github_device_poll", { clientId, deviceCode: code.deviceCode }));
          if ("done" in next) return finish(next.done);
          interval = next.wait;
        }
        if (!cancelled) status.textContent = "The code expired. Close this dialog and try again.";
      } catch (e) {
        fail(e);
      }
    }
  });
}

/// Markdown

/// Renders GitHub-produced HTML (already sanitized by GitHub, sanitized again here); links open in the browser.
export function renderHtml(html: string, cls = "gh-markdown"): HTMLElement {
  const el = h("div", { class: cls });
  el.append(sanitizeHtml(html));
  el.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("https://")) invoke("open_url", { url: href });
  });
  return el;
}

/// Multi-line markdown editor with Write / Preview tabs; preview is rendered by GitHub (`POST /markdown`).
export function markdownEditor(initial: string, context: string | null, placeholder = "Description (Markdown)") {
  const area = h("textarea", { class: "gh-textarea", placeholder, spellcheck: true, value: initial, rows: 10 });
  const preview = h("div", { class: "gh-preview", hidden: true });
  const writeTab = h("button", { class: "gh-tab active", onclick: () => show(false) }, "Write");
  const previewTab = h("button", { class: "gh-tab", onclick: () => show(true) }, "Preview");
  let seq = 0;
  async function show(p: boolean) {
    writeTab.classList.toggle("active", !p);
    previewTab.classList.toggle("active", p);
    area.hidden = p;
    preview.hidden = !p;
    if (!p) return area.focus();
    if (!area.value.trim()) return preview.replaceChildren(h("div", { class: "dim" }, "Nothing to preview."));
    const mine = ++seq;
    preview.replaceChildren(h("div", { class: "dim" }, "Rendering…"));
    try {
      const html = await gh<string>("POST", "/markdown", { text: area.value, mode: "gfm", ...(context ? { context } : {}) }, { raw: true });
      if (mine === seq) preview.replaceChildren(renderHtml(html));
    } catch (e) {
      if (mine === seq) preview.replaceChildren(h("div", { class: "gh-error" }, `Preview failed: ${e instanceof Error ? e.message : e}`));
    }
  }
  area.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !e.shiftKey && !e.metaKey) {
      e.preventDefault();
      area.setRangeText("  ", area.selectionStart, area.selectionEnd, "end");
    }
  });
  const el = h("div", { class: "gh-md" }, h("div", { class: "gh-tabs" }, writeTab, previewTab), area, preview);
  return { el, area, value: () => area.value };
}

/// Create pull request

async function requireRepo(): Promise<{ owner: string; repo: string } | null> {
  if (!(await ensureSignedIn())) return null;
  const repo = await remoteRepo();
  if (!repo) toast("The origin remote is not a GitHub repository.", "error");
  return repo;
}

let prCreated: () => void = () => {};
export const onPullRequestCreated = (fn: () => void) => (prCreated = fn);

export async function createPullRequest() {
  const repo = await requireRepo();
  if (!repo) return;
  const slug = `${repo.owner}/${repo.repo}`;
  try {
    const branch = (await git("rev-parse", "--abbrev-ref", "HEAD")).trim();
    const info = await gh<{ default_branch: string }>("GET", `/repos/${slug}`);
    if (branch === "HEAD") return toast("You are not on a branch.", "error");
    if (branch === info.default_branch) return toast(`You are on ${branch}; create a feature branch first.`, "error");
    const upstream = (await git("rev-parse", "--abbrev-ref", "@{upstream}").catch(() => "")).trim();
    if (!upstream) {
      if (!(await ask(`${branch} has not been pushed. Push it to origin now?`, { okLabel: "Push", cancelLabel: "Cancel" }))) return;
      await git("push", "--set-upstream", "origin", branch);
    } else if ((await git("rev-list", "--count", "@{upstream}..HEAD").catch(() => "0")).trim() !== "0") {
      if (await ask(`${branch} has commits that are not pushed yet. Push them first?`, { okLabel: "Push", cancelLabel: "Skip" })) await git("push");
    }
    const [subject, msgBody, branches] = await Promise.all([
      git("log", "-1", "--format=%s"),
      git("log", "-1", "--format=%b"),
      gh<{ name: string }[]>("GET", `/repos/${slug}/branches?per_page=100`, undefined, { pages: 5 }).catch(() => [{ name: info.default_branch }]),
    ]);
    pullRequestDialog({ slug, branch, defaultBase: info.default_branch, bases: branches.map((b) => b.name).filter((b) => b !== branch), title: subject.trim(), body: msgBody.trim() });
  } catch (e) {
    toast(`Create pull request: ${e instanceof Error ? e.message : e}`, "error");
  }
}

export function pullRequestDialog(o: { slug: string; branch: string; defaultBase: string; bases: string[]; title: string; body: string }) {
  const title = h("input", { class: "gh-input", value: o.title, placeholder: "Title", spellcheck: true });
  const base = h("select", { class: "gh-input" }, ...[o.defaultBase, ...o.bases.filter((b) => b !== o.defaultBase)].map((b) => h("option", { value: b }, b)));
  const draft = h("input", { type: "checkbox" });
  const md = markdownEditor(o.body, o.slug);
  const error = h("div", { class: "gh-error" });
  const createBtn = h("button", { class: "btn primary", onclick: () => submit() }, "Create Pull Request");
  const body = h(
    "div",
    { class: "rc-form" },
    h("label", { class: "rc-field" }, h("span", {}, "Title"), title),
    h("label", { class: "rc-field" }, h("span", {}, `Merge ${o.branch} into`), base),
    h("div", { class: "rc-field gh-grow" }, h("span", {}, "Description"), md.el),
    h("label", { class: "rc-check" }, draft, "Create as draft"),
    error,
  );
  const m = modal(`New Pull Request · ${o.slug}`, "git-pull-request", body, [h("button", { class: "btn", onclick: () => m.close() }, "Cancel"), createBtn], "gh-pr-create");
  title.focus();
  async function submit() {
    if (!title.value.trim()) return (error.textContent = "Enter a title.");
    error.textContent = "";
    createBtn.disabled = true;
    try {
      const pr = await gh<{ html_url: string; number: number }>("POST", `/repos/${o.slug}/pulls`, { title: title.value.trim(), head: o.branch, base: base.value, body: md.value(), draft: draft.checked });
      m.close();
      prCreated();
      toast(`Created pull request #${pr.number}.`, "info", [{ label: "Open on GitHub", run: () => invoke("open_url", { url: pr.html_url }) }]);
    } catch (e) {
      error.textContent = e instanceof Error ? e.message : String(e);
      createBtn.disabled = false;
    }
  }
  return { title, base, draft, md, submit, close: m.close };
}

/// Open on GitHub, gists

export async function openOnGitHub() {
  const t = activeTab();
  if (!t) return;
  const repo = await remoteRepo();
  if (!repo) return toast("The origin remote is not a GitHub repository.", "error");
  const sha = (await git("rev-parse", "HEAD")).trim();
  const sel = editor.getSelection();
  const lines = sel ? (sel.startLineNumber === sel.endLineNumber ? `#L${sel.startLineNumber}` : `#L${sel.startLineNumber}-L${sel.endLineNumber}`) : "";
  invoke("open_url", { url: `https://github.com/${repo.owner}/${repo.repo}/blob/${sha}/${rel(t.path).split("/").map(encodeURIComponent).join("/")}${lines}` });
}

export async function createGist() {
  const model = editor.getModel();
  const sel = editor.getSelection();
  if (!model || !sel || sel.isEmpty()) return toast("Select some code first.");
  if (!(await ensureSignedIn())) return;
  const name = basename(model.uri.fsPath);
  const content = model.getValueInRange(sel);
  const description = h("input", { class: "gh-input", placeholder: "Description (optional)" });
  const secret = h("input", { type: "radio", name: "gist-vis", checked: true });
  const pub = h("input", { type: "radio", name: "gist-vis" });
  const error = h("div", { class: "gh-error" });
  const body = h(
    "div",
    { class: "rc-form" },
    h("div", { class: "dim" }, `${content.split("\n").length} line(s) from ${name}`),
    h("label", { class: "rc-field" }, h("span", {}, "Description"), description),
    h("label", { class: "rc-check" }, secret, "Secret (only people with the link can see it)"),
    h("label", { class: "rc-check" }, pub, "Public"),
    error,
  );
  const create = async () => {
    try {
      const gist = await gh<{ html_url: string }>("POST", "/gists", { description: description.value, public: pub.checked, files: { [name]: { content } } });
      m.close();
      toast("Gist created.", "info", [{ label: "Open", run: () => invoke("open_url", { url: gist.html_url }) }]);
    } catch (e) {
      error.textContent = e instanceof Error ? e.message : String(e);
    }
  };
  const m = modal("Create Gist", "github", body, [h("button", { class: "btn", onclick: () => m.close() }, "Cancel"), h("button", { class: "btn primary", onclick: create }, "Create Gist")], "gh-small");
  description.focus();
}

/// Clone from GitHub

interface RepoItem {
  full_name: string;
  description: string | null;
  private: boolean;
  clone_url: string;
  stargazers_count: number;
}

const CLONE_PARENT_KEY = "garnet.cloneParent";

export async function cloneDialog(openProject: (path: string) => void) {
  const signedIn = (await refreshAccount()).signedIn;
  const search = h("input", { class: "gh-input", placeholder: "Search your repositories and GitHub, or paste a URL / owner/name", spellcheck: false });
  const list = h("div", { class: "gh-repo-list" });
  let parentDir = localStorage.getItem(CLONE_PARENT_KEY) ?? (state.project ? dirname(state.project.root) : "");
  const parentInput = h("input", { class: "gh-input", value: parentDir, placeholder: "Parent folder", spellcheck: false });
  const nameInput = h("input", { class: "gh-input gh-name", placeholder: "folder name", spellcheck: false });
  const progress = h("div", { class: "gh-progress", hidden: true }, h("div", { class: "gh-bar" }, h("div", { class: "gh-bar-fill" })), h("div", { class: "gh-progress-text dim" }));
  const error = h("div", { class: "gh-error" });
  const cloneBtn = h("button", { class: "btn primary", disabled: true, onclick: () => doClone() }, "Clone");
  let mine: RepoItem[] = [];
  let found: RepoItem[] = [];
  let selected: { url: string; name: string } | null = null;
  let loading = signedIn;

  const pick = (url: string, name: string) => {
    selected = { url, name };
    nameInput.value = name;
    cloneBtn.disabled = false;
    render();
  };
  const row = (r: RepoItem, scope: string) =>
    h(
      "div",
      { class: `gh-repo${selected?.url === r.clone_url ? " selected" : ""}`, onclick: () => pick(r.clone_url, r.full_name.split("/")[1]), ondblclick: () => doClone() },
      icon(r.private ? "lock" : "repo"),
      h("span", { class: "gh-repo-name" }, r.full_name),
      h("span", { class: "gh-repo-desc dim" }, r.description ?? ""),
      h("span", { class: "dim" }, r.stargazers_count ? `★ ${r.stargazers_count}` : ""),
      h("span", { class: "gh-badge" }, scope),
    );
  function render() {
    const q = search.value.trim();
    const direct = cloneUrl(q);
    const ownRows = fuzzyFilter(q, mine, (r) => r.full_name).slice(0, 100);
    const seen = new Set(ownRows.map((r) => r.full_name));
    const rows = [
      ...(direct ? [h("div", { class: `gh-repo${selected?.url === direct.url ? " selected" : ""}`, onclick: () => pick(direct.url, direct.name) }, icon("link"), h("span", { class: "gh-repo-name" }, `Clone ${direct.url}`))] : []),
      ...ownRows.map((r) => row(r, "yours")),
      ...found.filter((r) => !seen.has(r.full_name)).map((r) => row(r, "GitHub")),
    ];
    if (!rows.length) rows.push(h("div", { class: "empty" }, q ? "No matching repositories." : signedIn && loading ? "Loading your repositories…" : "Type to search GitHub."));
    if (!signedIn) rows.push(h("div", { class: "gh-hint" }, h("button", { class: "btn", onclick: () => signIn().then((ok) => void (ok && (m.close(), cloneDialog(openProject)))) }, "Sign In"), " to list your and your organizations' repositories."));
    list.replaceChildren(...rows);
  }
  let timer = 0;
  let seq = 0;
  search.addEventListener("input", () => {
    render();
    clearTimeout(timer);
    const q = search.value.trim();
    if (q.length < 2 || cloneUrl(q)?.explicit) {
      found = [];
      return render();
    }
    timer = window.setTimeout(async () => {
      const mineSeq = ++seq;
      try {
        const res = await gh<{ items: RepoItem[] }>("GET", `/search/repositories?q=${encodeURIComponent(q)}&per_page=30`);
        if (mineSeq === seq) (found = res.items), render();
      } catch (e) {
        if (mineSeq === seq) error.textContent = e instanceof Error ? e.message : String(e);
      }
    }, 350);
  });
  search.addEventListener("keydown", (e) => e.key === "Enter" && selected && doClone());
  const browse = async () => {
    const picked = await open({ directory: true, title: "Clone into folder", defaultPath: parentInput.value || undefined });
    if (typeof picked === "string") parentInput.value = picked;
  };
  const body = h(
    "div",
    { class: "gh-clone" },
    search,
    list,
    h("div", { class: "gh-row" }, h("span", { class: "dim" }, "Directory"), parentInput, h("span", { class: "dim" }, "/"), nameInput, h("button", { class: "btn", onclick: browse }, "Browse…")),
    progress,
    error,
  );
  const m = modal("Clone Repository", "repo-clone", body, [h("button", { class: "btn", onclick: () => m.close() }, "Cancel"), cloneBtn], "gh-clone-dialog");
  search.focus();
  render();
  if (signedIn)
    gh<RepoItem[]>("GET", "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member", undefined, { pages: 5 })
      .then((r) => (mine = r))
      .catch((e) => (error.textContent = e.message))
      .finally(() => ((loading = false), render()));

  async function doClone() {
    if (!selected || cloneBtn.disabled) return;
    parentDir = parentInput.value.trim().replace(/\/+$/, "");
    const name = nameInput.value.trim();
    if (!parentDir.startsWith("/")) return (error.textContent = "Choose an absolute parent folder.");
    if (!name || name.includes("/") || name.startsWith(".")) return (error.textContent = "Enter a valid folder name.");
    const target = `${parentDir}/${name}`;
    error.textContent = "";
    cloneBtn.disabled = true;
    m.lock(true);
    progress.hidden = false;
    const fill = progress.querySelector<HTMLElement>(".gh-bar-fill")!;
    const text = progress.querySelector<HTMLElement>(".gh-progress-text")!;
    const channel = new Channel<string>();
    channel.onmessage = (line) => {
      text.textContent = line;
      const p = cloneProgress(line);
      if (p) fill.style.width = `${p.percent}%`;
    };
    try {
      await invoke("github_clone", { url: selected.url, dest: target, onProgress: channel });
      localStorage.setItem(CLONE_PARENT_KEY, parentDir);
      m.lock(false);
      m.close();
      openProject(target);
    } catch (e) {
      m.lock(false);
      progress.hidden = true;
      cloneBtn.disabled = false;
      error.textContent = `Clone failed: ${e}`;
    }
  }
}
