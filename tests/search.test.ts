/**
 * Integration tests for PubMed search (hits real NCBI).
 * Covers t01–t15 from SPEC §8.1.
 */
import { describe, it, expect } from "vitest";
import { PubMedClient } from "../src/pubmed-client.js";
import { shapeSearchResult } from "../src/tools.js";

const client = new PubMedClient({ apiKey: process.env.NCBI_API_KEY });

describe("search (live NCBI)", () => {
  it("t01 — runs with default options (compact)", async () => {
    const r = await client.searchPubmed("cancer", { retmax: 3, withSummary: true });
    const shaped = r.items.map((i) => shapeSearchResult(i, "compact"));
    expect(shaped.length).toBeGreaterThan(0);
    for (const s of shaped) {
      expect(s.id).toBeTruthy();
      expect(s.journal).toBeDefined();
    }
  });

  it("t02 — minimal returns exactly 4 fields", async () => {
    const r = await client.searchPubmed("cancer", { retmax: 2, withSummary: true });
    const shaped = r.items.map((i) => shapeSearchResult(i, "minimal"));
    for (const s of shaped) {
      expect(Object.keys(s).sort()).toEqual(
        ["full_text_available", "id", "title", "url"].sort()
      );
    }
  });

  it("t03 — compact includes journal/year/authors/doi/pmcid", async () => {
    const r = await client.searchPubmed("cancer", { retmax: 2, withSummary: true });
    const shaped = r.items.map((i) => shapeSearchResult(i, "compact")) as any[];
    for (const s of shaped) {
      expect(s).toHaveProperty("journal");
      expect(s).toHaveProperty("year");
      expect(s).toHaveProperty("authors");
      expect(s).toHaveProperty("doi");
      expect(s).toHaveProperty("pmcid");
    }
  });

  it("t04 — full includes abstract / mesh_terms / publication_types", async () => {
    const r = await client.searchPubmed('"meta-analysis"[pt]', { retmax: 2, withSummary: true });
    const abs = await client.getAbstracts(r.items.map((i) => i.pmid));
    const byPmid: Record<string, any> = {};
    for (const a of abs) byPmid[a.pmid] = a;
    const shaped = r.items.map((i) => shapeSearchResult(i, "full", byPmid[i.pmid])) as any[];
    expect(shaped.length).toBeGreaterThan(0);
    for (const s of shaped) {
      expect(s).toHaveProperty("abstract");
      expect(s).toHaveProperty("mesh_terms");
      expect(s).toHaveProperty("publication_types");
      expect(Array.isArray(s.publication_types)).toBe(true);
    }
  });

  it("t05 — publication_types filter reduces hit count", async () => {
    const base = await client.searchPubmed("diabetes", { retmax: 1, withSummary: false });
    const filtered = await client.searchPubmed("diabetes", {
      retmax: 1,
      withSummary: false,
      filters: { publication_types: ["Meta-Analysis"] },
    });
    expect(filtered.total).toBeLessThan(base.total);
    expect(filtered.total).toBeGreaterThan(0);
  });

  it("t06 — date_range constrains years (older window to avoid epub-vs-print drift)", async () => {
    const r = await client.searchPubmed("cancer", {
      retmax: 5,
      withSummary: true,
      filters: { date_range: { start: "2020", end: "2022" } },
    });
    expect(r.items.length).toBeGreaterThan(0);
    for (const item of r.items) {
      const yr = parseInt(item.year, 10);
      // Allow ±1y drift between [dp] filter and esummary pubdate (epub vs print).
      expect(yr).toBeGreaterThanOrEqual(2019);
      expect(yr).toBeLessThanOrEqual(2023);
    }
  });

  it("t07 — humans_only reduces count", async () => {
    const base = await client.searchPubmed("aspirin", { retmax: 1, withSummary: false });
    const filt = await client.searchPubmed("aspirin", {
      retmax: 1,
      withSummary: false,
      filters: { humans_only: true },
    });
    expect(filt.total).toBeLessThan(base.total);
  });

  it("t08 — languages filter is reflected in query_translation", async () => {
    const r = await client.searchPubmed("cancer", {
      retmax: 1,
      withSummary: false,
      filters: { languages: ["eng"] },
    });
    expect(r.query_translation.toLowerCase()).toContain("english");
  });

  it("t09 — retstart=0 vs retstart=10 returns different PMIDs", async () => {
    const a = await client.searchPubmed("cancer", { retmax: 5, retstart: 0, withSummary: false });
    const b = await client.searchPubmed("cancer", { retmax: 5, retstart: 10, withSummary: false });
    const idsA = a.items.map((i) => i.pmid).join(",");
    const idsB = b.items.map((i) => i.pmid).join(",");
    expect(idsA).not.toEqual(idsB);
  });

  it("t10 — total/showing/next_start consistency", async () => {
    const r = await client.searchPubmed("cancer", { retmax: 5, retstart: 0, withSummary: false });
    expect(r.total).toBeGreaterThan(0);
    expect(r.items.length).toBeLessThanOrEqual(5);
    const nextStart = r.retstart + r.items.length < r.total ? r.retstart + r.items.length : null;
    if (nextStart !== null) expect(nextStart).toBe(5);
  });

  it("t11 — query_translation always present", async () => {
    const r = await client.searchPubmed("diabetes", { retmax: 1, withSummary: false });
    expect(r.query_translation.length).toBeGreaterThan(0);
  });

  it("t12 — retmax=500 succeeds", async () => {
    const r = await client.searchPubmed("cancer", { retmax: 500, withSummary: false });
    expect(r.items.length).toBeLessThanOrEqual(500);
    expect(r.items.length).toBeGreaterThan(100);
  });

  it("t13 — zero hits returns empty results, query_translation present", async () => {
    const r = await client.searchPubmed(
      '"this_query_should_return_no_results_xyzzy_42"[tiab]',
      { retmax: 10, withSummary: true }
    );
    expect(r.total).toBe(0);
    expect(r.items.length).toBe(0);
    expect(r.query_translation).toBeDefined();
  });

  it("t14 — sort=first_author runs", async () => {
    const r = await client.searchPubmed("cancer", {
      retmax: 3,
      withSummary: false,
      sort: "first_author",
    });
    expect(r.items.length).toBeGreaterThan(0);
  });

  it("t15 — backward compat: query+retmax produces minimum fields", async () => {
    const r = await client.searchPubmed("cancer", { retmax: 2, withSummary: true });
    const shaped = r.items.map((i) => shapeSearchResult(i, "minimal")) as any[];
    for (const s of shaped) {
      expect(s.id).toBeTruthy();
      expect(typeof s.title).toBe("string");
      expect(s.url.startsWith("https://pubmed.ncbi.nlm.nih.gov/")).toBe(true);
      expect(typeof s.full_text_available).toBe("boolean");
    }
  });
});
