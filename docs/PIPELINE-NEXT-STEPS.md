# TITAN Pipeline — Next Steps
## Follow-up plan after Ultraplan Phase 1-6 completion

**Date**: April 7, 2026
**Completed**: Phases 1-6 of ULTRAPLAN-PIPELINE-EXCELLENCE.md

---

## What's Working Now

| Capability | Status | Evidence |
|-----------|--------|---------|
| Simple tool calls (write/read/shell) | ✅ Reliable | `toolsUsed: ['write_file']` on every test |
| Fabrication detection | ✅ Active | FabricationGuard catches and nudges |
| Content capture (large text → write_file) | ✅ Active | Auto-wraps HTML/code in tool calls |
| ToolRescue (all tools, all models) | ✅ Active | No more skipSet for local models |
| Trajectory compression | ✅ Active | Long results compressed, full saved to disk |
| Auto-verify after writes | ✅ Active | Detects truncated HTML, empty files |
| Progress summaries | ✅ Active | Injected every 4 rounds |
| Dynamic silence timeout | ✅ Active | 180s for autonomous, model-adaptive |
| Deliberation auto-execute | ✅ Active | API calls skip approval gate |
| Schema simplification | ✅ All models | Cleaner JSON for better tool calling |
| Sub-agent depth 4 | ✅ Active | Was 2, now 4 |
| Project-level SOUL.md | ✅ Active | ./SOUL.md overrides global |

## Remaining Pipeline Gaps

### 1. Execute-Code Pattern (from Hermes)
**Problem**: Chaining 5+ tool calls for a complex task is fragile. Each call is a failure point.
**Solution**: Add an `execute_code` tool that lets the model write a Python/bash script that does the work in one shot. The script has access to the filesystem and can make HTTP calls.
**Impact**: Dramatically reduces failure points for multi-step operations.
**Effort**: 3-4 hours

### 2. Skill-from-Experience (from Hermes)
**Problem**: TITAN can't learn from successful task completions to do them better next time.
**Solution**: After a successful multi-step task, auto-generate a reusable skill from the trajectory. Store as a markdown skill file that can be invoked next time.
**Impact**: Self-improving loop — each successful task makes TITAN better.
**Effort**: 4-5 hours

### 3. Tool Result Deduplication
**Problem**: Model calls `read_file("/etc/hostname")` 3 times in a session, wasting tokens.
**Solution**: Cache recent tool results by tool+args hash. Return cached result if same call within 60s.
**Impact**: Saves tokens, prevents redundant I/O.
**Effort**: 1 hour

### 4. Streaming Tool Call Accumulation
**Problem**: When streaming, partial tool call JSON fragments arrive over multiple chunks. If the stream is interrupted, the tool call is lost.
**Solution**: Buffer tool call chunks until complete, with timeout-based flush.
**Impact**: More reliable streaming tool calls.
**Effort**: 2 hours

### 5. Multi-File Write Orchestration
**Problem**: "Create a project with 5 files" requires 5 sequential write_file calls. Model often writes 1-2 then stops.
**Solution**: When task involves multiple files, inject a checklist into context: "Files to create: [x] index.html [ ] style.css [ ] script.js [ ] README.md". Update after each write.
**Impact**: Model tracks its own progress, doesn't forget files.
**Effort**: 2 hours

### 6. Error Recovery with Context
**Problem**: When a tool call fails, the model often doesn't understand WHY and retries the same thing.
**Solution**: Inject structured error analysis: "Tool X failed because: [specific reason]. Previous successful approach for similar errors: [learned resolution]."
**Impact**: Faster error recovery, fewer retry loops.
**Effort**: 2 hours (builds on existing learning.ts)

### 7. Benchmark Suite
**Problem**: No way to measure pipeline reliability across model changes.
**Solution**: Create `scripts/pipeline-benchmark.ts` that runs 20 standardized tasks (simple write, medium HTML, large file, multi-step, read+modify, etc.) and reports success rate per model.
**Impact**: Data-driven pipeline improvement, regression detection.
**Effort**: 3 hours

### 8. RL Training Data Generation (from Hermes/Atropos)
**Problem**: Local models need fine-tuning data specific to TITAN's tool format.
**Solution**: Record successful tool-calling trajectories and export as training data. Use TITAN's existing LoRA training pipeline to fine-tune local models.
**Impact**: Local models get better at TITAN's specific tool format over time.
**Effort**: 4-5 hours

## Priority Order

1. **Execute-Code pattern** — biggest reliability win
2. **Tool Result Deduplication** — quick win, saves tokens
3. **Multi-File Write Orchestration** — common failure mode
4. **Benchmark Suite** — measure before optimizing further
5. **Skill-from-Experience** — self-improving loop
6. **Error Recovery with Context** — faster recovery
7. **Streaming Tool Call Accumulation** — edge case fix
8. **RL Training Data** — long-term model improvement
