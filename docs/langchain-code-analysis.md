# LangChain.js Code-Level Analysis for TITAN

> **Date:** 2026-04-25  
> **Source:** `langchainjs` monorepo (shallow clone at `/tmp/langchainjs-analysis`)  
> **Focus:** Specific code patterns, file paths, and implementation details TITAN could adopt.

---

## Executive Summary

LangChain.js (`libs/langchain-core/`, `libs/langchain/`, `libs/langchain-mcp-adapters/`) is a **TypeScript-first agent framework** with three layers:

| Layer | Package | Key Files |
|-------|---------|-----------|
| **Core** | `@langchain/core` | `tools/index.ts`, `messages/tool.ts`, `callbacks/manager.ts` |
| **Agents** | `langchain` | `agents/middleware/*.ts`, `agents/state.ts` |
| **MCP** | `@langchain/mcp-adapters` | `tools.ts`, `client.ts`, `connection.ts` |

For TITAN, the highest-value borrowable patterns are:
1. **Tool schema bridge** — JSON Schema ↔ Zod conversion for MCP tools
2. **Agent middleware** — Model call limits, PII redaction, context editing
3. **Callback manager** — Hierarchical tracing for tool calls and agent steps
4. **DynamicStructuredTool** — Runtime tool creation from schemas

---

## 1. Tool System Deep Dive

### 1.1 StructuredTool Base Class
**File:** `libs/langchain-core/src/tools/index.ts` (lines 100–300)

LangChain's tool hierarchy:
```
BaseLangChain
└── StructuredTool<SchemaT, OutputT>
    ├── name: string
    ├── description: string
    ├── schema: SchemaT  (Zod or JSON Schema)
    ├── _call(args, runManager, config) → Promise<OutputT>
    └── invoke(input, config) → Promise<ToolMessage>
```

Key design decisions:
- **Schema-driven**: Every tool has a typed schema. The LLM receives the schema as function-calling metadata.
- **Run manager injection**: `_call` receives a `CallbackManagerForToolRun` so tools can emit events, log errors, and report progress.
- **Tool messages**: Output is wrapped in `ToolMessage` with `tool_call_id` linkage to the originating `ToolCall`.

**TITAN adaptation:**
TITAN's tools are plain functions. Adopting a `StructuredTool` base would:
- Standardize schema definitions (currently ad-hoc Zod in each tool file)
- Enable callback tracing for every tool invocation
- Make tool output format consistent for the LLM

```typescript
// TITAN-style adaptation
abstract class TitanTool<
  Schema extends z.ZodTypeAny,
  Output = unknown
> {
  abstract name: string;
  abstract description: string;
  abstract schema: Schema;
  
  async invoke(args: z.infer<Schema>, ctx: ToolContext): Promise<ToolResult> {
    const validated = this.schema.parse(args);
    const result = await this._call(validated, ctx);
    return { toolCallId: ctx.toolCallId, content: JSON.stringify(result) };
  }
  
  protected abstract _call(args: z.infer<Schema>, ctx: ToolContext): Promise<Output>;
}
```

### 1.2 DynamicStructuredTool — Runtime Tool Creation
**File:** `libs/langchain-core/src/tools/index.ts` (lines 900–1000)

`DynamicStructuredTool` lets you create a tool at runtime from a name, description, schema, and function:

```typescript
const tool = new DynamicStructuredTool({
  name: "weather",
  description: "Get weather for a city",
  schema: z.object({ city: z.string() }),
  func: async (args) => {
    return await fetchWeather(args.city);
  },
});
```

**TITAN adaptation:**
TITAN already has dynamic tool loading via MCP. But `DynamicStructuredTool` would enable:
- User-defined tools via the UI (name + description + schema + code)
- Agent-generated tools (the agent writes a function, TITAN wraps it)
- Hot-reloading of tools without restarting the gateway

### 1.3 MCP Tool Adapter — JSON Schema Bridge
**File:** `libs/langchain-mcp-adapters/src/tools.ts` (lines 1192–1300)

This is the **most relevant file** for TITAN. It shows how LangChain converts MCP tools to LangChain tools:

```typescript
export async function loadMcpTools(
  serverName: string,
  client: MCPInstance,
  options?: LoadMcpToolsOptions
): Promise<DynamicStructuredTool[]> {
  const mcpTools = await client.listTools();
  
  return mcpTools.map(tool => {
    // 1. Dereference $defs/$ref in JSON Schema
    const dereferenced = dereferenceJsonSchema(tool.inputSchema);
    
    // 2. Simplify schema for LLM compatibility
    //    (remove allOf, anyOf, oneOf, if/then/else, not)
    const simplified = simplifyJsonSchemaForLLM(dereferenced);
    
    // 3. Wrap as DynamicStructuredTool
    return new DynamicStructuredTool({
      name: `${serverName}__${tool.name}`,
      description: tool.description,
      schema: simplified,  // JSON Schema (not Zod!)
      func: async (args) => {
        return await client.callTool({ name: tool.name, arguments: args });
      },
    });
  });
}
```

**Critical patterns:**
- **Schema dereferencing**: Resolves `$ref` pointers to `$defs` definitions. Pydantic v2 emits schemas with `$defs`; without dereferencing, OpenAI rejects them.
- **Schema simplification**: Removes `allOf`, `anyOf`, `oneOf`, `if/then/else`, `not` — patterns that OpenAI's function-calling API doesn't support.
- **Tool namespacing**: Prefixes tool names with server name (`serverName__toolName`) to avoid collisions across MCP servers.

**TITAN adaptation:**
TITAN's MCP integration in `src/mcp/` likely has similar logic but may lack the schema simplification step. Adding `dereferenceJsonSchema` and `simplifyJsonSchemaForLLM` would fix MCP tool failures with Pydantic v2 servers.

```typescript
// TITAN: src/mcp/client.ts enhancement
import { dereferenceJsonSchema, simplifyJsonSchemaForLLM } from './schemaUtils';

async function loadMcpTools(client: MCPClient): Promise<TitanTool[]> {
  const { tools } = await client.listTools();
  return tools.map(mcpTool => {
    const schema = simplifyJsonSchemaForLLM(
      dereferenceJsonSchema(mcpTool.inputSchema)
    );
    return {
      name: mcpTool.name,
      description: mcpTool.description,
      schema,
      handler: (args) => client.callTool(mcpTool.name, args),
    };
  });
}
```

---

## 2. Agent Middleware Pattern

**Files:** `libs/langchain/src/agents/middleware/*.ts`

LangChain agents use a **middleware pipeline** — composable wrappers around the core agent loop:

| Middleware | File | Purpose |
|------------|------|---------|
| `modelCallLimit` | `middleware/modelCallLimit.ts` | Caps model calls per thread/run |
| `piiRedaction` | `middleware/piiRedaction.ts` | Detects/redacts PII in messages |
| `contextEditing` | `middleware/contextEditing.ts` | Summarizes/trims context when too long |
| `toolEmulator` | `middleware/toolEmulator.ts` | Simulates tool calls for testing |

### 2.1 Model Call Limit Middleware
**File:** `libs/langchain/src/agents/middleware/modelCallLimit.ts`

```typescript
const contextSchema = z.object({
  threadLimit: z.number().optional(),
  runLimit: z.number().optional(),
  exitBehavior: z.enum(["error", "end"]).optional(),
});

const stateSchema = z.object({
  threadModelCallCount: z.number().default(0),
  runModelCallCount: z.number().default(0),
});

export const modelCallLimitMiddleware = createMiddleware({
  contextSchema,
  stateSchema,
  onModelCall: (state, context) => {
    state.runModelCallCount++;
    state.threadModelCallCount++;
    if (context.runLimit && state.runModelCallCount > context.runLimit) {
      throw new ModelCallLimitMiddlewareError({ ... });
    }
  },
});
```

**TITAN adaptation:**
TITAN has a `maxRounds` limit but no per-thread or per-run call tracking. Adopting middleware would:
- Enable budget-based agent control (e.g., "use max 5 model calls for this task")
- Track token and call usage across agent runs for cost accounting
- Support graceful degradation instead of hard errors

### 2.2 PII Redaction Middleware
**File:** `libs/langchain/src/agents/middleware/piiRedaction.ts`

Scans all messages for regex patterns (email, SSN, phone, etc.), replaces matches with `[REDACTED_ID]`, and stores originals in a redaction map. Tool outputs are automatically restored before display.

**TITAN adaptation:**
TITAN's guardrails check for violations but don't redact PII. Adding redaction middleware would:
- Prevent sensitive data from reaching LLM providers
- Store redaction map in the session for audit trails
- Restore original values in tool outputs for local display

---

## 3. Callback Manager — Observability

**File:** `libs/langchain-core/src/callbacks/manager.ts`

LangChain's callback system is hierarchical:

```
CallbackManager (agent-level)
├── CallbackManagerForLLMRun (each LLM call)
├── CallbackManagerForToolRun (each tool call)
│   ├── onToolStart(tool, input)
│   ├── onToolEnd(output)
│   └── onToolError(error)
└── CallbackManagerForChainRun (each chain step)
```

Every `invoke()` call receives a config with callbacks. This enables:
- **Tracing**: LangSmith listens to callbacks and builds trace trees
- **Logging**: Custom loggers emit structured events
- **Progress**: UI progress bars update via `onToolStart`/`onToolEnd`

**TITAN adaptation:**
TITAN's agent loop emits events but lacks a structured callback hierarchy. Adopting callbacks would:
- Replace ad-hoc `logger.info(COMPONENT, ...)` with typed events
- Enable LangSmith integration for external observability
- Support real-time UI updates (progress bars, tool call visualization)

```typescript
// TITAN-style callback hierarchy
interface TitanCallbackHandler {
  onAgentStart?(sessionId: string, goal: string): void;
  onToolStart?(toolCallId: string, toolName: string, args: unknown): void;
  onToolEnd?(toolCallId: string, result: unknown, durationMs: number): void;
  onToolError?(toolCallId: string, error: Error): void;
  onAgentEnd?(sessionId: string, summary: string): void;
}
```

---

## 4. Message Types — ToolCall / ToolMessage Linkage

**File:** `libs/langchain-core/src/messages/tool.ts`

LangChain uses explicit `ToolCall` and `ToolMessage` types with `tool_call_id` linkage:

```typescript
interface ToolCall {
  id: string;           // e.g. "call_abc123"
  name: string;         // tool name
  args: Record<string, unknown>;
}

class ToolMessage extends BaseMessage {
  tool_call_id: string; // links back to ToolCall
  name?: string;        // tool name (for tracing)
  artifact?: unknown;   // structured data for programmatic use
}
```

The `artifact` field is especially useful: it holds structured data (JSON, objects) while `content` holds the human-readable string.

**TITAN adaptation:**
TITAN's tool results are plain strings or raw objects. Adopting `ToolMessage` would:
- Enable reliable tool call → result linkage (currently inferred by order)
- Support artifacts for widget creation (the `_____react` payload could be an artifact)
- Make trace trees accurate for debugging

---

## 5. Runnable Interface — Composable Pipelines

**File:** `libs/langchain-core/src/runnables/base.ts`

LangChain's `Runnable` interface is the backbone of composition:

```typescript
interface Runnable<Input, Output> {
  invoke(input: Input, config?: RunnableConfig): Promise<Output>;
  stream(input: Input, config?: RunnableConfig): AsyncGenerator<Output>;
  batch(inputs: Input[], config?: RunnableConfig): Promise<Output[]>;
  pipe(other: Runnable<Output, Next>): Runnable<Input, Next>;
}
```

Every component (LLM, tool, chain, agent) implements `Runnable`. This enables:
- **Piping**: `llm.pipe(parser).pipe(tool)` composes operations
- **Streaming**: Every component supports streaming out of the box
- **Batching**: Run multiple inputs in parallel
- **Config passing**: `RunnableConfig` carries callbacks, metadata, and tags through the pipeline

**TITAN adaptation:**
TITAN's agent loop is a hand-coded state machine. Adopting `Runnable` would:
- Enable composable agent pipelines (e.g., `router.pipe(agent).pipe(reviewer)`)
- Support streaming tool results to the UI without polling
- Make testing easier (mock any Runnable in the pipeline)

---

## Integration Roadmap

### Phase 1: Schema Utilities (Week 1)
- Copy `dereferenceJsonSchema` and `simplifyJsonSchemaForLLM` from `libs/langchain-mcp-adapters/src/tools.ts`
- Add to `src/mcp/schemaUtils.ts`
- Fix Pydantic v2 MCP tool loading

### Phase 2: Tool Base Class (Week 2)
- Create `src/lib/TitanTool.ts` with `StructuredTool`-like interface
- Migrate 5 most-used tools (shell, read_file, web_search, memory, system_info)
- Add callback manager injection

### Phase 3: Middleware (Week 3)
- Implement `modelCallLimit` middleware for agent loop
- Implement `piiRedaction` middleware for safety
- Add middleware pipeline to `agentLoop.ts`

### Phase 4: Callback System (Week 4)
- Create `TitanCallbackManager` with `onToolStart`/`onToolEnd`/`onToolError`
- Integrate with existing event stream (`/api/sessions/:id/events`)
- Add LangSmith exporter option

### Phase 5: Runnable Refactor (Month 2)
- Refactor agent loop as `Runnable` pipeline
- Enable streaming responses without SSE polling
- Support batch tool execution

---

## Files Referenced

| File | Lines | Role |
|------|-------|------|
| `libs/langchain-core/src/tools/index.ts` | ~1000 | StructuredTool, DynamicStructuredTool base classes |
| `libs/langchain-core/src/tools/types.ts` | ~200 | Tool interface definitions |
| `libs/langchain-core/src/messages/tool.ts` | ~150 | ToolCall, ToolMessage types |
| `libs/langchain-core/src/callbacks/manager.ts` | ~800 | CallbackManager hierarchy |
| `libs/langchain-core/src/runnables/base.ts` | ~1500 | Runnable interface, piping, streaming |
| `libs/langchain-mcp-adapters/src/tools.ts` | ~1300 | MCP tool loading, schema dereference/simplify |
| `libs/langchain-mcp-adapters/src/client.ts` | ~200 | MCP client wrapper |
| `libs/langchain/src/agents/middleware/modelCallLimit.ts` | ~100 | Model call budget enforcement |
| `libs/langchain/src/agents/middleware/piiRedaction.ts` | ~150 | PII detection and redaction |
| `libs/langchain/src/agents/middleware/contextEditing.ts` | ~100 | Context summarization |
| `libs/langchain/src/agents/middleware/toolEmulator.ts` | ~80 | Tool call simulation for testing |
| `libs/langchain/src/agents/middleware.ts` | ~200 | Middleware creation helpers |
