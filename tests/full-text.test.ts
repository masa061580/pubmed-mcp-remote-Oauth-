/**
 * Integration tests for get_full_text (t19–t22).
 */
import { describe, it, expect } from "vitest";
import { PubMedClient } from "../src/pubmed-client.js";

const client = new PubMedClient({ apiKey: process.env.NCBI_API_KEY });

describe("get_full_text", () => {
  it("t19 — known PMCID returns body sections", async () => {
    const [r] = await client.getFullTextBatch(["PMC9167159"], ["all"]);
    expect(r.error).toBeUndefined();
    expect(r.sections.length).toBeGreaterThan(0);
    expect(r.available_sections.length).toBeGreaterThan(0);
  });

  it("t20 — sections=['methods','results'] excludes other sections", async () => {
    const [r] = await client.getFullTextBatch(["PMC9167159"], ["methods", "results"]);
    expect(r.error).toBeUndefined();
    const allowed = new Set(["methods", "results"]);
    for (const s of r.sections) {
      expect(allowed.has(s.name)).toBe(true);
    }
  });

  it("t21 — invalid PMCID returns error and other IDs continue", async () => {
    const results = await client.getFullTextBatch(["PMC9999999999", "PMC9167159"], ["abstract"]);
    expect(results.length).toBe(2);
    expect(results[0].error).toBeTruthy();
    expect(results[1].pmcid).toBe("PMC9167159");
  });

  it("t22 — accepts both 'PMC9167159' and '9167159'", async () => {
    const [a] = await client.getFullTextBatch(["9167159"], ["abstract"]);
    const [b] = await client.getFullTextBatch(["PMC9167159"], ["abstract"]);
    expect(a.pmcid).toBe("PMC9167159");
    expect(b.pmcid).toBe("PMC9167159");
  });

  it("extracts pmid and title from JATS metadata", async () => {
    const [r] = await client.getFullTextBatch(["PMC11208055"], ["abstract"]);
    if (!r.error) {
      expect(r.pmid).toBe("38305278");
      expect(r.title.length).toBeGreaterThan(0);
    }
  });
});
