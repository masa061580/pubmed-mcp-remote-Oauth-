/**
 * RIS Format Exporter for PubMed Data
 * Converts PubMed metadata to compact RIS format for EndNote/Zotero/Mendeley import
 */

export interface RISPaper {
  pmid: string;
  title: string;
  journal: string;
  year: string;
  authors: string[];
  doi?: string | null;
}

function formatDate(year: string): string {
  if (year && /^\d+$/.test(year)) {
    return `${year}///`;
  }
  return "////";
}

function escapeRisField(text: string): string {
  if (!text) return "";
  return text.replace(/[\n\r]+/g, " ").replace(/\s+/g, " ").trim();
}

export function convertToRis(paper: RISPaper): string {
  const lines: string[] = ["TY  - JOUR"];

  // First author only (citation manager fetches the rest)
  if (paper.authors.length > 0) {
    lines.push(`AU  - ${escapeRisField(paper.authors[0])}`);
  }

  if (paper.title) {
    lines.push(`TI  - ${escapeRisField(paper.title)}`);
  }

  if (paper.journal) {
    lines.push(`JO  - ${escapeRisField(paper.journal)}`);
  }

  if (paper.year) {
    lines.push(`PY  - ${formatDate(paper.year)}`);
  }

  if (paper.doi) {
    lines.push(`DO  - ${paper.doi}`);
  }

  if (paper.pmid) {
    lines.push(`AN  - ${paper.pmid}`);
  }

  lines.push("DB  - PubMed");
  lines.push("ER  - ");
  lines.push("");

  return lines.join("\n");
}

export function exportMultipleToRis(papers: RISPaper[]): string {
  if (papers.length === 0) return "";
  return papers.map(convertToRis).join("\n");
}
