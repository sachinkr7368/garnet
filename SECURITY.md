# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's
**Security** tab, choose **Report a vulnerability**, and describe the issue with
steps to reproduce. Do not open a public issue for a security problem.

Garnet is maintained by one person, so replies are best effort. Fixes go into the
next release and are credited in the changelog unless you prefer otherwise.

Supported versions: the latest release.

## Security model

- **Workspace trust.** Opening a folder never runs code from it until you trust it. Trust is stored in Garnet's own config keyed by canonical path, never in the repository. In Safe Mode ruby-lsp, repository run configurations, `.env` files, Rake/routes listing and terminals stay off. Settings that choose which programs run are global-only and ignored in `.garnet/settings.json`.
- **Secrets in Keychain.** The GitHub token and database passwords are stored in the macOS Keychain, never in a settings file.
- **No telemetry.** Garnet has no accounts and makes no network calls on its own. Network traffic is limited to what you trigger (GitHub actions, commands you run) and the optional update check, which is off by default.
- **Database safety.** Connections to non-development environments and non-local hosts are read-only by default, and destructive statements need explicit confirmation.

Builds are not notarized; see the README for first-launch steps.
