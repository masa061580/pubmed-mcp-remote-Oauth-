/**
 * PubMed MCP Server — Cloudflare Workers with Google OAuth 2.1
 *
 * Wires together:
 * - OAuth 2.1 provider (@cloudflare/workers-oauth-provider)
 * - MCP server (@modelcontextprotocol/sdk with WebStandard Streamable HTTP)
 * - PubMed tools
 */

import OAuthProvider, {
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerTools } from "./tools.js";

// ─── Types ──────────────────────────────────────────────────────────

export interface Env {
  OAUTH_KV: KVNamespace;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  NCBI_API_KEY?: string;
  // Injected by OAuthProvider at runtime
  OAUTH_PROVIDER: OAuthHelpers;
}

// ─── MCP API Handler ────────────────────────────────────────────────

const McpApiHandler: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, mcp-session-id, mcp-protocol-version",
        },
      });
    }

    // Create a fresh McpServer + transport per request (stateless mode)
    const server = new McpServer({
      name: "PubMed MCP Server",
      version: "1.0.0",
    });

    registerTools(server, env.NCBI_API_KEY);

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    await server.connect(transport);

    const response = await transport.handleRequest(request);

    // Inject CORS headers
    const headers = new Headers(response.headers);
    headers.set("Access-Control-Allow-Origin", "*");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};

// ─── Default Handler (handles /authorize, /callback, and all other non-API routes) ───

const DefaultHandler: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ── /authorize: Start Google OAuth flow ──
    if (url.pathname === "/authorize") {
      return handleAuthorize(request, env);
    }

    // ── /callback: Google redirects back here ──
    if (url.pathname === "/callback") {
      return handleCallback(request, env);
    }

    // ── / : Info page ──
    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({
          name: "PubMed MCP Server",
          description: "PubMed/PMC research data via MCP with Google OAuth",
          mcp_endpoint: "/mcp",
          tools: [
            "search", "fetch", "fetch_batch", "get_full_text",
            "count", "find_similar_articles", "export_to_ris", "get_citation_counts",
            "convert_ids", "batch_process",
          ],
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("Not Found", { status: 404 });
  },
};

// ─── /authorize ─────────────────────────────────────────────────────

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  // Parse the MCP client's OAuth request via OAuthHelpers
  const oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  if (!oauthReq.clientId) {
    return new Response("Missing client_id", { status: 400 });
  }

  // Store the parsed OAuth request in KV so /callback can complete the flow
  const stateKey = `oauth_state:${oauthReq.state}`;
  await env.OAUTH_KV.put(stateKey, JSON.stringify(oauthReq), {
    expirationTtl: 600,
  });

  // Redirect to Google OAuth consent screen
  const callbackUrl = `${new URL(request.url).origin}/callback`;

  const googleAuthUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  googleAuthUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  googleAuthUrl.searchParams.set("redirect_uri", callbackUrl);
  googleAuthUrl.searchParams.set("response_type", "code");
  googleAuthUrl.searchParams.set("scope", "openid");
  googleAuthUrl.searchParams.set("state", oauthReq.state);
  googleAuthUrl.searchParams.set("access_type", "online");
  googleAuthUrl.searchParams.set("prompt", "consent");

  return Response.redirect(googleAuthUrl.toString(), 302);
}

// ─── /callback ──────────────────────────────────────────────────────

async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return new Response(`OAuth error from Google: ${error}`, { status: 400 });
  }
  if (!code || !state) {
    return new Response("Missing code or state parameter", { status: 400 });
  }

  // Retrieve stored OAuth request
  const stateKey = `oauth_state:${state}`;
  const storedRaw = await env.OAUTH_KV.get(stateKey);
  if (!storedRaw) {
    return new Response("Invalid or expired state", { status: 400 });
  }
  await env.OAUTH_KV.delete(stateKey);

  const oauthReq = JSON.parse(storedRaw);

  // Exchange Google authorization code for tokens
  const callbackUrl = `${url.origin}/callback`;
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: callbackUrl,
      grant_type: "authorization_code",
    }).toString(),
  });

  if (!tokenResponse.ok) {
    const errBody = await tokenResponse.text();
    return new Response(`Google token exchange failed: ${errBody}`, { status: 502 });
  }

  const tokens = (await tokenResponse.json()) as { access_token: string };

  // Complete the MCP OAuth flow — issues token to the MCP client
  // No personal info is collected (scope: openid only)
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: "authenticated-user",
    metadata: { label: "Google User" },
    scope: oauthReq.scope || [],
    props: {},
  });

  return Response.redirect(redirectTo, 302);
}

// ─── Export Worker ──────────────────────────────────────────────────

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: McpApiHandler,
  defaultHandler: DefaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["openid"],
});
