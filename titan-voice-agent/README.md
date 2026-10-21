# Local LiveKit voice stack

The optional stack in `docker-compose.voice.yml` runs LiveKit, faster-whisper, Kokoro and this agent on one operator-controlled computer. It requires private LiveKit credentials and publishes signaling, media, STT and TTS ports only on `127.0.0.1`. The agent's health listener also binds loopback. The ordinary local F5-TTS gateway path remains independent of LiveKit credentials.

Before starting this stack, generate a private key pair using the official LiveKit server's [`generate-keys` command](https://github.com/livekit/livekit/blob/49414fe10068b64f298e391f67b60feec3edbdc6/cmd/server/commands.go). Keep the values in a private operator environment, outside source control and chat. This stack accepts a URL-safe API key of 8–128 characters and a separate random URL-safe secret of 32–256 characters. `devkey` / `secret`, missing values, whitespace, quotes and YAML delimiters are refused. Length and syntax checks cannot establish the entropy of an operator-selected secret; use the official random generator.

Supply matching values to both the Compose process and the TITAN gateway:

```text
LIVEKIT_URL=ws://127.0.0.1:7880
LIVEKIT_API_KEY=<private generated key>
LIVEKIT_API_SECRET=<private generated secret>
```

The gateway maps these environment variables to its voice configuration. It preserves explicit saved private credentials, but ships empty credential defaults. Its token endpoint returns `503` until a valid private pair is configured. Existing shared development credentials must be replaced explicitly. Routine voice settings saves preserve server-side credentials; neither configuration response exposes the signing secret.

Compose first runs a stdlib-only credential check without a network, before starting LiveKit or either model service. The agent checks the same policy before importing SDK or model code. LiveKit runs in normal mode, reads its YAML key map from `LIVEKIT_KEYS` and explicitly disables external-IP discovery. Docker administrators can inspect container environment variables; protect access to the host and Docker daemon. The setup does not create or rotate a secret automatically.

When privately configured, an operator can start the optional stack with:

```sh
docker compose -f docker-compose.voice.yml up -d
```

The published ports and advertised media address are deliberately **local-client-only**. A browser on a phone, another LAN computer or a remote desktop host will not obtain working media from this default configuration. Distributed voice requires a separately reviewed deployment with authenticated TLS signaling, appropriate firewall rules and a correct advertised media address. Do not widen published ports as a substitute for that review. `OLLAMA_HOST` can still select a separately administered LLM host; it does not expose this stack's voice listeners.

The inactive legacy `titan-voice-ui` is separate from the supported gateway/React UI. Follow its security-hold notice rather than its old setup flow.

This increment verifies configuration parsing, credential guards and synthetic callbacks. It does not prove a live WebRTC conversation or model inference. The unchanged container images, Python dependency ranges and model downloads still require a reproducible supply-chain review before release. No Docker daemon, image build, model download or deployment is needed to run the synthetic Python checks:

```sh
python3 -B -m unittest discover -s titan-voice-agent -p test_credentials.py
```

Primary behavior references: [LiveKit server configuration](https://github.com/livekit/livekit/blob/49414fe10068b64f298e391f67b60feec3edbdc6/cmd/server/main.go), [Compose startup dependencies](https://docs.docker.com/compose/how-tos/startup-order/), and [LiveKit agent server options](https://docs.livekit.io/agents/server/options/).
