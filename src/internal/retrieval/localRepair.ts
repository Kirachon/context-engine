import type { SearchResult } from '../../mcp/serviceClient.js';
import { scoreLexicalCandidates } from './lexical.js';
import { buildIdentifierPathSignals, computeExactMatchBoost, tokenizeLocalSearch } from './searchHeuristics.js';
import { analyzeLocalDocument, type LocalRepairAnalysis, type LocalRepairAnalysisCache } from './localRepairAnalysis.js';
import { LocalRetrievalBudgetError } from './localRepairBudget.js';

export const LOCAL_REPAIR_SCORER_VERSION = 'local-bm25-v6';

interface PreparedLocalRepair {
  length: number;
  frequencies: ReadonlyMap<string, number>;
  pathTerms: ReadonlySet<string>;
  declarationCoverage: number;
  exactMatchBoost: number;
  lines: string;
}
export interface LocalRepairDocument { path: string; content: string; prepared?: PreparedLocalRepair }

function declarationCoverage(analysis: LocalRepairAnalysis, terms: ReadonlySet<string>): number {
  let coverage = 0;
  for (const nameTerms of analysis.declarations) {
    coverage = Math.max(coverage, [...terms].filter(term => nameTerms.has(term)).length / terms.size);
  }
  return coverage;
}

/** Query-specific statistics only. No content, line sets or complete vocabulary
 * escapes the bounded analysis cache into a streaming request. */
export function prepareLocalRepairDocument(document: LocalRepairDocument, query: string,
  cache?: LocalRepairAnalysisCache, signal?: AbortSignal): LocalRepairDocument | null {
  signal?.throwIfAborted();
  const terms = new Set(tokenizeLocalSearch(query));
  if (!terms.size) return null;
  const analysis = cache?.get(document.path, document.content, signal)
    ?? analyzeLocalDocument(document.path, document.content, signal);
  const frequencies = new Map([...terms].filter(term=>analysis.frequencies.has(term))
    .map(term=>[term,analysis.frequencies.get(term)!]));
  if (!frequencies.size) return null;
  const lines = /\d/.test(query)
    ? selectSnippetForTerms(document.content, terms, analysis)?.lines
      ?? `1-${document.content.split('\n').slice(0,8).join('\n').slice(0,1600).split('\n').length}`
    : '0-0';
  return { path: document.path, content: '', prepared: {
    length: analysis.length, frequencies,
    pathTerms: new Set([...terms].filter(term=>analysis.pathTerms.has(term))),
    declarationCoverage: declarationCoverage(analysis,terms), lines,
    exactMatchBoost: computeExactMatchBoost({query,path:document.path,content:document.content,lines}),
  } };
}

/** Explicit request metadata limits; these estimates are not a process-RSS limit.
 * Overflow rejects the request, never silently truncates candidate discovery. */
export class LocalRepairDocumentBuffer {
  readonly documents: LocalRepairDocument[] = [];
  estimatedBytes = 0;
  constructor(private readonly maxBytes = 16 * 1024 * 1024, private readonly maxDocuments = 20000) {}
  add(document: LocalRepairDocument): void {
    if (!document.prepared || document.content) throw new Error('Expected compact local retrieval statistics');
    const size = 512 + document.path.length * 4 + document.prepared.frequencies.size * 128;
    if (this.documents.length >= this.maxDocuments || this.estimatedBytes + size > this.maxBytes) {
      throw new LocalRetrievalBudgetError('request');
    }
    this.documents.push(document);this.estimatedBytes += size;
  }
}
export interface LocalRepairScore {
  path: string;
  lexicalScore: number;
  declarationSignal: number;
  pathCoverage: number;
  implementationWeight: number;
  score: number;
  lines: string;
}

/** Prefer executable implementation for location questions, while leaving explicit
 * documentation, test, script and operational requests to ordinary relevance. */
function wantsImplementation(query: string): boolean {
  return /\b(where|implement(?:ation|ed|s)?|function|class|handler|code)\b/i.test(query)
    && !/\b(docs?|documentation|readme|guide|tests?|specs?|scripts?|benchmarks?|reports?|receipts?|metrics?|snapshots?|artifacts?|baseline|json|config(?:uration)?)\b/i.test(query);
}

function implementationWeight(query: string, file: string, preferImplementation: boolean): number {
  if (!preferImplementation) return 1;
  // A literal path or filename remains stronger evidence than its file category.
  const normalizedPath = file.replace(/\\/g, '/').toLowerCase();
  const literalTokens = query.toLowerCase().split(/\s+/).map(token => token.replace(/^[`'"(]+|[`'"),?!]+$/g, ''));
  if (literalTokens.some(token => token.includes('.') && (token === normalizedPath || token === normalizedPath.split('/').pop()))) return 1;
  const signals = buildIdentifierPathSignals(query, file);
  const supporting = /(^|\/)(?:docs?|tests?|__tests__|scripts?|benchmarks?|bench|fixtures?|examples?|coverage|dist|build)(\/|$)/.test(normalizedPath)
    || /\.(?:test|spec)\./.test(normalizedPath);
  return signals.isCodePath && !supporting ? 1 : .35;
}

/** A bounded contiguous range around the densest meaningful term coverage. */
export function selectLocalSnippet(content: string, query: string, analysis?: LocalRepairAnalysis): { content: string; lines: string; coverage: number } | null {
  return selectSnippetForTerms(content, new Set(tokenizeLocalSearch(query)), analysis);
}

function selectSnippetForTerms(content: string, terms: ReadonlySet<string>, analysis?: LocalRepairAnalysis): { content: string; lines: string; coverage: number } | null {
  if (!terms.size) return null;
  const lines = analysis?.lines ?? content.split('\n');
  const queryTerms = [...terms];
  const hits = lines.map((line, index) => {
    const tokens = analysis?.lineTerms[index] ?? new Set(tokenizeLocalSearch(line));
    return new Set(queryTerms.filter(term => tokens.has(term)));
  });
  const counts = new Map<string, number>();
  const width = 12;
  let bestStart = 0, bestCoverage = 0, bestHits = 0, totalHits = 0;
  for (let end = 0; end < lines.length; end++) {
    for (const term of hits[end]) { counts.set(term, (counts.get(term) ?? 0) + 1); totalHits++; }
    if (end >= width) for (const term of hits[end - width]) {
      const count = counts.get(term)! - 1;
      if (count) counts.set(term, count); else counts.delete(term);
      totalHits--;
    }
    if (counts.size > bestCoverage || (counts.size === bestCoverage && totalHits > bestHits)) {
      bestStart = Math.max(0, end - width + 1); bestCoverage = counts.size; bestHits = totalHits;
    }
  }
  if (!bestCoverage) return null;
  // Remove unmatched leading lines so a long introductory line cannot crowd out the evidence.
  let start = bestStart;
  while (start < Math.min(lines.length, bestStart + width) && !hits[start].size) start++;
  let end = start;
  let snippet = '';
  while (end < Math.min(lines.length, bestStart + width)) {
    const next = (snippet ? `${snippet}\n` : '') + lines[end];
    if (next.length > 1600 && snippet) break;
    snippet = next; end++;
    if (snippet.length > 1600) { snippet = snippet.slice(0, 1600); break; }
  }
  return { content: snippet, lines: `${start + 1}-${end}`, coverage: bestCoverage / terms.size };
}

/** Score every readable, eligible document before any top-k truncation. No path exceptions. */
export function rankLocalRepairDocuments(documents: LocalRepairDocument[], query: string, topK: number,
  trace?: (scores: LocalRepairScore[]) => void, signal?: AbortSignal,
  policy: { deprioritizeDocs?: boolean; deprioritizeJson?: boolean; preferImplementation?: boolean } = {},
  analysisCache?: LocalRepairAnalysisCache): SearchResult[] {
  signal?.throwIfAborted();
  const terms = new Set(tokenizeLocalSearch(query));
  if (!terms.size) return [];
  const preferImplementation = policy.preferImplementation !== false && wantsImplementation(query);
  if (documents.length > 20000) throw new LocalRetrievalBudgetError('request');
  const compact = new LocalRepairDocumentBuffer();
  for (const document of documents) {
    const prepared = document.prepared ? document : prepareLocalRepairDocument(document,query,analysisCache,signal);
    if (prepared) compact.add(prepared);
  }
  const snippets = new Map<string, NonNullable<ReturnType<typeof selectLocalSnippet>>>();
  const contents = new Map(documents.map(document => [document.path, document.content]));
  const preparedLines = new Map(documents.filter(document=>document.prepared)
    .map(document=>[document.path,document.prepared!.lines]));
  const lexicalAnalysis = new Map<string, { length: number; frequencies: ReadonlyMap<string, number> }>();
  const exactMatchBoosts = new Map<string, number>();
  const pathCoverages = new Map<string, number>();
  const getSnippet = (file: string) => {
    const cached = snippets.get(file);
    if (cached) return cached;
    signal?.throwIfAborted();
    const content = contents.get(file)!;
    if (preparedLines.has(file)) return {content:'',lines:preparedLines.get(file)!,coverage:0};
    const prefix = () => content.split('\n').slice(0, 8).join('\n').slice(0, 1600);
    const snippet = selectSnippetForTerms(content, terms, analysisCache?.get(file,content,signal));
    const fallback = snippet ? null : prefix();
    const selected = snippet ?? { content: fallback!, lines: `1-${fallback!.split('\n').length}`, coverage: 0 };
    snippets.set(file, selected);
    return selected;
  };
  const candidates: SearchResult[] = [];
  const declarations = new Map<string, number>();
  for (const document of compact.documents) {
    signal?.throwIfAborted();
    const metrics = document.prepared!;
    lexicalAnalysis.set(document.path, metrics);
    exactMatchBoosts.set(document.path, metrics.exactMatchBoost);
    pathCoverages.set(document.path, [...terms].filter(term => metrics.pathTerms.has(term)).length / terms.size);
    declarations.set(document.path, metrics.declarationCoverage);
    candidates.push({ path: document.path, content: '', matchType: 'keyword', lines: metrics.lines });
  }
  signal?.throwIfAborted();
  const lexical = scoreLexicalCandidates(candidates, {
    query, queryVariant: query, variantIndex: 0, variantWeight: 1,
    queryTokens: [...terms], documentAnalysis: lexicalAnalysis, exactMatchWeight: .15, exactMatchBoosts,
  });
  const scored = lexical.map(result => {
    const pathCoverage = pathCoverages.get(result.path)!;
    const declarationSignal = declarations.get(result.path) ?? 0;
    const lexicalScore = result.lexicalScore ?? 0;
    const normalizedPath = result.path.replace(/\\/g, '/').toLowerCase();
    const penalty = policy.deprioritizeDocs && (/^(docs|benchmark|bench|tmp|coverage|dist|build)\//.test(normalizedPath) || normalizedPath.endsWith('.md')) ? .15
      : policy.deprioritizeJson && normalizedPath.endsWith('.json') ? .15 : 0;
    const weight = implementationWeight(query, result.path, preferImplementation);
    // Keep implementation-to-implementation ordering identical to the original
    // scorer; only supporting evidence receives the query-dependent weight.
    const score = Math.max(0, lexicalScore + declarationSignal * .6 + pathCoverage - penalty) * weight;
    return { path: result.path, lexicalScore, declarationSignal, pathCoverage, implementationWeight: weight, score, lines: result.lines! };
  }).sort((a,b) => b.score-a.score || a.path.localeCompare(b.path) || Number(a.lines.split('-')[0])-Number(b.lines.split('-')[0]));
  if (trace) trace(scored.map(item => ({ ...item, lines: getSnippet(item.path).lines })));
  signal?.throwIfAborted();
  const max = scored[0]?.score ?? 1;
  return scored.slice(0, Math.max(0, topK)).map(item => ({ path: item.path, content: getSnippet(item.path).content,
    lines: getSnippet(item.path).lines, score: item.score, relevanceScore: max ? item.score/max : 0, matchType: 'keyword' }));
}
