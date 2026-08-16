/**
 * Per-user NCBI API key management tools.
 *
 * Each authenticated user can register their own NCBI API key so that
 * NCBI's per-key rate limit (10 req/s) applies per user instead of being
 * shared across everyone through the server's fallback key.
 *
 * Storage: OAUTH_KV under `ncbi_key:<google-sub>`. The Google `sub` claim is
 * a pseudonymous stable account ID — no email or profile data is stored,
 * preserving this server's no-personal-info design.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const KEY_PREFIX = "ncbi_key:";

export function userKeyKvKey(sub: string): string {
  return `${KEY_PREFIX}${sub}`;
}

function maskKey(key: string): string {
  return key.length <= 8 ? "****" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/**
 * Functional validation: hit einfo with the key. NCBI responds with
 * HTTP 400 / "API key invalid" for bad keys.
 */
async function validateNcbiKey(key: string): Promise<{ ok: boolean; detail: string }> {
  const url =
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi?retmode=json&api_key=" +
    encodeURIComponent(key);
  try {
    const res = await fetch(url);
    const text = await res.text();
    if (res.ok && !/API key invalid/i.test(text)) return { ok: true, detail: "" };
    return { ok: false, detail: text.slice(0, 200) };
  } catch (e) {
    return { ok: false, detail: `NCBI request failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function textResult(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj) }] };
}

export interface UserKeyContext {
  kv: KVNamespace;
  /** Google `sub` of the current user; undefined for tokens issued before sub support. */
  sub?: string;
  /** Whether the current request is already using the user's own key. */
  hasOwnKey: boolean;
  /** Whether the server has a shared fallback key configured. */
  sharedKeyAvailable: boolean;
}

const REAUTH_HINT =
  "Your session token predates per-user key support, so your account ID is not available. " +
  "Disconnect and reconnect (re-authenticate) this MCP server, then try again.";

export function registerUserKeyTools(server: McpServer, ctx: UserKeyContext) {
  // ─── set_ncbi_api_key ─────────────────────────────────────────────
  server.tool(
    "set_ncbi_api_key",
    "Register your own NCBI API key for this account. Your PubMed requests will then use your " +
      "personal 10 req/s NCBI rate limit instead of the server's shared key. " +
      "Get a free key at NCBI Account Settings (https://account.ncbi.nlm.nih.gov/settings/). " +
      "The key is validated against NCBI before saving.",
    {
      api_key: z.string().min(20).max(80).describe("Your NCBI API key from account.ncbi.nlm.nih.gov/settings"),
    },
    async ({ api_key }) => {
      if (!ctx.sub) return textResult({ ok: false, error: REAUTH_HINT });

      const key = api_key.trim();
      const check = await validateNcbiKey(key);
      if (!check.ok) {
        return textResult({
          ok: false,
          error: "NCBI rejected this API key — please check for typos.",
          ncbi_response: check.detail,
        });
      }

      await ctx.kv.put(userKeyKvKey(ctx.sub), key);
      return textResult({
        ok: true,
        message: `NCBI API key ${maskKey(key)} saved. From your next request onward, searches use your personal key (10 req/s dedicated to you).`,
      });
    }
  );

  // ─── get_ncbi_api_key_status ──────────────────────────────────────
  server.tool(
    "get_ncbi_api_key_status",
    "Show whether your own NCBI API key is registered for this account, and which key " +
      "(personal or server-shared) your requests currently use.",
    {},
    async () => {
      if (!ctx.sub) {
        return textResult({
          own_key_registered: false,
          using: ctx.sharedKeyAvailable ? "server-shared key" : "no key (3 req/s NCBI default)",
          note: REAUTH_HINT,
        });
      }
      const stored = await ctx.kv.get(userKeyKvKey(ctx.sub));
      return textResult({
        own_key_registered: !!stored,
        own_key: stored ? maskKey(stored) : null,
        using: stored
          ? "your personal key (10 req/s dedicated)"
          : ctx.sharedKeyAvailable
            ? "server-shared key (10 req/s shared among all users)"
            : "no key (3 req/s NCBI default)",
      });
    }
  );

  // ─── delete_ncbi_api_key ──────────────────────────────────────────
  server.tool(
    "delete_ncbi_api_key",
    "Delete your registered NCBI API key from this server. Your requests fall back to the " +
      "server's shared key.",
    {},
    async () => {
      if (!ctx.sub) return textResult({ ok: false, error: REAUTH_HINT });
      await ctx.kv.delete(userKeyKvKey(ctx.sub));
      return textResult({
        ok: true,
        message: ctx.sharedKeyAvailable
          ? "Your key was deleted. Requests now use the server-shared key."
          : "Your key was deleted. Requests now run without an API key (3 req/s NCBI default).",
      });
    }
  );
}
