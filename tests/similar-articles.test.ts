/**
 * Tests for elink-based find_similar_articles.
 * Reference: PMID 32371116 (Repici 2020, AI-colonoscopy RCT).
 */
import { describe, it, expect } from "vitest";
import { PubMedClient } from "../src/pubmed-client.js";

const client = new PubMedClient({ apiKey: process.env.NCBI_API_KEY });

describe("find_similar_articles (elink)", () => {
  it("returns AI/colonoscopy-related articles for Repici 2020", async () => {
    const r = await client.findSimilarArticles("32371116", 20);
    expect(r.error).toBeNull();
    expect(r.similar_articles.length).toBeGreaterThan(0);

    // Heuristic: at least one of the top-20 hits should mention colonoscopy/polyp/adenoma
    // in the title (similar topic). NCBI's pubmed_pubmed link is content-based.
    const haystack = r.similar_articles
      .map((a) => a.title.toLowerCase())
      .join(" | ");
    const onTopic =
      /colonoscop|polyp|adenoma|colorectal|endoscop/i.test(haystack);
    expect(onTopic).toBe(true);
  });

  it("returns empty for a junk PMID", async () => {
    const r = await client.findSimilarArticles("99999999999", 5);
    // Should not throw; either error or empty.
    expect(r.similar_articles.length).toBe(0);
  });
});
