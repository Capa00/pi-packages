# Telegram adapter

Implemented in `api.mjs` within the communication domain.

- Bot API long polling; no webhook required.
- Plain-text delivery and splitting of long responses.
- Sanitized errors do not expose tokens, URLs, or provider descriptions.
- The service checks contacts and permissions before invoking pi.
- Private chats and text only in the initial version.
- Native typing indication is implemented in `typing.mjs`.

Local tests use simulated fetch. Live conversations and confirmed outbound to the requesting user's own contact have been verified; delivery to a second real contact still needs live testing.
