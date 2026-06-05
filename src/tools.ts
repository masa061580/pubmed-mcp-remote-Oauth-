/**
 * MCP Tool definitions for PubMed server
 *
 * 9 tools: search, fetch, fetch_batch, get_full_text, count,
 *          find_similar_articles, export_to_ris, get_citation_counts, convert_ids
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { decode as htmlDecode } from "he";
import { PubMedClient, type ExtendedSearchItem, type AbstractItem } from "./pubmed-client.js";
import { exportMultipleToRis } from "./ris-exporter.js";

const SEARCH_FILTERS_SCHEMA = z
  .object({
    date_range: z
      .object({
        start: z.string().optional(),
        end: z.string().optional(),
      })
      .optional(),
    publication_types: z.array(z.string()).optional(),
    languages: z.array(z.string()).optional(),
    humans_only: z.boolean().optional(),
    has_abstract: z.boolean().optional(),
    free_full_text: z.boolean().optional(),
  })
  .optional();

export function registerTools(server: McpServer, apiKey?: string) {
  const client = new PubMedClient({ apiKey });

  // ─── 1. search ────────────────────────────────────────────────────

  server.tool(
    "search",
    "Search PubMed with MeSH support, structured filters, pagination, and selectable output verbosity. " +
      "output_mode=minimal returns id/title/url/full_text_available only (legacy-compatible); " +
      "compact (default) adds authors/journal/year/doi/pmcid; " +
      "full additionally includes abstract/mesh_terms/publication_types.",
    {
      query: z.string().describe("Search query string with MeSH/PubMed syntax support"),
      retmax: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe("Maximum results per page (1-500, default 50)"),
      retstart: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Result offset for pagination (default 0)"),
      sort: z
        .enum(["relevance", "pub_date", "first_author"])
        .default("relevance")
        .describe("Sort order"),
      output_mode: z
        .enum(["minimal", "compact", "full"])
        .default("compact")
        .describe("Output verbosity: minimal | compact (default) | full"),
      filters: SEARCH_FILTERS_SCHEMA.describe(
        "Structured filters AND-ed onto the query: date_range, publication_types, languages (ISO-3), humans_only, has_abstract, free_full_text"
      ),
    },
    async ({ query, retmax, retstart, sort, output_mode, filters }) => {
      const empty = {
        total: 0,
        showing: 0,
        retstart,
        next_start: null as number | null,
        query_translation: "",
        sort,
        results: [] as any[],
      };
      if (!query.trim()) {
        return { content: [{ type: "text" as const, text: JSON.stringify(empty) }] };
      }

      // For minimal/compact we always run esummary; only "full" additionally runs efetch.
      const searchRes = await client.searchPubmed(query, {
        retmax,
        retstart,
        sort,
        filters,
        withSummary: true,
      });

      let abstractsByPmid: Record<string, AbstractItem> = {};
      if (output_mode === "full" && searchRes.items.length > 0) {
        const abstracts = await client.getAbstracts(searchRes.items.map((i) => i.pmid));
        for (const a of abstracts) abstractsByPmid[a.pmid] = a;
      }

      const results = searchRes.items.map((item) =>
        shapeSearchResult(item, output_mode, abstractsByPmid[item.pmid])
      );

      const total = searchRes.total;
      const showing = results.length;
      const nextStart =
        retstart + showing < total && showing > 0 ? retstart + showing : null;

      const body = {
        total,
        showing,
        retstart,
        next_start: nextStart,
        query_translation: searchRes.query_translation,
        sort,
        results,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(body) }] };
    }
  );

  // ─── 2. fetch ─────────────────────────────────────────────────────

  server.tool(
    "fetch",
    "Retrieve abstract for a single PMID (OpenAI MCP compliant). Accepts exactly one PMID. For multiple PMIDs, use fetch_batch.",
    {
      id: z.string().describe("Single PubMed ID (PMID) — NO arrays or comma-separated values"),
    },
    async ({ id }) => {
      const pmid = id.trim();
      if (!pmid) throw new Error("Single document ID is required");
      if (pmid.includes(",") || pmid.includes("[")) {
        throw new Error("fetch accepts only a single PMID. Use fetch_batch for multiple PMIDs.");
      }

      const abstracts = await client.getAbstracts([pmid]);
      if (abstracts.length === 0) throw new Error(`No abstract found for PMID: ${pmid}`);

      const a = abstracts[0];
      const document = {
        id: pmid,
        title: a.title,
        text: a.abstract,
        url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
        metadata: {
          journal: a.journal,
          year: a.year,
          authors: capAuthors(a.authors),
          doi: a.doi,
        },
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(document) }] };
    }
  );

  // ─── 3. fetch_batch ───────────────────────────────────────────────

  server.tool(
    "fetch_batch",
    "Retrieve abstracts for multiple PMIDs in a single batch request. Returns structured data per PMID. " +
      "Set include_abstract=false to omit the abstract field (e.g., when you only need full author lists).",
    {
      pmids: z.array(z.string()).describe("List of PubMed IDs (PMIDs)"),
      include_abstract: z
        .boolean()
        .default(true)
        .describe("Whether to include the abstract field (default true)"),
    },
    async ({ pmids, include_abstract }) => {
      const unique = [...new Set(pmids.map((p) => p.trim()).filter(Boolean))];
      if (unique.length === 0) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ items: [] }) }] };
      }

      const abstracts = await client.getAbstracts(unique);
      const capped = abstracts.map((a) => ({ ...a, authors: capAuthors(a.authors) }));
      const items = include_abstract
        ? capped
        : capped.map(({ abstract: _abs, ...rest }) => rest);

      return { content: [{ type: "text" as const, text: JSON.stringify({ items }) }] };
    }
  );

  // ─── 4. get_full_text ─────────────────────────────────────────────

  server.tool(
    "get_full_text",
    "Retrieve full text of articles from PubMed Central (PMC) by PMC ID. Supports section filtering to reduce token usage.",
    {
      pmcIds: z
        .array(z.string())
        .min(1)
        .max(20)
        .describe("PMC IDs (with or without 'PMC' prefix). Max 20 per request."),
      sections: z
        .array(
          z.enum([
            "abstract",
            "introduction",
            "methods",
            "results",
            "discussion",
            "conclusions",
            "references",
            "all",
          ])
        )
        .default(["all"])
        .describe("Sections to extract. Use specific sections to reduce token usage."),
    },
    async ({ pmcIds, sections }) => {
      const items = await client.getFullTextBatch(pmcIds, sections);
      return { content: [{ type: "text" as const, text: JSON.stringify({ items }) }] };
    }
  );

  // ─── 5. count ─────────────────────────────────────────────────────

  server.tool(
    "count",
    "Get only the count of search results for query adjustment and optimization. Fast — retrieves no actual data. Useful for refining search strategies.",
    {
      query: z.string().describe("Search query string with MeSH/PubMed syntax support"),
    },
    async ({ query }) => {
      if (!query.trim()) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ query, count: 0, query_translation: "", warnings: [] }),
            },
          ],
        };
      }
      const result = await client.countSearch(query);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  // ─── 6. find_similar_articles ─────────────────────────────────────

  server.tool(
    "find_similar_articles",
    "Find similar articles for a given PMID using MeSH terms and title-based similarity. Useful for literature review and related research discovery.",
    {
      pmid: z.string().describe("PubMed ID of the reference article"),
      retmax: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum number of similar articles (1-100, default: 20)"),
    },
    async ({ pmid, retmax }) => {
      if (!pmid.trim()) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                reference_pmid: null,
                similar_articles: [],
                count: 0,
                error: "No PMID provided",
              }),
            },
          ],
        };
      }
      if (!/^\d+$/.test(pmid.trim())) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                reference_pmid: pmid,
                similar_articles: [],
                count: 0,
                error: "Invalid PMID format. PMID should be a numeric string.",
              }),
            },
          ],
        };
      }
      const result = await client.findSimilarArticles(pmid, retmax);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  // ─── 7. export_to_ris ────────────────────────────────────────────

  server.tool(
    "export_to_ris",
    "Export PubMed articles to RIS format for citation managers (EndNote/Zotero/Mendeley). Returns compact RIS with minimal metadata — citation managers auto-fetch the rest via PMID.",
    {
      pmids: z.array(z.string()).describe("List of PubMed IDs (PMIDs)"),
    },
    async ({ pmids }) => {
      const unique = [...new Set(pmids.map((p) => p.trim()).filter(Boolean))];
      if (unique.length === 0) {
        return { content: [{ type: "text" as const, text: "Error: No valid PMIDs provided" }] };
      }
      const abstracts = await client.getAbstracts(unique);
      if (abstracts.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: Could not retrieve data for PMIDs: ${unique.join(", ")}`,
            },
          ],
        };
      }
      const risText = exportMultipleToRis(abstracts);
      const header =
        `📄 RIS Export Complete (${abstracts.length} articles)\n\n` +
        "⚠️ IMPORTANT: This RIS file contains minimal metadata (PMID, title, first author only, journal, year, DOI).\n" +
        "Please use your citation manager (EndNote/Zotero/Mendeley) to retrieve complete information from PubMed.\n\n" +
        "Copy the text below and save as 'references.ris':\n\n" +
        "```ris\n";
      const footer =
        "```\n\n" +
        "✅ Ready for import into EndNote/Zotero/Mendeley\n" +
        '📝 After import, use your citation manager\'s "Update from PubMed" feature to fetch full author lists and abstracts';
      return { content: [{ type: "text" as const, text: `${header}${risText}${footer}` }] };
    }
  );

  // ─── 8. get_citation_counts ───────────────────────────────────────

  server.tool(
    "get_citation_counts",
    "Get citation counts for PMIDs. Default source is iCite (counts only, includes citations from outside PubMed). Set citing_source='pubmed' for elink-based PubMed-internal citations and to retrieve citing PMIDs (useful for backward snowballing).",
    {
      pmids: z.array(z.string()).describe("List of PubMed IDs (PMIDs), max 1000"),
      citing_source: z
        .enum(["icite", "pubmed"])
        .default("icite")
        .describe("'icite' (default, counts only) or 'pubmed' (elink, includes citing PMIDs)"),
      include_citing_pmids: z
        .boolean()
        .default(false)
        .describe("If true and citing_source='pubmed', include the list of citing PMIDs"),
    },
    async ({ pmids, citing_source, include_citing_pmids }) => {
      const unique = [...new Set(pmids.map((p) => p.trim()).filter(Boolean))];
      if (unique.length === 0) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ items: [] }) }] };
      }
      const results = await client.getCitationCounts(unique, {
        source: citing_source,
        includeCitingPmids: include_citing_pmids,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify({ items: results }) }] };
    }
  );

  // ─── 9. convert_ids ───────────────────────────────────────────────

  server.tool(
    "convert_ids",
    "Convert between PMID, PMCID, and DOI identifiers using NCBI ID Converter API.",
    {
      from_type: z.enum(["pmid", "pmcid", "doi"]).describe("Type of input identifiers"),
      to_type: z.enum(["pmid", "pmcid", "doi"]).describe("Desired output identifier type"),
      ids: z
        .array(z.string())
        .min(1)
        .max(200)
        .describe("List of identifiers to convert"),
    },
    async ({ from_type, to_type, ids }) => {
      const cleaned = [...new Set(ids.map((s) => s.trim()).filter(Boolean))];
      const result = await client.convertIds(cleaned, from_type, to_type);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  // ─── 10. batch_process ────────────────────────────────────────────

  server.tool(
    "batch_process",
    "Run multiple operations against the same set of PMIDs in one call. " +
      "Helpful for systematic-review style workflows. " +
      "operations is an array drawn from: 'abstract', 'citations', 'similar', 'ris_export', 'full_text'. " +
      "Respects NCBI rate limits via max_concurrency (default 3).",
    {
      pmids: z.array(z.string()).min(1).max(50).describe("PMIDs to operate on"),
      operations: z
        .array(z.enum(["abstract", "citations", "similar", "ris_export", "full_text"]))
        .min(1)
        .describe("Which operations to run"),
      max_concurrency: z.number().int().min(1).max(5).default(3),
    },
    async ({ pmids, operations, max_concurrency }) => {
      const unique = [...new Set(pmids.map((p) => p.trim()).filter(Boolean))];
      const tasks: Array<{ name: string; run: () => Promise<unknown> }> = [];

      if (operations.includes("abstract")) {
        tasks.push({
          name: "abstract",
          run: async () => ({
            items: (await client.getAbstracts(unique)).map((a) => ({
              ...a,
              authors: capAuthors(a.authors),
            })),
          }),
        });
      }
      if (operations.includes("citations")) {
        tasks.push({
          name: "citations",
          run: async () => ({ items: await client.getCitationCounts(unique) }),
        });
      }
      if (operations.includes("similar")) {
        tasks.push({
          name: "similar",
          run: async () => {
            const out: Record<string, unknown> = {};
            for (const p of unique) out[p] = await client.findSimilarArticles(p, 10);
            return { items: out };
          },
        });
      }
      if (operations.includes("ris_export")) {
        tasks.push({
          name: "ris_export",
          run: async () => {
            const abs = await client.getAbstracts(unique);
            return { ris: exportMultipleToRis(abs) };
          },
        });
      }
      if (operations.includes("full_text")) {
        tasks.push({
          name: "full_text",
          run: async () => {
            // Need PMCIDs — derive via id converter.
            const conv = await client.convertIds(unique, "pmid", "pmcid");
            const pmcIds = conv.conversions
              .map((c) => c.pmcid)
              .filter((x): x is string => !!x);
            if (pmcIds.length === 0) return { items: [] };
            return { items: await client.getFullTextBatch(pmcIds, ["all"]) };
          },
        });
      }

      const results: Record<string, unknown> = {};
      // Execute with bounded concurrency.
      let idx = 0;
      const workers = Array.from({ length: Math.min(max_concurrency, tasks.length) }, async () => {
        while (idx < tasks.length) {
          const i = idx++;
          const t = tasks[i];
          try {
            results[t.name] = await t.run();
          } catch (e: any) {
            results[t.name] = { error: e.message || String(e) };
          }
        }
      });
      await Promise.all(workers);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ pmids: unique, results }),
          },
        ],
      };
    }
  );
}

// ─── helpers ─────────────────────────────────────────────────────────

/**
 * Cap very long author lists to keep returned JSON compact.
 *
 * Consortium / multi-site trials can list dozens to hundreds of authors. When
 * the list exceeds `max`, keep the first `keep` names and append "et al." so the
 * model still gets the lead authors without flooding its context. Lists at or
 * below `max` are returned unchanged.
 */
export function capAuthors(authors: string[], max = 30, keep = 10): string[] {
  if (authors.length <= max) return authors;
  return [...authors.slice(0, keep), "et al."];
}

export function shapeSearchResult(
  item: ExtendedSearchItem,
  mode: "minimal" | "compact" | "full",
  abs?: AbstractItem
): Record<string, unknown> {
  const url = `https://pubmed.ncbi.nlm.nih.gov/${item.pmid}/`;
  const base = {
    id: item.pmid,
    title: item.title || "",
    url,
    full_text_available: item.full_text_available,
  };

  if (mode === "minimal") return base;

  if (mode === "compact") {
    const authorsCompact =
      item.authors.length === 0
        ? []
        : item.authors.length === 1
          ? [item.authors[0]]
          : [`${item.authors[0]} et al.`];
    return {
      ...base,
      authors: authorsCompact,
      journal: item.journal,
      year: item.year,
      doi: item.doi,
      pmcid: item.pmcid,
    };
  }

  // full mode
  return {
    ...base,
    authors: capAuthors(abs && abs.authors.length > 0 ? abs.authors : item.authors),
    journal: item.journal,
    year: item.year,
    doi: item.doi,
    pmcid: item.pmcid,
    pub_date: item.pubdate,
    abstract: abs ? htmlDecode(abs.abstract) : null,
    mesh_terms: abs?.mesh_terms ?? [],
    publication_types: abs?.publication_types ?? [],
  };
}
