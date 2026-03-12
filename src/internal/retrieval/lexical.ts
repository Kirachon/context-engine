import type { SearchResult } from '../../mcp/serviceClient.js';
import type { InternalSearchResult } from './types.js';

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
}

function termFrequency(text: string, token: string): number {
  if (!text) return 0;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function parseLineStart(lines?: string): number {
  if (!lines) return Number.MAX_SAFE_INTEGER;
  const match = lines.match(/(\d+)/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

export interface LexicalScoreOptions {
  query: string;
  queryVariant: string;
  variantIndex: number;
  variantWeight: number;
}

export function scoreLexicalCandidates(
  results: SearchResult[],
  options: LexicalScoreOptions
): InternalSearchResult[] {
  if (results.length === 0) return [];

  const tokens = [...new Set(tokenize(options.query))];
  if (tokens.length === 0) {
    return results.map((result) => ({
      ...result,
      retrievalSource: 'lexical',
      lexicalScore: 0,
      combinedScore: 0,
      tieBreakPath: result.path,
      tieBreakLine: parseLineStart(result.lines),
      queryVariant: options.queryVariant,
      variantIndex: options.variantIndex,
      variantWeight: options.variantWeight,
    }));
  }

  const docs = results.map((result) => {
    const body = `${result.path}\n${result.content ?? ''}`.toLowerCase();
    const length = Math.max(1, tokenize(body).length);
    return { result, body, length };
  });
  const avgDocLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length;
  const k1 = 1.2;
  const b = 0.75;

  const docFrequency = new Map<string, number>();
  for (const token of tokens) {
    let count = 0;
    for (const doc of docs) {
      if (termFrequency(doc.body, token) > 0) count += 1;
    }
    docFrequency.set(token, count);
  }

  const scored = docs.map((doc) => {
    let score = 0;
    for (const token of tokens) {
      const tf = termFrequency(doc.body, token);
      if (tf <= 0) continue;

      const df = docFrequency.get(token) ?? 0;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.length / avgDocLength)));
      score += idf * tfNorm;
    }

    const lowerPath = doc.result.path.toLowerCase();
    const pathHits = tokens.reduce((hits, token) => (lowerPath.includes(token) ? hits + 1 : hits), 0);
    score += pathHits * 0.12;

    return { doc, rawScore: score };
  });

  const maxRaw = scored.reduce((max, item) => Math.max(max, item.rawScore), 0);
  const normalize = (value: number) => (maxRaw > 0 ? Math.max(0, Math.min(1, value / maxRaw)) : 0);

  return scored.map(({ doc, rawScore }) => {
    const normalizedScore = normalize(rawScore);
    return {
      ...doc.result,
      retrievalSource: 'lexical',
      lexicalScore: normalizedScore,
      relevanceScore: normalizedScore,
      combinedScore: normalizedScore,
      tieBreakPath: doc.result.path,
      tieBreakLine: parseLineStart(doc.result.lines),
      queryVariant: options.queryVariant,
      variantIndex: options.variantIndex,
      variantWeight: options.variantWeight,
    };
  });
}
