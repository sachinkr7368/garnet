# Garnet

Garnet is a fast, open-source Ruby and Rails IDE for macOS. It covers the daily
workflow of a full Ruby IDE (navigation, Ruby intelligence, run configurations,
a real debugger, git) in a native-feeling app that starts in about half a second.

Built with Tauri 2 (Rust) + TypeScript, Monaco for editing, xterm.js for
terminals, [ruby-lsp](https://github.com/Shopify/ruby-lsp) for Ruby
intelligence and the [debug gem](https://github.com/ruby/debug) (rdbg) for
debugging.

## Privacy

Garnet has no accounts, no subscription, no telemetry, no licence checks and
makes no network calls on its own. The only network traffic is what you
trigger: GitHub actions (sign-in, pull requests, gists, clone, fetch/pull/push)
and commands you run yourself (for example `gem install ruby-lsp`). Your GitHub
token is stored in the macOS Keychain, never in a settings file.

## Status

Speed budgets, measured on an Apple Silicon Mac with a 5,085-file Rails app
(warm launch; see [CONTRIBUTING.md](CONTRIBUTING.md) for the smoke harness):

| Budget | Target | Measured |
| --- | --- | --- |
| Launch to usable window | < 1 s | ~0.5 s warm (first launch after install ~1.3 s while macOS verifies the binary) |
| File tree visible after open | < 300 ms | 17–28 ms |
| Go to File index ready | < 2 s | ~40 ms |
| Go to File per keystroke | < 50 ms | ≤ 1 ms |
| Find in Files across the repo | < 500 ms | 120–135 ms |
| Typing (main-thread work per keystroke) | no lag | ~0.15 ms |
| Idle RAM, excluding ruby-lsp | < 300 MB | ~140 MB RSS (app + WebKit processes) |

Feature status compared with RubyMine. The full checklist lives in
[docs/PARITY.md](docs/PARITY.md).

| Area | Status |
| --- | --- |
| Project tree, file create/rename/delete, gitignore aware, lazy | Done |
| Editor tabs, syntax highlighting (Ruby, ERB, YAML, JS/TS, CSS, JSON, Markdown, more), dirty markers, reload on external change, auto-save | Done |
| Go to File (double Shift / ⌘⇧O), Find in Files (⌘⇧F, regex, globs) | Done |
| Integrated terminal tabs (login shell, so rbenv/asdf/mise/chruby work) | Done |
| Ruby intelligence via ruby-lsp: completion, hover, go to definition, find usages, file structure, symbol search, diagnostics, RuboCop formatting, rename, code actions | Done |
| Run configurations (Rails server/console, RSpec, Minitest, Rake, Ruby script, Sidekiq, custom) with env vars, .env files, version manager, bundler | Done |
| Debugger (rdbg over DAP): breakpoints, conditional breakpoints, logpoints, break on exceptions, step, frames, variables, watches, evaluate, inline values, attach to process/Docker | Done |
| Tests: gutter run/debug icons on `it`/`describe`/`test`, run file/test/all, clickable `file:line` output | Done |
| Git: changes panel, stage/unstage, commit, diff view, gutter markers, blame, branch/worktree switchers, fetch/pull/push | Done |
| GitHub: sign in (gh token or PAT, Keychain), create PR, open on GitHub, gists, clone | Done |
| GitHub PR list/review panel, OAuth device flow | Planned |
| Rails navigation: related files (model/controller/views/tests/migrations), routes browser | Done |
| Settings window (searchable, global + per-project), keymap editor with presets, command palette, recent projects, session restore | Done |
| Database tools, HAML/Slim, Docker run targets, refactorings beyond rename | Planned |

## Install

1. Download `Garnet_<version>_aarch64.dmg` (Apple Silicon) or `_x64.dmg` (Intel)
   from the GitHub Releases page.
2. Open the DMG and drag Garnet to Applications.
3. Release builds are unsigned unless the maintainer has configured signing.
   macOS will refuse to open an unsigned app on first launch: right-click
   Garnet in Applications, choose **Open**, then confirm **Open** in the
   dialog. You only need to do this once.

Open a project from the welcome screen, with ⌘O, or from a terminal:

```sh
open -a Garnet --args /path/to/your/rails/app
```

For Ruby intelligence install ruby-lsp (Garnet offers a one-click install if it
is missing): `gem install ruby-lsp`. For debugging, keep the `debug` gem in your
Gemfile (Rails includes it by default).

## Build from source

Requirements: macOS 11+, Rust (stable), Node 22+, pnpm 10, Xcode command line tools.

```sh
pnpm install
pnpm tauri dev      # run in development
pnpm tauri build    # produces Garnet.app and a .dmg under src-tauri/target/release/bundle/
```

## Keyboard shortcuts

The default keymap follows the JetBrains macOS keymap for every action Garnet
implements; actions Garnet does not have are left unbound. Help › Keymap
Reference lists every action with its current shortcut.

| Action | Shortcut |
| --- | --- |
| Search Everywhere / Find Action | ⇧⇧ / ⌘⇧A |
| Go to File / Class / Symbol | ⌘⇧O / ⌘O / ⌘⌥O |
| Recent files / recent locations | ⌘E / ⌘⇧E |
| Back / forward | ⌘[ / ⌘] |
| Declaration / usages / test / related | ⌘B / ⌥F7 / ⌘⇧T / ⌃⌥↑ |
| File structure / go to line | ⌘F12 / ⌘L |
| Find / replace / next / in files | ⌘F / ⌘R / ⌘G / ⌘⇧F |
| Rename / reformat / context actions | ⇧F6 / ⌘⌥L / ⌥↩ |
| Line / block comment, duplicate, delete line | ⌘/ / ⌘⌥/, ⌘D, ⌘⌫ |
| Extend / shrink selection, next occurrence, move line | ⌥↑ / ⌥↓, ⌃G, ⌘⇧↑ / ⌘⇧↓ |
| Run / debug / run context configuration | ⌃R / ⌃D / ⌃⇧R |
| Step over / into / out, resume | F8 / F7 / ⇧F8, F9 or ⌘⌥R |
| Toggle / view breakpoints, evaluate | ⌘F8 / ⌘⇧F8, ⌥F8 |
| Commit / push / update project / VCS popup | ⌘K / ⌘⇧K / ⌘T / ⌃V |
| Tool windows | ⌘1 project, ⌘3 find, ⌘4 run, ⌘5 debug, ⌘6 problems, ⌘7 structure, ⌘9 commit, ⌥F12 terminal |
| Tabs / switcher / hide all tool windows | ⌘W, ⌘⇧[ / ⌘⇧], ⌃⇥, ⌘⇧F12 |
| Settings | ⌘, |

Settings › Keymap also offers a VS Code-style preset, per-action rebinding with
conflict detection, and import of a keymap XML exported from a JetBrains IDE
(also under Help › Import JetBrains Keymap).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Gaps are tracked in [docs/PARITY.md](docs/PARITY.md).

## License

MIT, see [LICENSE](LICENSE). Garnet is an independent project and is not
affiliated with JetBrains or RubyMine.
