"""Synthetic ASGI boundary checks. No models, audio devices, owner state or sockets."""
import importlib
import os
from pathlib import Path
import sys
import types
import unittest

import numpy as np
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

TOKEN = "synthetic_voice_service_token_0123456789abcdef"
ORIGIN = "http://localhost:48420"
os.environ.pop("HOST", None)
os.environ["TITAN_VOICE_AUTH_TOKEN"] = TOKEN
os.environ["TITAN_VOICE_ALLOWED_ORIGINS"] = ORIGIN
os.environ["TITAN_API_URL"] = "http://127.0.0.1:9/synthetic-api"
os.environ["TTS_VOICE"] = "synthetic_voice"
sys.path.insert(0, str(Path(__file__).resolve().parent))
calls = {"models": 0, "vad": 0, "pipeline": 0, "tts": 0, "audio": 0, "control": 0}


class FakeVad:
    def __init__(self):
        calls["vad"] += 1

    def reset(self):
        pass


class FakeTts:
    def synthesize(self, *_args):
        calls["tts"] += 1
        return np.zeros(8, dtype=np.float32)

    def available_voices(self):
        return ["synthetic_voice"]


class FakePipeline:
    def __init__(self, *_args):
        calls["pipeline"] += 1

    async def handle_audio(self, *_args):
        calls["audio"] += 1

    async def handle_control(self, *_args):
        calls["control"] += 1

    def interrupt(self):
        pass


# Prevent optional ML imports or downloads even if the service import order regresses.
for name, attrs in {
    "vad": {"VoiceActivityDetector": FakeVad, "_get_model": lambda: None},
    "stt": {"SpeechToText": object},
    "tts": {"TTSEngine": FakeTts, "create_tts_engine": FakeTts},
    "pipeline": {"VoicePipeline": FakePipeline},
}.items():
    module = types.ModuleType(name)
    module.__dict__.update(attrs)
    sys.modules[name] = module

server = importlib.import_module("server")


def fake_load():
    calls["models"] += 1


server._load_models = fake_load


class VoiceSecurityTests(unittest.TestCase):
    def setUp(self):
        for name in calls:
            calls[name] = 0
        server.cfg.AUTH_TOKEN = TOKEN
        server.cfg.ALLOWED_ORIGINS = [ORIGIN]
        server._tts = FakeTts()
        self.client = TestClient(server.app)
        self.addCleanup(self.client.close)

    def test_default_bind_is_loopback(self):
        self.assertEqual(server.cfg.HOST, "127.0.0.1")

    def test_missing_token_fails_startup_before_models(self):
        server.cfg.AUTH_TOKEN = ""
        with self.assertRaises(RuntimeError):
            with TestClient(server.app):
                pass
        self.assertEqual(calls["models"], 0)

    def test_unconfigured_token_fails_closed_even_without_lifespan(self):
        server.cfg.AUTH_TOKEN = ""
        response = self.client.post("/v1/audio/speech", json={"input": "synthetic"})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(calls["tts"], 0)

    def test_invalid_origin_configuration_fails_before_models(self):
        for origin in ["*", "https://*.example", "https://voice.invalid name", "https://voice.invalid\t", "https://voice.\x7finvalid", "null", "https://user:password@voice.invalid", "https://voice.invalid/path", "http://localhost:invalid"]:
            server.cfg.ALLOWED_ORIGINS = [origin]
            with self.assertRaises((RuntimeError, ValueError)):
                with TestClient(server.app):
                    pass
        self.assertEqual(calls["models"], 0)

    def test_http_auth_precedes_json_parsing_or_model_access(self):
        for headers in [{}, {"Authorization": "Bearer wrong"}]:
            response = self.client.post("/v1/audio/speech", content="not-json", headers=headers)
            self.assertEqual(response.status_code, 401)
        self.assertEqual(calls["tts"], 0)

    def test_voice_listing_needs_auth_and_health_is_minimal(self):
        self.assertEqual(self.client.get("/v1/audio/voices").status_code, 401)
        self.assertEqual(self.client.get("/health").json(), {"status": "ok"})

    def test_valid_native_bearer_preserves_pcm_and_voices(self):
        headers = {"Authorization": "Bearer " + TOKEN}
        response = self.client.post("/v1/audio/speech", json={"input": "synthetic", "response_format": "pcm"}, headers=headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, bytes(16))
        self.assertEqual(self.client.get("/v1/audio/voices", headers=headers).json(), {"voices": ["synthetic_voice"]})

    def test_foreign_or_duplicate_origins_are_rejected_even_with_token(self):
        for origins in [[("Origin", "https://attacker.invalid")], [("Origin", ORIGIN), ("Origin", ORIGIN)]]:
            headers = [("Authorization", "Bearer " + TOKEN)] + origins
            self.assertEqual(self.client.get("/v1/audio/voices", headers=headers).status_code, 403)

    def test_duplicate_authorization_or_query_tokens_are_rejected(self):
        headers = [("Authorization", "Bearer " + TOKEN), ("Authorization", "Bearer " + TOKEN)]
        self.assertEqual(self.client.get("/v1/audio/voices", headers=headers).status_code, 401)
        self.assertNotEqual(self.client.get("/v1/audio/voices?token=" + TOKEN, headers={"Authorization": "Bearer " + TOKEN}).status_code, 200)

    def test_cors_allows_only_configured_origin(self):
        for origin, expected in [(ORIGIN, ORIGIN), ("https://attacker.invalid", None)]:
            response = self.client.options("/v1/audio/speech", headers={"Origin": origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type"})
            self.assertEqual(response.headers.get("access-control-allow-origin"), expected)

    def test_body_text_and_voice_bounds_precede_inference(self):
        headers = {"Authorization": "Bearer " + TOKEN}
        for payload in [{"input": "x" * 4001}, {"input": "synthetic", "voice": "../../private"}, {"input": 42}]:
            self.assertEqual(self.client.post("/v1/audio/speech", json=payload, headers=headers).status_code, 400)
        response = self.client.post("/v1/audio/speech", content=b" " * 32769, headers={**headers, "Content-Type": "application/json"})
        self.assertEqual(response.status_code, 413)
        response = self.client.post("/v1/audio/speech", content="[" * 2000 + "]" * 2000, headers={**headers, "Content-Type": "application/json"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(calls["tts"], 0)

    def denied_ws(self, url="/ws/voice", **kwargs):
        with self.assertRaises(WebSocketDisconnect):
            with self.client.websocket_connect(url, **kwargs):
                self.fail("Unauthorized WebSocket was accepted")
        self.assertEqual(calls["pipeline"], 0)
        self.assertEqual(calls["vad"], 0)

    def test_ws_denies_missing_wrong_and_query_credentials_before_pipeline(self):
        self.denied_ws()
        self.denied_ws(headers={"Authorization": "Bearer wrong"})
        self.denied_ws("/ws/voice?token=" + TOKEN)

    def test_ws_denies_foreign_origin_and_ambiguous_protocol_credentials(self):
        self.denied_ws(headers={"Authorization": "Bearer " + TOKEN, "Origin": "https://attacker.invalid"})
        self.denied_ws(headers={"Origin": ORIGIN}, subprotocols=["titan-voice-v1", "bearer." + TOKEN, "bearer." + TOKEN])
        self.denied_ws(headers={"Authorization": "Bearer " + TOKEN}, subprotocols=["titan-voice-v1", "bearer." + TOKEN])
        self.denied_ws(headers={"Origin": ORIGIN}, subprotocols=["titan-voice-v1", "bearer." + TOKEN + "="])
        self.denied_ws(headers={"Origin": ORIGIN}, subprotocols=["other-app", "bearer." + TOKEN])

    def test_ws_native_and_browser_paths_authenticate_without_echoing_token(self):
        with self.client.websocket_connect("/ws/voice", headers={"Authorization": "Bearer " + TOKEN}) as ws:
            ws.send_json({"type": "interrupt"})
        with self.client.websocket_connect("/ws/voice", headers={"Origin": ORIGIN}, subprotocols=["titan-voice-v1", "bearer." + TOKEN]) as ws:
            self.assertEqual(ws.accepted_subprotocol, "titan-voice-v1")
            ws.send_json({"type": "config", "ttsVoice": "synthetic_voice"})
        self.assertEqual(calls["pipeline"], 2)

    def test_ws_frame_and_control_bounds_precede_pipeline_handling(self):
        for payload in [b"\0" * 65538, b"\0", '{"type":"config","ttsVoice":"../../private"}', "x" * 8193, "[" * 2000 + "]" * 2000]:
            before = (calls["audio"], calls["control"])
            with self.client.websocket_connect("/ws/voice", headers={"Authorization": "Bearer " + TOKEN}) as ws:
                if isinstance(payload, bytes):
                    ws.send_bytes(payload)
                else:
                    ws.send_text(payload)
                with self.assertRaises(WebSocketDisconnect):
                    ws.receive_text()
            self.assertEqual((calls["audio"], calls["control"]), before)

    def test_continuous_speech_cannot_accumulate_unbounded_audio(self):
        fake_torch = types.ModuleType("torch")
        fake_torch.from_numpy = lambda value: value
        previous = sys.modules.get("torch")
        sys.modules["torch"] = fake_torch
        try:
            spec = importlib.util.spec_from_file_location("synthetic_actual_vad", Path(__file__).with_name("vad.py"))
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            class Model:
                def __call__(self, *_args):
                    return types.SimpleNamespace(item=lambda: 1.0)
                def reset_states(self):
                    pass
            module._get_model = Model
            vad = module.VoiceActivityDetector()
            with self.assertRaises(ValueError):
                for _ in range(1000):
                    vad.process_chunk(bytes(1024))
            self.assertEqual(vad._speech_buffer, [])
            self.assertEqual(vad._speech_samples, 0)
        finally:
            if previous is None:
                sys.modules.pop("torch", None)
            else:
                sys.modules["torch"] = previous


if __name__ == "__main__":
    unittest.main()
