# Optional Python voice service

This optional service is separate from the gateway's default F5-TTS and LiveKit routes.
It now listens on `127.0.0.1:48421` by default and requires its own service credential
before synthesis, voice listing or WebSocket acceptance. `/health` remains unauthenticated
and returns only `{"status":"ok"}` for existing gateway probes.
This is a liveness probe, not proof of authentication or completed inference.

Generate a separate random token in the operator's shell and supply it to both the
voice service and the gateway process that calls it. Do not reuse `TITAN_AUTH_TOKEN`,
which authenticates the voice service's outbound gateway requests.

```sh
export TITAN_VOICE_AUTH_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
export TITAN_VOICE_SERVER_URL="http://127.0.0.1:48421"
python3 titan-voice-server/server.py
```

Keep the token in a private environment/secret manager, outside source and logs. The
server refuses missing/invalid tokens before loading models. Accepted tokens contain
32–256 URL-safe letters, digits, underscores or hyphens. Existing direct clients must
now send `Authorization: Bearer <service token>`; anonymous local clients must be updated.

For gateway TTS integration, set its existing `voice.ttsUrl` to the exact service origin
and provide the same two `TITAN_VOICE_*` environment values to the gateway. The gateway
adds the separate bearer only when the request origin equals `TITAN_VOICE_SERVER_URL`.
HTTP credential transport is accepted only for the literal `127.0.0.1` or `[::1]`;
use HTTPS for another host. URLs containing credentials, query tokens or a configured
base path are rejected, and credentialed requests never follow redirects. Unrelated
F5 and other TTS origins retain their ordinary headers.

Native WebSocket clients can send the same Authorization header to `/ws/voice`.
For browser clients, explicitly set `TITAN_VOICE_ALLOWED_ORIGINS` to a comma-separated
list of exact page origins, such as `http://localhost:48420`. The default empty list
denies browser origins. Wildcards, `null`, credentials and paths are not allowed.
The browser handshake uses two subprotocols:

```js
const socket = new WebSocket('ws://127.0.0.1:48421/ws/voice', [
  'titan-voice-v1',
  `bearer.${sessionToken}`, // supplied privately to this authorized client
]);
```

Only `titan-voice-v1` is selected in the response; the token is never echoed. Do not
put credentials in the URL, cookies, public HTML, or persistent browser storage.
Missing, duplicate, ambiguous or malformed credentials are rejected before creating
the VAD/pipeline. Allowed-origin REST requests still require the bearer header.

The supported REST body remains OpenAI-style JSON with `input`, optional `voice`,
and `response_format` (`wav` or `pcm`; other existing short format names retain the
WAV fallback). Input is limited to 4,000 characters and the JSON body to 32 KiB.
Voice names are 1–64 letters/digits/underscores/hyphens and cannot contain file paths.
Existing voice WAV basenames outside that format need operator renaming/configuration;
this change does not rename existing files.
WebSocket PCM16 frames are limited to 64 KiB and must have an even byte count;
control JSON is limited to 8 KiB and supports `config` and `interrupt`. A continuous
utterance is capped at 30 seconds and its buffer is cleared on overflow.

`HOST=0.0.0.0` is now an explicit operator choice for a protected container/network.
Do not publish this service directly without a TLS proxy and deployment-specific
connection/rate/resource controls. No deployment, firewall or live model was changed
by this source fix. The optional Python requirements and mutable model downloads
still need a reproducible dependency/model supply-chain review before release.
The pipeline also retains content logging and needs separate privacy, synthesis
output/time and multi-client resource review. This patch does not make the complete
optional service release-ready.

Synthetic checks (FastAPI, HTTPX and NumPy installed; no model dependencies required):

```sh
cd titan-voice-server
python3 -m unittest test_security
```

The tests stub every ML/pipeline import, use in-process ASGI transport, and never open
a microphone, speaker, network listener or existing owner vault. Gateway credential
routing is separately covered by `tests/voice-service-auth.test.ts` with a fake fetch.
