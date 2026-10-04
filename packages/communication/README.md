# @capa00/pi-communication

Telegram messaging, a multichannel contact directory, permission checks, and a persistent communication service for pi.

**Early release.** Telegram conversations and sending to the requesting user's own contact have been tested live. Delivery to a second real user and boot-time startup after reboot still need live verification. Other channels are directory entries only, not implemented adapters. Some existing CLI and Telegram interface text is still in Italian.

## Requirements

- Node.js 22 or newer and an existing pi installation with a configured model and credentials.
- A Telegram bot token from BotFather.
- Stable numeric Telegram user IDs for authorized contacts. Recipients must have started the bot first.
- Linux with a working systemd user manager for managed startup; foreground operation is also available.

## Installation

**Version `0.1.2` is prepared, not yet published:** the native TUI wizard described below is available in this checkout, not in npm `0.1.1`. That release still uses the terminal handoff for setup. For a temporary checkout test without replacing the installed package, see [Development smoke test](#development-smoke-test).

Install in pi:

```sh
pi install npm:@capa00/pi-communication
```

Reload pi if necessary with `/reload`, then run:

```text
/communication setup
/communication check
/communication start
/communication status
/communication stop
```

These commands are included in the package: **no repository clone, global CLI installation, or PATH setup is required**. Setup runs a native pi TUI wizard: hidden bot token, your name, and your positive numeric Telegram user ID (not `@username`), followed by a review with Confirm/Cancel. The token never enters the model conversation. Never paste tokens into the pi chat.

Technical paths are detected before asking for the token: the running pi SDK and current pi agent directory are used automatically. A new service workspace is created beside the configuration at `~/.pi/communication/workspace`, independent of pi's current working directory. An accessible existing workspace is preserved. If the host paths cannot be detected, setup fails before opening the form.

Setup requires interactive terminal pi (not RPC/print mode), waits for the model to become idle, and never starts the bot. `/communication start` requests managed background startup: systemd when configured, otherwise the Linux manual background manager. On unsupported systems without a suitable manager it fails rather than tying the bot to the pi terminal. `check` reports local validation results directly; `start`, `status`, and `stop` invoke the included CLI. Their output does not invoke the model or enter model context. Arguments other than the five action names are rejected; use the standalone CLI for alternate profiles.

The explicit manifest loads `src/extension.ts` without a TypeScript build. `/communication-status` remains a legacy capabilities command, not service health.

**Installing or loading the extension does not start a service or contact Telegram.** `pi install` does not guarantee that the service executable is in your PATH.

### Optional standalone service CLI

The in-pi commands above are the normal installation path. A checkout is optional for development or standalone administration:

```sh
git clone https://github.com/Capa00/pi-packages.git
cd pi-packages
npm run pi-communication -- setup
npm run pi-communication -- check
npm run pi-communication -- start
npm run pi-communication -- status
npm run pi-communication -- stop
```

Local extension installation from this checkout:

```sh
pi install ./packages/communication
```

For direct administration from any installed package directory, invoke `node src/service/cli.mjs <command>` or `npm run service -- <command>`. If an npm installation exposes the bin in your PATH, `pi-communication <command>` works too. No second SDK copy is bundled: standalone execution must resolve the existing pi SDK, normally through the configured absolute `sdkModule` path.

## Guided setup and commands

### In pi

`/communication setup` requires TUI mode and waits for the model to become idle. Enter advances through the three fields; Esc or Ctrl+C cancels without saving. At review, use arrow keys and Enter to choose Confirm or Cancel.

For an existing configuration, blank fields keep the saved values; the saved token is never loaded into the UI. Setup preserves the contact's stable identity, aliases, other endpoints, permissions, other contacts, and sessions. Ambiguous setup contacts, duplicate Telegram IDs, symlinks, unsafe file permissions, and changes made while the form is open are rejected rather than overwritten. Invalid configuration/contacts may require manual repair; use `/communication check` for diagnostics.

Confirm creates or updates private configuration and contacts files (mode `600` on Unix). A new contact receives permission to interact, receive messages, and request confirmed sends, as stated in the review. On Linux, confirming a new setup also configures/enables automatic startup; existing setups ask about startup separately after saving. Setup never starts or restarts the bot, contacts Telegram, or imports the SDK. Startup failure is reported separately from saved configuration. If the service may be running, changed values require an explicit stop/start.

`/communication check` distinguishes missing configuration, independent local errors, and valid configuration without displaying secrets or creating sessions. It checks SDK/path accessibility, not SDK importability, Telegram connectivity, or model credentials.

### Standalone CLI

All commands default to `~/.pi/communication/config.json`; use `--config /absolute/path/config.json` to select another profile. The standalone CLI retains its separate terminal prompts; it is not the native TUI wizard.

- `setup`: interactive terminal only, hidden token input, explicit contact authorization. Creates external configuration and contacts with mode `600`, without overwriting existing files. On Linux, offers to create and enable a systemd user unit, **never starts it**. Does not contact Telegram or import the SDK. With existing configuration it offers only systemd setup.
- `check`: uses the same local validation as `/communication check`, without printing secrets, connecting to Telegram, or creating sessions. It does not validate token connectivity or model credentials.
- `start`: uses the recognized systemd unit if present; otherwise runs in the foreground. `start --foreground` always forces foreground operation. Do not run two consumers for the same bot.
- `start --background`: uses systemd when configured, otherwise Linux manual background management with `service.log` and `managed-service.json` beside the configuration. Manual background mode survives terminal closure, not reboot.
- `status`: reports service management and lock state; not a Telegram/model health check.
- `stop`: stops recognized systemd/manual background processes gracefully, without SIGKILL or forcibly deleting session locks. Configuration and contacts must remain valid.

Old manual processes and `service.pid` files are not automatically adopted. Manual service controls use `.service-control.lock`; after a crash, inspect residual locks and unmanaged processes before removal.

## File configuration

Communication configuration is file-only, including the Telegram token. Keep all configuration, contacts, model credentials, and sessions **outside the package**.

Example `config.json` (Unix: `chmod 600 config.json`):

```json
{
  "version": 1,
  "telegram": { "botToken": "123456:REPLACE_WITH_BOT_TOKEN" },
  "pi": {
    "sdkModule": "/path/to/pi-coding-agent/dist/index.js",
    "workingDirectory": "/path/to/workspace",
    "agentDirectory": "/path/to/.pi/agent"
  },
  "contactsFile": "contacts.json",
  "sessionsDirectory": "sessions"
}
```

Relative paths are resolved against the configuration file. `pi` is required to start the service. `sdkModule` can be omitted only when Node can already resolve the SDK. No implicit global installation search or SDK download is performed. The configured agent directory supplies pi settings, models, and credentials; configure them through pi first. The SDK retains its own provider resolution behavior.

Example `contacts.json`:

```json
{
  "version": 1,
  "contacts": [
    {
      "id": "alice",
      "name": "Alice",
      "aliases": ["Al"],
      "preferredChannel": "telegram",
      "endpoints": [
        {
          "channel": "telegram",
          "address": "123456789",
          "permissions": {
            "canInteractWithPi": true,
            "canReceiveMessages": true,
            "canRequestSendMessages": true
          }
        }
      ]
    }
  ]
}
```

Telegram addresses are positive numeric strings, not usernames. Missing permissions are denied. A directory entry alone grants no authorization. The initial setup grants all three permissions after explicit confirmation; there is no administrator role. Additional contacts are edited manually. Duplicate IDs/endpoints, unknown fields, and invalid values are rejected; ambiguous names require clarification.

WhatsApp, Slack, and Discord endpoints can be stored but cannot deliver messages yet. Slack and Discord may include a workspace/server `scope`. Configuration/contact changes require a service restart.

## Systemd and boot startup

Setup writes `~/.config/systemd/user/pi-communication.service`, runs user `daemon-reload` and `enable`, but never `start` or `sudo`. Alternative config paths get stable profile suffixes. Conflicting units are not overwritten. If the user manager is unavailable, configuration is retained for a later attempt.

The unit contains absolute Node/package paths: keep them available. Logs:

```sh
journalctl --user -u pi-communication.service
```

Boot startup **without login** requires user linger. Setup checks it and, if necessary, suggests an administrative command:

```sh
sudo loginctl enable-linger <username>
```

Without linger, an enabled unit normally starts at login; boot startup is not guaranteed. The service uses `Restart=no` to avoid automatic crash retries and replay. Stop sends SIGTERM; after 30 seconds a timeout is reported without SIGKILL. A forced reboot/crash may leave a session lock that prevents startup: inspect it manually. Systemctl subprocess transport variables are not bot configuration sources.

To migrate a managed background process: `setup`, then `stop`, then `start`. Setup does not stop an existing process.

## Telegram behavior and safety

- Long polling, private chats only, stable-ID authorization, text messages only.
- Interaction and reception permissions required for responses. `/start` acknowledges access without invoking the model.
- One persistent SDK session and processing queue per contact; different contacts operate independently.
- Only `communication_contacts` and `communication_prepare_send` are exposed to the model. No file/command tools; external extensions, skills, and templates are disabled. Pi preferences are copied in memory without changing host settings.
- Native typing indicator refreshed every four seconds; failures do not block responses.
- Plain-text responses are split under Telegram limits.
- No unsolicited messages or model turns; forwarding never invokes the recipient's model.

### Confirmed outbound

Ask to send a message to a named contact. The service shows one minimal preview (`A <name>` and text), with **Conferma** (confirm) and **Annulla** (cancel) buttons. Model output duplicating a newly prepared preview is suppressed; ordinary conversation does not repeat old proposals.

The authenticated sender, chat, preview message, and proposal are bound to the callback. Other users, duplicate clicks, replaced proposals, and expired proposals cannot authorize delivery. The model cannot confirm or send directly. Permissions and recipient are checked again at confirmation. Legacy `/conferma <id>` and `/annulla <id>` commands remain manual fallbacks.

Only Telegram delivery is supported, with at most 3000 characters and one delivery API call. One proposal per sender, valid for 10 minutes from creation; replacement invalidates the previous proposal. Restart does not extend expiry. Proposals from the previous memory-only implementation cannot be recovered.

Proposals, button bindings, and outcomes are persisted in `sessionsDirectory/outbound.json`. Before network delivery, an atomic fsync-backed commit changes the state to `sending`. After restart, unfinished `sending` entries become `delivery_unconfirmed` and are **never retried automatically**. Success means accepted by the Bot API, not read by the recipient.

`/sends` retrieves the sender's pending preview and last five outcomes without invoking the model or delivering anything. A recreated preview invalidates old buttons. The register retains up to 100 terminal outcomes globally, in addition to active entries; it is not a permanent archive. It contains message text and recipient details and uses mode `600`.

The recipient sees only sender, forwarded text, and outcome, never the originating conversation. Forwarded content is treated as external data, not instructions. Request/outcome notes are recorded as custom SDK messages with `triggerTurn: false`. If a session is busy, notes are queued until its turn flushes; a crash before that flush can lose a note even if Telegram accepted the delivery. Sender context also receives the outcome. SDK sessions and the delivery register are separate persistence systems.

Corrupt, unreadable, or overly permissive register files fail closed. Persistence failures block further outbound actions and stop the service at batch end. If Telegram accepted delivery but the final commit/context update fails, the service reports success with a warning, without suggesting a resend.

**Not exactly-once.** Network uncertainty or a crash after acceptance may leave an uncertain outcome. Check Telegram before preparing another send. Replayed user messages can still create a distinct proposal, requiring new confirmation.

## Persistence and operational limits

```text
sessions/
├── contact-<id>/
├── telegram-offset.json
├── outbound.json
└── .telegram-service.lock/
    └── owner.json
```

Use one instance per bot, no other `getUpdates` consumer, and no active webhook. The service does not change webhooks automatically. Pending Telegram requests may be processed on first start.

The offset checkpoint is committed after a batch completes. Crashes before the checkpoint can replay input or duplicate ordinary responses. Ordinary response delivery errors stop the service; transient polling errors retry. Confirmed outbound is never automatically retried.

After forced termination a lock may remain. Linux ownership metadata includes PID, process start time, boot ID, and an ownership token. Status/start distinguish live, verified stale, and unknown locks (including older locks without metadata). **No residual lock is removed automatically.** Verify the service is stopped before manual cleanup. Normal shutdown removes only its own lock. No attachment support or automatic lock repair is provided.

Never share tokens in messages or logs. If exposed, rotate through BotFather. Telegram/model errors do not disclose token or request details.

## Updates

Stop the service before changing its installation. Update the package with `pi update npm:@capa00/pi-communication`, then `/reload`, or update the stable checkout for a checkout-based service. Re-run setup to inspect/reconfigure systemd if Node/package paths changed, then start explicitly. Keep configuration and sessions external; do not delete an uncertain delivery record to retry it.

## Tests and release

From the repository root:

```sh
npm test
npm run check:packages
```

Tests simulate SDK, Telegram, and systemd without real credentials or delivery. Native wizard tests cover hidden input, split bracketed paste, validation, preservation of existing values, cancellation, and narrow widths. Editor/flow tests cover preflight, private files, preserved contacts/sessions, stale snapshots, rollback on write failure, and separate startup outcomes. PTY tests cover the standalone CLI setup, not the complete pi TUI; they isolate HOME and systemd commands and require Linux, Python 3, and a usable user runtime directory, otherwise they are skipped.

### Development smoke test

From the repository root, launch a temporary pi session with only this extension:

```sh
pi --no-extensions --extension ./packages/communication/src/extension.ts
```

This avoids loading both the installed npm extension and checkout commands. It does not replace or update the installed package. Inside pi, try `/communication setup`: cancel first, then review the three fields and confirmation. Keep the token in the wizard, never in chat. Setup uses the normal communication configuration; confirmation saves files and, for a new Linux setup, configures automatic startup, but does not start the bot. Do not confirm unless those changes are intended.

Check keyboard navigation, masking, resizing, narrow widths, and return to the pi editor after cancellation/confirmation. Repeat setup to verify blank fields preserve saved values, then run `/communication check`. The user reported successful live testing of the setup and commands before preparing `0.1.2`; separate regular/fullscreen coverage was not recorded. Bot startup and messaging tests are separate explicit operations.

See the repository's `RELEASING.md` for the release checklist. Install the package subdirectory in development, not the Git repository root.

## License

MIT — Copyright (c) 2026 Giuseppe Di Puglia Pugliese.
