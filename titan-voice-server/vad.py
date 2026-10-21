"""
TITAN Voice Server — Silero VAD wrapper
Detects speech start/end in streaming audio chunks.
"""
import numpy as np
import torch
import time
from config import cfg

# Load model once at module level
_vad_model = None
MAX_UTTERANCE_SAMPLES = 30 * cfg.STT_SAMPLE_RATE

def _get_model():
    global _vad_model
    if _vad_model is None:
        _vad_model, _ = torch.hub.load(
            repo_or_dir="snakers4/silero-vad",
            model="silero_vad",
            trust_repo=True,
        )
    return _vad_model


class VoiceActivityDetector:
    """Silero VAD with configurable silence threshold for speech segmentation."""

    def __init__(self):
        self.model = _get_model()
        self.is_speaking = False
        self._silence_start: float | None = None
        self._audio_buffer: list[np.ndarray] = []
        self._speech_buffer: list[np.ndarray] = []
        self._speech_samples = 0

    def reset(self):
        """Reset VAD state for a new session."""
        self.model.reset_states()
        self.is_speaking = False
        self._silence_start = None
        self._audio_buffer.clear()
        self._speech_buffer.clear()
        self._speech_samples = 0

    def _append_speech(self, window):
        self._speech_samples += len(window)
        if self._speech_samples > MAX_UTTERANCE_SAMPLES:
            self.reset()
            raise ValueError("Voice utterance exceeds 30 seconds.")
        self._speech_buffer.append(window)

    def process_chunk(self, pcm: bytes) -> dict:
        """
        Process a raw PCM chunk (16kHz, 16-bit, mono).

        Returns dict with:
          - speaking: bool (current VAD state)
          - speech_end: bool (transition from speaking to silence)
          - audio: np.ndarray | None (complete utterance audio when speech_end=True)
        """
        samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0

        # Silero expects 512-sample chunks at 16kHz (32ms)
        chunk_size = 512
        result = {"speaking": self.is_speaking, "speech_end": False, "audio": None}

        for i in range(0, len(samples), chunk_size):
            window = samples[i : i + chunk_size]
            if len(window) < chunk_size:
                window = np.pad(window, (0, chunk_size - len(window)))

            tensor = torch.from_numpy(window)
            prob = self.model(tensor, cfg.STT_SAMPLE_RATE).item()

            if prob >= cfg.VAD_THRESHOLD:
                # Speech detected
                if not self.is_speaking:
                    self.is_speaking = True
                    self._speech_buffer.extend(self._audio_buffer)
                    self._speech_samples = sum(len(part) for part in self._speech_buffer)
                    self._audio_buffer.clear()
                self._silence_start = None
                self._append_speech(window)
                result["speaking"] = True
            else:
                if self.is_speaking:
                    self._append_speech(window)
                    if self._silence_start is None:
                        self._silence_start = time.monotonic()
                    elif (time.monotonic() - self._silence_start) * 1000 >= cfg.VAD_SILENCE_MS:
                        # Silence threshold exceeded — speech ended
                        self.is_speaking = False
                        self._silence_start = None
                        result["speaking"] = False
                        result["speech_end"] = True
                        result["audio"] = np.concatenate(self._speech_buffer)
                        self._speech_buffer.clear()
                        self._speech_samples = 0
                        self.model.reset_states()
                else:
                    # Keep a small rolling buffer for pre-speech context
                    self._audio_buffer.append(window)
                    if len(self._audio_buffer) > 10:
                        self._audio_buffer.pop(0)

        return result
