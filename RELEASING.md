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
pi install npm:@capa00/pi-communication@0.1.1
pi list
```

Check extension discovery, CLI access instructions, and that loading does not start a service. Record the release version in a Git tag after committing and pushing approved changes. Upgrading the real bot is a separate planned operation, not part of publishing.
