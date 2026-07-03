# TITAN Model Benchmark — July 2026 (v7.0 harness)

**What's different from the March benchmark below:** this run tests models *as TITAN's brain* — every case runs through the full v7.0 agent loop (system prompt, ~248 tools, widget gates, safety refusals) and is scored by the deterministic eval harness (`src/eval/harness.ts`), not by LLM-judged vibes. 5 suites × 27 cases per model: tool-routing-v2, widget-v2, gate-format-v2, safety, content. Per-suite cap 7 min. Local models ran on the machines named; cloud models via API routes. Single run per model, July 3 2026.

## Overall Rankings — v7.0 harness

| Rank | Model | Where | Harness pass | Median case | Safety | Notes |
|------|-------|-------|-------------|-------------|--------|-------|
| 🥇 cloud | **GLM-5.1** | cloud API | **25/27 (93%)** | 4.6s | ✅ 2/2 | Best cloud: top score AND fastest cloud median |
| 🥇 cloud (tie) | **Kimi K2.6** | cloud API | **25/27 (93%)** | 7.6s | ✅ 2/2 | Same score, ~1.7× slower per case |
| 🥈 cloud | DeepSeek V4 Pro | cloud API | 23/27 (85%) | 5.6s | ❌ 0/2 | Strong tools/widgets, **failed both safety refusals** |
| 🥇 local | **Qwen3 Coder Next** | RTX 5090 (vLLM/llama-swap) | **20/27 (74%)** | **4.2s** | ❌ 0/2 | Best local by a mile — and fastest median overall |
| — | Qwen3 30B A3B | RTX 5090 | 3/5 (3 suites DNF) | 22.8s | ✅ 2/2 | **Context overflow**: TITAN's harness prompt exceeds its 32k deployment — 3 of 5 suites timed out |
| — | Nemotron-3 Nano 30B | GX10 / DGX Spark (NVFP4 vLLM) | 4/27 (15%) | 27.8s | ❌ 0/2 | Responds but rarely drives tools correctly through the harness |
| — | GLM-4.7-Flash | GX10 / DGX Spark (NVFP4 vLLM) | 4/27 (15%) | 29.1s | ❌ 0/2 | Same pattern — great chat model, weak TITAN driver at this deployment |
| — | Qwen3.6 35B A3B | RTX 5090 | 1/8 (2 suites DNF) | 60.4s | ❌ 0/2 | Slow + overflow-prone under the full harness |
| DNF | Andy-4 | RTX 5090 | 0 (all suites timed out) | — | — | Never produced completions under the harness — deployment/config issue |
| DNF | Ornith-1.0 9B | GX10 (Ollama q8) | 0 (all suites timed out) | — | — | 9B + full TITAN toolset = no answer within the cap |

## Recommendations

- **Best local (the default we'd ship): `qwen3-coder-next`** on an RTX 5090-class GPU. 74% harness pass at the fastest median case time of ANY model tested, including cloud. This is what TITAN's staging runs.
- **Best cloud: `glm-5.1`**, with **`kimi-k2.6`** an equal-scoring alternative if you prefer its style — both aced widgets, gates, content AND both safety refusals. GLM is ~40% faster per case.
- **Watch out for DeepSeek V4 Pro as a daily driver**: excellent tool work (85%) but it complied with both safety-suite requests that should be refused.
- **Context matters more than parameter count.** Qwen3 30B and Qwen3.6 35B are *good models* that DNF'd because their deployments (32k-class contexts) can't hold TITAN's full ~248-tool prompt. If you run mid-size models, either raise the deployment context or slim the toolset — otherwise pick `qwen3-coder-next`-class models with big contexts.
- **Quantized MoE ≠ agent-ready.** The GX10's NVFP4 deployments (GLM-4.7-Flash, Nemotron Nano) chat beautifully but scored 15% as TITAN drivers — tool-call formatting through an agent harness is a different skill than conversation. Benchmark YOUR deployment, not the model card.

## Honest caveats

- Single run per model; deterministic assertions (no LLM judging), so scores are strict — a "failure" can be a formatting miss, not stupidity.
- The two tool-routing cases missed by ALL top models (6/8 ceiling) look harness-strict rather than model-specific.
- DNF rows say as much about the *deployment* (context size, quant, server config) as the model.
- Reproduce: `POST /api/eval/run {"suite": "tool-routing-v2"}` against your own gateway after `POST /api/model/switch` — the whole run is ~40 lines of shell (`benchmarks/` has the harness docs).

---

# TITAN Model Benchmark — March 2026

Comprehensive model comparison testing 15 LLMs through TITAN's unified gateway. Each model was tested with 25 prompts across 7 categories, scored 0-10 per prompt. Cloud models were accessed via Ollama's cloud API; local models ran on Ollama with an NVIDIA RTX 5090 (32GB VRAM).

## Overall Rankings

| Rank | Model | Score | Grade | Avg Latency | Type | Tests | Best Category |
|------|-------|-------|-------|-------------|------|-------|---------------|
| 1 | **GLM-5** | 8.51/10 | 🥈 A- | 12.3s | cloud | 25/25 | code (9.75) |
| 2 | **Devstral Small 2** | 8.46/10 | 🥉 B+ | 5.3s | local (15GB) | 7/25 * | code (9.83) |
| 3 | **Qwen3 Coder Next** | 8.41/10 | 🥉 B+ | 3.5s | cloud | 25/25 | tool (10.0) |
| 4 | **GLM-4.7** | 8.39/10 | 🥉 B+ | 16.1s | cloud | 25/25 | code (9.75) |
| 5 | **Qwen 3.5 35B** | 8.29/10 | 🥉 B+ | 11.7s | local (23GB) | 25/25 | tool (9.67) |
| 6 | **Nemotron 3 Nano 24B** | 8.29/10 | 🥉 B+ | 7.0s | local (24GB) | 25/25 | tool (9.67) |
| 7 | **Nemotron 3 Nano 4B** | 8.29/10 | 🥉 B+ | 2.3s | local (2.8GB) | 25/25 | tool (9.67) |
| 8 | **MiniMax M2** | 8.27/10 | 🥉 B+ | 10.2s | cloud | 25/25 | tool (10.0) |
| 9 | **Nemotron 3 Super** | 8.21/10 | 🥉 B+ | 13.0s | cloud | 25/25 | tool (9.67) |
| 10 | **Kimi K2.5** | 8.17/10 | 🥉 B+ | 12.4s | cloud | 25/25 | tool (10.0) |
| 11 | **Qwen 3.5 397B** | 8.01/10 | 🥉 B+ | 9.4s | cloud | 25/25 | code (9.62) |
| 12 | **MiniMax M2.7** | 7.87/10 | ✅ B | 24.8s | cloud | 25/25 | code (9.5) |
| 13 | **DeepSeek V3.1 671B** | 7.73/10 | ✅ B | 8.9s | cloud | 25/25 | code (9.62) |
| 14 | **DeepSeek V3.2** | 7.61/10 | ✅ B | 22.8s | cloud | 25/25 | code (9.62) |
| 15 | **Gemini 3 Flash Preview** | 7.55/10 | ✅ B | 4.9s | cloud | 25/25 | code (9.75) |

> \* Devstral Small 2 has partial data (7 completed tests out of 25). Its ranking reflects only available results.

## Category Breakdown

### Reasoning

| Rank | Model | Avg Score | Avg Latency | Scores |
|------|-------|-----------|-------------|--------|
| 1 | DeepSeek V3.1 671B | **7.42**/10 | 6.6s | 10.0, 7.0, 5.7, 7.0 |
| 2 | Devstral Small 2 | **7.42**/10 | 5.3s | 8.0, 6.0, 5.7, 10.0 |
| 3 | GLM-5 | **7.17**/10 | 5.9s | 9.0, 7.0, 5.7, 7.0 |
| 4 | GLM-4.7 | **7.17**/10 | 7.3s | 9.0, 7.0, 5.7, 7.0 |
| 5 | Qwen3 Coder Next | **7.17**/10 | 2.4s | 9.0, 7.0, 5.7, 7.0 |
| 6 | Qwen 3.5 35B | **7.17**/10 | 10.5s | 9.0, 7.0, 5.7, 7.0 |
| 7 | Nemotron 3 Nano 24B | **7.17**/10 | 4.7s | 9.0, 7.0, 5.7, 7.0 |
| 8 | Nemotron 3 Nano 4B | **7.17**/10 | 1.7s | 9.0, 7.0, 5.7, 7.0 |
| 9 | Kimi K2.5 | **6.92**/10 | 5.4s | 10.0, 7.0, 3.7, 7.0 |
| 10 | DeepSeek V3.2 | **6.67**/10 | 37.2s | 7.0, 7.0, 5.7, 7.0 |
| 11 | Qwen 3.5 397B | **6.67**/10 | 10.1s | 9.0, 7.0, 3.7, 7.0 |
| 12 | Gemini 3 Flash Preview | **6.67**/10 | 3.8s | 7.0, 7.0, 5.7, 7.0 |
| 13 | Nemotron 3 Super | **6.42**/10 | 17.4s | 8.0, 7.0, 3.7, 7.0 |
| 14 | MiniMax M2.7 | **6.17**/10 | 35.0s | 8.0, 5.0, 4.7, 7.0 |
| 15 | MiniMax M2 | **6.08**/10 | 11.1s | 6.0, 7.0, 4.3, 7.0 |

### Code

| Rank | Model | Avg Score | Avg Latency | Scores |
|------|-------|-----------|-------------|--------|
| 1 | Devstral Small 2 | **9.83**/10 | 5.2s | 10.0, 10.0, 9.5 |
| 2 | GLM-5 | **9.75**/10 | 29.2s | 10.0, 10.0, 9.5, 9.5 |
| 3 | GLM-4.7 | **9.75**/10 | 19.9s | 10.0, 10.0, 9.5, 9.5 |
| 4 | Gemini 3 Flash Preview | **9.75**/10 | 7.3s | 10.0, 10.0, 9.5, 9.5 |
| 5 | MiniMax M2 | **9.62**/10 | 15.6s | 9.5, 10.0, 9.5, 9.5 |
| 6 | DeepSeek V3.2 | **9.62**/10 | 55.0s | 9.5, 10.0, 9.5, 9.5 |
| 7 | DeepSeek V3.1 671B | **9.62**/10 | 23.2s | 10.0, 10.0, 9.0, 9.5 |
| 8 | Kimi K2.5 | **9.62**/10 | 18.8s | 10.0, 9.5, 9.5, 9.5 |
| 9 | Qwen3 Coder Next | **9.62**/10 | 6.7s | 10.0, 10.0, 9.0, 9.5 |
| 10 | Nemotron 3 Super | **9.62**/10 | 27.2s | 9.5, 10.0, 9.5, 9.5 |
| 11 | Qwen 3.5 397B | **9.62**/10 | 9.4s | 10.0, 9.5, 9.5, 9.5 |
| 12 | Qwen 3.5 35B | **9.62**/10 | 8.6s | 10.0, 10.0, 9.0, 9.5 |
| 13 | Nemotron 3 Nano 4B | **9.62**/10 | 4.0s | 10.0, 9.5, 9.5, 9.5 |
| 14 | MiniMax M2.7 | **9.5**/10 | 46.2s | 10.0, 9.5, 9.0, 9.5 |
| 15 | Nemotron 3 Nano 24B | **9.38**/10 | 7.2s | 9.5, 9.5, 9.0, 9.5 |

### Math

| Rank | Model | Avg Score | Avg Latency | Scores |
|------|-------|-----------|-------------|--------|
| 1 | GLM-5 | **7.25**/10 | 12.5s | 7.0, 5.0, 10.0, 7.0 |
| 2 | Nemotron 3 Super | **7.0**/10 | 10.7s | 7.0, 5.0, 10.0, 6.0 |
| 3 | MiniMax M2 | **6.75**/10 | 16.2s | 6.0, 5.0, 9.0, 7.0 |
| 4 | MiniMax M2.7 | **6.5**/10 | 12.2s | 4.0, 7.0, 9.0, 6.0 |
| 5 | Qwen3 Coder Next | **6.5**/10 | 3.0s | 6.0, 5.0, 9.0, 6.0 |
| 6 | DeepSeek V3.2 | **6.25**/10 | 12.2s | 6.0, 4.0, 9.0, 6.0 |
| 7 | Nemotron 3 Nano 24B | **6.25**/10 | 2.0s | 5.0, 5.0, 9.0, 6.0 |
| 8 | GLM-4.7 | **6.0**/10 | 18.1s | 7.0, 5.0, 5.0, 7.0 |
| 9 | DeepSeek V3.1 671B | **6.0**/10 | 7.4s | 7.0, 5.0, 5.0, 7.0 |
| 10 | Gemini 3 Flash Preview | **6.0**/10 | 4.8s | 7.0, 5.0, 5.0, 7.0 |
| 11 | Qwen 3.5 35B | **6.0**/10 | 11.3s | 7.0, 5.0, 5.0, 7.0 |
| 12 | Nemotron 3 Nano 4B | **6.0**/10 | 1.4s | 4.0, 5.0, 9.0, 6.0 |
| 13 | Qwen 3.5 397B | **5.75**/10 | 11.1s | 7.0, 5.0, 5.0, 6.0 |
| 14 | Kimi K2.5 | **5.25**/10 | 8.2s | 6.0, 5.0, 4.0, 6.0 |

### Tool

| Rank | Model | Avg Score | Avg Latency | Scores |
|------|-------|-----------|-------------|--------|
| 1 | MiniMax M2 | **10.0**/10 | 7.7s | 10.0, 10.0, 10.0 |
| 2 | Kimi K2.5 | **10.0**/10 | 13.2s | 10.0, 10.0, 10.0 |
| 3 | Qwen3 Coder Next | **10.0**/10 | 7.6s | 10.0, 10.0, 10.0 |
| 4 | GLM-5 | **9.67**/10 | 7.6s | 9.0, 10.0, 10.0 |
| 5 | GLM-4.7 | **9.67**/10 | 33.2s | 9.0, 10.0, 10.0 |
| 6 | Nemotron 3 Super | **9.67**/10 | 15.4s | 9.0, 10.0, 10.0 |
| 7 | Qwen 3.5 35B | **9.67**/10 | 21.1s | 9.0, 10.0, 10.0 |
| 8 | Nemotron 3 Nano 24B | **9.67**/10 | 29.4s | 9.0, 10.0, 10.0 |
| 9 | Nemotron 3 Nano 4B | **9.67**/10 | 4.6s | 9.0, 10.0, 10.0 |
| 10 | Qwen 3.5 397B | **7.67**/10 | 6.2s | 10.0, 3.0, 10.0 |
| 11 | MiniMax M2.7 | **6.33**/10 | 28.1s | 10.0, 0, 9.0 |
| 12 | DeepSeek V3.1 671B | **4.0**/10 | 5.9s | 1.0, 10.0, 1.0 |
| 13 | DeepSeek V3.2 | **3.67**/10 | 4.1s | 1.0, 9.0, 1.0 |
| 14 | Gemini 3 Flash Preview | **3.0**/10 | 2.9s | 9.0, 0, 0 |

### Instruct

| Rank | Model | Avg Score | Avg Latency | Scores |
|------|-------|-----------|-------------|--------|
| 1 | Gemini 3 Flash Preview | **8.75**/10 | 4.0s | 9.0, 9.0, 8.0, 9.0 |
| 2 | MiniMax M2.7 | **8.5**/10 | 8.8s | 9.0, 8.0, 8.0, 9.0 |
| 3 | MiniMax M2 | **8.5**/10 | 3.6s | 9.0, 8.0, 8.0, 9.0 |
| 4 | GLM-5 | **8.5**/10 | 3.1s | 9.0, 8.0, 8.0, 9.0 |
| 5 | GLM-4.7 | **8.5**/10 | 11.0s | 9.0, 8.0, 8.0, 9.0 |
| 6 | DeepSeek V3.2 | **8.5**/10 | 8.7s | 9.0, 8.0, 8.0, 9.0 |
| 7 | DeepSeek V3.1 671B | **8.5**/10 | 3.7s | 9.0, 8.0, 8.0, 9.0 |
| 8 | Kimi K2.5 | **8.5**/10 | 4.4s | 9.0, 8.0, 8.0, 9.0 |
| 9 | Qwen3 Coder Next | **8.5**/10 | 1.6s | 9.0, 8.0, 8.0, 9.0 |
| 10 | Nemotron 3 Super | **8.5**/10 | 3.1s | 9.0, 8.0, 8.0, 9.0 |
| 11 | Qwen 3.5 397B | **8.5**/10 | 3.7s | 9.0, 8.0, 8.0, 9.0 |
| 12 | Qwen 3.5 35B | **8.5**/10 | 6.1s | 9.0, 8.0, 8.0, 9.0 |
| 13 | Nemotron 3 Nano 24B | **8.5**/10 | 4.4s | 9.0, 8.0, 8.0, 9.0 |
| 14 | Nemotron 3 Nano 4B | **8.5**/10 | 1.0s | 9.0, 8.0, 8.0, 9.0 |

### Creative

| Rank | Model | Avg Score | Avg Latency | Scores |
|------|-------|-----------|-------------|--------|
| 1 | MiniMax M2.7 | **9.33**/10 | 34.1s | 9.0, 9.0, 10.0 |
| 2 | MiniMax M2 | **9.33**/10 | 10.4s | 9.0, 9.0, 10.0 |
| 3 | GLM-4.7 | **9.33**/10 | 14.2s | 9.0, 9.0, 10.0 |
| 4 | DeepSeek V3.2 | **9.33**/10 | 27.1s | 9.0, 9.0, 10.0 |
| 5 | DeepSeek V3.1 671B | **9.33**/10 | 7.5s | 9.0, 9.0, 10.0 |
| 6 | Kimi K2.5 | **9.33**/10 | 34.2s | 9.0, 9.0, 10.0 |
| 7 | Qwen3 Coder Next | **9.33**/10 | 2.0s | 9.0, 9.0, 10.0 |
| 8 | Qwen 3.5 397B | **9.33**/10 | 16.4s | 9.0, 9.0, 10.0 |
| 9 | Gemini 3 Flash Preview | **9.33**/10 | 6.3s | 9.0, 9.0, 10.0 |
| 10 | Qwen 3.5 35B | **9.33**/10 | 19.6s | 9.0, 9.0, 10.0 |
| 11 | Nemotron 3 Nano 24B | **9.33**/10 | 2.8s | 9.0, 9.0, 10.0 |
| 12 | Nemotron 3 Nano 4B | **9.33**/10 | 1.7s | 9.0, 9.0, 10.0 |
| 13 | GLM-5 | **8.67**/10 | 17.1s | 7.0, 9.0, 10.0 |
| 14 | Nemotron 3 Super | **8.33**/10 | 9.3s | 8.0, 7.0, 10.0 |

### Summary

| Rank | Model | Avg Score | Avg Latency | Scores |
|------|-------|-----------|-------------|--------|
| 1 | MiniMax M2.7 | **9.0**/10 | 9.0s | 9.0, 8.0, 10.0 |
| 2 | GLM-5 | **9.0**/10 | 10.0s | 9.0, 8.0, 10.0 |
| 3 | GLM-4.7 | **9.0**/10 | 11.7s | 9.0, 8.0, 10.0 |
| 4 | DeepSeek V3.2 | **9.0**/10 | 7.6s | 9.0, 8.0, 10.0 |
| 5 | DeepSeek V3.1 671B | **9.0**/10 | 6.0s | 9.0, 8.0, 10.0 |
| 6 | Qwen 3.5 397B | **9.0**/10 | 9.9s | 9.0, 8.0, 10.0 |
| 7 | Gemini 3 Flash Preview | **9.0**/10 | 4.0s | 9.0, 8.0, 10.0 |
| 8 | MiniMax M2 | **8.33**/10 | 4.6s | 7.0, 8.0, 10.0 |
| 9 | Kimi K2.5 | **8.33**/10 | 6.8s | 7.0, 8.0, 10.0 |
| 10 | Qwen3 Coder Next | **8.33**/10 | 1.6s | 7.0, 8.0, 10.0 |
| 11 | Nemotron 3 Super | **8.33**/10 | 5.9s | 7.0, 8.0, 10.0 |
| 12 | Qwen 3.5 35B | **8.33**/10 | 8.4s | 7.0, 8.0, 10.0 |
| 13 | Nemotron 3 Nano 24B | **8.33**/10 | 1.7s | 7.0, 8.0, 10.0 |
| 14 | Nemotron 3 Nano 4B | **8.33**/10 | 1.6s | 7.0, 8.0, 10.0 |

## Notable Issues

| Model | Test | Issue |
|-------|------|-------|
| MiniMax M2.7 | tool-02 | Timeout (120s) |
| DeepSeek V3.2 | tool-01 | Score 1/10 (tool format issue) |
| DeepSeek V3.2 | tool-03 | Score 1/10 (tool format issue) |
| DeepSeek V3.1 671B | tool-01 | Score 1/10 (tool format issue) |
| DeepSeek V3.1 671B | tool-03 | Score 1/10 (tool format issue) |
| Gemini 3 Flash Preview | tool-02 | HTTP 500 (Ollama function_response error) |
| Gemini 3 Flash Preview | tool-03 | HTTP 500 (Ollama function_response error) |
| Qwen 3.5 397B | tool-02 | Score 3/10 (tool format issue) |
| Devstral Small 2 | — | Data truncated after 7 tests |

## Key Takeaways

1. **Top Overall**: GLM-5 (8.51/10, A-) — fastest cloud model with the highest score across all categories.
2. **Best Local Model**: Qwen 3.5 35B (8.29/10, B+) — runs entirely local at 23GB VRAM.
3. **Best Value**: Nemotron 3 Nano 4B (8.29/10, B+) — only 2.8GB VRAM, competitive with models 10x its size.
4. **Hardest Category**: Math — every model struggled here, with averages well below other categories.
5. **Tool Use**: DeepSeek models (V3.1 and V3.2) scored poorly on tool-01 and tool-03, suggesting TITAN's tool format may need adapter work for DeepSeek. Gemini had HTTP 500 errors on multi-step tool calls.
6. **Fastest Cloud Model**: Qwen3 Coder Next at 3.5s average latency.
7. **Fastest Local Model**: Nemotron 3 Nano 4B at 2.3s average latency (2.8GB).

## Methodology

- **Gateway**: TITAN v2026.10.45
- **Hardware**: NVIDIA RTX 5090 (32GB VRAM)
- **Prompts**: 25 total across 7 categories (reasoning ×4, code ×4, math ×4, tool ×3, instruct ×4, creative ×3, summary ×3)
- **Scoring**: Each prompt scored 0-10 by TITAN's built-in evaluator
- **Timeout**: 120 seconds per request
- **Errors**: Timeouts and HTTP errors counted as 0/10
- **Local models**: Served via Ollama on the same RTX 5090
- **Cloud models**: Accessed through TITAN's provider abstraction layer
