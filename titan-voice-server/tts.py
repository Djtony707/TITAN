"""
TITAN Voice Server — TADA TTS (Hume AI)
0.09 RTF, zero hallucinations, voice cloning via reference WAV files.
"""
import os
import numpy as np
from abc import ABC, abstractmethod
from config import cfg


class TTSEngine(ABC):
    """Base class for TTS engines."""

    @abstractmethod
    def synthesize(self, text: str, voice: str | None = None) -> np.ndarray:
        """Synthesize text to PCM float32 audio at TTS_SAMPLE_RATE."""
        ...

    @abstractmethod
    def stream(self, text: str, voice: str | None = None):
        """Yield audio chunks as they're generated (for streaming)."""
        ...


class TadaTTS(TTSEngine):
    """TADA TTS — Hume AI, 0.09 RTF, zero hallucinations, voice cloning via reference WAV."""

    def __init__(self):
        import torch
        import torchaudio
        from tada.modules.encoder import Encoder
        from tada.modules.tada import TadaForCausalLM

        device = cfg.TTS_DEVICE if cfg.TTS_DEVICE != "cpu" else "cuda"
        # Validate CUDA availability
        if device == "cuda" and not torch.cuda.is_available():
            device = "cpu"
        self._device = device

        self._encoder = Encoder.from_pretrained(
            "HumeAI/tada-codec", subfolder="encoder"
        ).to(self._device)
        self._model = TadaForCausalLM.from_pretrained(
            "HumeAI/tada-1b"
        ).to(self._device)

        # Reference voice WAV files for voice cloning
        self._voices_dir = os.path.expanduser("~/.titan/voices")
        os.makedirs(self._voices_dir, exist_ok=True)
        self._default_voice = cfg.TTS_VOICE or "default"
        self._torch = torch
        self._torchaudio = torchaudio

        # Cache loaded prompts to avoid re-encoding on every call
        self._prompt_cache: dict = {}

    def _get_voice_prompt(self, voice: str):
        """Load reference audio for a voice name, returns encoder prompt."""
        if voice in self._prompt_cache:
            return self._prompt_cache[voice]

        wav_path = os.path.join(self._voices_dir, f"{voice}.wav")
        if not os.path.exists(wav_path):
            wav_path = os.path.join(self._voices_dir, "default.wav")
            if not os.path.exists(wav_path):
                return None  # No reference = model's default voice

        audio, sr = self._torchaudio.load(wav_path)
        audio = audio.to(self._device)
        prompt = self._encoder(audio, text=["reference"], sample_rate=sr)

        self._prompt_cache[voice] = prompt
        return prompt

    def available_voices(self) -> list[str]:
        """List available voice names based on WAV files in voices dir."""
        voices = []
        if os.path.isdir(self._voices_dir):
            import glob
            for f in sorted(glob.glob(os.path.join(self._voices_dir, "*.wav"))):
                name = os.path.splitext(os.path.basename(f))[0]
                voices.append(name)
        return voices if voices else ["default"]

    def synthesize(self, text: str, voice: str | None = None) -> np.ndarray:
        voice = voice or self._default_voice
        prompt = self._get_voice_prompt(voice)

        output = self._model.generate(prompt=prompt, text=text)

        # Extract audio tensor → numpy float32
        audio_tensor = output.audio if hasattr(output, 'audio') else output
        if hasattr(audio_tensor, 'cpu'):
            audio = audio_tensor.cpu().numpy().astype(np.float32)
        else:
            audio = np.array(audio_tensor, dtype=np.float32)

        # Normalize to [-1, 1] if needed
        if audio.max() > 1.0 or audio.min() < -1.0:
            peak = max(abs(audio.max()), abs(audio.min()))
            if peak > 0:
                audio = audio / peak

        # Flatten to 1D if multi-channel
        if audio.ndim > 1:
            audio = audio.squeeze()

        return audio

    def stream(self, text: str, voice: str | None = None):
        """TADA generates full audio in one shot. Yield as single chunk."""
        audio = self.synthesize(text, voice)
        yield audio


def create_tts_engine() -> TTSEngine:
    """Factory: create the TADA TTS engine."""
    return TadaTTS()
