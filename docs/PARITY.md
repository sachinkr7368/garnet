# Feature parity checklist

Status of Garnet against the daily feature set of a full Ruby IDE such as
RubyMine. Status values: **done** (shipped and working), **partial** (works
with a stated limitation), **planned** (not in the UI yet). Each planned or
partial row is meant to become a GitHub issue.

## Editing

| Feature | Status | Notes |
| --- | --- | --- |
| Tabs, dirty markers, close prompts, session restore | done | |
| Syntax highlighting: Ruby, ERB, YAML, JS/TS, CSS/SCSS, JSON, Markdown, HTML, Dockerfile, shell, SQL | done | Monarch grammars; ERB embeds Ruby inside HTML |
| Multi-cursor, column selection, folding, bracket pair colors, sticky scroll, minimap | done | Monaco |
| Reload on external change, conflict prompt for dirty buffers | done | |
| Auto-save (delay / focus change), trim trailing whitespace, final newline | done | |
| Code style per language, .editorconfig, .rubocop.yml indentation width | done | |
| Live templates / snippets | planned | |
| HAML and Slim highlighting | planned | |
| Spell checking | planned | |
| Semantic highlighting from ruby-lsp | planned | both themes already color the semantic token types; the request stays disabled for speed until the legend mapping lands |
| Inlay hints | planned | |

## Navigation

| Feature | Status | Notes |
| --- | --- | --- |
| Go to File (fuzzy, double Shift, `file:line`) | done | Rust index, ≤1 ms per keystroke on 5k files |
| Go to Symbol in project, File Structure popup and panel | done | ruby-lsp |
| ruby-lsp startup: global `ruby-lsp --use-launcher` through the detected version manager (mise, rbenv, asdf, chruby, rvm; Settings override), survives a broken project bundle; failures show the reason from stderr with Run bundle install in terminal / Show Log / Restart | done | ruby-lsp itself may install the composed bundle's gems, as in VS Code |
| Go to Declaration (⌘B / ⌘-click), Quick Definition | done | |
| Find Usages (panel) and inline usages | done | |
| Find in Files (regex, case, word, include globs) | done | |
| Search Everywhere (files, symbols, actions), Go to Class, Go to Test, recent files (⌘E), recent locations (⌘⇧E), back/forward, switcher | done | history is per window session |
| Breadcrumbs | planned | |
| Type / call hierarchy | planned | ruby-lsp support is limited |
| Replace in Files | planned | |

## Refactoring

| Feature | Status | Notes |
| --- | --- | --- |
| Rename (across files, unopened files written to disk) | done | ruby-lsp |
| Code actions / quick fixes (RuboCop autocorrect, extract variable/method where ruby-lsp offers them) | partial | only what ruby-lsp provides |
| Reformat (RuboCop via ruby-lsp), format on save | done | |
| Move class/file with reference updates, safe delete, change signature | planned | |

## Rails

| Feature | Status | Notes |
| --- | --- | --- |
| Related files (model, controller, views, helpers, specs/tests, factories, migrations) | done | naive inflector; irregular plurals beyond a short list fall back to `s` |
| Routes browser (`bin/rails routes --expanded`), jump to action | done | |
| Rails server / console / rake run configurations, RAILS_ENV and port defaults | done | |
| Generators UI (`rails g` with preview) | planned | |
| Partial and i18n key navigation from ERB | planned | |
| Model/schema diagram | planned | |

## Testing

| Feature | Status | Notes |
| --- | --- | --- |
| Gutter run/debug icons for `describe`/`context`/`it`/`test`/`def test_` | done | |
| Run test at cursor, file, all; RSpec and Minitest (Rails and plain) | done | |
| Clickable `file:line` in output, rerun last | done | |
| Test results tree (per-example pass/fail, rerun failed) | planned | output is a console today |
| Coverage | planned | |

## Run and debug

| Feature | Status | Notes |
| --- | --- | --- |
| Run configurations: Rails server, Rails console, RSpec, Minitest, Rake, Ruby script, Sidekiq, custom | done | kept in Garnet's config dir by default (nothing written to the repo); per-configuration "Store as project file (share via VCS)" writes `.garnet/run.json`, which is read only for trusted projects; Rails defaults auto-created |
| Env vars, `.env` file, working directory, version manager (rbenv/asdf/chruby/rvm/mise), bundler toggle | done | |
| Toolbar selector with Run / Debug / Stop, several configurations running at once | done | one console tab each, ANSI colors, restart/stop |
| Debug any configuration under rdbg (DAP), fix hint when `debug` is not bundled | done | verified end-to-end on a Rails request |
| Breakpoints, conditional breakpoints, logpoints, break on exceptions | done | logpoints are evaluated by Garnet (rdbg has no native logpoints) |
| Step over/into/out, pause, resume, restart, stop | done | |
| Frames, variables tree (locals, ivars via `self`, expandable objects), watches, evaluate console, inline values | done | |
| Attach to rdbg (port, host:port, socket) incl. Docker path mapping | done | |
| Breakpoints follow edits and persist across restarts | partial | they keep their line numbers and are kept for the session only |
| Several debug sessions at the same time | planned | one debug session at a time (any number of plain runs) |
| Hit-count breakpoints, exception breakpoint conditions | planned | |
| Run configurations inside Docker / docker compose | planned | attach works today |

## Version control

| Feature | Status | Notes |
| --- | --- | --- |
| Changes panel, stage/unstage (file), commit, commit checks for errors | done | |
| Diff view (Monaco diff editor), gutter change markers, blame current line | partial | gutter markers refresh on save, not while typing |
| Branch switcher: local/remote, checkout (stash or carry changes), new, rename, delete, fetch/pull/push, ahead/behind | done | |
| Worktree switcher: list, open here / new window, create from branch, remove | done | toolbar shows the current worktree (main checkout: repo name + "main worktree" tag); count in the dropdown header |
| Hunk/line staging, stash list UI, log/history view, merge conflict resolver, interactive rebase | planned | |

## GitHub

| Feature | Status | Notes |
| --- | --- | --- |
| Sign in by reusing `gh auth token` or a personal access token; token in Keychain | done | |
| OAuth device flow | planned | needs a registered Garnet OAuth app client id |
| Create pull request from the current branch (title, body, base, draft), push with upstream | done | body is a single-line field; edit more on GitHub |
| Open file/line on GitHub, create gist from selection | done | |
| Clone by URL or `owner/name` | done | |
| Clone with repository search | planned | |
| PR list (mine / review requested, CI status), PR diff and inline review comments, check out PR branch | planned | |

## Database

| Feature | Status | Notes |
| --- | --- | --- |
| Database browser / SQL console / schema view | planned | |

## Docker and remote

| Feature | Status | Notes |
| --- | --- | --- |
| Attach debugger to rdbg in a container (`localfsMap`) | done | |
| Docker / compose run targets, remote interpreters | planned | |

## ERB, HAML, JavaScript

| Feature | Status | Notes |
| --- | --- | --- |
| ERB highlighting with embedded Ruby, ERB documents synced to ruby-lsp | done | |
| JS/TS, CSS, JSON, HTML language features (Monaco workers) | partial | per-file only; no project-wide TS server |
| HAML / Slim | planned | |

## App

| Feature | Status | Notes |
| --- | --- | --- |
| Settings window (searchable tree, global + `.garnet/settings.json` overrides, JSON stays editable) | done | |
| JetBrains macOS default keymap for every implemented action; keymap editor (search, rebind, conflict prompt, find by shortcut), VS Code preset, JetBrains keymap XML import, Help › Keymap Reference | done | XML import skips two-keystroke shortcuts and actions Garnet does not have |
| Command palette, recent projects, session restore, multiple windows (one process per window) | done | |
| Light / dark / system theme, UI font size, zoom | done | System (default) follows macOS live; Toggle Theme in the toolbar and palette; chrome, editor, diff, terminal ANSI and semantic-token colors switch without restart; contrast checked by tests (text ≥ 4.5:1) |
| Signed and notarized releases | partial | workflow supports it once Apple secrets are added |
| Auto-update check (opt-in) | planned | |
| Plugin API | planned | |

## Work packages for follow-up

Independent chunks that touch separate files, so they can be built in parallel:

1. **Test results tree** — new `src/testresults.ts`; run RSpec with `--format json` / Minitest reporter output, render pass/fail tree, rerun failed. Hooks into `run.ts` `launch` only.
2. **GitHub PR panel** — new `src/github-prs.ts` + `github_api` (exists): PR list (search API), CI status (check-runs), PR diff (Monaco diff per file), review comments as editor view zones, checkout PR branch (`git fetch origin pull/N/head`).
3. **OAuth device flow** — `src-tauri/src/github.rs`: device code + polling; requires registering an OAuth app and embedding its client id.
4. **Git history and stash** — new `src/gitlog.ts`: `git log --graph` view, commit details, stash list/apply/drop, hunk staging via `git apply --cached`.
5. **Merge conflict resolver** — new `src/merge.ts`: three-way view using Monaco diff editors.
6. **Breadcrumbs and Go to Implementation** — `src/editor.ts`/`src/lsp.ts`: breadcrumbs from document symbols; bind ⌘⌥B once ruby-lsp offers implementations.
7. **Replace in Files** — `src/search.ts` + Rust `search.rs` replace command with preview.
8. **Breakpoint persistence and tracking** — `src/debug.ts`: decorations with stickiness to follow edits, persist per project in `.garnet/breakpoints.json`; hit-count breakpoints.
9. **Multiple debug sessions** — `src-tauri/src/dap.rs` keyed sessions + `src/debug.ts` session tabs.
10. **Docker run targets** — `src/run.ts`: config type for `docker compose run/exec` with rdbg port publishing and automatic `localfsMap`.
11. **HAML/Slim grammars and snippets** — `src/editor.ts` Monarch definitions, snippet provider.
12. **Database tools** — new Rust module + `src/db.ts`: read `config/database.yml`, connect via `psql`/`mysql`/`sqlite3` CLIs, table browser and SQL console.
13. **Rails generators and i18n/partials navigation** — `src/rails.ts`.
14. **Live gutter diff while typing** — `src/git.ts`: diff buffer against cached HEAD text in a worker.
