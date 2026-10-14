/**
 * Cloudflare Workers entry point for the SalesBuildr MCP Server.
 *
 * Serves the full MCP server over the Streamable HTTP transport using the SDK's
 * Web Standard transport (Request/Response), which runs natively on Workers.
 * It reuses the exact same `createMcpServer()` factory as the stdio / Node HTTP
 * entrypoints (see `mcp-server.ts`), so there is no second tool implementation
 * to maintain.
 *
 * Credentials are resolved per request, in order:
 * 1. Gateway header (when AUTH_MODE=gateway):
 *    - X-SalesBuildr-API-Key (required; blank values are rejected; no env fallback)
 * 2. Worker secrets / vars (env mode):
 *    - SALESBUILDR_API_KEY
 *    - SALESBUILDR_BASE_URL (optional)
 *
 * Per-request isolation uses the same AsyncLocalStorage-backed credentialStore
 * the Node HTTP transport uses (nodejs_compat provides node:async_hooks on
 * workerd). `tools/list` and `initialize` work without credentials; only
 * `tools/call` requires them.
 *
 * The client returned by `utils/client.ts`'s `getClient()` reads the same
 * AsyncLocalStorage store directly and builds a fresh, uncached client per
 * request when it's populated — there is no module-level client cache to
 * reset between requests here.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "./mcp-server.js";
import {
  credentialStore,
  type RequestCredentials,
} from "./utils/credential-store.js";

export interface Env {
  SALESBUILDR_API_KEY?: string;
  SALESBUILDR_BASE_URL?: string;
  AUTH_MODE?: string;
  LOG_LEVEL?: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, X-SalesBuildr-API-Key",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Run the MCP request through a fresh server + Web Standard transport.
 * getClient() (see utils/client.ts) reads the AsyncLocalStorage scope this
 * request runs in directly, so credentials/client are always request-scoped
 * with no reset step needed here.
 */
async function handleMcp(request: Request): Promise<Response> {
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);

  try {
    const response = await transport.handleRequest(request);
    return withCors(response);
  } finally {
    await transport.close();
    await server.close();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Shallow, unauthenticated liveness probe.
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      return json({ status: "ok" });
    }

    if (url.pathname === "/mcp") {
      const isGatewayMode = (env.AUTH_MODE ?? "env") === "gateway";

      if (isGatewayMode) {
        const apiKey = request.headers.get("x-salesbuildr-api-key")?.trim() || undefined;
        if (!apiKey) {
          return json(
            {
              error: "Missing credentials",
              message: "Missing credentials: X-SalesBuildr-API-Key",
              required: ["X-SalesBuildr-API-Key"],
            },
            401
          );
        }
        const creds: RequestCredentials = { apiKey };
        return credentialStore.run(creds, () => handleMcp(request));
      }

      // env mode: build credentials from Worker secrets if present.
      // (Absent creds are fine — tools/list still works, tools/call errors.)
      if (env.SALESBUILDR_API_KEY) {
        const creds: RequestCredentials = {
          apiKey: env.SALESBUILDR_API_KEY,
          ...(env.SALESBUILDR_BASE_URL ? { baseUrl: env.SALESBUILDR_BASE_URL } : {}),
        };
        return credentialStore.run(creds, () => handleMcp(request));
      }

      return handleMcp(request);
    }

    return json(
      { error: "Not found", endpoints: ["/mcp", "/health"] },
      404
    );
  },
};
