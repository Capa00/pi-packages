# Pi domain packages

Independent packages for pi, organized by domain rather than technical component.

## Packages

- [`@capa00/pi-communication`](packages/communication): Telegram messaging, contact permissions, pi integration, and a persistent receiving service.

The workspace root is private and is not an installable aggregate pi package. Each domain has its own version and explicit `pi` manifest. Install the communication subdirectory locally; do not install the repository root as a pi package.

## Development

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

See [RELEASING.md](RELEASING.md). The initial npm release is being prepared; publication is a separate step.

## License

MIT — Copyright (c) 2026 Giuseppe Di Puglia Pugliese.
