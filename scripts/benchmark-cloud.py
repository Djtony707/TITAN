#!/usr/bin/env python3
"""Benchmark Ollama cloud models for chat quality and tool calling reliability."""
import json, time, urllib.request, sys

OLLAMA = "http://localhost:11434"
TOOLS = [
    {"type":"function","function":{"name":"weather","description":"Get current weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}},
    {"type":"function","function":{"name":"shell","description":"Run shell command","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}}
]

MODELS = [
    "qwen3.5:397b-cloud",
    "deepseek-v3.2:cloud",
    "minimax-m2.7:cloud",
    "glm-5:cloud",
    "kimi-k2.5:cloud",
    "qwen3-coder-next:cloud",
    "nemotron-3-super:cloud",
]

def call(model, messages, tools=None, tool_choice=None, timeout=30):
    body = {"model": model, "messages": messages, "stream": False}
    if tools:
        body["tools"] = tools
    if tool_choice:
        body["tool_choice"] = tool_choice
    data = json.dumps(body).encode()
    req = urllib.request.Request(OLLAMA + "/api/chat", data=data, headers={"Content-Type": "application/json"})
    start = time.time()
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        result = json.loads(resp.read())
        elapsed = round(time.time() - start, 1)
        msg = result.get("message", {})
        return {
            "time": elapsed,
            "content": msg.get("content", "")[:80],
            "tool_calls": msg.get("tool_calls", []),
            "ok": True,
        }
    except Exception as e:
        elapsed = round(time.time() - start, 1)
        return {"time": elapsed, "content": str(e)[:60], "tool_calls": [], "ok": False}

print()
print("=" * 100)
print("  OLLAMA CLOUD MODEL BENCHMARK — Chat + Tool Calling + tool_choice:required")
print("=" * 100)
print()

results = []

for m in MODELS:
    short = m.replace(":cloud", "")
    print(f"Testing {short}...")
    sys.stdout.flush()

    # Test 1: Simple chat
    r1 = call(m, [{"role": "user", "content": "What is 2+2? Answer only the number."}])

    # Test 2: Tool calling (auto)
    r2 = call(m, [{"role": "user", "content": "What is the weather in Tokyo right now?"}], tools=TOOLS)

    # Test 3: Forced tool_choice
    r3 = call(m, [{"role": "user", "content": "Run the command: hostname"}], tools=TOOLS, tool_choice="required")

    tc2 = [t["function"]["name"] for t in r2["tool_calls"]] if r2["tool_calls"] else None
    tc3 = [t["function"]["name"] for t in r3["tool_calls"]] if r3["tool_calls"] else None

    results.append({
        "model": short,
        "chat_time": r1["time"],
        "chat_answer": r1["content"][:30],
        "tools_time": r2["time"],
        "tools_called": tc2,
        "tools_text": r2["content"][:30] if not tc2 else "",
        "forced_time": r3["time"],
        "forced_called": tc3,
        "forced_text": r3["content"][:30] if not tc3 else "",
    })

print()
print(f"{'MODEL':<25} {'CHAT':>6} {'ANSWER':<20} {'TOOLS':>6} {'CALLED':<15} {'FORCED':>6} {'CALLED':<15}")
print("-" * 100)

for r in results:
    chat_col = f"{r['chat_time']}s"
    ans_col = r["chat_answer"][:18]
    tools_col = f"{r['tools_time']}s"
    tc_col = str(r["tools_called"] or r["tools_text"][:13])[:13]
    forced_col = f"{r['forced_time']}s"
    fc_col = str(r["forced_called"] or r["forced_text"][:13])[:13]

    print(f"{r['model']:<25} {chat_col:>6} {ans_col:<20} {tools_col:>6} {tc_col:<15} {forced_col:>6} {fc_col:<15}")

print()

# Summary
tool_models = [r["model"] for r in results if r["tools_called"]]
forced_models = [r["model"] for r in results if r["forced_called"]]
fastest = min(results, key=lambda r: r["chat_time"])

print("SUMMARY:")
print(f"  Tool calling works:      {tool_models or 'NONE'}")
print(f"  tool_choice works:       {forced_models or 'NONE'}")
print(f"  Fastest chat:            {fastest['model']} ({fastest['chat_time']}s)")
print(f"  Best for TITAN:          ", end="")

# Pick best: prefers tool_choice support, then tool calling, then fastest
if forced_models:
    best = [r for r in results if r["forced_called"]]
    best.sort(key=lambda r: r["chat_time"])
    print(f"{best[0]['model']} (supports tool_choice, {best[0]['chat_time']}s chat)")
elif tool_models:
    best = [r for r in results if r["tools_called"]]
    best.sort(key=lambda r: r["chat_time"])
    print(f"{best[0]['model']} (calls tools, {best[0]['chat_time']}s chat)")
else:
    print(f"{fastest['model']} (fastest, no tool support)")
