# System Prompt Research: Reliable Tool Calling for LLM Agents

> Research date: March 14, 2026
> Purpose: Inform the rewrite of TITAN's core system prompt for reliable tool use, especially with local/open-source models via Ollama.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [The Tool-Use vs Text-Generation Problem](#the-tool-use-vs-text-generation-problem)
3. [Common Failure Modes](#common-failure-modes)
4. [Proven Prompting Patterns for Tool Use](#proven-prompting-patterns-for-tool-use)
5. [System Prompt Structure Best Practices](#system-prompt-structure-best-practices)
6. [Model-Specific Quirks](#model-specific-quirks)
7. [Agent Framework System Prompts](#agent-framework-system-prompts)
8. [Constrained Decoding and Structured Output](#constrained-decoding-and-structured-output)
9. [Recommendations for TITAN](#recommendations-for-titan)
10. [Sources](#sources)

---

## Executive Summary

### Key Findings

1. **Tool calling is probabilistic, not deterministic.** The model's decision to call a tool is shaped by prompts, schema definitions, and `tool_choice` settings, but it is never guaranteed. Treat tool calling as a distributed systems problem, not a pure ML problem.

2. **System prompt structure matters more than length.** The "lost in the middle" phenomenon means models attend most strongly to the beginning and end of prompts. Critical tool-use instructions must go at the top and be repeated at the bottom.

3. **Three simple instructions boosted OpenAI's internal benchmarks by ~20%**: (a) persistence (you are in a multi-turn loop), (b) tool-calling (use tools, do NOT guess), (c) planning (plan before each call, reflect on results).

4. **Few-shot examples are the single highest-impact technique** for improving tool-calling reliability. Even 2-3 well-chosen examples dramatically improve performance. Message-format examples outperform string-format examples.

5. **Qwen 3.5 has critical tool-calling issues in Ollama** (as of March 2026). It was trained on the Qwen3-Coder XML format, but Ollama wires it to the Hermes JSON format. The fix exists in Ollama's codebase but is not yet properly mapped for Qwen 3.5.

6. **Tool descriptions are more important than system prompt instructions** for tool selection accuracy. Clear, specific, unambiguous tool descriptions with explicit "when to use" and "when NOT to use" guidance are critical.

7. **Keep system prompts under 5-10% of total context window.** Beyond that, instruction-following degrades due to attention dilution and conflicting instructions.

### Top Recommendations for TITAN

- Restructure the system prompt: identity/role first, tool-use mandate second, behavioral rules third, dynamic context last
- Add 2-3 few-shot tool-use examples as messages (not embedded in the system prompt string)
- Use `tool_choice: "required"` for the first round when the user's intent clearly requires a tool
- Improve every tool description with explicit "when to use" guidance
- Add a ReAct-style thinking step before tool calls for complex tasks
- Implement tool-call validation with descriptive error feedback for self-correction
- For Qwen 3.5 specifically: validate the tool call format (XML vs JSON) and use the correct parser

---

## The Tool-Use vs Text-Generation Problem

### Why Models Default to Text

LLMs are fundamentally text generators. Tool calling is a learned behavior layered on top through fine-tuning and prompt engineering. When the model is uncertain, it defaults to its strongest capability: generating plausible-sounding text.

The model uses three primary decision signals when choosing whether to call a tool:

1. **User request** -- Does the query imply an action or information retrieval?
2. **Tool descriptions in context** -- Do the available tools match the user's need?
3. **System instructions** -- Does the prompt explicitly direct tool use?

When any of these signals are weak or ambiguous, the model falls back to text generation.

### The Core Tension

Tool calling requires the model to:
- Recognize that a tool is needed (classification)
- Select the correct tool (retrieval/matching)
- Construct valid arguments (structured generation)
- Pause its text generation to emit a structured call

Each of these steps is a potential failure point. The model must suppress its natural text-generation behavior in favor of structured output -- this is inherently fragile.

### Key Insight from Research

> "The decision to call a tool is still probabilistic; you shape it with prompts, schema, and tool_choice, but you don't program it like a deterministic rules engine."
> -- "The Anatomy of Tool Calling in LLMs" (martinuke0, Jan 2026)

LLMs do NOT actually call functions. Software layers wrap around the model to parse structured output into function calls, execute them, and feed results back. Understanding this is critical for debugging.

---

## Common Failure Modes

### 1. Model Generates Text Instead of Tool Calls

**Symptoms**: The model describes what it would do instead of doing it. "I would use the search tool to..." or "You can check this by..."

**Causes**:
- Vague system prompt that suggests rather than mandates tool use
- Tool descriptions that don't clearly match the user's request
- Too many tools creating decision paralysis (50+ tools in context)
- Long context diluting tool-use instructions
- Model was not fine-tuned for tool calling (or using the wrong chat template)

**Mitigations**:
- Use explicit mandates: "You MUST use tools. NEVER describe what could be done."
- Use `tool_choice: "required"` when appropriate
- Implement tool search/discovery to keep active tool count manageable
- Place tool-use instructions at the top AND bottom of the system prompt

### 2. Invalid Tool Call Generation

**Symptoms**: Malformed JSON, hallucinated parameter names, wrong types, missing required fields.

**Causes**:
- Complex input schemas that exceed the model's structured generation ability
- Vague parameter descriptions
- No examples of correct tool calls
- Smaller models with less training on structured output

**Mitigations**:
- Keep tool schemas simple; use enums and constraints over free-form strings
- Set `additionalProperties: false` in JSON schemas
- Provide few-shot examples of correct tool calls
- Implement validation with descriptive error messages for self-correction
- Use constrained decoding (grammar-guided generation) where available

### 3. Sequential Tool Call Degradation

**Symptoms**: First tool call works, subsequent calls fail or the model starts outputting tool calls as plain text.

**Causes**:
- Context window filling up with tool results
- Thinking/reasoning tags not properly closed between rounds
- Model loses track of the conversation structure in long exchanges

**Mitigations**:
- Compact tool results (summarize verbose outputs)
- Ensure proper closing of thinking tags between rounds
- Implement a maximum tool-call budget per interaction
- Clear accumulated tool results periodically while keeping the system prompt and original query

### 4. Tool Selection Errors

**Symptoms**: Model calls the wrong tool, especially when tools have overlapping descriptions.

**Causes**:
- Overlapping tool functionality with ambiguous decision boundaries
- Too many similar tools in context
- Tool names or descriptions that are too generic

**Mitigations**:
- Each tool should have a unique, clear purpose
- Include "when NOT to use this tool" in descriptions
- As a diagnostic: "If a human engineer can't definitively say which tool should be used in a given situation, an AI agent can't be expected to do better." (Anthropic)
- Implement tool search to surface only relevant tools per query

### 5. Argument Hallucination

**Symptoms**: Model invents parameter values not present in the user's request (fake URLs, made-up IDs, incorrect dates).

**Causes**:
- Model fills in gaps with plausible-sounding but fabricated data
- Parameter descriptions don't specify format requirements
- No validation feedback loop

**Mitigations**:
- Add format examples in parameter descriptions: `"date (ISO 8601 format, e.g., '2026-03-14')"`
- Instruct the model: "If you don't have enough information to fill a parameter, ask the user"
- Implement argument validation with descriptive error messages
- Use constrained decoding for format-sensitive fields

---

## Proven Prompting Patterns for Tool Use

### Pattern 1: Explicit Tool-Use Mandate

The most basic and essential pattern. Without explicit instructions, models will often describe actions rather than perform them.

**Weak (what TITAN currently has in places)**:
```
Be proactive: if a task implies follow-up actions, suggest or perform them
```

**Strong**:
```
You MUST use your tools to complete tasks. NEVER describe what you would do --
actually do it. NEVER suggest the user visit a URL -- fetch it yourself.
NEVER output file contents in your response -- write them to disk with write_file.
If a tool exists for the task, use it. Do NOT guess or make up an answer.
```

**Evidence**: OpenAI's GPT-4.1 prompting guide found that three simple agent instructions (persistence, tool-calling mandate, planning) increased internal benchmarks by nearly 20%.

### Pattern 2: ReAct (Reason + Act)

The most widely adopted agentic pattern. The model alternates between reasoning steps and tool calls.

**Template** (from LangChain):
```
Answer the following questions as best you can. You have access to the following tools:

{tools}

Use the following format:

Question: the input question you must answer
Thought: you should always think about what to do
Action: the action to take, should be one of [{tool_names}]
Action Input: the input to the action
Observation: the result of the action
... (this Thought/Action/Action Input/Observation can repeat N times)
Thought: I now know the final answer
Final Answer: the final answer to the original input question
```

**Key benefit**: The explicit "Thought" step forces the model to reason before acting, dramatically reducing incorrect tool selections and hallucinated arguments.

**Adaptation for native tool calling**: When using API-level tool calling (not text-based), the ReAct pattern can be adapted:
```
Before each tool call, briefly explain your reasoning in your response.
After receiving tool results, reflect on whether the result answers the
question or if additional tool calls are needed.
```

### Pattern 3: Few-Shot Tool-Use Examples

**The single most impactful technique for improving tool-calling reliability.**

**Key findings from LangChain research**:
- Message-format examples outperform string-format examples
- 2-3 well-selected examples match or exceed larger sets (diminishing returns beyond 3)
- Dynamic example selection (based on query similarity) outperforms static examples for complex tasks
- Smaller models with few-shot examples can rival zero-shot performance of much larger models

**Implementation**: Place examples as messages between the system prompt and the user's actual query:

```typescript
const messages = [
  { role: 'system', content: systemPrompt },
  // Few-shot example 1
  { role: 'user', content: 'What is the weather in San Francisco?' },
  { role: 'assistant', content: null, tool_calls: [{
    function: { name: 'weather', arguments: '{"location":"San Francisco"}' }
  }]},
  { role: 'tool', content: '{"temp": 62, "condition": "Foggy"}' },
  { role: 'assistant', content: 'It is currently 62F and foggy in San Francisco.' },
  // Actual user message
  { role: 'user', content: actualUserMessage }
];
```

**Important**: Few-shot examples consume tokens. For TITAN with 100+ tools, use dynamic example selection -- pick examples relevant to the user's current query rather than static examples for all queries.

### Pattern 4: Chain-of-Thought Before Tool Calls

Instruct the model to think step-by-step before making a tool call. This is a lighter version of ReAct that works with native tool-calling APIs.

```
When you receive a request:
1. Identify what the user needs
2. Determine which tool(s) can fulfill the request
3. Plan the sequence of tool calls needed
4. Execute the first tool call
5. Reflect on the result and determine if more calls are needed
```

**Evidence**: OpenAI's GPT-4.1 guide recommends: "Plan extensively before each function call, and reflect extensively on the outcomes of the previous function calls."

### Pattern 5: Negative Examples (What NOT to Do)

Explicitly showing the model incorrect behavior and contrasting it with correct behavior.

```
WRONG (do not do this):
User: "Create a config file for my project"
Assistant: "Here's the config file content: { ... }"

CORRECT (do this instead):
User: "Create a config file for my project"
Assistant: [calls write_file tool with the config content]
"I've created the config file at ./config.json."
```

### Pattern 6: Tool-Use Priority Rules

When multiple tools could apply, explicit priority rules prevent ambiguity:

```
Tool selection priority:
1. Use specialized tools over general tools (weather tool > web_search for weather)
2. Use local tools over remote tools when both can fulfill the request
3. Use read tools before write tools (check current state before modifying)
4. Use the tool that gives the most direct answer with fewest intermediate steps
```

---

## System Prompt Structure Best Practices

### The "Lost in the Middle" Problem

Research from Stanford (Liu et al., 2023) and subsequent studies demonstrate that LLMs exhibit a U-shaped attention curve:

- **Primacy bias**: Strong attention to the beginning of the context
- **Recency bias**: Strong attention to the end of the context
- **Middle degradation**: Significantly reduced attention to middle content

**Implication for system prompts**: Critical instructions placed in the middle of a long system prompt will be partially ignored. This is an architectural property of transformers (causal masking creates geometric primacy bias, residual connections create recency bias, RoPE introduces distance-based decay).

### Optimal Ordering

Based on research from Anthropic, OpenAI, and Google, the recommended structure is:

```
1. ROLE AND IDENTITY (top -- primacy position)
   - Who is the agent, what is its purpose
   - Core behavioral mandate (e.g., "always use tools")

2. CRITICAL RULES (near top -- high attention)
   - Tool-use mandate
   - Security constraints
   - Hard behavioral rules that must never be violated

3. TOOL GUIDANCE (upper-middle)
   - How to select tools
   - Priority rules
   - Tool-specific instructions

4. BEHAVIORAL GUIDELINES (middle)
   - Communication style
   - Response format preferences
   - Quality expectations

5. DYNAMIC CONTEXT (lower-middle)
   - Memory/learning context
   - User preferences
   - Session-specific information

6. REINFORCEMENT (bottom -- recency position)
   - Repeat critical rules (especially tool-use mandate)
   - Final reminders of highest-priority behaviors
```

**Key insight from OpenAI**: "GPT-4.1 prioritizes instructions closer to the prompt's end." This means placing final reinforcement of critical rules at the very bottom of the system prompt is essential.

### Token Budget

- **Rule of thumb**: Budget no more than 5-10% of total context window for the system prompt
- For a 16K context (Ollama default for many models): ~800-1600 tokens for system prompt
- For a 128K context: ~6400-12800 tokens, but diminishing returns set in much earlier
- **Instruction-following rate drops as instruction count increases** -- confirmed across all models
- The inflection point where adding more content degrades performance rather than enhancing it varies by model, but is generally around 2000-3000 tokens for system prompts

### Structure Over Prose

- Use markdown headers (`##`) or XML tags (`<section>`) to delineate sections
- Bullet points over paragraphs for rules and guidelines
- Numbered lists for sequential procedures
- Bold or caps for critical emphasis (but sparingly -- excessive emphasis dilutes everything)

**Anthropic recommendation**: "Organize prompts into distinct sections using XML tags or Markdown headers. This delineation helps models parse instructions more effectively."

**OpenAI recommendation**: "Use structured XML specs like `<instruction_spec>` to improve instruction adherence."

### Minimalism Principle

> "Strive for the minimal information needed to fully outline expected behavior -- though minimal doesn't mean short."
> -- Anthropic, Context Engineering guide

- Start with a minimal baseline
- Add instructions iteratively based on identified failure modes
- Every instruction competes for attention budget -- earn its place
- If a rule can be enforced programmatically (validation, `tool_choice`, constrained decoding), prefer code over prompt text

### Avoiding Instruction Conflicts

Research shows that instruction-following degradation is partly caused by **tension and conflict between instructions** as the number increases. Audit for:

- Contradictory rules ("be concise" vs. "explain your reasoning thoroughly")
- Overlapping guidance (same behavior described differently in multiple places)
- Ambiguous priorities (which rule wins when two conflict?)

---

## Model-Specific Quirks

### Qwen 3.5 (Current TITAN Default via Ollama)

**Critical issue (as of March 2026)**: Qwen 3.5 tool calling in Ollama has four known bugs:

1. **Wrong tool calling format**: Ollama uses the Qwen 3 Hermes JSON format, but Qwen 3.5 was trained on the **Qwen3-Coder XML format**: `<function=name><parameter=key>value</parameter></function>`. The correct parser (`Qwen3CoderRenderer` + `Qwen3CoderParser`) exists in Ollama's codebase but is wired to "qwen3-coder" instead of "qwen3.5".

2. **Unclosed `</think>` tags**: When assistant messages contain thinking plus tool calls without text, the renderer fails to emit closing tags, corrupting multi-turn prompts.

3. **Missing generation prompts**: Tool call turns don't receive proper generation prompts, breaking the round-trip loop.

4. **Penalty sampling not implemented**: The Go runner's sampler has zero implementation of penalty sampling -- `repeat_penalty` and `presence_penalty` are silently ignored.

**Workarounds**:
- Ollama PR #14603 partially fixed some issues (merged)
- Downgrading to Ollama 0.17.5 avoids the think-tag regression
- For reliable tool calling with Qwen 3.5, consider using vLLM instead: `vllm serve Qwen/Qwen3.5-27B --tool-call-parser qwen3_coder --enable-auto-tool-choice`
- Qwen-Agent framework handles parsing internally and is recommended by the Qwen team

**System prompt format for Qwen models**: Tool definitions should be wrapped in XML tags:
```xml
<tools>
[tool definitions as JSON]
</tools>
```

Tool calls should be returned in `<tool_call></tool_call>` XML tags (for Qwen3) or `<function>` tags (for Qwen3.5/Qwen3-Coder).

### Qwen 3 (Previous Generation)

- Uses Hermes-style JSON tool calling
- More mature and stable tool calling support in Ollama
- Chat template in `tokenizer_config.json` includes built-in support for Hermes-style tool use
- Generally reliable for tool calling when the system prompt includes tool definitions

### Devstral / Mistral Models

- Mistral models use their own tool calling format via `[TOOL_CALLS]` special tokens
- For vLLM: use `--tool-call-parser mistral --enable-auto-tool-choice`
- Devstral Small 2 (24B) is strong at coding and tool-calling tasks
- Load the model's built-in system prompt with `load_system_prompt(model, "CHAT_SYSTEM_PROMPT.txt")`
- Devstral models are specifically designed for agentic workflows

### Llama 3.x Models

- Support tool calling via the Llama tool-calling format
- In Ollama, tool calling works with `llama3.1`, `llama3.2`, and `llama3.3` models
- For best results, include the tool definitions in the system prompt using the model's expected format
- Llama models benefit strongly from ReAct-style prompting

### DeepSeek Models

- DeepSeek V3 supports function calling through prompt engineering
- Uses special tokens: `<tool_calls_begin>`, `<tool_call_begin>`, etc.
- DeepSeek R1 (reasoning model) has limited tool calling support -- it was not specifically trained for it
- Community-modified Ollama model files (like `MFDoom/deepseek-r1-tool-calling`) add tool calling via custom system prompts
- Best practice: ensure descriptions are explicit and clearly define when the function should be used

### Claude (Anthropic)

- Tool definitions passed via the `tools` API parameter are automatically incorporated into a special system prompt
- Claude writes code to parse tool outputs, so document return formats clearly
- Supports `tool_choice: "auto"`, `"any"` (must use at least one), or `{"type": "tool", "name": "specific_tool"}`
- Advanced features: Tool Search (defer_loading), Programmatic Tool Calling
- Best practice: Use the API's `tools` field rather than injecting tool descriptions into the system prompt manually

### GPT-4.1 / GPT-5 (OpenAI)

- Use the API's `tools` field, not manual system prompt injection
- `tool_choice: "required"` guarantees the model generates at least one tool call
- Create an `# Examples` section in system prompts for complex tools
- Avoid hallucinated tool inputs by adding: "if you don't have enough information, ask the user"
- GPT-4.1 prioritizes instructions closer to the prompt's end

---

## Agent Framework System Prompts

### LangChain / LangGraph ReAct Agent

The canonical ReAct prompt:

```
Answer the following questions as best you can. You have access to the following tools:

{tools}

Use the following format:

Question: the input question you must answer
Thought: you should always think about what to do
Action: the action to take, should be one of [{tool_names}]
Action Input: the input to the action
Observation: the result of the action
... (this Thought/Action/Action Input/Observation can repeat N times)
Thought: I now know the final answer
Final Answer: the final answer to the original input question

Begin!

Question: {input}
Thought:{agent_scratchpad}
```

**Key design decisions**:
- Tools are described inline in the system prompt (not via API parameters)
- The format is rigidly specified to enable reliable text parsing
- The scratchpad accumulates all previous thoughts/actions/observations
- Max iterations limit (typically 5-10) prevents infinite loops

**Production considerations**:
- Set `max_iterations` to prevent runaway loops and excessive API usage
- LangGraph adds graph-based state management for more complex flows
- Observability via LangSmith for tracing and debugging

### CrewAI

CrewAI uses role-based agent configuration:

```python
Agent(
    role="Senior Researcher",
    goal="Uncover groundbreaking technologies in AI",
    backstory="You are a seasoned researcher...",
    tools=[search_tool, web_tool],
    reasoning=True  # Enables strategic planning
)
```

**Key design decisions**:
- Agents have explicit roles, goals, and backstories
- Custom system templates, prompt templates, and response templates supported
- Template format uses Jinja-style `{{ .System }}`, `{{ .Prompt }}`
- Tools are bound to specific agents, not globally available
- Multi-agent coordination through defined responsibilities

### AutoGen (Microsoft)

AutoGen uses a conversational model:

```python
AssistantAgent(
    name="assistant",
    system_message="You are a helpful AI assistant. Solve tasks using your coding and language skills...",
    llm_config={"tools": [tool_definitions]}
)
```

**Key design decisions**:
- Agents communicate through natural language messages
- Tool definitions passed via `llm_config` (similar to OpenAI API)
- Conversation orchestration over structured flowcharts
- Low-level Core for event-driven messaging, high-level AgentChat for simpler use

### OpenAI Assistants API

OpenAI's Assistants use a straightforward approach:

```
instructions: "You are a helpful assistant. Use the provided tools to answer questions.
When a user asks about weather, use the get_weather function.
When a user asks about calculations, use the calculator function.
Always use tools when available rather than generating answers from memory."
```

**Key design decisions**:
- Tools defined via the API's `tools` parameter (not in the system prompt)
- `tool_choice` parameter controls tool-calling behavior at the API level
- Built-in tools: code_interpreter, file_search, function
- Run-level instructions can override assistant-level instructions per interaction

### Anthropic Agent Skills

Anthropic's approach emphasizes progressive disclosure:

- Agent Skills are organized folders of instructions, scripts, and resources
- Skills are discovered and loaded dynamically (not all at once)
- The system prompt is kept tight, with skills providing just-in-time context
- Core principle: "Load information only as needed"

**Key design decisions**:
- Tools are self-contained with clear contracts
- Tool descriptions are the primary guidance mechanism (not system prompt text)
- Avoid tool bloat -- overlapping functionality creates ambiguity
- Token-efficient tool results (summarize verbose outputs)

### Common Patterns Across Frameworks

1. **Role definition first**: Every framework starts with who the agent is
2. **Tool awareness**: Explicit mention that tools are available and should be used
3. **Format specification**: Clear structure for how the agent should respond (especially for text-based tool calling)
4. **Iteration support**: All frameworks handle multi-round tool calling
5. **Guardrails**: Max iterations, token budgets, cost ceilings
6. **Error handling**: Retry logic, fallback strategies, descriptive error messages

---

## Constrained Decoding and Structured Output

### The Nuclear Option for Tool-Call Reliability

When prompt engineering alone cannot achieve reliable tool calling, constrained decoding enforces structure at the token-generation level.

**How it works**: During token sampling, the decoder only allows tokens that are valid according to a predefined grammar or schema. Invalid tokens receive -infinity logits and cannot be sampled.

### Major Libraries (2025-2026)

| Library | Approach | Performance | Notes |
|---------|----------|-------------|-------|
| **XGrammar** | FSM + CFG hybrid | ~100x faster than traditional | Context-independent/dependent token splitting |
| **llguidance** (Microsoft) | Rust-based engine | ~50us/token for 128K vocab | Credited by OpenAI for their Structured Outputs |
| **Outlines** | Regex/CFG to FSM | Mature, widely used | Integrates with HuggingFace |
| **vLLM Structured Outputs** | Built-in (v0.8.5+) | JSON schema, regex, grammar | Production-grade, recommended for Qwen |

### When to Use Constrained Decoding

- **Always use** for critical tool call arguments (dates, IDs, enums)
- **Use when** smaller models consistently produce malformed JSON
- **Use when** the tool schema has strict format requirements
- **Avoid** for free-form text generation (it constrains creativity)

### vLLM Configuration for Tool Calling

```bash
vllm serve Qwen/Qwen3.5-27B \
  --tool-call-parser qwen3_coder \
  --enable-auto-tool-choice \
  --max-model-len 32768
```

This enables grammar-guided tool call generation, significantly reducing malformed outputs.

### Ollama Limitations

As of March 2026, Ollama does not support constrained decoding / structured outputs at the server level. Tool calling relies entirely on the model's ability to generate valid structured output from prompt engineering alone. This is a significant reliability gap compared to vLLM.

---

## Recommendations for TITAN

### Priority 1: Restructure the System Prompt

Current TITAN system prompt issues:
- Tool-use mandate is buried in "Behavior Guidelines" (middle of prompt)
- Too many instructions competing for attention
- No reinforcement of critical rules at the bottom
- Dynamic context (learning, memory, etc.) is interspersed with static rules

**Proposed structure**:

```
## Identity
[Who is TITAN, 2-3 sentences max]

## CRITICAL RULES (Tool-Use Mandate)
- You MUST use tools to complete tasks. NEVER describe what could be done.
- NEVER output file content in response -- use write_file.
- NEVER suggest URLs -- use web_fetch yourself.
- If you don't have enough info to call a tool, ask the user.
- Do NOT guess or make up answers. Use tools to verify.

## Tool Selection
[Priority rules for choosing between tools]
[Specialized tool routing: weather tool for weather, etc.]

## Response Style
[Concise, action-oriented, etc.]

## Security
[Hard constraints, 3-4 bullets max]

## Dynamic Context
[Memory, learning, preferences -- injected at runtime]

## REMINDER (Reinforcement)
Always use tools. Never describe actions -- perform them.
Plan before each tool call. Reflect on results before responding.
```

### Priority 2: Add Few-Shot Tool-Use Examples

Add 2-3 few-shot examples as messages (not in the system prompt string). Select examples dynamically based on the user's query when possible.

**Implementation approach**:
```typescript
// In agent.ts, before the actual user message
const fewShotExamples = selectRelevantExamples(userMessage, availableTools);
const messages = [
  { role: 'system', content: systemPrompt },
  ...fewShotExamples,  // 2-3 example exchanges
  { role: 'user', content: userMessage }
];
```

### Priority 3: Improve Tool Descriptions

Every tool definition should include:
- Clear name (verb_noun format: `write_file`, `web_search`)
- Description with "Use this when..." guidance
- "Do NOT use this when..." for commonly confused tools
- Parameter descriptions with format examples
- Return value documentation

### Priority 4: Use `tool_choice` Strategically

- Default to `"auto"` for general conversation
- Use `"required"` when the user's intent clearly requires a tool (e.g., "search for...", "create a file...")
- Use specific tool forcing for unambiguous requests (e.g., weather queries -> force `weather` tool)

**Implementation**: Add intent classification before the LLM call to determine the appropriate `tool_choice` setting.

### Priority 5: Implement Self-Correction Loop

When a tool call fails validation:
1. Return a descriptive error message to the model
2. Include the schema violation and expected format
3. Let the model retry with corrected arguments
4. Limit retries to 2-3 attempts before escalating

Example error feedback:
```
ValidationError: 'tomorrow morning' is not a valid ISO 8601 date.
Please provide the date in format '2026-03-14T09:00:00Z'.
```

### Priority 6: Address Qwen 3.5 / Ollama Issues

Options (in order of preference):
1. **Monitor Ollama fixes** -- PR #14603 partially addressed the XML format issue. Watch for full resolution.
2. **Consider vLLM** -- More reliable tool calling for Qwen 3.5 with proper parser support.
3. **Custom Modelfile** -- Create an Ollama Modelfile with the correct Qwen3-Coder template if fixes are delayed.
4. **Model fallback** -- Use Qwen 3 (stable Hermes format) as fallback when Qwen 3.5 tool calling fails.

### Priority 7: Reduce Prompt Token Budget

Current TITAN system prompt is ~350 lines with heavy dynamic context injection. Target:
- Static system prompt: under 500 tokens
- Dynamic context: under 1000 tokens
- Total: under 1500 tokens (~10% of 16K context)

Techniques:
- Move detailed tool guidance into tool descriptions (where it belongs)
- Use tool search to reduce active tool count per query
- Compress learning/memory context
- Eliminate redundant instructions

### Priority 8: ReAct-Style Reasoning for Complex Tasks

For multi-step tasks, add reasoning instructions:
```
For complex requests that require multiple steps:
1. Plan: List the steps needed
2. Act: Execute the first step with a tool call
3. Observe: Examine the result
4. Repeat: Continue until the task is complete
5. Respond: Summarize what was accomplished
```

This can be toggled on/off based on task complexity to avoid overhead on simple queries.

---

## Sources

### Anthropic
- [Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Introducing Advanced Tool Use](https://www.anthropic.com/engineering/advanced-tool-use)
- [How to Implement Tool Use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use)
- [Prompting Best Practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- [Claude Code Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices)
- [Equipping Agents for the Real World with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)

### OpenAI
- [GPT-4.1 Prompting Guide](https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide/)
- [GPT-5 Prompting Guide](https://cookbook.openai.com/examples/gpt-5/gpt-5_prompting_guide)
- [Prompt Engineering Guide](https://platform.openai.com/docs/guides/prompt-engineering)
- [Prompting Best Practices for Tool Use (Community)](https://community.openai.com/t/prompting-best-practices-for-tool-use-function-calling/1123036)

### Qwen / Ollama
- [Qwen Function Calling Documentation](https://qwen.readthedocs.io/en/latest/framework/function_call.html)
- [Ollama Tool Calling Documentation](https://docs.ollama.com/capabilities/tool-calling)
- [Qwen 3.5 Tool Calling Bug Report (Ollama #14493)](https://github.com/ollama/ollama/issues/14493)
- [Qwen 3.5 9B Print-Instead-of-Execute Bug (Ollama #14745)](https://github.com/ollama/ollama/issues/14745)
- [Qwen-Agent Framework](https://github.com/QwenLM/Qwen-Agent)

### Mistral / DeepSeek
- [Mistral Function Calling Documentation](https://docs.mistral.ai/capabilities/function_calling)
- [DeepSeek Function Calling API Docs](https://api-docs.deepseek.com/guides/function_calling)
- [DeepSeek R1 Tool Calling Discussion](https://huggingface.co/deepseek-ai/DeepSeek-R1/discussions/122)

### Framework References
- [LangChain ReAct Agent Template](https://github.com/langchain-ai/react-agent)
- [LangChain ReAct Agent Source](https://python.langchain.com/api_reference/langchain/agents/langchain.agents.react.agent.create_react_agent.html)
- [CrewAI Agents Documentation](https://docs.crewai.com/en/concepts/agents)
- [AutoGen ReAct Documentation](https://microsoft.github.io/autogen/0.2/docs/topics/prompting-and-reasoning/react/)
- [LangChain Few-Shot Prompting for Tool Calling](https://blog.langchain.com/few-shot-prompting-to-improve-tool-calling-performance/)

### Research Papers and Guides
- [Lost in the Middle: How Language Models Use Long Contexts (Stanford)](https://cs.stanford.edu/~nfliu/papers/lost-in-the-middle.arxiv2023.pdf)
- [The Anatomy of Tool Calling in LLMs: A Deep Dive](https://martinuke0.github.io/posts/2026-01-07-the-anatomy-of-tool-calling-in-llms-a-deep-dive/)
- [Function Calling Using LLMs (Martin Fowler)](https://martinfowler.com/articles/function-call-LLM.html)
- [ReAct Prompting Guide](https://www.promptingguide.ai/techniques/react)
- [Function Calling in AI Agents (Prompt Engineering Guide)](https://www.promptingguide.ai/agents/function-calling)
- [Tool Calling Explained: The Core of AI Agents (Composio)](https://composio.dev/content/ai-agent-tool-calling-guide)
- [Why Long System Prompts Hurt Context Windows](https://medium.com/data-science-collective/why-long-system-prompts-hurt-context-windows-and-how-to-fix-it-7a3696e1cdf9)
- [Optimal Prompt Length Before AI Performance Degrades](https://particula.tech/blog/optimal-prompt-length-ai-performance)
- [Boosting Instruction Following at Scale (arXiv)](https://arxiv.org/html/2510.14842v1)

### Structured Output / Constrained Decoding
- [vLLM Structured Outputs](https://developers.redhat.com/articles/2025/06/03/structured-outputs-vllm-guiding-ai-responses)
- [llguidance (Microsoft)](https://github.com/guidance-ai/llguidance)
- [Constrained Decoding Guide](https://www.aidancooper.co.uk/constrained-decoding/)
- [Best Ollama Models for Function Calling 2025](https://collabnix.com/best-ollama-models-for-function-calling-tools-complete-guide-2025/)
