# SalesBuildr MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for integrating with the SalesBuildr quoting and sales platform. Built with a decision-tree architecture to expose domain-specific tools without overwhelming the LLM.

## Architecture

The server uses a **decision tree** pattern:

1. At root, only `salesbuildr_navigate` is exposed
2. User selects a domain (companies, contacts, products, opportunities, quotes)
3. Domain-specific tools become available along with `salesbuildr_back`
4. Tool calls route to domain handlers that interact with the SalesBuildr API

### Interactive Quote Card (MCP Apps)

`salesbuildr_quotes_get` renders as an interactive, read-only quote card in
MCP Apps hosts (Claude Desktop/web) — title, status, company/contact, dates,
line items, and totals; plain-JSON behavior is unchanged in other hosts.
The card is neutral by default and brandable via `window.__BRAND__` injection
or `MCP_BRAND_*` env vars (`MCP_BRAND_NAME`, `MCP_BRAND_LOGO_URL`,
`MCP_BRAND_PRIMARY_COLOR`, `MCP_BRAND_ACCENT_COLOR`, `MCP_BRAND_BG`,
`MCP_BRAND_TEXT`) — no rebuild needed.

## Domains

| Domain | Tools | Description |
|--------|-------|-------------|
| **companies** | 5 | Company/account management (list, get, create, update, delete) |
| **contacts** | 5 | Contact management (list, get, create, update, delete) |
| **products** | 2 | Product catalog (list, get) |
| **opportunities** | 4 | Sales pipeline (list, get, create, update) |
| **quotes** | 3 | Quote management with line items (list, get, create) |

## One-Click Deployment

> [!IMPORTANT]
> **Before you click:** this server depends on `@wyre-technology/node-salesbuildr`,
> which is hosted on the **GitHub Packages** npm registry. GitHub Packages has no
> anonymous access — even though the package is public, every `npm install` needs a
> token. The cloud builder runs `npm install` for you, so you must give it one, or
> the build fails with `npm error 401 Unauthorized ... npm.pkg.github.com`.
>
> 1. Create a GitHub **Personal Access Token** with the `read:packages` scope
>    ([classic token](https://github.com/settings/tokens/new?scopes=read:packages&description=salesbuildr-mcp%20deploy)).
>    Any GitHub account works — you do **not** need to be a member of the
>    `wyre-technology` org to read its public packages.
> 2. Add it as a build variable when prompted by the deploy flow:
>    - **Cloudflare Workers** → set a build variable named **`NODE_AUTH_TOKEN`** to your PAT
>      (Workers → Settings → Build → Variables and Secrets).
>    - **DigitalOcean App Platform** → set an encrypted env var named **`GITHUB_TOKEN`**
>      with scope **Build Time** to your PAT (the Dockerfile reads it for the install).

[![Deploy to DO](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/WYRE-AI/salesbuildr-mcp/tree/main)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/WYRE-AI/salesbuildr-mcp)

## Installation

This package is published to the **GitHub Packages** npm registry, which requires a
token even for public packages. Authenticate once, then install:

```bash
# Authenticate npm to GitHub Packages (token needs the read:packages scope)
export NODE_AUTH_TOKEN=$(gh auth token)   # or a PAT with read:packages

npm install @wyre-ai/salesbuildr-mcp
```

The repo's `.npmrc` already points the `@wyre-technology` scope at GitHub Packages and
reads the token from `NODE_AUTH_TOKEN`, so no further config is needed.

## Configuration

Copy [`.env.example`](.env.example). Stdio and `AUTH_MODE=env` read the SalesBuildr variables. Gateway mode does not.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SALESBUILDR_API_KEY` | For stdio and `AUTH_MODE=env` | - | SalesBuildr API key |
| `SALESBUILDR_BASE_URL` | No | Library default | Tenant-specific base URL (e.g. `https://mytenant.salesbuildr.com`) |
| `MCP_TRANSPORT` | No | `stdio` | `stdio` or `http` |
| `MCP_HTTP_PORT` | No | `8080` | HTTP server port |
| `MCP_HTTP_HOST` | No | `0.0.0.0` when a real secret is set | Bind address when `CONDUIT_S2S_SECRET` is set. The container image sets `0.0.0.0`. Without a secret, `MCP_ALLOW_INSECURE_DEV=1` binds `127.0.0.1` instead. |
| `AUTH_MODE` | No | `env` outside the image | `env` or `gateway`. The container image and Compose default to `gateway`. Gateway mode requires `X-SalesBuildr-API-Key` on each `/mcp` request and never falls back to `SALESBUILDR_*`. |
| `CONDUIT_S2S_SECRET` | Yes for HTTP | - | Service-to-service secret. The HTTP server logs an error and exits non-zero when this is empty or a known placeholder. Compose will not start without it. Never commit a real value. Generate one with `openssl rand -hex 32`. |
| `MCP_ALLOW_INSECURE_DEV` | No | unset | Set to `1` only for local development to start HTTP without `CONDUIT_S2S_SECRET`. The process logs a warning, does not enforce `X-Gateway-S2S`, and binds `127.0.0.1` only. A non-loopback `MCP_HTTP_HOST` refuses startup. A known placeholder secret is still refused. |

`/health` and `/healthz` stay unauthenticated and do not read credentials. The stdio transport does not use `CONDUIT_S2S_SECRET`.

### HTTP authentication

With `MCP_TRANSPORT=http` and `CONDUIT_S2S_SECRET` set, every `/mcp` request must include `X-Gateway-S2S`. The value is `t=<unix seconds>,v1=<hex>`, where `v1` is HMAC-SHA256 of the exact string `t=<unix seconds>` keyed by `CONDUIT_S2S_SECRET` (64 lowercase hex characters). The timestamp must be within 300 seconds of the server clock. A missing or invalid header returns 401. The secret is never written to logs.

```js
import { createHmac } from "node:crypto";

const t = Math.floor(Date.now() / 1000);
const v1 = createHmac("sha256", process.env.CONDUIT_S2S_SECRET)
  .update(`t=${t}`)
  .digest("hex");
const xGatewayS2s = `t=${t},v1=${v1}`;
```

In `AUTH_MODE=gateway`, `/mcp` also requires `X-SalesBuildr-API-Key`. That header is the only credential source for the request. A request missing it returns 401 and does not read `SALESBUILDR_API_KEY` from the environment.

### Stdio Mode (Claude Desktop)

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "salesbuildr": {
      "command": "npx",
      "args": ["@wyre-ai/salesbuildr-mcp"],
      "env": {
        "SALESBUILDR_API_KEY": "your-api-key"
      }
    }
  }
}
```

### HTTP Mode (Gateway)

```bash
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" MCP_TRANSPORT=http AUTH_MODE=gateway node dist/index.js
```

In gateway mode, pass credentials via request headers. The gateway also signs each request with `X-Gateway-S2S` (see [HTTP authentication](#http-authentication)):

```
X-Gateway-S2S: t=<unix seconds>,v1=<hex hmac-sha256>
X-SalesBuildr-API-Key: your-api-key
```

### Docker

The image listens on `0.0.0.0` inside the container (`MCP_HTTP_HOST`) and defaults to `AUTH_MODE=gateway`. Publish the port on loopback and pass a real S2S secret. In gateway mode, the SalesBuildr API key arrives on each request as `X-SalesBuildr-API-Key`; it is not read from the environment.

```bash
docker run -d \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -p 127.0.0.1:8080:8080 \
  ghcr.io/wyre-ai/salesbuildr-mcp:latest
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset, sets `AUTH_MODE=gateway`, does not set `SALESBUILDR_API_KEY` or `env_file`, and publishes `127.0.0.1:8080:8080`:

```bash
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" docker compose up
```

Single-tenant HTTP (`AUTH_MODE=env`) still requires the S2S secret, then uses `SALESBUILDR_API_KEY`:

```bash
docker run -d \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -e AUTH_MODE=env \
  -e SALESBUILDR_API_KEY=your-api-key \
  -p 127.0.0.1:8080:8080 \
  ghcr.io/wyre-ai/salesbuildr-mcp:latest
```

Local HTTP without a secret is development-only. It binds `127.0.0.1` and logs a warning. A non-loopback `MCP_HTTP_HOST` makes startup exit:

```bash
MCP_TRANSPORT=http MCP_ALLOW_INSECURE_DEV=1 npm start
```

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Type check
npm run typecheck

# Build
npm run build

# Run locally (stdio)
SALESBUILDR_API_KEY=your-key npm start

# Run locally (HTTP). Refuses to start until CONDUIT_S2S_SECRET is a real secret.
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" MCP_TRANSPORT=http SALESBUILDR_API_KEY=your-key npm start

# Local HTTP only, without a service-to-service secret (always binds 127.0.0.1)
MCP_TRANSPORT=http MCP_ALLOW_INSECURE_DEV=1 npm start
```

## License

Apache-2.0
