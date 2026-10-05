# Release checklist

Package: `@capa00/pi-communication`

Repository: https://github.com/Capa00/pi-packages

License: MIT, Copyright (c) 2026 Giuseppe Di Puglia Pugliese

Publication, Git initialization, commits, pushes, and changes to the running service are separate operations requiring explicit approval.

## Current release status

- `0.1.0`: published on npm; source commit `bbc648e`.
- `0.1.1`: published on npm; source commit `04a91e2`.
- 104 local tests passed, including isolated PTY setup with hidden token input and host-default suggestions.
- Public `pi install npm:@capa00/pi-communication@0.1.1` verified in an isolated HOME/agent/work directory. Only the communication package was installed; the real pi resource loader registered the commands without model or Telegram calls.
- The production bot was not restarted or changed as part of the release checks.
- End-to-end interactive pi terminal handoff still needs a live user smoke test; terminal handoff/restoration are covered by simulated unit tests and the child setup by PTY tests.

## Published release: `0.1.2`

- `/communication setup` now uses a native three-field pi TUI wizard with masked token input, review/confirmation, cancellation, and safe editing of existing configuration.
- `/communication check` reports missing configuration and independent local errors; standalone setup retains its terminal prompts.
- 127 local tests passed, including additional cancellation/control-paste/disposal and initial-save rollback cases. Package dry-run and `git diff --check` passed.
- Real host extension loader verified the new `pi-tui` peer import and both command registrations in a temporary agent/work directory. Real TUI components passed split secret paste, Unicode/narrow-width rendering, confirmation, and cancellation checks without Telegram/model calls.
- The user reported successful live testing of the setup and commands and authorized Git push and npm release preparation. Separate regular/fullscreen coverage was not recorded.
- npm registry verification confirms `0.1.2` is published and marked latest, with source commit `6a1729f`. Publication was not performed by the assistant; installation and live service upgrade status have not been rechecked.
- Release preparation reran all 127 tests (no failures or skips), package dry-run, and whitespace checks. The extracted tarball CLI `--help` and local `pi install`/`pi list` passed in an isolated HOME/agent/work directory. The tarball contains 28 source/documentation/metadata files and no operational data.

## Prepared release: `0.1.3` (not yet published)

- Adds named Telegram bot profiles, Create/Edit selection, authorized-user management, and per-bot Pi file-read, file-write, and shell-command permissions.
- Preserves contact identity, existing permissions, other channel endpoints, and sessions during edits; profile commits are serialized and setup never starts or restarts a bot.
- Removes legacy setup helpers, unused type contracts, redundant permission wrappers, and unused draft fields; tests exercise the active setup path.
- Latest code validation: 148 tests passed, one optional real host-SDK test skipped. Workspace package dry-runs and whitespace checks passed before the version bump.
- Multi-bot setup and the new permissions still require an agreed live smoke test. Earlier user testing applies to the previous wizard, not these additions.
- Only communication is prepared for npm publication. Sprint Planner remains a locally installed package and is not part of this release.
- Publication, release commits/tags/pushes, and live service upgrades require separate approval.

## Before publication

1. Confirm the npm account owns the `@capa00` scope and can publish publicly. An unauthenticated registry lookup can only show whether a package is already published, not reserve its name.
2. Review package version, author, repository URL/directory, license, and public access configuration.
3. Run `npm test` and `npm run check:packages` from the workspace root.
4. Inspect the tarball file list: only source, README, LICENSE, and package metadata should ship. No contacts, tokens, credentials, logs, sessions, or test fixtures.
5. Create a tarball with `npm pack --workspace @capa00/pi-communication` and extract it into a temporary directory. Verify the CLI `--help` and explicit extension entry point from that extracted package.
6. Install the extracted directory with `pi install /absolute/path/to/extracted/package` using isolated HOME, agent directory, and working directory. Check package registration and extension loading without model calls, bot startup, or real credentials. This checks local resource loading, not the future npm registry install.
7. Confirm the documentation accurately describes current limitations. Decide whether to complete second-user/reboot live checks before the initial release.
8. Review Git contents before the first push. Keep operational data outside the repository. Do not commit personal agent settings or secrets.

## Publish (only after explicit approval)

Authenticate interactively with npm as `capa00`, with the required account security/2FA configuration. Do not share passwords, OTPs, or access tokens in chat.

From the workspace root:

```sh
npm publish --workspace @capa00/pi-communication --access public
```

Do not publish the private workspace root. Publication makes the package public and cannot be treated as a reversible test. A published version cannot be overwritten.

## After publication

In an isolated pi profile, verify:

```sh
pi install npm:@capa00/pi-communication@0.1.3
pi list
```

Check extension discovery, CLI access instructions, and that loading does not start a service. Record the release version in a Git tag after committing and pushing approved changes. Upgrading the real bot is a separate planned operation, not part of publishing.
