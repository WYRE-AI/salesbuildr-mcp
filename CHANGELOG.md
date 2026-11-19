## [Unreleased]

### Added

- **EU SalesBuildr hosts on the base-URL allowlist.** Gateway
  `X-SalesBuildr-Base-URL` (and the same normalizer used elsewhere) now
  accepts `https://*.eu1-salesbuildr.com` in addition to
  `https://*.salesbuildr.com`. A bare host or full https URL works for EU
  tenants (e.g. `wilroffreitsma.eu1-salesbuildr.com`); a bare single label
  like `acme` still maps to `https://acme.salesbuildr.com`. Apex hosts and
  SSRF lookalikes (`eu1-salesbuildr.com.evil.com`,
  `evileu1-salesbuildr.com`) remain rejected.

### Security

- **Fixed a cross-tenant credential leak in gateway mode.** `getClient()` in
  `src/utils/client.ts` cached the constructed vendor client in a
  module-level `_client` singleton regardless of whether the credentials
  came from the per-request `AsyncLocalStorage`-backed `credentialStore`
  (gateway mode) or `process.env` (stdio/env mode). Callers (`worker.ts`,
  `index.ts`) called `resetClient()` at the *start* of each HTTP request
  handler, before `server.connect()` / `transport.handleRequest()` ever
  awaited anything. That reset-at-request-start did not prevent overlap:
  under concurrent requests, whichever tenant's request reached
  `getClient()` first populated the shared singleton, and any other
  tenant's request still in flight read that same cached instance instead
  of building its own — moving the reset earlier just moved the race
  window, it didn't close it. Fixed by making `getClient()` build a fresh,
  uncached client directly from the request-scoped credentials whenever
  they're present, so it never reads from or writes to the singleton. The
  `_client` singleton itself is now used only for the stdio/env-mode path,
  where credentials come from `process.env` and are fixed for the lifetime
  of the process (a single tenant, nothing to race). The
  reset-at-request-start calls in `worker.ts` and `index.ts` were removed —
  there is no longer anything request-scoped to reset. Also switched
  `client.ts`'s SDK import from a dynamic `await import()` to a static
  top-level import: a dynamic import of a module that is also
  `vi.mock()`-intercepted can race under concurrent test execution and
  resolve to the real, un-mocked SDK for one of the concurrent calls (a
  test-only concern — Node's real dynamic `import()` is cache-deduped in
  production). New regression tests in `src/__tests__/client.test.ts` and
  `src/__tests__/gateway-concurrency.test.ts` force a deterministic
  interleave via a manually-resolved deferred promise (not a timer) and
  assert on the actual per-tenant credential/client values, not just object
  identity.

### Added

- **Gateway mode accepts an optional `X-SalesBuildr-Base-URL` header (WYREAI-794).**
  After `X-Gateway-S2S` verifies, a per-request tenant API base may be supplied
  as a subdomain (`acme`) or a full `https://acme.salesbuildr.com` /
  `https://acme.salesbuildr.com/public-api` URL. The host is allowlisted to
  `*.salesbuildr.com` (https only, no userinfo, port 443 only; the apex is
  rejected). A missing header leaves the client on the library default
  (`https://portal.salesbuildr.com/public-api`). A present invalid or blank
  value returns HTTP 400 and does not fall back to portal. Gateway mode still
  never reads `SALESBUILDR_BASE_URL` from the environment. The Worker CORS
  allow-list also includes `X-SalesBuildr-Base-URL`.

- **Interactive quote card via MCP Apps (SEP-1865).** `salesbuildr_quotes_get` results now
  render as an interactive, read-only card in MCP Apps hosts (Claude Desktop/web, and other
  hosts advertising the `io.modelcontextprotocol/ui` extension) — quote title, status,
  company/contact names, created/expiry dates, line items, and totals. Non-App hosts are
  unaffected: the tool's JSON payload is unchanged apart from a new `_card` field.
  - The card is **brand-neutral by default** (system fonts, neutral palette, no baked-in
    identity — this is a published server) and brandable without rebuilding:
    `MCP_BRAND_NAME`, `MCP_BRAND_LOGO_URL`, `MCP_BRAND_PRIMARY_COLOR`,
    `MCP_BRAND_ACCENT_COLOR`, `MCP_BRAND_BG`, and `MCP_BRAND_TEXT` env vars are injected
    as `window.__BRAND__` at serve time (a gateway can inject the same object per-org).
    A test pins the default bundle to zero brand identity and zero external font fetches.
  - The renderable tool advertises the UI via `_meta` (`ui/resourceUri`, plus the nested
    `ui.resourceUri` form) pointing at a new `ui://salesbuildr/quote-card.html` resource
    served as `text/html;profile=mcp-app` (the server now declares the `resources`
    capability). The card HTML is a self-contained vite single-file bundle embedded at
    build time (`src/generated/quote-card-html.ts`, committed), so it serves identically
    from stdio, Node HTTP, and the fs-less Cloudflare Workers runtime.
  - The card payload builder (`src/card.builder.ts`) is best-effort: a missing company
    name is resolved with one existing `companies.get` lookup, lookup failures fall back
    to `#id` labels, and a non-renderable payload just drops the card without affecting
    the tool result. Contract tests in `src/__tests__/mcp-apps.test.ts` pin the `_meta`
    advertisement, the `ui://` resource wire shape, card normalization, brand neutrality,
    and injection escaping.
  - New `npm run build:ui` regenerates the embedded HTML after editing `ui/` (requires
    the new `vite`, `vite-plugin-singlefile`, and `@modelcontextprotocol/ext-apps`
    devDependencies); plain `npm run build` and CI are unaffected.

### Fixed

- Upgraded `@wyre-technology/node-salesbuildr` to `^1.0.2`, inheriting the SDK's
  single-read HTTP response fix: response bodies are now read exactly once, so failed
  API calls surface descriptive error messages instead of being swallowed as empty `{}`
  bodies. See the
  [node-salesbuildr v1.0.2 release](https://github.com/wyre-technology/node-salesbuildr/releases/tag/v1.0.2);
  the pattern was originally identified in
  [connectwise-automate-mcp#54](https://github.com/wyre-technology/connectwise-automate-mcp/issues/54).
- One-click cloud deploys (Cloudflare Workers, DigitalOcean) no longer fail with
  `npm error 401 Unauthorized` from `npm.pkg.github.com`. The `.npmrc` now carries the
  GitHub Packages auth-token line (`${NODE_AUTH_TOKEN}`) so operators can supply their own
  `read:packages` PAT as a build variable (the Dockerfile already wrote a temporary
  authenticated `.npmrc` from the `GITHUB_TOKEN` build arg before `npm ci`).

### Changed

- `@semantic-release/npm` now publishes to GitHub Packages (`npmPublish: true`); the
  package is scoped (`@wyre-technology/salesbuildr-mcp`) with `publishConfig` already set
  and the release workflow already has `packages: write`.
- README documents creating a `read:packages` PAT and setting `NODE_AUTH_TOKEN`
  (Cloudflare) / build-time `GITHUB_TOKEN` (DigitalOcean) before deploying or installing.

## [1.2.3](https://github.com/wyre-technology/salesbuildr-mcp/compare/v1.2.2...v1.2.3) (2026-04-07)


### Bug Fixes

* **ci:** deploy :latest tag, force revision via env var bump ([3998795](https://github.com/wyre-technology/salesbuildr-mcp/commit/3998795b9550e2f912a353ef0454bcd566c3ed1c))

## [1.2.2](https://github.com/wyre-technology/salesbuildr-mcp/compare/v1.2.1...v1.2.2) (2026-04-06)


### Bug Fixes

* per-request MCP Server+Transport for gateway compatibility ([f072b09](https://github.com/wyre-technology/salesbuildr-mcp/commit/f072b098577cad5945d405164a0e35a97154d2dc))

## [1.2.1](https://github.com/wyre-technology/salesbuildr-mcp/compare/v1.2.0...v1.2.1) (2026-04-06)


### Bug Fixes

* allow unauthenticated tools/list in gateway mode ([f4e7d4b](https://github.com/wyre-technology/salesbuildr-mcp/commit/f4e7d4b9a1aa9de5e7d15eac0ad70f9ea906dff3))

# [1.2.0](https://github.com/wyre-technology/salesbuildr-mcp/compare/v1.1.5...v1.2.0) (2026-03-10)


### Features

* **elicitation:** add MCP elicitation support with graceful fallback ([1fb17f0](https://github.com/wyre-technology/salesbuildr-mcp/commit/1fb17f07024c8ecce71954300001465d50596bcf))

## [1.1.5](https://github.com/wyre-technology/salesbuildr-mcp/compare/v1.1.4...v1.1.5) (2026-03-02)


### Bug Fixes

* **ci:** fix broken YAML in Discord notification step ([9b0035c](https://github.com/wyre-technology/salesbuildr-mcp/commit/9b0035c2a85bfc419d6c425fb147ed132202de5f))
* **ci:** move Discord notification into release workflow ([91e2b28](https://github.com/wyre-technology/salesbuildr-mcp/commit/91e2b284545ebdc185906ea1a162a0c9f12e87b6))
* support SALESBUILDR_BASE_URL for tenant-specific subdomains ([#29](https://github.com/wyre-technology/salesbuildr-mcp/issues/29)) ([3436f10](https://github.com/wyre-technology/salesbuildr-mcp/commit/3436f10cccece9a60ea479d13d759bc40583b86e))

## [Unreleased]

### Added

- `SALESBUILDR_BASE_URL` environment variable support — pass your tenant-specific subdomain URL (e.g. `https://mytenant.salesbuildr.com`) to override the library default base URL (fixes #29)

## [1.1.4](https://github.com/wyre-technology/salesbuildr-mcp/compare/v1.1.3...v1.1.4) (2026-02-25)


### Bug Fixes

* add missing node-salesbuildr dependency to Docker image ([#2](https://github.com/wyre-technology/salesbuildr-mcp/issues/2)) ([b91ea44](https://github.com/wyre-technology/salesbuildr-mcp/commit/b91ea442ec26956ea72cf6bd5bb190b7c13e08ec)), closes [#1](https://github.com/wyre-technology/salesbuildr-mcp/issues/1)

## [1.1.3](https://github.com/wyre-technology/salesbuildr-mcp/compare/v1.1.2...v1.1.3) (2026-02-23)


### Bug Fixes

* quote MCPB bundle filename to prevent shell glob expansion failure ([a654bb1](https://github.com/wyre-technology/salesbuildr-mcp/commit/a654bb15e5f9cd41cf61f8e7246e1f4972abfae8))
* rename duplicate step id 'version' to 'release-version' in docker job ([63472cb](https://github.com/wyre-technology/salesbuildr-mcp/commit/63472cb7e95d8f991d0178d0d56acce1df14f695))

## [1.1.2](https://github.com/wyre-technology/salesbuildr-mcp/compare/v1.1.1...v1.1.2) (2026-02-18)


### Bug Fixes

* **ci:** convert pack-mcpb.js to ESM imports ([0990ee1](https://github.com/wyre-technology/salesbuildr-mcp/commit/0990ee1a8a9d90b75a1036787f90ffff7a8840c9))

## [1.1.1](https://github.com/wyre-technology/salesbuildr-mcp/compare/v1.1.0...v1.1.1) (2026-02-18)


### Bug Fixes

* **ci:** fix release workflow failures ([b9e4e5a](https://github.com/wyre-technology/salesbuildr-mcp/commit/b9e4e5a94c8cb055fa55c614a08da2d1d5ac8c8c))

# [1.1.0](https://github.com/wyre-technology/salesbuildr-mcp/compare/v1.0.1...v1.1.0) (2026-02-17)


### Features

* add MCPB bundle to release workflow ([f6607ec](https://github.com/wyre-technology/salesbuildr-mcp/commit/f6607ec1da527ac71f0481a5aa3f47ce83e4ae2b))
* add MCPB manifest for desktop installation ([5f643d0](https://github.com/wyre-technology/salesbuildr-mcp/commit/5f643d0fc5acc49a6bc392a08b80577fe06ef0d7))
* add MCPB pack script ([3e622ba](https://github.com/wyre-technology/salesbuildr-mcp/commit/3e622baaff04cf6af8dc4b3552cb97cda7560b98))
* add pack:mcpb script ([1044401](https://github.com/wyre-technology/salesbuildr-mcp/commit/1044401894e77d3ec524b368d5fade0d3e7c95bb))

## [1.0.1](https://github.com/wyre-technology/salesbuildr-mcp/compare/v1.0.0...v1.0.1) (2026-02-17)


### Bug Fixes

* **docker:** drop arm64 platform to fix QEMU build failures ([3385293](https://github.com/wyre-technology/salesbuildr-mcp/commit/33852931ab557bcfdfda6daf1615ffb1cb036761))

# 1.0.0 (2026-02-17)


### Features

* initial SalesBuildr MCP server ([551768b](https://github.com/wyre-technology/salesbuildr-mcp/commit/551768bf73bc16d1de4888cd35711cdc77ea61ee))

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial MCP server implementation with decision-tree architecture
- Five domains: companies, contacts, products, opportunities, quotes
- `salesbuildr_navigate` tool for domain selection
- `salesbuildr_back` tool for returning to domain selection
- Companies domain: list, get, create, update, delete
- Contacts domain: list, get, create, update, delete
- Products domain: list, get
- Opportunities domain: list, get, create, update
- Quotes domain: list, get, create (with line items support)
- Stdio and HTTP (StreamableHTTP) transport support
- Gateway mode with header-based authentication (`x-salesbuildr-api-key`)
- Health check endpoint at `/health`
- Docker multi-stage build with non-root user
- CI/CD with GitHub Actions (test, release, Docker)
- Semantic release configuration
