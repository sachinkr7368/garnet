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
| Live templates / snippets | partial | built-in Ruby, RSpec (in `*_spec.rb`) and ERB templates with tab stops; no user-defined templates yet |
| HAML and Slim highlighting | done | Monarch grammars; Ruby lines embedded as Ruby; filter bodies (`:javascript`, `css:`) are not highlighted as their language |
| Spell checking | planned | |
| Semantic highlighting from ruby-lsp | done | full + delta requests; colors for dark and light themes; toggle in Settings › Editor › General |
| Inlay hints | done | whatever ruby-lsp provides (implicit rescue, hash shorthand); toggle in Settings |

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
| Breadcrumbs | done | above the editor, from document symbols; click to jump; toggle in Settings |
| Go to Implementation (⌘⌥B) | partial | `textDocument/implementation` or type-hierarchy subtypes when the server has them; ruby-lsp has neither, so classes and modules use a project search for subclasses and include/extend/prepend sites; method overrides are not found |
| Go to Type Declaration (⌃⇧B) | partial | needs a server with `typeDefinition` (e.g. Sorbet via `ruby.lspCommand`); ruby-lsp has none |
| Type / call hierarchy views | planned | ruby-lsp support is limited |
| Replace in Files (⌘⇧R) | done | preview with per-file/line/match include, Replace All / Selected, `$1`/`${name}` groups in regex mode, open buffers edited with undo, .gitignore respected; line-based (no multi-line matches); only listed matches when results are truncated at 5000 |

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
| Test results tree: per-example pass/fail/ignored, durations, failure message and clickable backtrace, rerun failed / one / all, show passed / ignored filters, progress bar, gutter icons with the last result | done | RSpec via a formatter Garnet ships, Minitest via a reporter plugin on `RUBYLIB` (both kept in Garnet's state dir); Minitest progress is indeterminate when filtered by line or name; runs inside Docker show the console only |
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
| Breakpoints follow edits and persist across restarts, enable/disable, Breakpoints dialog (⌘⇧F8) with conditions, logpoints and pass counts | done | stored per project in Garnet's state dir (`breakpoints.json`), not in the repo |
| Several debug sessions at the same time | done | session tabs in the Debug panel; threads, frames, variables, console and toolbar follow the selected session; breakpoints apply to all sessions |
| Hit-count breakpoints, exception breakpoint conditions | partial | pass counts and per-session hit counters work (Garnet-side, rdbg has no hit conditions); exception breakpoint conditions are planned |
| Run configurations inside Docker / docker compose | done | `docker compose run` or `exec` in a service; debug via rdbg on a port published on 127.0.0.1 only (exec refuses ports published on all interfaces) or a shared-volume socket, with path mapping; option shows why it is unavailable when Docker is missing |

## Version control

| Feature | Status | Notes |
| --- | --- | --- |
| Changes panel, stage/unstage (file), commit, commit checks for errors | done | |
| Changes as a directory tree: filter, status badges, +/- counts, Viewed marks (per branch, cleared when the file changes), expand/collapse all, group by changelist or directory | done | |
| Compare with Branch (`git diff <base>...HEAD`, PR-style review tree) | done | diffs show merge base ↔ HEAD, not uncommitted edits |
| Diff view: side-by-side / unified, collapse unchanged regions, next/previous difference (F7 / ⇧F7), read-only revision diffs | done | |
| Live gutter change markers (buffer vs HEAD in a worker, debounced), click a marker: old text, Rollback, Stage This Hunk, previous/next | done | |
| Rollback Lines (⌘⌥Z), Next/Previous Change (⌃⌥⇧↓/↑), blame current line | done | |
| Partial staging in the Commit panel (stage/unstage single hunks) | done | hunk-level, not single lines; files with a clean filter (git-crypt, LFS) are staged whole only |
| Git log tool window (⌘9): commit graph, filter by branch/user/path/text, commit details with changed files and diffs, file history (Project tree › Show History) | done | text filter matches commit messages, not hashes |
| Log actions: copy revision, new branch/tag, cherry-pick, revert, reset soft/mixed/hard (confirmed) | done | |
| Stashes: list, stash with message and untracked files, apply, pop, drop (confirmed), view a stash's changes | done | |
| Merge conflicts (merge, rebase, cherry-pick, revert, stash pop): Conflicts list, 3-pane resolver (yours / result / theirs) with accept yours/theirs/both per chunk, mark resolved, abort/continue | done | symlink conflicts resolve by taking one side; binary files resolve with Accept Yours/Theirs |
| Branch switcher: local/remote, checkout (stash or carry changes), new, rename, delete, fetch/pull/push, ahead/behind | done | |
| Worktrees: toolbar switcher and Commit panel section (folder, branch, dirty marker, current), open here / new window, create from branch, remove, reveal | done | toolbar shows the current worktree (main checkout: repo name + "main worktree" tag); count in the dropdown header |
| Line-level staging, interactive rebase | planned | |

## GitHub

| Feature | Status | Notes |
| --- | --- | --- |
| Sign in without a Garnet account: reuse `gh auth token`, browser (OAuth device flow), or a fine-grained personal access token; token in the macOS Keychain only; account indicator in the status bar, switch account, sign out | done | browser sign-in appears only when a client id is set at build time (`GARNET_GITHUB_CLIENT_ID`) or in Settings › Version Control › GitHub; no client secret is used |
| API errors: re-auth prompt on 401, rate-limit wait time, offline message, Link pagination | done | REST and GraphQL from Rust (reqwest + rustls) |
| Create pull request (title, base picker, multi-line Markdown description with GitHub-rendered preview, draft), push with upstream first | done | |
| Open file/line on GitHub, create gist from selection (secret or public, description) | done | |
| Clone dialog: your, your organizations' and global repository search, URL or `owner/name`, destination picker, progress, then open (trust prompt) | done | no cancel while git is cloning |
| Pull Requests tool window: review requested, mine, current repo's open PRs; CI status, review state, draft; filter (`is:draft`, `ci:failing`, `review:approved`, `author:`, `#n`, text); load more | done | |
| PR view: rendered description, checks, commits, Files tab (changed-files tree + side-by-side diff) | done | last 100 commits and 100 review threads per PR; binary or very large files link to GitHub |
| Review: existing threads inline on the diff, comment on a line or range (either side), reply, resolve/unresolve, pending comments submitted as a review (comment / approve / request changes) | done | pending comments live in memory until submitted or the app closes |
| Check out a PR branch (same repo or fork), open on GitHub, merge (merge / squash / rebase as the repo allows) with a confirm dialog | done | fork PRs check out as `pr/<n>-<owner>-<branch>` without a push target |
| Edit PR title/description, request reviewers, labels, PR timeline (issue comments, review summaries), suggested changes | planned | |

## Database

| Feature | Status | Notes |
| --- | --- | --- |
| Database browser / SQL console / schema view | planned | |

## Docker and remote

| Feature | Status | Notes |
| --- | --- | --- |
| Attach debugger to rdbg in a container (`localfsMap`) | done | |
| Docker / compose run targets | done | see Run and debug |
| Remote interpreters (SSH), test results tree for runs inside Docker | planned | |

## ERB, HAML, JavaScript

| Feature | Status | Notes |
| --- | --- | --- |
| ERB highlighting with embedded Ruby, ERB documents synced to ruby-lsp | done | |
| JS/TS, CSS, JSON, HTML language features (Monaco workers) | partial | per-file only; no project-wide TS server |
| HAML / Slim | partial | highlighting only; no language server features |

## App

| Feature | Status | Notes |
| --- | --- | --- |
| File writes limited to the open project and Garnet's config folder; never through symlinks | done | files outside the project (e.g. gem sources reached via Go to Declaration) cannot be saved |
| Settings window (searchable tree, global + `.garnet/settings.json` overrides, JSON stays editable) | done | |
| JetBrains macOS default keymap for every implemented action; keymap editor (search, rebind, conflict prompt, find by shortcut), VS Code preset, JetBrains keymap XML import, Help › Keymap Reference | done | XML import skips two-keystroke shortcuts and actions Garnet does not have |
| Command palette, recent projects, session restore, multiple windows (one process per window) | done | |
| Light / dark / system theme, UI font size, zoom | done | System (default) follows macOS live; Toggle Theme in the toolbar and palette; chrome, editor, diff, terminal ANSI and semantic-token colors switch without restart; contrast checked by tests (text ≥ 4.5:1) |
| Signed and notarized releases | partial | workflow supports it once Apple secrets are added |
| Auto-update check (opt-in) | planned | |
| Plugin API | planned | |

## Work packages for follow-up

Independent chunks that touch separate files, so they can be built in parallel:

1. ~~**Test results tree**~~ done.
2. ~~**GitHub PR panel**~~ done (`src/prs.ts`). Follow-up: PR timeline, reviewers, labels, suggested changes.
3. ~~**OAuth device flow**~~ done; needs a registered Garnet OAuth app client id (device flow enabled) for release builds.
4. **Interactive rebase** — `src/gitlog.ts`: reorder/squash/fixup/reword from the log, driving `git rebase -i` with a generated todo via `GIT_SEQUENCE_EDITOR`.
5. **Line-level staging** — `src/git.ts`: select lines inside a hunk in the Commit panel and build the patch from those lines only.
6. **Method implementations** — `src/lsp.ts`: find overrides of a method in subtypes from the type hierarchy plus document symbols.
7. **User live templates** — `src/languages/snippets.ts`: templates editable in Settings, per-language contexts.
8. ~~**Breakpoint persistence and tracking**~~ done.
9. ~~**Multiple debug sessions**~~ done.
10. ~~**Docker run targets**~~ done.
11. **Embedded filter highlighting** — `src/languages/haml.ts`/`slim.ts`: indentation-aware `:javascript`/`css:` bodies.
12. **Database tools** — new Rust module + `src/db.ts`: read `config/database.yml`, connect via `psql`/`mysql`/`sqlite3` CLIs, table browser and SQL console.
13. **Rails generators and i18n/partials navigation** — `src/rails.ts`.
