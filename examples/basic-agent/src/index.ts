/**
 * TITAN Basic Agent — A minimal CLI agent with tool usage.
 *
 * Demonstrates:
 * - Connecting to a TITAN gateway
 * - Sending messages and receiving responses
 * - Tool execution (shell, filesystem, web search)
 * - Session management
 * - Streaming responses with SSE
 *
 * Prerequisites: titan gateway running (titan gateway)
 * Run: npx tsx src/index.ts
 */

import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

const TITAN_URL = process.env.TITAN_URL ?? "http://localhost:48420";

// ============================================================
// Basic Agent Class
// ============================================================

interface AgentResponse {
  content: string;
  sessionId: string;
  toolsUsed: string[];
  durationMs: number;
  model: string;
}

class BasicAgent {
  private sessionId: string | null = null;

  /**
   * Send a message to TITAN and return the response.
   */
  async sendMessage(message: string): Promise<AgentResponse> {
    const body: Record<string, unknown> = { content: message };

    // Continue existing session if we have one
    if (this.sessionId) {
      body.sessionId = this.sessionId;
    }

    const res = await fetch(`${TITAN_URL}/api/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`TITAN returned ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    this.sessionId = data.sessionId;

    return {
      content: data.content,
      sessionId: data.sessionId,
      toolsUsed: data.toolsUsed ?? [],
      durationMs: data.durationMs,
      model: data.model,
    };
  }

  /**
   * Stream a message with Server-Sent Events for real-time output.
   */
  async *streamMessage(message: string): AsyncGenerator<string, void, unknown> {
    const body: Record<string, unknown> = { content: message };
    if (this.sessionId) {
      body.sessionId = this.sessionId;
    }

    const res = await fetch(`${TITAN_URL}/api/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      throw new Error(`TITAN returned ${res.status}: ${await res.text()}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        if (payload === "[DONE]") return;

        try {
          const event = JSON.parse(payload);
          if (event.content) yield event.content;
          if (event.sessionId && !this.sessionId) {
            this.sessionId = event.sessionId;
          }
        } catch {
          // Non-JSON line, pass through
          yield line + "\n";
        }
      }
    }
  }

  /**
   * Get the current session ID.
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Clear the session to start fresh.
   */
  clearSession(): void {
    this.sessionId = null;
  }
}

// ============================================================
// Interactive Chat Loop
// ============================================================

async function chatLoop() {
  const agent = new BasicAgent();
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  console.log("TITAN Basic Agent — Type 'quit' or 'exit' to quit.\n");

  while (true) {
    const input = await ask("> ");

    if (!input.trim()) continue;
    if (["quit", "exit", "q"].includes(input.toLowerCase())) {
      console.log("Goodbye!");
      rl.close();
      return;
    }

    if (input.toLowerCase() === "clear") {
      agent.clearSession();
      console.log("Session cleared.\n");
      continue;
    }

    if (input.toLowerCase() === "session") {
      console.log(`Current session: ${agent.getSessionId() ?? "none"}\n`);
      continue;
    }

    try {
      console.log("Thinking...");
      const response = await agent.sendMessage(input);

      console.log(`\n${response.content}\n`);

      if (response.toolsUsed.length > 0) {
        console.log(`Tools used: ${response.toolsUsed.join(", ")}\n`);
      }

      console.log(`Model: ${response.model} | ${response.durationMs}ms`);
      if (agent.getSessionId()) {
        console.log(`Session: ${agent.getSessionId()}\n`);
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}\n`);
    }
  }
}

// ============================================================
// Single Message Mode (via CLI argument)
// ============================================================

async function singleMessage(message: string) {
  const agent = new BasicAgent();

  console.log(`Sending: "${message}"\n`);

  for await (const chunk of agent.streamMessage(message)) {
    process.stdout.write(chunk);
  }

  console.log("\n");
}

// ============================================================
// Entry Point
// ============================================================

const cliMessage = process.argv.slice(2).join(" ");

if (cliMessage) {
  singleMessage(cliMessage).catch(console.error);
} else {
  chatLoop().catch(console.error);
}
