#!/usr/bin/env python3
"""
TITAN Voice Cloning TTS Server (GPU / PyTorch)
Uses F5-TTS via PyTorch + CUDA for high-quality zero-shot voice cloning.
Runs on NVIDIA GPUs (RTX 5090 tested).

OpenAI-compatible /v1/audio/speech endpoint with reference audio support.

Usage:
    ~/.titan/f5tts-venv/bin/python3 scripts/f5-tts-gpu-server.py --port 5006

Set voice to a reference audio filename in ~/.titan/voices/ (e.g., "andrew").
"""
import argparse
import io
import json
import os
import re
import struct
import subprocess
import tempfile
import threading
import wave
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler

# Fix CUDA library paths for pip-installed nvidia packages
try:
    import nvidia.cuda_nvrtc
    nvrtc_lib = str(Path(nvidia.cuda_nvrtc.__file__).parent / "lib")
    current = os.environ.get("LD_LIBRARY_PATH", "")
    if nvrtc_lib not in current:
        os.environ["LD_LIBRARY_PATH"] = f"{nvrtc_lib}:{current}" if current else nvrtc_lib
except ImportError:
    pass

VOICES_DIR = Path.home() / ".titan" / "voices"
ENGINE = "f5-tts"
SAMPLE_RATE = 24000
SPEED = 0.87
STEPS = 16
CFG_STRENGTH = 1.5
SEED = 42

_model_lock = threading.Lock()
_tts_model = None  # Cached F5TTS instance


def get_voices_dir():
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    return VOICES_DIR


def _find_ref_audio(voice_name):
    voices_dir = get_voices_dir()
    for ext in [".wav", ".mp3", ".flac"]:
        candidate = voices_dir / f"{voice_name}{ext}"
        if candidate.exists():
            return str(candidate)
    return None


def _find_ref_text(voice_name):
    voices_dir = get_voices_dir()
    txt = voices_dir / f"{voice_name}.txt"
    if txt.exists():
        return txt.read_text().strip()
    return None


def _get_model():
    """Load F5-TTS model once, cache for all subsequent calls."""
    global _tts_model
    if _tts_model is None:
        from f5_tts.api import F5TTS
        print("[VoiceClone] Loading F5-TTS model (one-time)...")
        _tts_model = F5TTS(model="F5TTS_v1_Base", ode_method="euler")
        print("[VoiceClone] Model cached on GPU")
    return _tts_model


def _preprocess_voice(input_path, output_path):
    """Auto-preprocess uploaded voice reference for optimal cloning quality."""
    try:
        result = subprocess.run(["ffmpeg", "-version"], capture_output=True, timeout=5)
        if result.returncode != 0:
            return {"ok": False, "error": "ffmpeg not found"}
    except FileNotFoundError:
        return {"ok": False, "error": "ffmpeg not installed"}

    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", input_path],
        capture_output=True, text=True, timeout=10
    )
    if probe.returncode != 0 or not probe.stdout.strip():
        return {"ok": False, "error": "Invalid audio file"}

    raw_duration = float(probe.stdout.strip())
    if raw_duration < 1.0:
        return {"ok": False, "error": f"Audio too short ({raw_duration:.1f}s)"}

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_out = tmp.name

    cmd = [
        "ffmpeg", "-y", "-i", input_path,
        "-af", (
            "loudnorm=I=-23:TP=-1.5:LRA=11,"
            "equalizer=f=4500:t=o:w=2000:g=-4,"
            "silenceremove=start_periods=1:start_silence=0.1:start_threshold=-40dB,"
            "areverse,silenceremove=start_periods=1:start_silence=0.1:start_threshold=-40dB,areverse"
        ),
        "-ac", "1", "-ar", str(SAMPLE_RATE), "-sample_fmt", "s16",
        tmp_out
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        os.unlink(tmp_out)
        return {"ok": False, "error": f"Preprocessing failed: {result.stderr[:200]}"}

    probe2 = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", tmp_out],
        capture_output=True, text=True, timeout=10
    )
    duration = float(probe2.stdout.strip()) if probe2.stdout.strip() else 0

    if duration < 3.0:
        os.unlink(tmp_out)
        return {"ok": False, "error": f"After trimming, audio is only {duration:.1f}s — need 3+ seconds"}

    if duration > 30.0:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp2:
            tmp_trunc = tmp2.name
        subprocess.run(
            ["ffmpeg", "-y", "-i", tmp_out, "-t", "30",
             "-ac", "1", "-ar", str(SAMPLE_RATE), "-sample_fmt", "s16", tmp_trunc],
            capture_output=True, timeout=30
        )
        os.unlink(tmp_out)
        tmp_out = tmp_trunc
        duration = 30.0

    import shutil
    shutil.move(tmp_out, output_path)
    print(f"[VoiceClone] Preprocessed voice: {duration:.1f}s, 24kHz mono, -23 LUFS")
    return {"ok": True, "duration": round(duration, 1)}


def generate_speech(text, voice="default"):
    """Generate speech using F5-TTS PyTorch API with CUDA."""
    with _model_lock:
        import numpy as np
        import soundfile as sf

        tts = _get_model()

        ref_file = _find_ref_audio(voice) if voice and voice != "default" else None
        ref_text = _find_ref_text(voice) if voice and voice != "default" else ""

        if not ref_file:
            # No reference audio — generate without cloning
            # F5-TTS requires ref_file, so use built-in default
            print(f"[VoiceClone] No ref audio for '{voice}', using default voice")
            ref_file = None
            ref_text = ""
        else:
            print(f"[VoiceClone] Cloning from: {ref_file}")

        gen_text = text.strip()

        # F5-TTS PyTorch handles sentence batching internally — don't merge
        try:
            if ref_file:
                wav, sr, _ = tts.infer(
                    ref_file=ref_file,
                    ref_text=ref_text or "",
                    gen_text=gen_text,
                    speed=SPEED,
                    seed=SEED,
                    nfe_step=STEPS,
                )
            else:
                # No ref file — use basic generation (no cloning)
                wav, sr, _ = tts.infer(
                    gen_text=gen_text,
                    speed=SPEED,
                    seed=SEED,
                    nfe_step=STEPS,
                )
        except RuntimeError as e:
            if "Sizes of tensors must match" in str(e):
                # Text too long for ref audio — truncate and retry
                print(f"[VoiceClone] Text too long for ref ({len(gen_text)} chars), truncating to 200 chars")
                gen_text = gen_text[:200].rsplit(' ', 1)[0] + '.'
                wav, sr, _ = tts.infer(
                    ref_file=ref_file,
                    ref_text=ref_text or "",
                    gen_text=gen_text,
                    speed=SPEED,
                    seed=SEED,
                    nfe_step=STEPS,
                )
            else:
                raise

        # Normalize volume — target peak at -10dB
        peak = np.max(np.abs(wav))
        if peak > 0:
            target_peak = 0.3
            wav = wav * (target_peak / peak)

        # Write to WAV bytes
        buf = io.BytesIO()
        sf.write(buf, wav, sr, format='WAV', subtype='PCM_16')
        return buf.getvalue()


class TTSHandler(BaseHTTPRequestHandler):
    """OpenAI-compatible TTS HTTP handler."""

    def log_message(self, format, *args):
        print(f"[VoiceClone] {format % args}")

    def do_GET(self):
        if self.path in ("/health", "/v1/health"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": "ok",
                "model": "f5-tts",
                "engine": ENGINE,
                "device": "cuda",
            }).encode())
        elif self.path == "/v1/audio/voices":
            voices = sorted({f.stem for f in get_voices_dir().glob("*.wav")})
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

            if not text:
                self._json_response(400, {"error": "input is required"})
                return

            print(f'[VoiceClone] Generating: "{text[:120]}" ({len(text)} chars) voice={voice}')

            import time
            start = time.time()
            wav_bytes = generate_speech(text, voice=voice)
            elapsed = time.time() - start
            print(f"[VoiceClone] Generated {len(wav_bytes)} bytes in {elapsed:.2f}s")

            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav_bytes)))
            self.end_headers()
            self.wfile.write(wav_bytes)

        except Exception as e:
            print(f"[VoiceClone] Error: {e}")
            import traceback
            traceback.print_exc()
            self._json_response(500, {"error": str(e)})

    def _handle_voice_upload(self):
        """Upload a reference audio file for voice cloning with auto-preprocessing."""
        try:
            content_type = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in content_type:
                self._json_response(400, {"error": "Expected multipart/form-data"})
                return

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

            if not re.match(r'^[a-zA-Z0-9_-]{1,50}$', voice_name):
                self._json_response(400, {"error": "Voice name must be 1-50 alphanumeric chars"})
                return

            voices_dir = get_voices_dir()

            with tempfile.NamedTemporaryFile(suffix=".raw_upload", delete=False) as tmp:
                tmp.write(audio_data)
                raw_path = tmp.name

            try:
                final_path = voices_dir / f"{voice_name}.wav"
                result = _preprocess_voice(raw_path, str(final_path))

                if not result["ok"]:
                    self._json_response(400, result)
                    return

                if transcript:
                    (voices_dir / f"{voice_name}.txt").write_text(transcript)

                self._json_response(200, {
                    "ok": True,
                    "voice": voice_name,
                    "duration": result["duration"],
                    "sampleRate": SAMPLE_RATE,
                    "preprocessed": True,
                    "hasTranscript": bool(transcript),
                })
            finally:
                os.unlink(raw_path)

        except Exception as e:
            import traceback
            traceback.print_exc()
            self._json_response(500, {"error": str(e)})

    def _json_response(self, code, data):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())


def main():
    parser = argparse.ArgumentParser(description="TITAN Voice Cloning TTS Server (GPU)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5006)
    args = parser.parse_args()

    import torch
    device = "cuda" if torch.cuda.is_available() else "cpu"
    gpu_name = torch.cuda.get_device_name(0) if device == "cuda" else "N/A"

    print(f"[VoiceClone] TITAN Voice Cloning Server (GPU)")
    print(f"[VoiceClone] Engine: F5-TTS (PyTorch)")
    print(f"[VoiceClone] Device: {device} ({gpu_name})")
    print(f"[VoiceClone] PyTorch: {torch.__version__}, CUDA: {torch.version.cuda}")
    print(f"[VoiceClone] Speed: {SPEED}x, Steps: {STEPS}, CFG: {CFG_STRENGTH}")
    print(f"[VoiceClone] Voices: {VOICES_DIR}")
    print(f"[VoiceClone] Endpoints:")
    print(f"  POST /v1/audio/speech  — Generate speech (OpenAI-compatible)")
    print(f"  POST /v1/voices/upload — Upload reference audio")
    print(f"  GET  /v1/audio/voices  — List voices")
    print(f"  GET  /health           — Health check")

    # Warm up model — use andrew if available for realistic warmup
    print(f"[VoiceClone] Warming up F5-TTS model...")
    warmup_voice = "andrew" if _find_ref_audio("andrew") else "default"
    try:
        generate_speech("Good morning Sir.", voice=warmup_voice)
        print(f"[VoiceClone] Model warm and ready (voice={warmup_voice})")
    except Exception as e:
        print(f"[VoiceClone] Warmup note: {e}")

    server = HTTPServer((args.host, args.port), TTSHandler)
    print(f"[VoiceClone] Ready at http://{args.host}:{args.port}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[VoiceClone] Shutting down...")
        server.shutdown()


if __name__ == "__main__":
    main()
