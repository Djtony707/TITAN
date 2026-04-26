#!/usr/bin/env python3
"""
TITAN Voice Cloning TTS Server
Uses F5-TTS via MLX for high-quality zero-shot voice cloning.
Runs natively on Apple Silicon via MLX.

OpenAI-compatible /v1/audio/speech endpoint with reference audio support.
Generates sentence-by-sentence for natural pacing with pauses between.

Usage:
    python scripts/f5-tts-server.py --host 127.0.0.1 --port 5006

Set voice to a reference audio filename in ~/.titan/voices/ (e.g., "andrew").
"""
import argparse
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

VOICES_DIR = Path.home() / ".titan" / "voices"
ENGINE = "f5-tts"
SAMPLE_RATE = 24000
SPEED = 0.87
STEPS = 16
CFG_STRENGTH = 1.5  # Lower than default 2.0 for calmer, less aggressive output
PAUSE_SECONDS = 0.4

_model_lock = threading.Lock()


def get_voices_dir():
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    return VOICES_DIR


def _find_ref_audio(voice_name):
    """Find reference audio for a voice name."""
    voices_dir = get_voices_dir()
    for ext in [".wav", ".mp3", ".flac"]:
        candidate = voices_dir / f"{voice_name}{ext}"
        if candidate.exists():
            return str(candidate)
    return None


def _find_ref_text(voice_name):
    """Find transcript for reference audio (improves clone quality)."""
    voices_dir = get_voices_dir()
    txt = voices_dir / f"{voice_name}.txt"
    if txt.exists():
        return txt.read_text().strip()
    return None


def _split_sentences(text):
    """Split text into sentences for sentence-by-sentence generation."""
    # Split on sentence-ending punctuation followed by space or end
    parts = re.split(r'(?<=[.!?])\s+', text.strip())
    # Filter empty strings
    return [p.strip() for p in parts if p.strip()]


def _make_silence(duration_sec, sample_rate=SAMPLE_RATE):
    """Create WAV silence bytes."""
    num_samples = int(duration_sec * sample_rate)
    return struct.pack(f'<{num_samples}h', *([0] * num_samples))


def _join_wavs(wav_files, pause_sec=PAUSE_SECONDS):
    """Join multiple WAV files with silence between them, return combined WAV bytes."""
    if not wav_files:
        raise RuntimeError("No WAV files to join")

    if len(wav_files) == 1:
        return wav_files[0].read_bytes()

    # Read all audio data
    segments = []
    params = None
    for wf in wav_files:
        with wave.open(str(wf), 'rb') as w:
            if params is None:
                params = w.getparams()
            segments.append(w.readframes(w.getnframes()))

    # Build combined audio with silence gaps
    silence = _make_silence(pause_sec, params.framerate)
    combined = bytearray()
    for i, seg in enumerate(segments):
        combined.extend(seg)
        if i < len(segments) - 1:
            combined.extend(silence)

    # Write combined WAV
    import io
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as out:
        out.setparams(params)
        out.writeframes(bytes(combined))
    return buf.getvalue()


_cached_model = None
_cached_ref = {}  # voice_name -> (audio_mx, ref_text)


def _preprocess_voice(input_path, output_path):
    """Auto-preprocess uploaded voice reference for optimal cloning quality.

    Pipeline:
    1. Convert to 24kHz mono 16-bit WAV
    2. Normalize to -23 LUFS (broadcast standard)
    3. De-ess (reduce 3-6kHz by 4dB for cleaner cloning)
    4. Trim leading/trailing silence
    5. Validate duration (3-30 seconds)
    """
    try:
        # Check ffmpeg available
        result = subprocess.run(["ffmpeg", "-version"], capture_output=True, timeout=5)
        if result.returncode != 0:
            return {"ok": False, "error": "ffmpeg not found — required for voice preprocessing"}
    except FileNotFoundError:
        return {"ok": False, "error": "ffmpeg not installed — required for voice preprocessing"}

    # Step 1: Validate input is actual audio
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", input_path],
        capture_output=True, text=True, timeout=10
    )
    if probe.returncode != 0 or not probe.stdout.strip():
        return {"ok": False, "error": "Invalid audio file — could not detect audio stream"}

    raw_duration = float(probe.stdout.strip())
    if raw_duration < 1.0:
        return {"ok": False, "error": f"Audio too short ({raw_duration:.1f}s) — need at least 3 seconds of speech"}

    # Step 2: Full preprocessing pipeline in one ffmpeg call
    # - loudnorm: normalize to -23 LUFS (broadcast standard)
    # - equalizer: de-ess male range (reduce 3-6kHz by 4dB)
    # - silenceremove: trim leading silence
    # - areverse + silenceremove + areverse: trim trailing silence
    # - Output: 24kHz mono 16-bit PCM WAV
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

    # Step 3: Validate processed duration
    probe2 = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", tmp_out],
        capture_output=True, text=True, timeout=10
    )
    duration = float(probe2.stdout.strip()) if probe2.stdout.strip() else 0

    if duration < 3.0:
        os.unlink(tmp_out)
        return {"ok": False, "error": f"After trimming silence, audio is only {duration:.1f}s — need at least 3 seconds of speech"}

    if duration > 30.0:
        # Truncate to 30 seconds
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

    # Move to final location
    import shutil
    shutil.move(tmp_out, output_path)

    print(f"[VoiceClone] Preprocessed voice: {duration:.1f}s, 24kHz mono, -23 LUFS normalized")
    return {"ok": True, "duration": round(duration, 1)}

def _get_model():
    """Load F5-TTS model once, cache for all subsequent calls."""
    global _cached_model
    if _cached_model is None:
        from f5_tts_mlx.cfm import F5TTS
        print("[VoiceClone] Loading F5-TTS model (one-time)...")
        _cached_model = F5TTS.from_pretrained("lucasnewman/f5-tts-mlx")
        print("[VoiceClone] Model cached in memory")
    return _cached_model

def _get_ref_audio(voice_name):
    """Load and cache reference audio as MLX array."""
    if voice_name not in _cached_ref:
        import mlx.core as mx
        import soundfile as sf
        ref_path = _find_ref_audio(voice_name)
        if not ref_path:
            return None, None
        audio, sr = sf.read(ref_path)
        if sr != SAMPLE_RATE:
            raise ValueError(f"Reference audio must be 24kHz, got {sr}")
        audio_mx = mx.array(audio)
        # Normalize RMS
        rms = mx.sqrt(mx.mean(mx.square(audio_mx)))
        target_rms = 0.1
        if rms < target_rms:
            audio_mx = audio_mx * target_rms / rms
        ref_text = _find_ref_text(voice_name)
        _cached_ref[voice_name] = (audio_mx, ref_text)
        print(f"[VoiceClone] Cached ref audio for '{voice_name}' ({audio_mx.shape[0]/SAMPLE_RATE:.1f}s)")
    return _cached_ref[voice_name]

def generate_speech(text, voice="default"):
    """Generate speech audio using F5-TTS via MLX with cached model."""
    with _model_lock:
        import mlx.core as mx
        import soundfile as sf
        from f5_tts_mlx.generate import generate as f5_generate

        # Monkey-patch from_pretrained to return cached model
        # Must patch in BOTH modules — generate.py imports F5TTS at module level
        from f5_tts_mlx import cfm as f5_cfm
        import f5_tts_mlx.generate as f5_gen_mod
        model = _get_model()
        original_cfm = f5_cfm.F5TTS.from_pretrained
        original_gen = f5_gen_mod.F5TTS.from_pretrained
        f5_cfm.F5TTS.from_pretrained = classmethod(lambda cls, *a, **kw: model)
        f5_gen_mod.F5TTS.from_pretrained = classmethod(lambda cls, *a, **kw: model)

        try:
            ref_audio_path = None
            ref_text = None

            if voice and voice != "default":
                ref_audio_path = _find_ref_audio(voice)
                if ref_audio_path:
                    _, ref_text = _get_ref_audio(voice)
                    if ref_text:
                        print(f"[VoiceClone] Using cached ref for '{voice}'")

            with tempfile.TemporaryDirectory() as tmpdir:
                out_path = Path(tmpdir) / "speech.wav"

                # Merge all sentences into one by replacing mid-text sentence
                # endings with commas. F5-TTS splits on .!? internally and
                # generates each sentence separately (causing voice drift).
                gen_text = text.strip()
                # Replace .!? that are followed by more text with comma
                gen_text = re.sub(r'([.!?])\s+(?=\S)', ', ', gen_text)

                kwargs = {
                    "generation_text": gen_text,
                    "speed": SPEED,
                    "steps": STEPS,
                    "cfg_strength": CFG_STRENGTH,
                    "seed": 42,  # Fixed seed for consistent pitch/cadence
                    "output_path": str(out_path),
                }
                if ref_audio_path:
                    kwargs["ref_audio_path"] = ref_audio_path
                if ref_text:
                    kwargs["ref_audio_text"] = ref_text

                f5_generate(**kwargs)

                if out_path.exists() and out_path.stat().st_size > 100:
                    # Normalize volume to prevent yelling — target peak at -10dB
                    import numpy as np
                    audio, sr = sf.read(str(out_path))
                    peak = np.max(np.abs(audio))
                    if peak > 0:
                        target_peak = 0.3  # ~-10dB, gentle volume
                        audio = audio * (target_peak / peak)
                        norm_path = Path(tmpdir) / "speech_norm.wav"
                        sf.write(str(norm_path), audio, sr)
                        return norm_path.read_bytes()
                    return out_path.read_bytes()

                raise RuntimeError("F5-TTS produced no output")
        finally:
            f5_cfm.F5TTS.from_pretrained = original_cfm
            f5_gen_mod.F5TTS.from_pretrained = original_gen


class TTSHandler(BaseHTTPRequestHandler):
    """OpenAI-compatible TTS HTTP handler."""

    def log_message(self, format, *args):
        print(f"[VoiceClone] {format % args}")

    def do_GET(self):
        if self.path in ("/health", "/v1/health"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "model": "f5-tts-mlx", "engine": ENGINE}).encode())
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
            wav_bytes = generate_speech(text, voice=voice)

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

            # Validate voice name
            if not re.match(r'^[a-zA-Z0-9_-]{1,50}$', voice_name):
                self._json_response(400, {"error": "Voice name must be 1-50 alphanumeric characters, hyphens, or underscores"})
                return

            voices_dir = get_voices_dir()

            # Save raw upload to temp file for preprocessing
            with tempfile.NamedTemporaryFile(suffix=".raw_upload", delete=False) as tmp:
                tmp.write(audio_data)
                raw_path = tmp.name

            try:
                # Auto-preprocess: convert, normalize, de-ess, trim silence
                final_path = voices_dir / f"{voice_name}.wav"
                result = _preprocess_voice(raw_path, str(final_path))

                if not result["ok"]:
                    self._json_response(400, result)
                    return

                # Clear cached ref so it reloads with preprocessed audio
                if voice_name in _cached_ref:
                    del _cached_ref[voice_name]

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
    parser = argparse.ArgumentParser(description="TITAN Voice Cloning TTS Server (F5-TTS)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5006)
    args = parser.parse_args()

    print(f"[VoiceClone] TITAN Voice Cloning Server")
    print(f"[VoiceClone] Engine: F5-TTS (MLX native)")
    print(f"[VoiceClone] Speed: {SPEED}x")
    print(f"[VoiceClone] Voices: {VOICES_DIR}")
    print(f"[VoiceClone] Endpoints:")
    print(f"  POST /v1/audio/speech  — Generate speech (OpenAI-compatible)")
    print(f"  POST /v1/voices/upload — Upload reference audio")
    print(f"  GET  /v1/audio/voices  — List voices")
    print(f"  GET  /health           — Health check")

    # Warm up model on startup so first real request is fast
    print(f"[VoiceClone] Warming up F5-TTS model...")
    try:
        generate_speech("Warming up.", voice="default")
        print(f"[VoiceClone] Model warm and ready")
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
