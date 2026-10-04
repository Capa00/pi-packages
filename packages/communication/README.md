# @capa00/pi-communication

Telegram messaging, a multichannel contact directory, permission checks, and a persistent communication service for pi.

**Initial release preparation.** Telegram conversations and sending to the requesting user's own contact have been tested live. Delivery to a second real user and boot-time startup after reboot still need live verification. Other channels are directory entries only, not implemented adapters. Some existing CLI and Telegram interface text is still in Italian.

## Requirements

- Node.js 22 or newer and an existing pi installation with a configured model and credentials.
- A Telegram bot token from BotFather.
- Stable numeric Telegram user IDs for authorized contacts. Recipients must have started the bot first.
- Linux with a working systemd user manager for managed startup; foreground operation is also available.

## Installation

Once published:

```sh
pi install npm:@capa00/pi-communication
```

Reload pi if necessary with `/reload`. The explicit manifest loads `src/extension.ts` without a TypeScript build. `/communication-status` describes package capabilities, not service health.

**Installing or loading the extension does not start a service or contact Telegram.** `pi install` does not guarantee that the service executable is in your PATH.

### Service CLI

For a stable standalone checkout, including before publication:

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

From any installed package directory, invoke `node src/service/cli.mjs <command>` or `npm run service -- <command>`. If an npm installation exposes the bin in your PATH, `pi-communication <command>` works too. No second SDK copy is bundled: standalone execution must resolve the existing pi SDK, normally through the configured absolute `sdkModule` path.

## Guided setup and commands

All commands default to `~/.pi/communication/config.json`; use `--config /absolute/path/config.json` to select another profile.

- `setup`: interactive terminal only, hidden token input, explicit contact authorization. Creates external configuration and contacts with mode `600`, without overwriting existing files. On Linux, offers to create and enable a systemd user unit, **never starts it**. Does not contact Telegram or import the SDK. With existing configuration it offers only systemd setup.
- `check`: validates files without printing secrets, connecting to Telegram, or creating sessions. It does not validate token connectivity or model credentials.
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

Stop the service before changing its installation. Update the extension through pi package management after publication, or update the stable checkout for a checkout-based service. Re-run setup to inspect/reconfigure systemd if Node/package paths changed, then start explicitly. Keep configuration and sessions external; do not delete an uncertain delivery record to retry it.

## Tests and release

From the repository root:

```sh
npm test
npm run check:packages
```

Tests simulate SDK, Telegram, and systemd without real credentials or delivery. PTY setup tests isolate HOME and systemd commands; they require Linux, Python 3, and a usable user runtime directory, otherwise they are skipped.

See the repository's `RELEASING.md` for the release checklist. Install the package subdirectory in development, not the Git repository root.

## License

MIT — Copyright (c) 2026 Giuseppe Di Puglia Pugliese.
