"""
TITAN Voice Server — Environment-based configuration
"""
import os


class Config:
    """All settings from environment variables with sensible defaults."""

    # TITAN gateway
    TITAN_API_URL: str = os.getenv("TITAN_API_URL", "http://localhost:48420/api/message")
    TITAN_AUTH_TOKEN: str = os.getenv("TITAN_AUTH_TOKEN", "")

    # STT (faster-whisper)
    STT_MODEL: str = os.getenv("STT_MODEL", "large-v3-turbo")
    STT_DEVICE: str = os.getenv("STT_DEVICE", "cuda")
    STT_COMPUTE_TYPE: str = os.getenv("STT_COMPUTE_TYPE", "float16")

    # TTS engine: tada (Hume AI TADA)
    TTS_ENGINE: str = os.getenv("TTS_ENGINE", "tada")
    TTS_VOICE: str = os.getenv("TTS_VOICE", "default")
    TTS_DEVICE: str = os.getenv("TTS_DEVICE", "cpu")

    # VAD (Silero)
    VAD_THRESHOLD: float = float(os.getenv("VAD_THRESHOLD", "0.5"))
    VAD_SILENCE_MS: int = int(os.getenv("VAD_SILENCE_MS", "600"))

    # Server
    HOST: str = os.getenv("HOST", "0.0.0.0")
    PORT: int = int(os.getenv("PORT", "48421"))

    # Audio
    STT_SAMPLE_RATE: int = 16000
    TTS_SAMPLE_RATE: int = 24000

    # Model cache directory
    MODEL_DIR: str = os.getenv("MODEL_DIR", "/app/models")


cfg = Config()
