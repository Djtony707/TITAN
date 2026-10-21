# Gateway authentication

The gateway refuses startup when `gateway.auth.mode` is `token` or `password` but its corresponding credential is missing or blank. A fresh default configuration selects token mode and therefore needs private setup before `titan gateway` can start. Missing credentials never mean anonymous access.

Run `titan onboard`, enable authentication, select token or password, and supply a nonempty credential through the masked prompt. Alternatively, use `titan config --path` to locate the configuration and edit it with a private local editor. Keep the application home private (0700 on POSIX) and `titan.json` private (0600). Do not place credentials in shell arguments, command history, screenshots or logs. There is no `TITAN_GATEWAY_TOKEN` environment binding in this gateway.

The main gateway applies the same bearer/session authentication before body parsing or dispatch to `/api`, `/v1`, `/ollama`, `/paperclip`, `/mcp` and `/metrics`. This includes Paperclip management/UI proxies, Ollama model mutations and SSE endpoints. Static Mission Control files and the login page remain public. Password login returns a session token; native clients use that session or the configured gateway token. The built-in `/mcp` endpoint uses this gateway credential, without a second MCP token.

An embedded Paperclip page that cannot supply the gateway bearer receives 401. The proxy strips gateway authorization, cookies, proxy credentials, referrers and original-URL forwarding headers; it removes the gateway `token` query parameter and refuses upstream redirects. It does not invent authentication for a sidecar.

Explicit `auth.mode: "none"` is limited to a loopback listener and trusted local clients. Mesh expansion to a network listener requires authentication before any mesh initialization. A running network listener also refuses an attempted configuration downgrade to no-auth; changing a configuration file cannot bypass the captured listener policy. No-auth requests need a trusted Host, an exact trusted Origin when supplied, and no cross-site Fetch Metadata. `gateway.originAllowlist` accepts at most 64 exact HTTP(S) origins without wildcards, credentials or paths. It is browser-origin policy, not network authentication or isolation from other local processes. Browser preflights terminate without operation dispatch. Authenticated remote clients still require a valid gateway credential.

Only exact platform webhook methods and paths bypass gateway bearer authentication, and their handlers must authenticate the platform request:

- Messenger POSTs require a configured app secret and a matching `X-Hub-Signature-256` over the exact raw JSON bytes. A missing secret denies requests; the configured secret is loaded when the adapter connects. Verification tokens are not logged.
- LINE POSTs require `channels.line.apiKey` to contain the channel secret and a matching raw-body `x-line-signature`, following [LINE's signature contract](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/).
- Twilio requires its configured Auth Token and signature for voice, GET/POST polling and status callbacks, using the complete public URL and POST fields as [Twilio documents](https://www.twilio.com/docs/usage/security). Configure the correct public host. Cached audio remains accessible only through its random 96-bit capability and short TTL; the audio can contain private speech.
- Dograh retains its separate configured webhook credential. Lark inbound events return 503 before body parsing or dispatch until event-signature configuration has been designed and reviewed.

The optional [MCP HTTP example](../examples/mcp-server/README.md) does not forward a gateway credential and is limited to an explicitly configured local no-auth gateway. Use built-in authenticated `/mcp` or the native `titan mcp` stdio command where appropriate. Do not add ambient owner credentials to the example's anonymous local HTTP transport.
