# Pi domain packages

Independent packages for pi, organized by domain rather than technical component.

## Packages

- [`@capa00/pi-communication`](packages/communication): Telegram messaging, contact permissions, pi integration, and a persistent receiving service.

The workspace root is private and is not an installable aggregate pi package. Each domain has its own version and explicit `pi` manifest. Install the communication subdirectory locally; do not install the repository root as a pi package.

## Installation

```sh
pi install npm:@capa00/pi-communication
```

Inside interactive pi, run `/communication setup`, then `/communication check` and `/communication start`. Setup accepts hidden token input in the terminal and never starts the bot. No clone is required. See the [package README](packages/communication/README.md) for requirements and operating limits.

## Development

Version `0.1.3` is prepared for npm publication with Create/Edit selection for multiple bot profiles, user management, and per-bot Pi file/shell tool permissions. Published npm `0.1.2` includes the earlier native TUI setup wizard. To test the checkout without changing the installed package or loading duplicate commands:

```sh
pi --no-extensions --extension ./packages/communication/src/extension.ts
```

Run `/communication setup` in that session. Confirmation uses the normal communication configuration and may enable systemd startup; cancellation changes nothing, and neither path starts the bot. See the [development smoke test](packages/communication/README.md#development-smoke-test).

Requires Node.js 22 or newer and an existing pi installation for integration checks.

```sh
npm test
npm run check:packages
pi install ./packages/communication
```

Tests use simulated Telegram and SDK implementations; they do not require real credentials. Local packages are not installed or modified by pi: any future runtime dependencies must be installed explicitly.

## Conventions

- Explicit pi entry points and declared dependencies.
- Host-provided dependencies in `peerDependencies` with `"*"`; never bundled.
- Credentials, configuration, contacts, and sessions outside updatable packages.
- Loading an extension never starts a service.
- Standalone services have explicit dependency resolution and lifecycle controls.
- Automation and proactive messaging belong to a future, separate domain.

## Release preparation

See [RELEASING.md](RELEASING.md). Versions `0.1.0`, `0.1.1`, and `0.1.2` are published on npm; the registry currently marks `0.1.2` as latest. Version `0.1.3` is prepared locally, not yet published. The public npm installation and real pi extension loading of `0.1.1` were verified in an isolated profile.

## License

MIT — Copyright (c) 2026 Giuseppe Di Puglia Pugliese.
