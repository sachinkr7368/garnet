# Contributing to Garnet

Thanks for helping. Garnet aims to be the fastest Ruby IDE, so every change is
judged on two things: does it fully work, and does it keep the app fast.

## Layout

- `src-tauri/src/` Rust backend: file system and index (`fsops.rs`, `index.rs`),
  search (`search.rs`), file watching (`watch.rs`), terminals (`pty.rs`),
  ruby-lsp transport (`lsp.rs`), rdbg/DAP transport (`dap.rs`), git (`git.rs`),
  GitHub (`github.rs`), project/env/config (`project.rs`, `env.rs`).
- `src/` TypeScript frontend (no framework): `editor.ts` (Monaco, tabs),
  `tree.ts`, `search.ts`, `terminal.ts`, `lsp.ts` (LSP client and Monaco
  providers), `run.ts` (run configurations), `debug.ts` (DAP client and
  debugger UI), `git.ts`, `toolbar.ts` (project/worktree/branch switchers,
  GitHub), `rails.ts`, `settings.ts` + `settingsui.ts`, `commands.ts` (keymap,
  palette), `smoke.ts` (end-to-end harness).

## Development

```sh
pnpm install
pnpm tauri dev
pnpm typecheck
cd src-tauri && cargo clippy --all-targets && cargo test
```

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

`GARNET_SMOKE_DEBUG=1` also starts the Rails server under rdbg, sets a
breakpoint in `PostsController#index`, requests `/posts` and checks that the
request pauses there, evaluates an expression and completes after resuming.
Use a throwaway app (`rails new blog && bin/rails g scaffold Post title body:text`).

## Guidelines

- Keep the UI thread free: anything that touches the disk, git or a process
  runs in Rust (async commands or threads) and streams results back.
- Ship complete features. If something can't be finished, leave it out of the
  UI and add it to `docs/PARITY.md` as planned.
- No telemetry and no network calls the user didn't trigger.
- Minimal comments; code should read clearly. Match the surrounding style.
- Don't commit build output, screenshots or scratch files.
