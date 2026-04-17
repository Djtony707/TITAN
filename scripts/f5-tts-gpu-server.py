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

# ── torchaudio.load monkey-patch (v4.3.2+) ──────────────────────────
# torchaudio 2.5+ routes .load() through torchcodec, which fails on
# F5-TTS's internal tempfiles with "Could not open input file" even
# though the file exists on disk. Route torchaudio.load through
# soundfile directly, which is already a dependency of F5-TTS and
# handles wav/mp3/flac reliably. This must run BEFORE f5_tts imports.
try:
    import torch
    import torchaudio
    import soundfile as _sf
    _orig_torchaudio_load = torchaudio.load

    def _load_via_soundfile(uri, *args, **kwargs):
        try:
            # soundfile handles str, Path, file-like objects and most common formats.
            data, sr = _sf.read(str(uri), dtype="float32", always_2d=True)
            # soundfile returns (frames, channels); torchaudio returns (channels, frames).
            tensor = torch.from_numpy(data.T.copy())  # copy() guarantees contiguous
            return tensor, sr
        except Exception:
            # Last-resort fallback to the original loader so we don't break
            # callers that expect torchcodec features (e.g., mp4 video audio).
            return _orig_torchaudio_load(uri, *args, **kwargs)

    torchaudio.load = _load_via_soundfile
    print("[VoiceClone] torchaudio.load patched → soundfile (bypasses torchcodec)")
except Exception as _e:
    print(f"[VoiceClone] torchaudio patch skipped: {_e}")

VOICES_DIR = Path.home() / ".titan" / "voices"
ENGINE = "f5-tts"
SAMPLE_RATE = 24000
# v4.3.3: bumped STEPS 16→32 for pitch stability. The cheap-and-fast 16-step
# inference produced audible pitch wobble ("chipmunk for a few words, then
# normal") especially on short utterances. 32 is the F5-TTS reference default.
STEPS = 32
# v4.3.3: neutral speed. Previous 0.87 slowed slightly but also sometimes
# triggered timing artifacts mid-sentence. 1.0 is pass-through.
SPEED = 1.0
CFG_STRENGTH = 1.5
SEED = 42
# v4.3.3: output format + playback-safe sample rate for Messenger. Messenger
# can misinterpret 24kHz WAVs as 16kHz-encoded phone audio → pitch shifted
# 1.5× = "fast + high". MP3 at 44.1kHz embeds unambiguous rate metadata.
OUTPUT_FORMAT = "mp3"
OUTPUT_SAMPLE_RATE = 44100
OUTPUT_BITRATE = "128k"

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


def generate_speech(text, voice="default", output_format=None):
    """Generate speech using F5-TTS PyTorch API with CUDA.

    output_format: 'mp3' (default, Messenger-safe) or 'wav' (raw).
    """
    if output_format is None:
        output_format = OUTPUT_FORMAT
    with _model_lock:
        import numpy as np
        import soundfile as sf

        tts = _get_model()

        # Always find a ref file — F5-TTS requires one
        ref_file = _find_ref_audio(voice) if voice and voice != "default" else None
        ref_text = _find_ref_text(voice) if voice and voice != "default" else None

        # Fallback: if requested voice has no ref, try andrew, then any available voice
        if not ref_file:
            ref_file = _find_ref_audio("andrew")
            ref_text = _find_ref_text("andrew")
        if not ref_file:
            # Last resort: find ANY voice reference
            voices_dir = get_voices_dir()
            for wav in voices_dir.glob("*.wav"):
                ref_file = str(wav)
                txt = voices_dir / f"{wav.stem}.txt"
                ref_text = txt.read_text().strip() if txt.exists() else ""
                break
        if not ref_file:
            raise RuntimeError("No voice reference audio found. Upload a .wav to ~/.titan/voices/")

        print(f"[VoiceClone] Cloning from: {ref_file}, voice={voice}")

        gen_text = text.strip()

        # F5-TTS has a max text length relative to ref audio.
        # Split long text into chunks of ~150 chars, generate each, concatenate.
        MAX_CHUNK = 150
        if len(gen_text) > MAX_CHUNK:
            # Split at sentence boundaries
            sentences = re.split(r'(?<=[.!?])\s+', gen_text)
            chunks = []
            current = ""
            for s in sentences:
                if current and len(current) + len(s) + 1 > MAX_CHUNK:
                    chunks.append(current)
                    current = s
                else:
                    current = (current + " " + s).strip() if current else s
            if current:
                chunks.append(current)

            print(f"[VoiceClone] Split {len(gen_text)} chars into {len(chunks)} chunks")
            all_wav = []
            for i, chunk in enumerate(chunks):
                wav, sr, _ = tts.infer(
                    ref_file=ref_file,
                    ref_text=ref_text or "",
                    gen_text=chunk,
                    speed=SPEED,
                    seed=SEED,
                    nfe_step=STEPS,
                )
                all_wav.append(wav)

            # Concatenate with small silence gap
            silence = np.zeros(int(sr * 0.3), dtype=np.float32)
            combined = []
            for i, w in enumerate(all_wav):
                combined.append(w)
                if i < len(all_wav) - 1:
                    combined.append(silence)
            wav = np.concatenate(combined)
        else:
            wav, sr, _ = tts.infer(
                ref_file=ref_file,
                ref_text=ref_text or "",
                gen_text=gen_text,
                speed=SPEED,
                seed=SEED,
                nfe_step=STEPS,
            )

        # Normalize volume — target peak at -10dB
        peak = np.max(np.abs(wav))
        if peak > 0:
            target_peak = 0.3
            wav = wav * (target_peak / peak)

        # v4.3.3: write WAV at F5-TTS's native rate, then transcode to MP3
        # at 44.1kHz so Messenger / any consumer plays it back at correct
        # pitch regardless of sample-rate heuristics. Keeps a WAV fallback
        # path for callers that explicitly request wav.
        wav_buf = io.BytesIO()
        sf.write(wav_buf, wav, sr, format='WAV', subtype='PCM_16')
        wav_bytes = wav_buf.getvalue()

        if output_format == 'wav':
            return wav_bytes

        # Transcode to MP3 via ffmpeg. ffmpeg is a hard dependency of the
        # voice preprocessing path above, so it's already installed.
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f_in:
            f_in.write(wav_bytes)
            in_path = f_in.name
        with tempfile.NamedTemporaryFile(suffix=f'.{output_format}', delete=False) as f_out:
            out_path = f_out.name
        try:
            cmd = [
                'ffmpeg', '-y', '-i', in_path,
                '-ar', str(OUTPUT_SAMPLE_RATE),
                '-ac', '1',
                '-b:a', OUTPUT_BITRATE,
                '-f', output_format,
                out_path,
            ]
            proc = subprocess.run(cmd, capture_output=True, timeout=30)
            if proc.returncode != 0:
                print(f"[VoiceClone] ffmpeg transcode failed, returning WAV: {proc.stderr[-200:].decode(errors='ignore')}")
                return wav_bytes
            with open(out_path, 'rb') as f:
                return f.read()
        finally:
            for p in (in_path, out_path):
                try:
                    os.unlink(p)
                except OSError:
                    pass


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
            # v4.3.3: per-request format override (defaults to server-wide
            # OUTPUT_FORMAT). Callers that need raw WAV pass response_format='wav'.
            requested_format = (body.get("response_format") or OUTPUT_FORMAT).lower()

            if not text:
                self._json_response(400, {"error": "input is required"})
                return

            print(f'[VoiceClone] Generating: "{text[:120]}" ({len(text)} chars) voice={voice} format={requested_format}')

            import time
            start = time.time()
            audio_bytes = generate_speech(text, voice=voice, output_format=requested_format)
            elapsed = time.time() - start
            print(f"[VoiceClone] Generated {len(audio_bytes)} bytes in {elapsed:.2f}s ({requested_format})")

            content_type = "audio/mpeg" if requested_format == "mp3" else "audio/wav"
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(audio_bytes)))
            self.end_headers()
            self.wfile.write(audio_bytes)

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
