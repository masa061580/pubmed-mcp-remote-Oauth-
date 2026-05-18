import { describe, it, expect } from "vitest";
import { PubMedClient } from "../src/pubmed-client.js";

const client = new PubMedClient();

describe("buildFilteredQuery (pure)", () => {
  it("wraps original query in parens", () => {
    const t = client.buildFilteredQuery("diabetes");
    expect(t).toBe("(diabetes)");
  });

  it("adds publication_types as OR-clause with [pt]", () => {
    const t = client.buildFilteredQuery("diabetes", {
      publication_types: ["Meta-Analysis", "Randomized Controlled Trial"],
    });
    expect(t).toContain('"Meta-Analysis"[pt]');
    expect(t).toContain('"Randomized Controlled Trial"[pt]');
    expect(t).toContain(" OR ");
  });

  it("adds date_range as [dp] : [dp]", () => {
    const t = client.buildFilteredQuery("x", { date_range: { start: "2020", end: "2024" } });
    expect(t).toContain('"2020"[dp] : "2024"[dp]');
  });

  it("maps ISO-3 language to PubMed [la]", () => {
    const t = client.buildFilteredQuery("x", { languages: ["eng", "jpn"] });
    expect(t).toContain('"english"[la]');
    expect(t).toContain('"japanese"[la]');
  });

  it("adds humans_only / has_abstract / free_full_text", () => {
    const t = client.buildFilteredQuery("x", {
      humans_only: true,
      has_abstract: true,
      free_full_text: true,
    });
    expect(t).toContain('"humans"[mh]');
    expect(t).toContain('"hasabstract"');
    expect(t).toContain('"free full text"[sb]');
  });

  it("preserves original-query OR semantics by parenthesizing", () => {
    const t = client.buildFilteredQuery("a OR b", { humans_only: true });
    expect(t.startsWith("(a OR b)")).toBe(true);
  });
});
