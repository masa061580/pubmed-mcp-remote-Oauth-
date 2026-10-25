# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Repository Overview

PubMed MCP server deployed on Cloudflare Workers with Google OAuth 2.1 authentication. Provides access to NCBI PubMed/PMC research data through the Model Context Protocol (MCP).

Built with TypeScript using:
- `@modelcontextprotocol/sdk` — MCP server with WebStandard Streamable HTTP transport
- `@cloudflare/workers-oauth-provider` — OAuth 2.1 provider
- `zod` — Input validation

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Local dev server (port 8787)
npm run deploy       # Deploy to Cloudflare Workers
npm run type-check   # TypeScript type checking
npm test             # Run vitest (integration tests hit live NCBI)
```

### Testing with MCP Inspector
```bash
npx @modelcontextprotocol/inspector
# Enter URL: http://localhost:8787/mcp (local) or https://<worker>.workers.dev/mcp (production)
```

### Cloudflare Setup
```bash
wrangler login
wrangler kv namespace create OAUTH_KV          # Create KV, update wrangler.jsonc with ID
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put COOKIE_ENCRYPTION_KEY       # openssl rand -hex 32
wrangler secret put NCBI_API_KEY                # Optional
```

## Architecture

### Entry Point (`src/index.ts`)
- `OAuthProvider` (workers-oauth-provider 1.x) wraps the entire worker. It is built per request
  origin with `resourceMetadata.resource = ${origin}/mcp`, because the Worker is served on both
  the custom domain and workers.dev and 1.x binds every token to one canonical resource (RFC 8707)
- `/mcp` route → `McpApiHandler` (authenticated MCP endpoint)
- `/authorize` → redirects to Google OAuth consent
- `/callback` → exchanges Google code for tokens, completes MCP OAuth flow
- `/` → JSON info page

### MCP Tools (`src/tools.ts`)
9 tools registered on a stateless `McpServer`:
1. **search** — PubMed queries with MeSH; supports `output_mode` (minimal/compact/full), `retmax` 1-500, `retstart` pagination, `sort` (relevance/pub_date/first_author), and structured `filters` (date_range, publication_types, languages, humans_only, has_abstract, free_full_text). Response includes `total/showing/retstart/next_start/query_translation`.
2. **fetch** — Single PMID abstract (OpenAI MCP compliant). HTML entities decoded.
3. **fetch_batch** — Multiple PMID abstracts. `include_abstract: false` strips the abstract field. Returns `mesh_terms` and `publication_types`.
4. **get_full_text** — PMC full-text via JATS XML. Accepts an array of PMCIDs and an optional `sections` filter (abstract/introduction/methods/results/discussion/conclusions/references/all).
5. **count** — Result count only (fast)
6. **find_similar_articles** — MeSH/title-based similarity
7. **export_to_ris** — RIS format for citation managers
8. **get_citation_counts** — NIH iCite API
9. **convert_ids** — PMID ⇔ PMCID ⇔ DOI conversion via NCBI ID Converter API

### PubMed Client (`src/pubmed-client.ts`)
- NCBI E-utilities: esearch, esummary, efetch, elink
- PMC OA Service for PDF URLs
- iCite API for citation counts
- NCBI ID Converter API (`pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/`)
- Simple XML parsing (regex-based, no DOMParser needed in Workers)
- HTML entity decoding via `he` package on titles/abstracts/authors/journal
- JATS section classifier maps `sec-type` / `<title>` text to canonical section keys
- Filter builder wraps original query in parens: `(query) AND (filter1) AND (filter2)`
- 429 retry with exponential backoff (1s/2s/4s, max 3 attempts)
- 30s `AbortSignal.timeout` on every fetch

### RIS Exporter (`src/ris-exporter.ts`)
Minimal RIS format: PMID, title, first author, journal, year, DOI. Citation managers auto-fetch full metadata.

## Key Design Decisions

- **Stateless transport**: Each request creates fresh McpServer + transport. No session persistence needed.
- **No DOMParser**: Cloudflare Workers doesn't have DOMParser, so XML parsing uses regex.
- **OAuth flow**: OAuthProvider handles token management; Google provides identity. Auth state stored in KV with 10-min TTL.
- **CORS**: Permissive CORS headers added to MCP responses for browser-based clients.

## NCBI API Compliance
- Always include `tool` and `email` params
- Respect rate limits (3 req/s without key, 10 req/s with key)
- Use POST for large ID lists
- Handle 429 with retry

## Per-user NCBI API keys (v1.1.0, 2026-08)

Users can register their own NCBI API key so NCBI's 10 req/s per-key limit applies per user
instead of sharing the server's fallback `NCBI_API_KEY` secret.

- Registration UI (v1.2.0): a key-settings page is shown right after Google sign-in in the
  OAuth flow (`/callback` renders it; form posts to `/callback/complete` with a one-time nonce
  stored as `pending_auth:<nonce>` in KV). Keys are validated against NCBI einfo before saving.
  There is deliberately NO chat tool for setting keys — pasting secrets into chat exposes them
  in conversation logs and assistants refuse to handle them.
- Chat tools: `get_ncbi_api_key_status`, `delete_ncbi_api_key` (read/delete only, no secrets)
- Storage: `OAUTH_KV` under `ncbi_key:<google-sub>` (plaintext). Only the pseudonymous Google `sub`
  claim is kept (decoded from the id_token in `handleCallback`) — no email/profile data, preserving
  the no-personal-info design.
- Key resolution per request (`src/index.ts` McpApiHandler): user's own key → `env.NCBI_API_KEY` → none.
- Tokens issued before v1.1.0 have empty props (no `sub`): those sessions fall back to the shared key
  and the management tools ask the user to re-authenticate.
- URLs: `https://pubmed-mcp.med-ai-lounge.com/mcp` (custom domain, dashboard-managed) and the
  workers.dev URL coexist.
