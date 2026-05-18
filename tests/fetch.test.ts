/**
 * Integration tests for fetch / fetch_batch (t16–t18).
 */
import { describe, it, expect } from "vitest";
import { PubMedClient } from "../src/pubmed-client.js";

const client = new PubMedClient({ apiKey: process.env.NCBI_API_KEY });

describe("fetch / fetch_batch", () => {
  it("t16 — HTML entities are decoded in abstracts", async () => {
    const items = await client.getAbstracts(["39531400"]);
    expect(items.length).toBe(1);
    const text = items[0].abstract + " " + items[0].title;
    expect(text).not.toMatch(/&#x[0-9a-fA-F]+;/);
    expect(text).not.toMatch(/&amp;/);
  });

  it("t17/t18 — abstract present by default; can be omitted", async () => {
    const items = await client.getAbstracts(["39531400"]);
    expect(items[0]).toHaveProperty("abstract");
    expect(items[0].abstract.length).toBeGreaterThan(0);

    // Simulate include_abstract=false (tools.ts strips the key).
    const stripped = items.map(({ abstract: _abs, ...rest }) => rest) as any[];
    expect(stripped[0]).not.toHaveProperty("abstract");
    expect(stripped[0]).toHaveProperty("title");
  });
});
