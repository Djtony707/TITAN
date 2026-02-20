# TITAN Communication Integrations

Last updated: February 20, 2026

TITAN exposes a unified multi-channel interface through one CLI contract:

- `titan comm list`
- `titan comm status <channel>`
- `titan comm send <channel> --target <target> --message <message>`

## Supported Channel Names

1. `whatsapp`
2. `telegram`
3. `discord`
4. `irc`
5. `slack`
6. `feishu`
7. `googlechat`
8. `mattermost`
9. `signal`
10. `bluebubbles`
11. `imessage`
12. `msteams`
13. `line`
14. `nextcloud-talk`
15. `matrix`
16. `nostr`
17. `tlon`
18. `twitch`
19. `zalo`
20. `zalouser`
21. `webchat`

## Native Integrations (Directly Implemented in TITAN)

1. `discord`
- `status`: validates bot token against Discord API.
- `send`: posts message to a channel.
- Required env: `DISCORD_BOT_TOKEN`

2. `telegram`
- `status`: validates bot token with `getMe`.
- `send`: calls Telegram `sendMessage`.
- Required env: `TELEGRAM_BOT_TOKEN`

3. `slack`
- `status`: validates token with `auth.test`.
- `send`: posts via `chat.postMessage`.
- Required env: `SLACK_BOT_TOKEN`

4. `googlechat`
- `status`: checks webhook presence.
- `send`: posts text payload to webhook.
- Required env: `GOOGLECHAT_WEBHOOK_URL`

5. `msteams`
- `status`: checks webhook presence.
- `send`: posts text payload to webhook.
- Required env: `MSTEAMS_WEBHOOK_URL`

6. `webchat`
- `status`: local dashboard channel available.
- `send`: currently returns queued placeholder for websocket flow.
- Required env: none

## Bridge Integrations (Uniform Adapter Contract)

Channels without direct native implementation use a bridge endpoint. This keeps the CLI/API uniform while letting you plug in any provider SDK.

Bridge channels:
- `whatsapp`, `irc`, `feishu`, `mattermost`, `signal`, `bluebubbles`, `imessage`, `line`, `nextcloud-talk`, `matrix`, `nostr`, `tlon`, `twitch`, `zalo`, `zalouser`

For each bridge channel, set:
- `TITAN_<CHANNEL>_BRIDGE_URL`

Normalization rule:
- channel name uppercased
- `-` replaced with `_`
- suffix `_BRIDGE_URL`

Examples:
- `TITAN_WHATSAPP_BRIDGE_URL`
- `TITAN_NEXTCLOUD_TALK_BRIDGE_URL`
- `TITAN_ZALOUSER_BRIDGE_URL`

Bridge HTTP contract:

1. Health endpoint
- `GET {bridge_url}/health`
- Success status code means channel is configured.

2. Send endpoint
- `POST {bridge_url}/send`
- JSON body:

```json
{
  "target": "destination-id",
  "message": "text message"
}
```

## Why this improves operability

1. Broad channel naming surface for consistent operations.
2. One operator interface for all channels (`titan comm ...`).
3. Native where stable; bridge adapters where providers differ.
4. Easier incremental hardening: each bridge can evolve independently without changing TITAN core CLI.
