/**
 * PubMed API Client for Cloudflare Workers
 *
 * Handles all NCBI E-utilities interactions including search, abstract retrieval,
 * full-text (PMC), similar articles, citation counts via iCite, and ID conversion.
 */

import { decode as htmlDecode } from "he";

const NCBI_BASE_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const PMC_OA_URL = "https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi";
const ICITE_API_URL = "https://icite.od.nih.gov/api/pubs";
const ID_CONVERTER_URL = "https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/";

const TOOL_NAME = "PubMedMCPServer";
const DEFAULT_EMAIL = "pubmed.mcp.server@example.com";

// ISO 639-2 (3-letter) → PubMed [la] tag value
const LANG_MAP: Record<string, string> = {
  eng: "english",
  jpn: "japanese",
  ger: "german",
  fre: "french",
  spa: "spanish",
  chi: "chinese",
  ita: "italian",
  kor: "korean",
};

const SECTION_KEYS = [
  "abstract",
  "introduction",
  "methods",
  "results",
  "discussion",
  "conclusions",
  "references",
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export interface PubMedClientConfig {
  apiKey?: string;
  email?: string;
  toolName?: string;
}

export interface SearchFilters {
  date_range?: { start?: string; end?: string };
  publication_types?: string[];
  languages?: string[];
  humans_only?: boolean;
  has_abstract?: boolean;
  free_full_text?: boolean;
}

export interface SearchPubmedOptions {
  retmax?: number;
  retstart?: number;
  sort?: "relevance" | "pub_date" | "first_author";
  filters?: SearchFilters;
  /** When true, also fetches summaries (compact mode metadata). */
  withSummary?: boolean;
}

export interface ExtendedSearchItem {
  pmid: string;
  pmcid: string | null;
  title: string;
  pubdate: string;
  year: string;
  journal: string;
  authors: string[];
  doi: string | null;
  full_text_available: boolean;
}

export interface SearchPubmedResult {
  total: number;
  retmax: number;
  retstart: number;
  query_translation: string;
  final_term: string;
  items: ExtendedSearchItem[];
}

export interface AbstractItem {
  pmid: string;
  title: string;
  abstract: string;
  journal: string;
  year: string;
  authors: string[];
  doi: string | null;
  mesh_terms: string[];
  publication_types: string[];
}

export interface CountResult {
  query: string;
  count: number;
  query_translation: string;
  warnings: string[];
}

export interface FullTextSection {
  name: string;
  text: string;
}

export interface FullTextItem {
  pmcid: string;
  pmid: string | null;
  title: string;
  sections: FullTextSection[];
  available_sections: string[];
  pdf_url?: string | null;
  error?: string;
}

export interface SimilarArticlesResult {
  reference_pmid: string;
  similar_articles: SimilarArticle[];
  count: number;
  error: string | null;
}

export interface SimilarArticle {
  pmid: string;
  pmcid: string | null;
  title: string;
  authors: string[];
  journal: string;
  pubdate: string;
  url: string;
  full_text_available: boolean;
}

export interface CitationItem {
  pmid: string;
  citation_count: number | null;
  citing_pmids?: string[];
  source?: "icite" | "pubmed";
  error?: string;
  note?: string;
}

export type ConvertIdType = "pmid" | "pmcid" | "doi";

export interface ConvertIdsItem {
  input: string;
  pmid?: string | null;
  pmcid?: string | null;
  doi?: string | null;
  error?: string;
}

export interface ConvertIdsResult {
  requested: number;
  converted: number;
  failed: number;
  conversions: ConvertIdsItem[];
  failedIds: string[];
}

export class PubMedClient {
  private apiKey?: string;
  private email: string;
  private toolName: string;

  constructor(config: PubMedClientConfig = {}) {
    this.apiKey = config.apiKey;
    this.email = config.email || DEFAULT_EMAIL;
    this.toolName = config.toolName || TOOL_NAME;
  }

  private getCommonParams(): Record<string, string> {
    const params: Record<string, string> = { tool: this.toolName, email: this.email };
    if (this.apiKey) params.api_key = this.apiKey;
    return params;
  }

  /** Mask api_key in URLs for error messages. */
  private maskUrl(url: string): string {
    return url.replace(/api_key=[^&]+/g, "api_key=***");
  }

  private async makeRequest(
    url: string,
    params: Record<string, string>,
    method: "GET" | "POST" = "GET",
    attempt = 0
  ): Promise<Response> {
    const allParams = { ...params, ...this.getCommonParams() };
    const search = new URLSearchParams(allParams);

    const fullUrl = method === "GET" ? `${url}?${search.toString()}` : url;
    const init: RequestInit =
      method === "GET"
        ? { signal: AbortSignal.timeout(30000) }
        : {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: search.toString(),
            signal: AbortSignal.timeout(30000),
          };

    let response: Response;
    try {
      response = await fetch(fullUrl, init);
    } catch (e: any) {
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        return this.makeRequest(url, params, method, attempt + 1);
      }
      throw new Error(
        `NCBI request failed (${this.maskUrl(method === "GET" ? fullUrl : url)}): ${e.message || e}`
      );
    }

    if (response.status === 429 && attempt < 3) {
      const retryAfter = parseInt(response.headers.get("Retry-After") || "0", 10);
      const delay = retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, delay));
      return this.makeRequest(url, params, method, attempt + 1);
    }

    if (!response.ok) {
      throw new Error(
        `NCBI API error ${response.status} ${response.statusText} (${this.maskUrl(
          method === "GET" ? fullUrl : url
        )})`
      );
    }

    return response;
  }

  // ─── Filter Builder ───────────────────────────────────────────────

  /**
   * Wrap original query in parens and AND each filter clause.
   * Returns the final term that will be sent to NCBI.
   */
  buildFilteredQuery(query: string, filters?: SearchFilters): string {
    const clauses: string[] = [`(${query})`];

    if (filters) {
      const f = filters;
      if (f.date_range && (f.date_range.start || f.date_range.end)) {
        const start = f.date_range.start || "1800";
        const end = f.date_range.end || "3000";
        clauses.push(`("${start}"[dp] : "${end}"[dp])`);
      }
      if (f.publication_types && f.publication_types.length > 0) {
        const inner = f.publication_types.map((pt) => `"${pt}"[pt]`).join(" OR ");
        clauses.push(`(${inner})`);
      }
      if (f.languages && f.languages.length > 0) {
        const inner = f.languages
          .map((l) => LANG_MAP[l.toLowerCase()] || l.toLowerCase())
          .map((l) => `"${l}"[la]`)
          .join(" OR ");
        clauses.push(`(${inner})`);
      }
      if (f.humans_only) clauses.push(`"humans"[mh]`);
      if (f.has_abstract) clauses.push(`"hasabstract"`);
      if (f.free_full_text) clauses.push(`"free full text"[sb]`);
    }

    return clauses.join(" AND ");
  }

  // ─── Search ───────────────────────────────────────────────────────

  async searchPubmed(
    query: string,
    options: SearchPubmedOptions = {}
  ): Promise<SearchPubmedResult> {
    const retmax = options.retmax ?? 50;
    const retstart = options.retstart ?? 0;
    const sortInput = options.sort ?? "relevance";
    const sort = sortInput === "first_author" ? "first+author" : sortInput;

    const finalTerm = this.buildFilteredQuery(query, options.filters);

    // Step 1: ESearch
    const searchResponse = await this.makeRequest(`${NCBI_BASE_URL}/esearch.fcgi`, {
      db: "pubmed",
      term: finalTerm,
      retmode: "json",
      retmax: String(retmax),
      retstart: String(retstart),
      usehistory: "y",
      sort,
    });

    const searchData = (await searchResponse.json()) as any;
    if (!searchData.esearchresult) throw new Error("Invalid response from esearch");

    const result = searchData.esearchresult;
    const pmids: string[] = result.idlist || [];
    const total = parseInt(result.count || "0", 10);
    const queryTranslation: string = result.querytranslation || "";

    if (pmids.length === 0 || !options.withSummary) {
      // Minimal: skip ESummary entirely
      return {
        total,
        retmax,
        retstart,
        query_translation: queryTranslation,
        final_term: finalTerm,
        items: pmids.map((pmid) => ({
          pmid,
          pmcid: null,
          title: "",
          pubdate: "",
          year: "",
          journal: "",
          authors: [],
          doi: null,
          full_text_available: false,
        })),
      };
    }

    // Step 2: ESummary (chunk by 200)
    const items: ExtendedSearchItem[] = [];
    const byPmid: Record<string, ExtendedSearchItem> = {};
    for (const part of chunkArray(pmids, 200)) {
      const summaryResponse = await this.makeRequest(`${NCBI_BASE_URL}/esummary.fcgi`, {
        db: "pubmed",
        id: part.join(","),
        retmode: "json",
      });
      const summaryData = (await summaryResponse.json()) as any;
      if (!summaryData.result) continue;
      for (const pmid of part) {
        const paper = summaryData.result[pmid];
        if (!paper) continue;
        let pmcid: string | null = null;
        let doi: string | null = null;
        if (paper.articleids) {
          for (const aid of paper.articleids) {
            if (aid.idtype === "pmc") pmcid = aid.value;
            if (aid.idtype === "doi") doi = aid.value;
          }
        }
        const pubdate: string = paper.pubdate || "";
        const yearMatch = pubdate.match(/^\d{4}/);
        const year = yearMatch ? yearMatch[0] : "";
        const authors: string[] = (paper.authors || [])
          .map((a: any) => htmlDecode(a.name || ""))
          .filter(Boolean);
        byPmid[pmid] = {
          pmid,
          pmcid,
          title: htmlDecode(paper.title || "No title available"),
          pubdate,
          year,
          journal: htmlDecode(paper.fulljournalname || paper.source || "Unknown journal"),
          authors,
          doi,
          full_text_available: pmcid !== null,
        };
      }
    }
    // Preserve original order
    for (const pmid of pmids) {
      if (byPmid[pmid]) items.push(byPmid[pmid]);
    }

    return {
      total,
      retmax,
      retstart,
      query_translation: queryTranslation,
      final_term: finalTerm,
      items,
    };
  }

  // ─── Count ────────────────────────────────────────────────────────

  async countSearch(query: string): Promise<CountResult> {
    const response = await this.makeRequest(`${NCBI_BASE_URL}/esearch.fcgi`, {
      db: "pubmed",
      term: query,
      retmode: "json",
      retmax: "0",
    });

    const data = (await response.json()) as any;
    if (!data.esearchresult) throw new Error("Invalid response from esearch");

    const result = data.esearchresult;
    const warnings: string[] = [];
    const warningList = result.warninglist || {};
    if (warningList.phraseignored) warnings.push(...warningList.phraseignored);
    if (warningList.quotedphrasefound) warnings.push(...warningList.quotedphrasefound);

    return {
      query,
      count: parseInt(result.count || "0", 10),
      query_translation: result.querytranslation || "",
      warnings,
    };
  }

  // ─── Abstracts (EFetch) ──────────────────────────────────────────

  async getAbstracts(pmids: string[]): Promise<AbstractItem[]> {
    if (pmids.length === 0) return [];

    const all: AbstractItem[] = [];
    for (const part of chunkArray(pmids, 200)) {
      const response = await this.makeRequest(
        `${NCBI_BASE_URL}/efetch.fcgi`,
        { db: "pubmed", id: part.join(","), retmode: "xml", rettype: "abstract" },
        "POST"
      );
      const xmlText = await response.text();
      all.push(...this.parseAbstractsXml(xmlText));
    }
    return all;
  }

  private parseAbstractsXml(xml: string): AbstractItem[] {
    const items: AbstractItem[] = [];
    const articles = xml.split("<PubmedArticle>");

    for (let i = 1; i < articles.length; i++) {
      const article = articles[i];
      const endIdx = article.indexOf("</PubmedArticle>");
      const content = endIdx >= 0 ? article.substring(0, endIdx) : article;

      const pmid = this.extractTag(content, "PMID");
      if (!pmid) continue;

      const titleRaw = this.extractTag(content, "ArticleTitle") || "No title available";
      const title = htmlDecode(this.stripTags(titleRaw));

      // Abstract (handle structured)
      const abstractTexts: string[] = [];
      const abstractRegex = /<AbstractText(?:\s+Label="([^"]*)")?[^>]*>([\s\S]*?)<\/AbstractText>/g;
      let match;
      while ((match = abstractRegex.exec(content)) !== null) {
        const label = match[1];
        const text = htmlDecode(this.stripTags(match[2])).trim();
        abstractTexts.push(label ? `${label}: ${text}` : text);
      }
      const abstract = abstractTexts.length > 0 ? abstractTexts.join("\n") : "No abstract available";

      const journal = htmlDecode(
        this.extractNestedTag(content, "Journal", "Title") || "Unknown journal"
      );
      const year = this.extractNestedTag(content, "PubDate", "Year") || "Unknown";

      const authors = this.parseAuthors(content);

      let doi: string | null = null;
      const doiMatch = content.match(/<ArticleId\s+IdType="doi">([\s\S]*?)<\/ArticleId>/);
      if (doiMatch) doi = doiMatch[1].trim();

      const meshTerms: string[] = [];
      const meshRegex = /<DescriptorName[^>]*>([\s\S]*?)<\/DescriptorName>/g;
      while ((match = meshRegex.exec(content)) !== null) {
        meshTerms.push(htmlDecode(match[1].trim()));
      }

      const pubTypes: string[] = [];
      const ptRegex = /<PublicationType[^>]*>([\s\S]*?)<\/PublicationType>/g;
      while ((match = ptRegex.exec(content)) !== null) {
        pubTypes.push(match[1].trim());
      }

      items.push({
        pmid,
        title,
        abstract,
        journal,
        year,
        authors,
        doi,
        mesh_terms: meshTerms,
        publication_types: pubTypes,
      });
    }

    return items;
  }

  // ─── Full Text (PMC, JATS) ───────────────────────────────────────

  async getFullTextBatch(
    pmcIds: string[],
    sections: (SectionKey | "all")[] = ["all"]
  ): Promise<FullTextItem[]> {
    const wantAll = sections.includes("all");
    const wanted: Set<SectionKey> = wantAll
      ? new Set(SECTION_KEYS)
      : new Set(sections.filter((s): s is SectionKey => s !== "all"));

    const out: FullTextItem[] = [];
    for (const raw of pmcIds) {
      out.push(await this.getFullTextSingle(raw, wanted));
    }
    return out;
  }

  private async getFullTextSingle(pmcid: string, wanted: Set<SectionKey>): Promise<FullTextItem> {
    const empty = (id: string, error: string): FullTextItem => ({
      pmcid: id,
      pmid: null,
      title: "",
      sections: [],
      available_sections: [],
      error,
    });

    if (!pmcid || !pmcid.trim()) return empty("", "No PMCID provided");
    const trimmed = pmcid.trim().toUpperCase();
    const numeric = trimmed.startsWith("PMC") ? trimmed.slice(3) : trimmed;
    if (!/^\d+$/.test(numeric)) return empty(trimmed, "Invalid PMCID format");
    const fullPmcid = `PMC${numeric}`;

    try {
      const xmlResponse = await this.makeRequest(
        `${NCBI_BASE_URL}/efetch.fcgi`,
        { db: "pmc", id: fullPmcid, retmode: "xml" },
        "POST"
      );
      const jatsXml = await xmlResponse.text();

      if (!jatsXml || /does not allow downloading/i.test(jatsXml)) {
        return empty(fullPmcid, "Not open access");
      }
      if (!/<article\b/.test(jatsXml) || /<error[^>]*>[\s\S]*?<\/error>/i.test(jatsXml)) {
        return empty(fullPmcid, "Not found in PMC");
      }

      const parsed = this.parseJatsArticle(jatsXml, wanted);

      // Article identifiers + title (from JATS metadata).
      const pmidMatch = jatsXml.match(
        /<article-id\s+pub-id-type="pmid"[^>]*>([\s\S]*?)<\/article-id>/
      );
      const pmid = pmidMatch ? pmidMatch[1].trim() : null;
      const titleMatch = jatsXml.match(/<article-title[^>]*>([\s\S]*?)<\/article-title>/);
      const title = titleMatch ? htmlDecode(this.stripTags(titleMatch[1]).trim()) : "";

      // PDF URL via OA service (best effort).
      let pdfUrl: string | null = null;
      try {
        const oaResponse = await this.makeRequest(PMC_OA_URL, { id: fullPmcid });
        const oaText = await oaResponse.text();
        const pdfMatch = oaText.match(/<link[^>]+format="pdf"[^>]+href="([^"]+)"/);
        if (pdfMatch) pdfUrl = pdfMatch[1];
      } catch {
        // non-critical
      }

      return {
        pmcid: fullPmcid,
        pmid,
        title,
        sections: parsed.sections,
        available_sections: parsed.available,
        pdf_url: pdfUrl,
      };
    } catch (e: any) {
      return empty(fullPmcid, e.message || String(e));
    }
  }

  /** Classify a section by sec-type attr or title text. */
  private classifySection(secType: string, title: string): SectionKey | null {
    const t = (secType || "").toLowerCase();
    const ti = (title || "").toLowerCase();
    const has = (s: string) => t.includes(s) || ti.includes(s);
    if (has("introduction") || has("background")) return "introduction";
    if (has("materials and methods") || has("study design") || has("methods") || t === "method")
      return "methods";
    if (has("results") || has("findings")) return "results";
    if (has("discussion")) return "discussion";
    if (has("conclusion")) return "conclusions";
    return null;
  }

  private parseJatsArticle(
    xml: string,
    wanted: Set<SectionKey>
  ): { sections: FullTextSection[]; available: string[] } {
    const collected: Partial<Record<SectionKey, string>> = {};
    const available = new Set<string>();

    // Abstract — found in <front> as a top-level element, not in body.
    const absMatch = xml.match(/<abstract\b[^>]*>([\s\S]*?)<\/abstract>/);
    if (absMatch) {
      available.add("abstract");
      if (wanted.has("abstract")) {
        const txt = this.extractParagraphText(absMatch[1]);
        if (txt) collected.abstract = htmlDecode(txt);
      }
    }

    // Body sections (depth-aware).
    const bodyMatch = xml.match(/<body\b[^>]*>([\s\S]*?)<\/body>/);
    if (bodyMatch) {
      const topSections = extractTopLevelSections(bodyMatch[1]);
      for (const sec of topSections) {
        const secTypeMatch = sec.openTag.match(/sec-type="([^"]*)"/);
        const secType = secTypeMatch ? secTypeMatch[1] : "";
        const titleMatch = sec.inner.match(/<title[^>]*>([\s\S]*?)<\/title>/);
        const title = titleMatch ? this.stripTags(titleMatch[1]).trim() : "";
        const key = this.classifySection(secType, title);
        if (!key) continue;
        available.add(key);
        if (!wanted.has(key)) continue;
        const text = this.extractParagraphText(sec.inner);
        if (text) {
          const prev = collected[key];
          collected[key] = prev ? `${prev}\n\n${htmlDecode(text)}` : htmlDecode(text);
        }
      }
    }

    // References — store as joined string for uniform shape.
    const refListMatch = xml.match(/<ref-list\b[^>]*>([\s\S]*?)<\/ref-list>/);
    if (refListMatch) {
      available.add("references");
      if (wanted.has("references")) {
        const refs: string[] = [];
        const refRegex = /<ref\b[^>]*>([\s\S]*?)<\/ref>/g;
        let m;
        while ((m = refRegex.exec(refListMatch[1])) !== null) {
          const text = htmlDecode(this.stripTags(m[1]).replace(/\s+/g, " ").trim());
          if (text) refs.push(text);
        }
        if (refs.length) collected.references = refs.join("\n");
      }
    }

    // Emit in canonical order.
    const sections: FullTextSection[] = [];
    for (const k of SECTION_KEYS) {
      if (collected[k]) sections.push({ name: k, text: collected[k]! });
    }
    return { sections, available: [...available] };
  }

  private extractParagraphText(content: string): string {
    const paragraphs: string[] = [];
    const pRegex = /<p\b[^>]*>([\s\S]*?)<\/p>/g;
    let m;
    while ((m = pRegex.exec(content)) !== null) {
      const text = this.stripTags(m[1]).replace(/\s+/g, " ").trim();
      if (text) paragraphs.push(text);
    }
    return paragraphs.join("\n\n");
  }

  // ─── Similar Articles ─────────────────────────────────────────────

  async findSimilarArticles(pmid: string, retmax: number = 20): Promise<SimilarArticlesResult> {
    if (!pmid || !pmid.trim()) {
      return { reference_pmid: pmid, similar_articles: [], count: 0, error: "No PMID provided" };
    }
    const cleanPmid = pmid.trim();

    try {
      // Use elink with linkname=pubmed_pubmed (NCBI's "Similar articles").
      const elinkResponse = await this.makeRequest(`${NCBI_BASE_URL}/elink.fcgi`, {
        dbfrom: "pubmed",
        db: "pubmed",
        linkname: "pubmed_pubmed",
        id: cleanPmid,
        retmode: "json",
      });
      const elinkData = (await elinkResponse.json()) as any;

      const linksets = elinkData.linksets || [];
      const links: { id: string; score?: number }[] = [];
      for (const ls of linksets) {
        for (const lsdb of ls.linksetdbs || []) {
          if (lsdb.linkname !== "pubmed_pubmed") continue;
          // Newer responses use linksetdbhistories or links with score.
          const ids: string[] = lsdb.links || [];
          for (const id of ids) {
            if (String(id) !== cleanPmid) links.push({ id: String(id) });
          }
        }
      }

      if (links.length === 0) {
        return {
          reference_pmid: cleanPmid,
          similar_articles: [],
          count: 0,
          error: "No similar articles found",
        };
      }

      const similarPmids = links.slice(0, retmax).map((l) => l.id);

      const summaryResponse = await this.makeRequest(`${NCBI_BASE_URL}/esummary.fcgi`, {
        db: "pubmed",
        id: similarPmids.join(","),
        retmode: "json",
      });
      const summaryData = (await summaryResponse.json()) as any;
      const similarArticles: SimilarArticle[] = [];

      if (summaryData.result) {
        for (const pid of similarPmids) {
          const paper = summaryData.result[pid];
          if (!paper) continue;
          let pmcid: string | null = null;
          if (paper.articleids) {
            for (const aid of paper.articleids) {
              if (aid.idtype === "pmc") {
                pmcid = aid.value;
                break;
              }
            }
          }
          similarArticles.push({
            pmid: pid,
            pmcid,
            title: htmlDecode(paper.title || "No title available"),
            authors: (paper.authors || []).map((a: any) => htmlDecode(a.name || "")),
            journal: htmlDecode(paper.fulljournalname || paper.source || "Unknown journal"),
            pubdate: paper.pubdate || "Unknown",
            url: `https://pubmed.ncbi.nlm.nih.gov/${pid}/`,
            full_text_available: pmcid !== null,
          });
        }
      }

      return {
        reference_pmid: cleanPmid,
        similar_articles: similarArticles,
        count: similarArticles.length,
        error: null,
      };
    } catch (e: any) {
      return {
        reference_pmid: cleanPmid,
        similar_articles: [],
        count: 0,
        error: e.message || String(e),
      };
    }
  }

  // ─── Citation Counts (iCite) ──────────────────────────────────────

  async getCitationCounts(
    pmids: string[],
    options: { source?: "icite" | "pubmed"; includeCitingPmids?: boolean } = {}
  ): Promise<CitationItem[]> {
    if (pmids.length === 0) return [];
    const source = options.source ?? "icite";

    if (source === "pubmed") {
      return this.getCitationsViaElink(pmids, options.includeCitingPmids ?? true);
    }

    // iCite (default — counts only).
    const pmidsStr = pmids.slice(0, 1000).join(",");
    try {
      const url = `${ICITE_API_URL}?pmids=${encodeURIComponent(pmidsStr)}&format=json`;
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) {
        return pmids.map((p) => ({
          pmid: p,
          citation_count: null,
          source: "icite" as const,
          error: `HTTP error: ${response.status}`,
        }));
      }
      const data = (await response.json()) as any;
      const results: CitationItem[] = [];
      for (const item of data.data || []) {
        const result: CitationItem = {
          pmid: String(item.pmid || ""),
          citation_count: null,
          source: "icite",
        };
        if (item.citation_count != null) result.citation_count = item.citation_count;
        else result.note = "Citation data not available";
        results.push(result);
      }
      return results;
    } catch (e: any) {
      return pmids.map((p) => ({
        pmid: p,
        citation_count: null,
        source: "icite" as const,
        error: e.message || String(e),
      }));
    }
  }

  /** Use elink pubmed_pubmed_citedin to get PMIDs that cite each input. */
  private async getCitationsViaElink(
    pmids: string[],
    include: boolean
  ): Promise<CitationItem[]> {
    const results: CitationItem[] = [];
    for (const pmid of pmids) {
      try {
        const r = await this.makeRequest(`${NCBI_BASE_URL}/elink.fcgi`, {
          dbfrom: "pubmed",
          db: "pubmed",
          linkname: "pubmed_pubmed_citedin",
          id: pmid,
          retmode: "json",
        });
        const data = (await r.json()) as any;
        const linksets = data.linksets || [];
        const citing: string[] = [];
        for (const ls of linksets) {
          for (const lsdb of ls.linksetdbs || []) {
            if (lsdb.linkname !== "pubmed_pubmed_citedin") continue;
            for (const id of lsdb.links || []) citing.push(String(id));
          }
        }
        results.push({
          pmid,
          citation_count: citing.length,
          citing_pmids: include ? citing : undefined,
          source: "pubmed",
        });
      } catch (e: any) {
        results.push({
          pmid,
          citation_count: null,
          source: "pubmed",
          error: e.message || String(e),
        });
      }
    }
    return results;
  }

  // ─── ID Conversion ────────────────────────────────────────────────

  async convertIds(
    ids: string[],
    fromType?: ConvertIdType,
    toType?: ConvertIdType
  ): Promise<ConvertIdsResult> {
    const cleaned = ids.map((s) => s.trim()).filter(Boolean);
    if (cleaned.length === 0) {
      return { requested: 0, converted: 0, failed: 0, conversions: [], failedIds: [] };
    }

    const conversions: ConvertIdsItem[] = [];
    const failedIds: string[] = [];

    try {
      const params = new URLSearchParams({
        ids: cleaned.join(","),
        format: "json",
        tool: this.toolName,
        email: this.email,
      });
      if (fromType) params.set("idtype", fromType);
      if (this.apiKey) params.set("api_key", this.apiKey);
      const url = `${ID_CONVERTER_URL}?${params.toString()}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) {
        for (const id of cleaned) {
          conversions.push({ input: id, error: `HTTP error: ${response.status}` });
          failedIds.push(id);
        }
        return {
          requested: cleaned.length,
          converted: 0,
          failed: cleaned.length,
          conversions,
          failedIds,
        };
      }

      const data = (await response.json()) as any;
      const records: any[] = data.records || [];
      const byInput = new Map<string, ConvertIdsItem>();
      for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        const input =
          rec["requested-id"] ??
          rec.requestedid ??
          (rec.pmid != null ? String(rec.pmid) : undefined) ??
          rec.pmcid ??
          rec.doi ??
          cleaned[i] ??
          "";
        const item: ConvertIdsItem = {
          input,
          pmid: rec.pmid != null ? String(rec.pmid) : null,
          pmcid: rec.pmcid ?? null,
          doi: rec.doi ?? null,
        };
        if (rec.errmsg || rec.status === "error") item.error = rec.errmsg || "conversion error";
        byInput.set(input, item);
      }

      for (const id of cleaned) {
        const item = byInput.get(id) ?? { input: id, error: "Not found" };
        // If a specific to_type was requested, judge success on that field.
        const wantedField = toType ? item[toType] : item.pmid ?? item.pmcid ?? item.doi;
        const ok = !item.error && wantedField != null && wantedField !== "";
        if (ok) {
          conversions.push(item);
        } else {
          conversions.push({ ...item, error: item.error || `No ${toType ?? "mapping"} available` });
          failedIds.push(id);
        }
      }

      return {
        requested: cleaned.length,
        converted: cleaned.length - failedIds.length,
        failed: failedIds.length,
        conversions,
        failedIds,
      };
    } catch (e: any) {
      const msg = e.message || String(e);
      for (const id of cleaned) {
        conversions.push({ input: id, error: msg });
        failedIds.push(id);
      }
      return {
        requested: cleaned.length,
        converted: 0,
        failed: cleaned.length,
        conversions,
        failedIds,
      };
    }
  }

  // ─── XML Helpers ──────────────────────────────────────────────────

  private extractTag(xml: string, tag: string): string | null {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
    const match = xml.match(regex);
    return match ? match[1].trim() : null;
  }

  private extractNestedTag(xml: string, parent: string, child: string): string | null {
    const parentRegex = new RegExp(`<${parent}[^>]*>([\\s\\S]*?)<\\/${parent}>`);
    const parentMatch = xml.match(parentRegex);
    if (!parentMatch) return null;
    return this.extractTag(parentMatch[1], child);
  }

  private stripTags(text: string): string {
    return text.replace(/<[^>]+>/g, "");
  }

  /**
   * Parse the author list from a PubmedArticle's XML.
   *
   * Restricted to the <AuthorList> block so consortium papers (e.g. PMID
   * 25176015 with 1184 <Investigator> collaborators) never get scanned. Each
   * <Author> element is sliced out and parsed in isolation — a single
   * cross-element regex with nested lazy quantifiers backtracks catastrophically
   * on group authors that lack <LastName>/<ForeName>, which can block the
   * Worker for the request's lifetime and hang the MCP endpoint.
   */
  private parseAuthors(content: string): string[] {
    const listMatch = content.match(/<AuthorList[^>]*>([\s\S]*?)<\/AuthorList>/);
    const listXml = listMatch ? listMatch[1] : "";
    if (!listXml) return [];

    const authors: string[] = [];
    // Split on each <Author ...> / <Author> opening; "<AuthorList" is not matched.
    const parts = listXml.split(/<Author[\s>]/).slice(1);
    for (const part of parts) {
      const endIdx = part.indexOf("</Author>");
      const authorXml = endIdx >= 0 ? part.slice(0, endIdx) : part;

      const last = this.extractTag(authorXml, "LastName");
      if (last) {
        const fore = this.extractTag(authorXml, "ForeName");
        authors.push(htmlDecode(fore ? `${fore} ${last}` : last));
        continue;
      }
      // Group / consortium author (no personal name).
      const collective = this.extractTag(authorXml, "CollectiveName");
      if (collective) authors.push(htmlDecode(collective));
    }
    return authors;
  }
}

// ─── Module helpers ───────────────────────────────────────────────

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Walk content and emit top-level <sec> elements with their open tag and inner content,
 * accounting for nested <sec> tags so we don't truncate at the first inner close.
 */
function extractTopLevelSections(content: string): { openTag: string; inner: string }[] {
  const out: { openTag: string; inner: string }[] = [];
  const openRe = /<sec\b[^>]*>/g;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = openRe.exec(content)) !== null) {
    if (m.index < i) continue; // inside a previous top-level section
    const start = m.index;
    const openEnd = m.index + m[0].length;
    let depth = 1;
    const re = /<sec\b[^>]*>|<\/sec>/g;
    re.lastIndex = openEnd;
    let end = -1;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(content)) !== null) {
      if (mm[0].startsWith("</")) {
        depth--;
        if (depth === 0) {
          end = mm.index;
          break;
        }
      } else {
        depth++;
      }
    }
    if (end === -1) break;
    out.push({ openTag: m[0], inner: content.substring(openEnd, end) });
    i = end + "</sec>".length;
    openRe.lastIndex = i;
  }
  return out;
}
