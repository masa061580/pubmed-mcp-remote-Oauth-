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
import {
  registerUserKeyTools,
  userKeyKvKey,
  maskKey,
  validateNcbiKey,
} from "./user-key.js";

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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

    // Stateless mode has no server-initiated notifications, so the standalone
    // GET SSE stream would never emit anything. Return 405 so MCP clients stop
    // re-opening it (otherwise the Workers runtime kills the hung stream and
    // clients reconnect in a tight loop).
    if (request.method === "GET") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null,
        }),
        {
          status: 405,
          headers: {
            Allow: "POST, DELETE, OPTIONS",
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    // Create a fresh McpServer + transport per request (stateless mode)
    const server = new McpServer({
      name: "PubMed MCP Server",
      version: "1.2.0",
    });

    // OAuthProvider exposes the grant's props on ctx.props.
    // `sub` is the user's pseudonymous Google account ID (set in handleCallback);
    // undefined for tokens issued before per-user key support.
    const props = (ctx as ExecutionContext & { props?: { sub?: string } }).props;
    const sub = props?.sub;

    // Per-user NCBI API key takes precedence; server-shared key is the fallback.
    const ownKey = sub ? await env.OAUTH_KV.get(userKeyKvKey(sub)) : null;
    registerTools(server, ownKey ?? env.NCBI_API_KEY);
    registerUserKeyTools(server, {
      kv: env.OAUTH_KV,
      sub,
      hasOwnKey: !!ownKey,
      sharedKeyAvailable: !!env.NCBI_API_KEY,
    });

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

    // ── /callback/complete: key-settings form submission ──
    if (url.pathname === "/callback/complete" && request.method === "POST") {
      return handleCallbackComplete(request, env);
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
            "get_ncbi_api_key_status", "delete_ncbi_api_key",
          ],
          ncbi_key_registration:
            "Per-user NCBI API keys are registered on the settings page shown after Google sign-in (reconnect the server to open it)",
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

  const tokens = (await tokenResponse.json()) as {
    access_token: string;
    id_token?: string;
  };

  // Only the pseudonymous Google `sub` claim is kept (needed to scope
  // per-user NCBI API keys); no email or profile data is collected.
  const sub = decodeJwtSub(tokens.id_token);

  // Without a stable user ID, per-user keys are unavailable — finish the
  // MCP authorization immediately (legacy behavior, shared key).
  if (!sub) {
    return completeAndRedirect(env, oauthReq, undefined);
  }

  // Show the NCBI API key settings page before completing the MCP flow
  // (ChatGPT-style post-auth interstitial). The key is entered here in the
  // browser and never passes through any chat conversation.
  const nonce = crypto.randomUUID();
  await env.OAUTH_KV.put(
    `pending_auth:${nonce}`,
    JSON.stringify({ oauthReq, sub }),
    { expirationTtl: 600 }
  );

  const existing = await env.OAUTH_KV.get(userKeyKvKey(sub));
  return htmlResponse(
    renderKeyPage({ nonce, maskedKey: existing ? maskKey(existing) : null, error: null })
  );
}

// ─── /callback/complete ─────────────────────────────────────────────

async function handleCallbackComplete(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const nonce = typeof form.get("nonce") === "string" ? (form.get("nonce") as string) : "";
  const action = form.get("action");
  const apiKey = typeof form.get("api_key") === "string" ? (form.get("api_key") as string).trim() : "";

  if (!nonce) return new Response("Missing nonce", { status: 400 });

  const pendingRaw = await env.OAUTH_KV.get(`pending_auth:${nonce}`);
  if (!pendingRaw) {
    return htmlResponse(
      renderExpiredPage(),
      410
    );
  }
  const { oauthReq, sub } = JSON.parse(pendingRaw) as { oauthReq: unknown; sub: string };

  if (action === "save" && apiKey) {
    const check = await validateNcbiKey(apiKey);
    if (!check.ok) {
      // Keep the pending state so the user can retry with a corrected key.
      const existing = await env.OAUTH_KV.get(userKeyKvKey(sub));
      return htmlResponse(
        renderKeyPage({
          nonce,
          maskedKey: existing ? maskKey(existing) : null,
          error: "NCBIにキーを拒否されました。入力ミスがないかご確認ください。",
        }),
        400
      );
    }
    await env.OAUTH_KV.put(userKeyKvKey(sub), apiKey);
  } else if (action === "delete") {
    await env.OAUTH_KV.delete(userKeyKvKey(sub));
  }
  // action === "skip" (or empty save): change nothing

  await env.OAUTH_KV.delete(`pending_auth:${nonce}`);
  return completeAndRedirect(env, oauthReq, sub);
}

// ─── Shared helpers ─────────────────────────────────────────────────

async function completeAndRedirect(
  env: Env,
  oauthReq: unknown,
  sub: string | undefined
): Promise<Response> {
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq as Parameters<OAuthHelpers["completeAuthorization"]>[0]["request"],
    userId: sub ?? "authenticated-user",
    metadata: { label: "Google User" },
    scope: (oauthReq as { scope?: string[] }).scope || [],
    props: sub ? { sub } : {},
  });
  return Response.redirect(redirectTo, 302);
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function renderKeyPage(opts: {
  nonce: string;
  maskedKey: string | null;
  error: string | null;
}): string {
  const { nonce, maskedKey, error } = opts;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>NCBI APIキー設定 | PubMed MCP</title>
<style>
  body { font-family: -apple-system, "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif;
         background: #f4f6f8; color: #1c2733; margin: 0; padding: 24px 16px; line-height: 1.7; }
  .card { max-width: 560px; margin: 4vh auto; background: #fff; border-radius: 12px;
          box-shadow: 0 2px 12px rgba(20, 40, 60, 0.08); padding: 32px 28px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #5a6b7b; font-size: 13.5px; margin: 0 0 20px; }
  .status { background: #f0f4f8; border-radius: 8px; padding: 12px 16px; font-size: 14px; margin-bottom: 20px; }
  .status b { color: #0b6e4f; }
  .error { background: #fdecea; color: #b3261e; border-radius: 8px; padding: 12px 16px;
           font-size: 14px; margin-bottom: 20px; }
  label { display: block; font-weight: 600; font-size: 14px; margin-bottom: 6px; }
  input[type="text"] { width: 100%; box-sizing: border-box; font-family: ui-monospace, Menlo, monospace;
         font-size: 14px; padding: 10px 12px; border: 1px solid #c3cdd6; border-radius: 8px; }
  input[type="text"]:focus { outline: 2px solid #2563eb; border-color: transparent; }
  .hint { font-size: 12.5px; color: #5a6b7b; margin: 8px 0 20px; }
  .hint a { color: #2563eb; }
  .btns { display: flex; flex-direction: column; gap: 10px; }
  button { font-size: 15px; font-weight: 600; padding: 12px 16px; border-radius: 8px;
           border: 1px solid transparent; cursor: pointer; }
  .primary { background: #2563eb; color: #fff; }
  .primary:hover { background: #1d4ed8; }
  .secondary { background: #fff; color: #1c2733; border-color: #c3cdd6; }
  .secondary:hover { background: #f0f4f8; }
  .danger { background: #fff; color: #b3261e; border-color: #e7b6b2; font-weight: 500; font-size: 13.5px; }
  .danger:hover { background: #fdecea; }
  .note { font-size: 12px; color: #8393a2; margin-top: 20px; }
</style>
</head>
<body>
<div class="card">
  <h1>NCBI APIキー設定</h1>
  <p class="sub">PubMed MCP Server — Google認証が完了しました</p>

  ${error ? `<div class="error">${error}</div>` : ""}

  <div class="status">${
    maskedKey
      ? `登録済みキー: <b>${maskedKey}</b>（あなた専用の 10リクエスト/秒 で動作中）`
      : `キー未登録 — 現在はサーバー共有キー（全員で 10リクエスト/秒 を共有）で動作します`
  }</div>

  <form method="POST" action="/callback/complete" autocomplete="off">
    <input type="hidden" name="nonce" value="${nonce}">
    <label for="api_key">あなたのNCBI APIキー${maskedKey ? "（変更する場合のみ入力）" : ""}</label>
    <input type="text" id="api_key" name="api_key" spellcheck="false" autocomplete="off"
           placeholder="例: 4b9c...（36文字前後の英数字）">
    <p class="hint">
      キーを登録すると、PubMed検索が<b>あなた専用の10リクエスト/秒</b>になります。<br>
      キーは <a href="https://account.ncbi.nlm.nih.gov/settings/" target="_blank" rel="noopener">NCBIアカウント設定</a>
      から無料で取得できます（API Key Management欄）。<br>
      入力されたキーは保存前にNCBIで検証されます。チャットには絶対に貼らないでください。
    </p>
    <div class="btns">
      <button class="primary" type="submit" name="action" value="save">保存して接続を完了</button>
      <button class="secondary" type="submit" name="action" value="skip">${
        maskedKey ? "変更せずに接続を完了" : "登録せずに接続を完了（共有キーを使用）"
      }</button>
      ${
        maskedKey
          ? `<button class="danger" type="submit" name="action" value="delete">登録済みキーを削除して接続を完了</button>`
          : ""
      }
    </div>
  </form>

  <p class="note">キーはこのサーバー（Cloudflare KV）にのみ保存され、キーの登録状況の確認・削除はチャットのツール
  （get_ncbi_api_key_status / delete_ncbi_api_key）からも行えます。</p>
</div>
</body>
</html>`;
}

function renderExpiredPage(): string {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>セッション期限切れ | PubMed MCP</title></head>
<body style="font-family: -apple-system, 'Hiragino Kaku Gothic ProN', sans-serif; padding: 40px; text-align: center;">
<h1 style="font-size: 20px;">セッションの有効期限が切れました</h1>
<p>お手数ですが、MCPクライアント（Claudeなど）から接続をやり直してください。</p>
</body></html>`;
}

/**
 * Extract the `sub` claim from a Google id_token. The token was received
 * directly from Google's token endpoint over TLS, so signature verification
 * is not required here.
 */
function decodeJwtSub(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  try {
    const payload = idToken.split(".")[1];
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as {
      sub?: unknown;
    };
    return typeof json.sub === "string" && json.sub.length > 0 ? json.sub : undefined;
  } catch {
    return undefined;
  }
}

// ─── Export Worker ──────────────────────────────────────────────────

// The library types its handlers with `unknown` env generics while ours are
// typed as Env; the shapes are runtime-compatible, so bridge the generics.
type ProviderOptions = ConstructorParameters<typeof OAuthProvider>[0];

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: McpApiHandler as unknown as ProviderOptions["apiHandler"],
  defaultHandler: DefaultHandler as unknown as ProviderOptions["defaultHandler"],
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["openid"],
});
