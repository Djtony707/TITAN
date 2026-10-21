# Benchmarks & Performance

Performance characteristics of TITAN (`titan-agent`) measured on typical development hardware.

---

## System Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| Node.js | 22.23.4+ / 24.22.1+ / 26.12.1+ | Supported stable security release lines |
| Disk | ~150MB (npm package) | 500MB+ (with local models) |
| RAM | 512MB | 2GB+ |
| GPU | Not required | NVIDIA GPU for LoRA fine-tuning |
| OS | Linux, macOS, Windows (WSL2) | Linux or macOS |

TITAN has **zero native dependencies** -- it is pure JavaScript/TypeScript. No C++ compilation, no Python runtime, no system libraries required beyond Node.js.

---

## Performance Characteristics

### Gateway Startup

| Metric | Value |
|--------|-------|
| Cold start (first run) | < 2 seconds |
| Warm start (cached) | < 1 second |
| Time to first API response | < 3 seconds from process start |

### Memory Usage

| Scenario | RSS |
|----------|-----|
| Idle gateway (no active sessions) | ~50MB |
| Single active session | ~80MB |
| 10 concurrent sessions | ~150MB |
| Under load (50+ sessions) | ~200MB |
| Peak observed (100+ sessions) | ~300MB |

Memory is stable under sustained load. Sessions are garbage collected after configurable idle timeouts.

### API Response Times

Measured with a local Ollama backend (`devstral-small-2` on RTX 5090):

| Metric | Value |
|--------|-------|
| Simple query (first token, streaming) | < 500ms |
| Simple query (full response) | 1-3 seconds |
| Tool-using query (single tool) | 2-5 seconds |
| Multi-step reasoning (3+ tools) | 5-15 seconds |
| RAG query (FTS5 + embeddings) | < 200ms retrieval + LLM time |

Response times depend heavily on the LLM provider and model. Cloud providers (OpenAI, Anthropic, etc.) add network latency.

### Concurrency

| Metric | Value |
|--------|-------|
| Concurrent sessions tested | 100+ |
| Concurrent API requests (throughput) | Limited by LLM backend |
| WebSocket connections | 1000+ (Node.js default) |
| Channel adapters running simultaneously | All 15 tested concurrently |

TITAN itself is not the bottleneck -- throughput is determined by the LLM provider's capacity.

---

## Test Suite

| Metric | Value |
|--------|-------|
| Total tests | 3,839 |
| Test files | 123 |
| Framework | Vitest |
| Full suite runtime | ~15 seconds |
| Test coverage | Skills, tools, providers, channels, API, mesh |

All tests run without network access or GPU. No external services required.

---

## Codebase Stats

| Metric | Value |
|--------|-------|
| Lines of TypeScript | ~40,000 |
| Test files | 123 |
| Tests | 3,839 |
| Skills | 91 |
| Tools | ~149 |
| LLM providers | 34 (4 native + 30 OpenAI-compatible) |
| Channel adapters | 15 |
| Native dependencies | 0 |

---

## How to Run Your Own Benchmarks

### Startup Time

```bash
# Measure cold start time
time node dist/cli/index.js gateway &

# Wait for ready, then stop
sleep 3 && kill %1
```

### Memory Usage

```bash
# Start the gateway
node dist/cli/index.js gateway &

# Check stats via API
node -e "fetch('http://localhost:48420/api/stats').then(r=>r.json()).then(console.log)"

# Or check process memory directly
ps aux | grep titan | grep -v grep
```

### API Latency

```bash
# Simple query (measure time to full response)
time curl -s -X POST http://localhost:48420/api/message \
  -H "Content-Type: application/json" \
  -d '{"content": "What is 2+2?"}'

# Streaming (measure time to first token)
curl -w "\nTime to first byte: %{time_starttransfer}s\n" \
  -X POST http://localhost:48420/api/message \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"content": "What is 2+2?"}'
```

### Test Suite

```bash
# Full test suite with timing
time npx vitest run

# Specific test file
time npx vitest run src/skills/builtin/web.test.ts

# With coverage
npx vitest run --coverage
```

### Concurrent Load

```bash
# Send 50 concurrent requests
for i in $(seq 1 50); do
  curl -s -X POST http://localhost:48420/api/message \
    -H "Content-Type: application/json" \
    -d "{\"content\": \"Hello $i\", \"sessionId\": \"bench-$i\"}" &
done
wait
```

---

## Environment Used for Reference Numbers

The numbers in this document were measured on:

- **CPU**: Intel i9-14900KF
- **RAM**: 64GB DDR5-6000
- **GPU**: NVIDIA RTX 5090 (32GB VRAM)
- **Storage**: NVMe SSD
- **OS**: Linux (Ubuntu)
- **Node.js**: v22 LTS
- **LLM Backend**: Ollama with `devstral-small-2`

Your results will vary based on hardware, LLM provider, model size, and network conditions. The gateway itself is lightweight -- performance is dominated by the LLM backend.
