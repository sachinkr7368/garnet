# Contributing to Garnet

Thanks for helping. Garnet aims to be the fastest Ruby IDE, so every change is
judged on two things: does it fully work, and does it keep the app fast.

## Layout

- `src-tauri/src/` Rust backend: file system and index (`fsops.rs`, `index.rs`),
  search (`search.rs`), file watching (`watch.rs`), terminals (`pty.rs`),
  ruby-lsp transport (`lsp.rs`), rdbg/DAP transport (`dap.rs`), git (`git.rs`),
  GitHub REST/GraphQL, auth and clone (`github.rs`), project/env/config (`project.rs`, `env.rs`).
- `src/` TypeScript frontend (no framework): `editor.ts` (Monaco, tabs),
  `tree.ts`, `search.ts`, `terminal.ts`, `lsp.ts` (LSP client and Monaco
  providers), `run.ts` (run configurations), `debug.ts` (DAP client and
  debugger UI), `git.ts` (Commit panel, gutter hunks), `gitlog.ts` (Git log,
  stashes), `merge.ts` (conflict resolver), `difflogic.ts` + `diffworker.ts`
  (line diff, patches), `toolbar.ts` (project/worktree/branch switchers),
  `github.ts` (sign-in, create PR, gist, clone), `prs.ts` (Pull Requests tool
  window and PR review), `ghmodel.ts` (pure GitHub logic), `rails.ts`, `settings.ts` + `settingsui.ts`, `commands.ts` (keymap,
  palette), `languages/` (HAML/Slim grammars, live templates), `replace.ts`,
  `breadcrumbs.ts`, `semantic.ts` (pure helpers), `smoke.ts` (end-to-end harness).

## Development

```sh
pnpm install
pnpm tauri dev
```

## Tests

Every feature ships with tests. A pull request that adds or changes behaviour
adds or updates the tests that cover it; CI runs all of them on every PR and on
`main`, and a release only builds after they pass.

```sh
pnpm typecheck                     # TypeScript
pnpm test                          # vitest, frontend logic (jsdom)
pnpm test:watch                    # vitest in watch mode
cd src-tauri
cargo clippy --all-targets -- -D warnings
cargo test                         # Rust: search, index, git, shell env, config
```

- Frontend tests live in `src/test/*.test.ts`. `src/test/setup.ts` loads
  `index.html` into jsdom and replaces the Tauri backend with an in-memory fake
  (`src/test/fakeIpc.ts`: files, config dir, trust flag). Modules that touch
  Monaco at import time load with `vi.mock("../editor", () => import("./fakeEditor"))`.
- Test pure logic directly; export a helper rather than reaching into a module.
- Rust tests sit next to the code (`#[cfg(test)] mod tests`). Use a temp dir per
  test (they run in parallel) and a real git repo where git behaviour matters.
- UI-level behaviour that needs the real app goes into `src/smoke.ts`.

Stop `pnpm tauri dev` when you are done; it keeps Vite and the app running.

## End-to-end smoke test

`src/smoke.ts` drives the real UI code against a project, checks each feature,
measures the speed budgets and writes a JSON report:

```sh
pnpm tauri build --bundles app
GARNET_SMOKE=/tmp/report.json GARNET_SMOKE_DEBUG=1 \
  src-tauri/target/release/bundle/macos/Garnet.app/Contents/MacOS/garnet /path/to/rails/app
cat /tmp/report.json
```

The harness ships in release builds, so the same command verifies a CI-built or
installed app: unpack `Garnet_universal.app.tar.gz` from the release (or use
`/Applications/Garnet.app`) and run its `Contents/MacOS/garnet` binary. Only
the `GARNET_SMOKE*` variables switch it on; without them none of it runs.

- The report is rewritten after every check, and each step is logged to stderr
  with its time (`smoke: 14870 ms  database`), so a run that is killed still
  leaves what it checked.
- `GARNET_SMOKE_TIMEOUT=<seconds>` (default 900): when the run has not finished
  by then, the app adds a `timeout` check naming the step it stopped in, writes
  the report and quits. Keep it below any outer timeout you wrap the run in.
- A check passes when its value is `true`; anything else is the failure detail,
  or `skipped: …` when the machine can't run it (no Docker, not signed in).
- Smoke-only hooks: CSV/JSON exports skip the save dialog and are written to
  `<report>.export.csv` (Rust, only when `GARNET_SMOKE` is set), and the SQL
  console's dangerous-statement confirmation is answered by `dbSmokeHooks.ask`
  in `src/db.ts`, which only `src/smoke.ts` sets.

`GARNET_SMOKE_DEBUG=1` also starts the Rails server under rdbg, sets a
breakpoint in `PostsController#index`, requests `/posts` and checks that the
request pauses there, evaluates an expression and completes after resuming.
Use a throwaway app (`rails new blog && bin/rails g scaffold Post title body:text`).
It also runs two copies of `lib/smoke_debug.rb` under the debugger at once and
checks both pause at the breakpoint on line 5 (which it leaves set, so a second
smoke run proves breakpoints survive a restart).

The database checks use the app's `config/database.yml` (SQLite `development`
and `test`, with a `posts` table): they connect, page through 150 temporary rows,
run console queries, check that `test` blocks writes and that `DROP` asks first
(answered with Cancel), export CSV, and delete what they added. The Rails tools
checks list generators, preview `scaffold --pretend` (nothing is created), read
`db:migrate:status`, open the Rails project view and Cmd+click a partial and an
i18n key (temporary files, removed afterwards). GitHub checks are read-only: gh
account detection and, if you are signed in to Garnet, the account name.

The test tree checks expect `spec/calc_spec.rb` (one passing, one failing on
line 7, one pending example; run with the global `rspec` gem) and
`test/models/smoke_calc_test.rb` (pass, failure on line 8, skip). With Docker
running, a `docker-compose.yml` service `app` (image `ruby:3.3-slim`, project
mounted at `/app`) is used for the compose run check.

## Guidelines

- Keep the UI thread free: anything that touches the disk, git or a process
  runs in Rust (async commands or threads) and streams results back.
- Ship complete features. If something can't be finished, leave it out of the
  UI and add it to `docs/PARITY.md` as planned.
- No telemetry and no network calls the user didn't trigger.
- Minimal comments; code should read clearly. Match the surrounding style.
- Don't commit build output, screenshots or scratch files.
