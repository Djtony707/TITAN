FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Keep operator .env.local and other private build-context files out of image layers.
COPY agent.py kokoro_tts.py validate_livekit.py ./

# LiveKit credentials must be supplied privately by the operator.
ENV LIVEKIT_URL=ws://localhost:7880

CMD ["python", "agent.py", "start"]
