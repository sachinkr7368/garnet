# Changelog

All notable changes to Garnet are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Garnet uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Zoom IDE: View › Appearance › Zoom In IDE (⌃⌥=), Zoom Out IDE (⌃⌥-) and Reset IDE Zoom (⌃⌥0), RubyMine's macOS defaults. Settings › Keymap › Standard macOS zoom keys switches ⌘= ⌘- ⌘0 to zoom instead.
- Reset Font Size, and an opt-in ⌘ + mouse wheel / trackpad pinch to change the editor font size.
- Code folding: Expand / Collapse (⌘+ / ⌘-), Expand / Collapse All (⇧⌘+ / ⇧⌘-), Recursively (⌥⌘+ / ⌥⌘-), and the NumPad keys.
- Theme menu in the toolbar and View › Theme: System, Light or Dark with a checkmark on the current one.
- Full macOS menu bar: File, Edit, View, Navigate, Code, Refactor, Run, Git, Window and Help, with shortcuts from the live keymap, Open Recent, New Window, Close Window (⇧⌘W), Bring All to Front and the window list.
- Distraction Free Mode, Presentation Mode, and toggles for the toolbar, status bar and tool window bars.
- Drop a folder on the window or the Dock icon to open it. The window's size and position are restored on relaunch.

### Fixed
- Zoom scaled the page with CSS zoom, which put clicks in the editor on the wrong line and column; it now uses the web view's page zoom.
- Going back to System after pinning Light or Dark kept the old theme when macOS had changed appearance in the meantime.
- The toolbar theme button only toggled Light and Dark, so System could only be restored from Settings.
- Code fields (search, paths, branch names) no longer autocorrect, autocapitalize or spell check. ⌘A in a terminal selects its buffer.

## [0.2.3] - 2026-11-03

### Added
- Responsive layout: editor tabs, the bottom tool-window strip and the Terminal/Run subtabs move tabs that do not fit into a `»` menu, and tool-window toolbars do the same with icons. Truncated text shows in full on hover.
- Terminal and Run tool windows show a Trust Project button in an untrusted project.
- Recent Files is saved with the session.

### Changed
- Breakpoints are drawn over the line number (click the number to toggle).
- The "Viewed" checkbox is gone from Commit tree rows; it remains in the context menu and branch compare.

### Fixed
- Search Everywhere and Go to File: file matching is case-insensitive (`Post` finds `PostsController`), files and actions appear immediately instead of waiting for ruby-lsp, and stale symbol requests are cancelled.
- Terminals and run commands refuse to start until the project is trusted, matching what the trust dialog promises. Ruby detection waits for trust too.
- Run configuration edits made in Safe Mode no longer shadow `.garnet/run.json` once the project is trusted.
- Rails tools failed when Garnet was launched from a mise-activated shell; Garnet no longer inherits the launching shell's mise, direnv, Bundler or Ruby-version variables.
- Window layout bugs: clipped toolbars, squeezed branch names, overlapping Test Results summary, Commit tree rows misaligned at narrow widths.

## [0.2.2] - 2026-11-03

### Added
- Rollback (⌥⌘Z) for files, folders or all changes in the Commit tool window, with Shelve and Unshelve (git stash), amend with the last message prefilled, and include checkboxes on each row.
- Database tool window docked on the right, with table data, SQL consoles and DDL as editor tabs, cell editing with a confirmation step, value viewer, and Copy All as CSV, JSON, Markdown or SQL INSERT.
- Prompt to save unsaved files on quit and logout, and hot exit: unsaved buffers are restored after a crash or force quit.
- Keymap audited against RubyMine's macOS keymap, with icons and keymap-aware tooltips.

### Changed
- Tool windows activate the JetBrains way: show and focus, hide only when focused.
- Database read-only connections are enforced in the session, and destructive statements need a single-use confirmation.

### Fixed
- Find/Replace in Files stale results, counts and truncation.
- Broken JSON config files are backed up instead of overwritten, and config writes are atomic.
- Language server and terminal lifecycle bugs, breakpoints sent before resume, dialog focus after resizing panels.
- Many Git fixes: gutter Rollback Lines, staged diffs, deleted files, stash-and-checkout, the merge resolver on non-UTF-8 files, double commits.
- Security hardening: tighter file read sandbox, stricter `git_run` argument checks, Ruby warm-up waits for project trust.

## [0.2.1] - 2026-11-02

### Fixed
- The smoke harness no longer stalls when the window is hidden.
- A test run no longer reports `exited` before its last results arrive.

### Added
- Smoke checks for the Database tool window, Rails tools and GitHub account detection, plus `GARNET_SMOKE_TIMEOUT`.

## [0.2.0] - 2026-11-02

### Added
- Run configurations and rdbg debugger improvements: persistent breakpoints, multiple debug sessions, Docker Compose run targets, test results tree.
- Git log, stashes, hunk staging, merge conflict resolver and live gutter.
- GitHub sign-in (gh token, OAuth device flow or PAT, stored in Keychain), Pull Requests tool window with inline review, and a clone dialog.
- Rails tools: generators dialog, partial, i18n, route and association navigation, Rails project view, migrations panel, send to Rails console.
- Database tool window for PostgreSQL, MySQL and SQLite.
- Replace in Files, breadcrumbs, implementations, semantic tokens, inlay hints, HAML and Slim, snippets.
- Themes (Light, Dark, System) and a worktree label.
- Opt-in update check (Settings › Updates), off by default.

### Fixed
- ruby-lsp launch, and Minitest reporter directory in an inherited `RUBYLIB`.

## [0.1.0] - 2026-11-02

### Added
- First release: project tree, editor tabs, Go to File, Find in Files, integrated terminals, ruby-lsp intelligence, git panel with branch and worktree switchers, run configurations, rdbg debugger, Rails navigation, and the JetBrains macOS keymap with import.
- Project trust: opening a folder never runs its code until you trust it.

[0.2.3]: https://github.com/sachinkr7368/garnet/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/sachinkr7368/garnet/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/sachinkr7368/garnet/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/sachinkr7368/garnet/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sachinkr7368/garnet/releases/tag/v0.1.0
