#!/usr/bin/env node
/**
 * SalesBuildr MCP Server
 *
 * This MCP server provides tools for interacting with the SalesBuildr API.
 * All tools are listed upfront so they work with every MCP client, including
 * remote connectors (claude.ai, mcp-remote) that do not support dynamic
 * tool-list changes. A helper `salesbuildr_navigate` tool provides domain
 * discovery and guidance.
 *
 * Supports both stdio and HTTP transports:
 * - stdio: default, for local CLI usage
 * - http: set MCP_TRANSPORT=http for hosted/gateway deployments
 *
 * The shared, side-effect-free server factory lives in `mcp-server.ts` and is
 * reused by the Cloudflare Workers entrypoint (`worker.ts`).
 *
 * Authentication:
 * - env (default outside the image): SALESBUILDR_API_KEY from the environment
 * - gateway: X-SalesBuildr-API-Key on each request. Missing headers are
 *   rejected. There is no SALESBUILDR_* fallback.
 *
 * HTTP transport refuses to start unless CONDUIT_S2S_SECRET is a real secret.
 * A known placeholder is never accepted. MCP_ALLOW_INSECURE_DEV=1 is a
 * local-only escape hatch for an empty secret: it logs a warning, skips
 * X-Gateway-S2S, and listens on 127.0.0.1 only. A configured secret still
 * honors MCP_HTTP_HOST (default 0.0.0.0). /health and /healthz stay
 * unauthenticated. stdio does not use S2S auth.
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp-server.js";
import { credentialStore } from "./utils/credential-store.js";
import { verifyS2sHeader, S2S_HEADER } from "./s2s-verify.js";

/**
 * Public example values. A copied placeholder must not verify as a real
 * secret, and it is not bypassed by MCP_ALLOW_INSECURE_DEV.
 */
export const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-real-secret",
  "your-s2s-secret",
  "your-secret",
  "changeme",
  "change-me",
  "placeholder",
  "secret",
  "example",
  "replace-me",
  "s2s-secret",
]);

const MISSING_S2S_SECRET_ERROR =
  "Refusing to start HTTP server: CONDUIT_S2S_SECRET is empty. " +
  "Set CONDUIT_S2S_SECRET to the gateway-provisioned secret (openssl rand -hex 32), " +
  "or set MCP_ALLOW_INSECURE_DEV=1 for local development only.";

const PLACEHOLDER_S2S_SECRET_ERROR =
  "Refusing to start HTTP server: CONDUIT_S2S_SECRET is a known placeholder. " +
  "Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value.";

const INSECURE_DEV_WARNING =
  "SECURITY WARNING: CONDUIT_S2S_SECRET is unset and MCP_ALLOW_INSECURE_DEV=1. " +
  "HTTP /mcp is starting with service-to-service authentication DISABLED, bound to 127.0.0.1 only. " +
  "Local development only; do not expose this port.";

const LOOPBACK_HOST = "127.0.0.1";
/** Bind used when a real secret is set and MCP_HTTP_HOST is unset. Container images set 0.0.0.0 explicitly. */
const SECRET_DEFAULT_HOST = "0.0.0.0";

const S2S_UNAUTHORIZED = {
  error:
    "Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.",
};

const GATEWAY_CREDENTIALS_UNAUTHORIZED = {
  error: "Missing credentials",
  message: "Missing credentials: X-SalesBuildr-API-Key",
  required: ["X-SalesBuildr-API-Key"],
};

/**
 * Transport and auth configuration types
 */
type TransportType = "stdio" | "http";

function exitWithError(message: string): never {
  console.error(message);
  process.exit(1);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 127.0.0.0/8, localhost, and ::1. Bracketed IPv6 forms count too. */
function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const bare = normalized.startsWith("::ffff:")
    ? normalized.slice("::ffff:".length)
    : normalized;
  const parts = bare.split(".");
  if (parts.length !== 4) return false;
  if (parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  return parts[0] === "127";
}

/**
 * Fail closed. An empty CONDUIT_S2S_SECRET used to skip X-Gateway-S2S.
 * Read at HTTP startup, not module load. A known placeholder is refused
 * even when MCP_ALLOW_INSECURE_DEV=1, so a copied example cannot sign
 * requests. The secret value is never logged.
 */
function resolveHttpS2sSecret(): { secret: string; insecureDev: boolean } {
  const raw = (process.env.CONDUIT_S2S_SECRET ?? "").trim();
  if (raw && KNOWN_PLACEHOLDER_SECRETS.has(raw.toLowerCase())) {
    exitWithError(PLACEHOLDER_S2S_SECRET_ERROR);
  }
  if (raw) return { secret: raw, insecureDev: false };
  if (process.env.MCP_ALLOW_INSECURE_DEV === "1") {
    console.error("================================================================");
    console.error(INSECURE_DEV_WARNING);
    console.error("================================================================");
    return { secret: "", insecureDev: true };
  }
  exitWithError(MISSING_S2S_SECRET_ERROR);
}

/**
 * No secret: bind 127.0.0.1 only. A non-loopback MCP_HTTP_HOST refuses to
 * start and is logged. A real secret honors MCP_HTTP_HOST, including
 * 0.0.0.0, so container deploys stay on the image bind address.
 */
function resolveBindHost(insecureDev: boolean): string {
  const configured = (process.env.MCP_HTTP_HOST ?? "").trim();
  if (!insecureDev) return configured || SECRET_DEFAULT_HOST;
  if (configured === "" || configured === LOOPBACK_HOST) return LOOPBACK_HOST;
  if (isLoopbackHost(configured)) {
    console.error(
      `WARNING: MCP_HTTP_HOST=${configured} is loopback, but MCP_ALLOW_INSECURE_DEV=1 binds ${LOOPBACK_HOST} only.`
    );
    return LOOPBACK_HOST;
  }
  exitWithError(
    "Refusing to start HTTP server: MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET only binds 127.0.0.1. " +
      `MCP_HTTP_HOST=${configured} is not loopback. Unset MCP_HTTP_HOST or set it to 127.0.0.1.`
  );
}

/**
 * Start the server with stdio transport (default)
 */
async function startStdioTransport(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SalesBuildr MCP server running on stdio");
}

/**
 * Start the server with HTTP Streamable transport.
 * In gateway mode, credentials must arrive on X-SalesBuildr-API-Key.
 * A request missing that header is rejected and does not fall back to
 * SALESBUILDR_* in process.env. Each request gets a fresh Server +
 * Transport (stateless).
 */
export async function startHttpTransport(): Promise<HttpServer> {
  const { secret: s2sSecret, insecureDev } = resolveHttpS2sSecret();
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const host = resolveBindHost(insecureDev);
  const isGatewayMode = process.env.AUTH_MODE === "gateway";

  const httpServer = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(
        req.url || "/",
        `http://${req.headers.host || "localhost"}`
      );

      // /health is container liveness, not credential readiness. Gateway
      // credentials arrive per request, so this must not read them.
      if (url.pathname === "/health" || url.pathname === "/healthz") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            transport: "http",
            authMode: isGatewayMode ? "gateway" : "env",
            timestamp: new Date().toISOString(),
          })
        );
        return;
      }

      // MCP endpoint
      if (url.pathname === "/mcp") {
        // Empty s2sSecret is only reachable when MCP_ALLOW_INSECURE_DEV=1.
        // A configured secret is always enforced. Placeholder secrets never
        // reach this point — startup already exited. Rejected before any
        // credential extraction.
        if (s2sSecret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), s2sSecret)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify(S2S_UNAUTHORIZED));
          return;
        }

        // Credentials are stored in AsyncLocalStorage so concurrent
        // requests are isolated — no process.env mutation.
        const apiKey = headerValue(req.headers["x-salesbuildr-api-key"]);

        const handleMcp = () => {
          const server = createMcpServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          });

          res.on("close", () => {
            transport.close();
            server.close();
          });

          server.connect(transport).then(() => {
            transport.handleRequest(req, res);
          });
        };

        // Gateway mode: credentials must arrive on this request. Falling
        // through would resolve SALESBUILDR_* from the process environment,
        // which is not request-scoped.
        if (isGatewayMode) {
          if (!apiKey) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify(GATEWAY_CREDENTIALS_UNAUTHORIZED));
            return;
          }
          credentialStore.run({ apiKey }, handleMcp);
          return;
        }

        handleMcp();
        return;
      }

      // 404 for everything else
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Not found",
          endpoints: ["/mcp", "/health"],
        })
      );
    }
  );

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, () => {
      console.error(
        `SalesBuildr MCP server listening on http://${host}:${port}/mcp`
      );
      console.error(
        `Health check available at http://${host}:${port}/health`
      );
      console.error(
        `Authentication mode: ${isGatewayMode ? "gateway (header-based)" : "env (environment variables)"}`
      );
      resolve();
    });
  });

  return httpServer;
}

/**
 * Main entry point - selects transport based on MCP_TRANSPORT env var
 */
async function main() {
  const transportType =
    (process.env.MCP_TRANSPORT as TransportType) || "stdio";

  if (transportType === "http") {
    const httpServer = await startHttpTransport();
    const shutdown = async () => {
      console.error("Shutting down SalesBuildr MCP server...");
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else {
    await startStdioTransport();
  }
}

// Vitest imports this module to call startHttpTransport. Skip the CLI
// entrypoint there. `node dist/index.js` still starts stdio or HTTP.
if (process.env.VITEST !== "true") {
  // Handle unhandled promise rejections
  process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
    process.exit(1);
  });

  // Handle uncaught exceptions
  process.on("uncaughtException", (error) => {
    console.error("Uncaught Exception:", error);
    process.exit(1);
  });

  main().catch(console.error);
}
