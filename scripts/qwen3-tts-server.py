#!/usr/bin/env python3
"""
Qwen3-TTS Voice Cloning Server for TITAN
OpenAI-compatible /v1/audio/speech endpoint with reference audio support.
Runs on Apple Silicon via MLX.

Usage:
    python scripts/qwen3-tts-server.py --host 127.0.0.1 --port 5006

The server accepts standard OpenAI TTS requests. To use voice cloning,
set voice to a reference audio filename stored in ~/.titan/voices/ (e.g., "robin").
"""
import argparse
import io
import os
import sys
import json
import wave
import struct
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading
import time

VOICES_DIR = Path.home() / ".titan" / "voices"
DEFAULT_MODEL = "mlx-community/Qwen3-TTS-0.6B-bf16"

# Lazy-loaded globals
_tts_model = None
_tts_processor = None
_model_lock = threading.Lock()


def get_voices_dir():
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    return VOICES_DIR


def load_model(model_name=None):
    """Lazy-load the Qwen3-TTS model via mlx-audio."""
    global _tts_model, _tts_processor
    with _model_lock:
        if _tts_model is not None:
            return _tts_model, _tts_processor
        model_name = model_name or DEFAULT_MODEL
        print(f"[Qwen3-TTS] Loading model: {model_name} ...")
        try:
            from mlx_audio.tts.utils import load_model as mlx_load
            _tts_model, _tts_processor = mlx_load(model_name)
            print(f"[Qwen3-TTS] Model loaded successfully")
            return _tts_model, _tts_processor
        except Exception as e:
            print(f"[Qwen3-TTS] Failed to load model: {e}")
            raise


def generate_speech(text, voice="default", ref_audio_path=None, model_name=None):
    """Generate speech audio, optionally cloning from reference audio."""
    model, processor = load_model(model_name)

    from mlx_audio.tts.utils import generate as mlx_generate
    import numpy as np

    # Build generation kwargs
    gen_kwargs = {
        "text": text,
        "model": model,
        "processor": processor,
    }

    # Check for reference audio (voice cloning)
    if ref_audio_path and os.path.isfile(ref_audio_path):
        gen_kwargs["ref_audio"] = ref_audio_path
        # For Qwen3-TTS, we may also need ref_text (transcript of reference)
        ref_text_path = ref_audio_path.replace(".wav", ".txt")
        if os.path.isfile(ref_text_path):
            with open(ref_text_path, "r") as f:
                gen_kwargs["ref_text"] = f.read().strip()
        print(f"[Qwen3-TTS] Voice cloning from: {ref_audio_path}")
    elif voice and voice != "default":
        # Check voices directory for a matching reference file
        voices_dir = get_voices_dir()
        for ext in [".wav", ".mp3", ".flac"]:
            candidate = voices_dir / f"{voice}{ext}"
            if candidate.exists():
                gen_kwargs["ref_audio"] = str(candidate)
                ref_text = voices_dir / f"{voice}.txt"
                if ref_text.exists():
                    gen_kwargs["ref_text"] = ref_text.read_text().strip()
                print(f"[Qwen3-TTS] Voice cloning from: {candidate}")
                break

    # Generate audio
    audio = mlx_generate(**gen_kwargs)

    # Convert to numpy if needed
    if hasattr(audio, 'tolist'):
        audio_np = np.array(audio, dtype=np.float32)
    else:
        audio_np = np.array(audio, dtype=np.float32)

    return audio_np


def audio_to_wav(audio_np, sample_rate=24000):
    """Convert float32 numpy array to WAV bytes."""
    import numpy as np
    # Normalize to int16
    audio_int16 = np.clip(audio_np * 32767, -32768, 32767).astype(np.int16)

    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(sample_rate)
        wf.writeframes(audio_int16.tobytes())
    return buf.getvalue()


class TTSHandler(BaseHTTPRequestHandler):
    """OpenAI-compatible TTS HTTP handler."""

    def log_message(self, format, *args):
        print(f"[Qwen3-TTS] {format % args}")

    def do_GET(self):
        if self.path == "/health" or self.path == "/v1/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "model": DEFAULT_MODEL}).encode())
        elif self.path == "/v1/audio/voices":
            voices_dir = get_voices_dir()
            voices = []
            for f in voices_dir.glob("*.wav"):
                voices.append(f.stem)
            for f in voices_dir.glob("*.mp3"):
                voices.append(f.stem)
            voices = sorted(set(voices))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"voices": voices}).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/v1/audio/speech":
            self._handle_speech()
        elif self.path == "/v1/voices/upload":
            self._handle_voice_upload()
        else:
            self.send_response(404)
            self.end_headers()

    def _handle_speech(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(content_length))

            text = body.get("input", "")
            voice = body.get("voice", "default")
            model_name = body.get("model", DEFAULT_MODEL)
            response_format = body.get("response_format", "wav")
            ref_audio = body.get("ref_audio_path", None)

            if not text:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "input is required"}).encode())
                return

            audio_np = generate_speech(text, voice=voice, ref_audio_path=ref_audio, model_name=model_name)
            wav_bytes = audio_to_wav(audio_np)

            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav_bytes)))
            self.end_headers()
            self.wfile.write(wav_bytes)

        except Exception as e:
            print(f"[Qwen3-TTS] Error: {e}")
            import traceback
            traceback.print_exc()
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def _handle_voice_upload(self):
        """Upload a reference audio file for voice cloning."""
        try:
            content_type = self.headers.get("Content-Type", "")

            if "multipart/form-data" in content_type:
                # Handle multipart upload
                import cgi
                form = cgi.FieldStorage(
                    fp=self.rfile,
                    headers=self.headers,
                    environ={"REQUEST_METHOD": "POST", "CONTENT_TYPE": content_type},
                )
                voice_name = form.getfirst("name", "custom")
                transcript = form.getfirst("transcript", "")
                audio_field = form["audio"]
                audio_data = audio_field.file.read() if hasattr(audio_field, "file") else audio_field.value

                voices_dir = get_voices_dir()
                audio_path = voices_dir / f"{voice_name}.wav"
                audio_path.write_bytes(audio_data)

                if transcript:
                    transcript_path = voices_dir / f"{voice_name}.txt"
                    transcript_path.write_text(transcript)

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "ok": True,
                    "voice": voice_name,
                    "path": str(audio_path),
                }).encode())
            else:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Expected multipart/form-data"}).encode())

        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())


def main():
    parser = argparse.ArgumentParser(description="Qwen3-TTS Voice Cloning Server")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind to")
    parser.add_argument("--port", type=int, default=5006, help="Port to listen on")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Model to use")
    parser.add_argument("--preload", action="store_true", help="Preload model on startup")
    args = parser.parse_args()

    global DEFAULT_MODEL
    if args.model:
        DEFAULT_MODEL = args.model

    print(f"[Qwen3-TTS] Starting server on {args.host}:{args.port}")
    print(f"[Qwen3-TTS] Model: {DEFAULT_MODEL}")
    print(f"[Qwen3-TTS] Voices directory: {VOICES_DIR}")

    if args.preload:
        load_model()

    server = HTTPServer((args.host, args.port), TTSHandler)
    print(f"[Qwen3-TTS] Server ready at http://{args.host}:{args.port}")
    print(f"[Qwen3-TTS] Endpoints:")
    print(f"  POST /v1/audio/speech  — Generate speech (OpenAI-compatible)")
    print(f"  POST /v1/voices/upload — Upload reference audio for voice cloning")
    print(f"  GET  /v1/audio/voices  — List available cloned voices")
    print(f"  GET  /health           — Health check")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[Qwen3-TTS] Shutting down...")
        server.shutdown()


if __name__ == "__main__":
    main()
