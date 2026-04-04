/**
 * TITAN MCP Server — Expose TITAN's tools via Model Context Protocol.
 *
 * Demonstrates:
 * - Implementing an MCP server with JSON-RPC 2.0
 * - Supporting stdio and HTTP transports
 * - Tool discovery via tools/list
 * - Tool execution via tools/call
 * - Error handling with JSON-RPC error codes
 *
 * This server allows MCP clients (Claude Desktop, Cursor, etc.) to
 * discover and call any of TITAN's 200+ tools.
 *
 * Run: npx tsx src/index.ts
 * Or use TITAN's built-in command: npx titan-agent mcp
 */

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";

const TITAN_URL = process.env.TITAN_URL ?? "http://localhost:48420";
const MCP_VERSION = "1.0.0";

// ============================================================
// JSON-RPC 2.0 Types
// ============================================================

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result: unknown;
  error?: never;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// ============================================================
// TITAN Tool Discovery
// ============================================================

interface TitanTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

async function fetchTools(): Promise<TitanTool[]> {
  const res = await fetch(`${TITAN_URL}/api/tools`);
  if (!res.ok) {
    throw new Error(`Failed to fetch tools: ${res.status}`);
  }
  const data = await res.json();
  return data.tools ?? [];
}

async function callTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${TITAN_URL}/api/tools/${toolName}/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ args }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Tool call failed (${res.status}): ${errorBody}`);
  }

  return res.json();
}

// ============================================================
// MCP Request Handler
// ============================================================

async function handleRequest(
  request: JsonRpcRequest,
): Promise<JsonRpcResponse | JsonRpcError> {
  const { id, method, params } = request;

  // MCP handshake
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: MCP_VERSION,
        serverInfo: {
          name: "titan-mcp",
          version: "2026.10.68",
        },
        capabilities: {
          tools: {},
        },
      },
    };
  }

  // Tool discovery
  if (method === "tools/list") {
    const tools = await fetchTools();
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.parameters,
        })),
      },
    };
  }

  // Tool execution
  if (method === "tools/call") {
    const callParams = params as { name: string; arguments?: Record<string, unknown> };
    if (!callParams?.name) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32602,
          message: "Invalid params: missing 'name'",
        },
      };
    }

    try {
      const result = await callTool(callParams.name, callParams.arguments ?? {});
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        },
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: (err as Error).message,
        },
      };
    }
  }

  // Unknown method
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32601,
      message: `Method not found: ${method}`,
    },
  };
}

// ============================================================
// stdio Transport
// ============================================================

async function runStdioServer() {
  console.log("TITAN MCP Server — Starting on stdio...\n");
  console.log(`Connected to TITAN gateway at ${TITAN_URL}`);
  console.log("Waiting for MCP client...\n");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const request = JSON.parse(line) as JsonRpcRequest;
      const response = await handleRequest(request);
      process.stdout.write(JSON.stringify(response) + "\n");
    } catch (err) {
      const errorResponse: JsonRpcError = {
        jsonrpc: "2.0",
        id: 0,
        error: {
          code: -32700,
          message: `Parse error: ${(err as Error).message}`,
        },
      };
      process.stdout.write(JSON.stringify(errorResponse) + "\n");
    }
  }
}

// ============================================================
// HTTP Transport (Optional)
// ============================================================

async function runHttpServer(port: number = 48421) {
  console.log(`TITAN MCP Server — Starting HTTP on port ${port}...\n`);
  console.log(`Connected to TITAN gateway at ${TITAN_URL}`);
  console.log(`MCP endpoint: http://localhost:${port}/mcp\n`);

  const { createServer } = await import("node:http");

  const server = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/mcp") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }

      try {
        const request = JSON.parse(body) as JsonRpcRequest;
        const response = await handleRequest(request);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            error: {
              code: -32700,
              message: (err as Error).message,
            },
          }),
        );
      }
    } else if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(
        "TITAN MCP Server\n\nUse POST /mcp with JSON-RPC 2.0 requests.",
      );
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  server.listen(port);
  console.log(`HTTP server listening on :${port}`);
}

// ============================================================
// Entry Point
// ============================================================

const transport = process.env.MCP_TRANSPORT ?? "stdio";

if (transport === "http") {
  const port = parseInt(process.env.MCP_PORT ?? "48421", 10);
  runHttpServer(port).catch(console.error);
} else {
  runStdioServer().catch(console.error);
}
