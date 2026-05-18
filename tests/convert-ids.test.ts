import { describe, it, expect } from "vitest";
import { PubMedClient } from "../src/pubmed-client.js";

const client = new PubMedClient({ apiKey: process.env.NCBI_API_KEY });

describe("convert_ids", () => {
  it("converts PMCID to PMID", async () => {
    const r = await client.convertIds(["PMC9167159"], "pmcid", "pmid");
    expect(r.requested).toBe(1);
    expect(r.converted).toBe(1);
    expect(r.conversions[0].pmid).toBeTruthy();
  });

  it("converts DOI to PMID", async () => {
    const r = await client.convertIds(
      ["10.1038/s41598-024-77079-1"],
      "doi",
      "pmid"
    );
    expect(r.requested).toBe(1);
    // PMC may or may not have indexed this DOI; either way the structure is consistent.
    expect(r.conversions.length).toBe(1);
    expect(r.conversions[0].input).toBe("10.1038/s41598-024-77079-1");
  });

  it("reports failed IDs", async () => {
    const r = await client.convertIds(["NOT_A_REAL_ID_XYZ"], "pmid", "pmcid");
    expect(r.failed).toBe(1);
    expect(r.failedIds).toContain("NOT_A_REAL_ID_XYZ");
  });
});
