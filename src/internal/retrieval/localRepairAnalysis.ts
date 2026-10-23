import { tokenizeLocalSearch } from './searchHeuristics.js';
import { LocalRetrievalBudgetError } from './localRepairBudget.js';

export interface LocalRepairAnalysis {
  length: number;
  frequencies: ReadonlyMap<string, number>;
  pathTerms: ReadonlySet<string>;
  lines: readonly string[];
  lineTerms: readonly ReadonlySet<string>[];
  declarations: readonly ReadonlySet<string>[];
}

interface AnalysisEntry { content: string; analysis: LocalRepairAnalysis; estimatedBytes: number }

/** Query-independent analysis of the exact bytes supplied by the secure reader. */
export function analyzeLocalDocument(file: string, content: string, signal?: AbortSignal): LocalRepairAnalysis {
  signal?.throwIfAborted();
  const pathTokens = tokenizeLocalSearch(file);
  const lines = content.split('\n');
  const baseBytes = 2 * (file.length + content.length) + 96 * lines.length;
  const maxAnalysisBytes = 32 * 1024 * 1024;
  let termEntries = 0;
  const checkBudget = () => {
    if (baseBytes + 96 * frequencies.size + 64 * termEntries > maxAnalysisBytes) {
      throw new LocalRetrievalBudgetError('analysis');
    }
  };
  const frequencies = new Map<string, number>();
  let length = 0;
  const add = (tokens: string[]) => {
    length += tokens.length;
    for (const term of tokens) {
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
      checkBudget();
    }
  };
  checkBudget();
  add(pathTokens);
  const lineTerms: Set<string>[] = [], declarations: Set<string>[] = [];
  for (const line of lines) {
    signal?.throwIfAborted();
    const tokens = tokenizeLocalSearch(line);
    add(tokens);
    lineTerms.push(new Set(tokens));
    termEntries += lineTerms[lineTerms.length-1].size;
    const match = /\b(?:function|class|interface|type|enum|const|let|var|def|func)\s+([\p{L}\p{N}_$]+)/u.exec(line);
    if (match && !/^\s*(?:\/\/|\*|\/\*)/.test(line)) {
      const declaration = new Set(tokenizeLocalSearch(match[1]));
      declarations.push(declaration);termEntries += declaration.size;
    }
    checkBudget();
  }
  return { length: Math.max(1, length), frequencies, pathTerms: new Set(pathTokens), lines, lineTerms, declarations };
}

/**
 * Bounded, process-only analysis reuse. Callers MUST still securely read files
 * before lookup: a path, timestamp or index generation alone is insufficient.
 * Limits count retained entries and estimated analysis bytes, not process RSS.
 */
export class LocalRepairAnalysisCache {
  private readonly entries = new Map<string, AnalysisEntry>();
  private retainedBytes = 0;

  constructor(private readonly maxEntries = 512, private readonly maxEstimatedBytes = 32 * 1024 * 1024) {}

  get(file: string, content: string, signal?: AbortSignal): LocalRepairAnalysis {
    signal?.throwIfAborted();
    const previous = this.entries.get(file);
    if (previous) {
      this.entries.delete(file);
      this.retainedBytes -= previous.estimatedBytes;
      if (previous.content === content) {
        this.entries.set(file, previous);
        this.retainedBytes += previous.estimatedBytes;
        return previous.analysis;
      }
    }
    const analysis = analyzeLocalDocument(file, content, signal);
    const lineTermCount = analysis.lineTerms.reduce((sum, terms) => sum + terms.size, 0);
    const declarationTerms = analysis.declarations.reduce((sum, terms) => sum + terms.size, 0);
    const estimatedBytes = 2 * (file.length + content.length) + 96 * analysis.frequencies.size
      + 64 * (lineTermCount + declarationTerms) + 96 * analysis.lines.length;
    signal?.throwIfAborted();
    if (this.maxEntries <= 0 || estimatedBytes > this.maxEstimatedBytes) return analysis;
    while (this.entries.size >= this.maxEntries || this.retainedBytes + estimatedBytes > this.maxEstimatedBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.retainedBytes -= this.entries.get(oldest)!.estimatedBytes;
      this.entries.delete(oldest);
    }
    this.entries.set(file, { content, analysis, estimatedBytes });
    this.retainedBytes += estimatedBytes;
    return analysis;
  }

  clear(): void {
    this.entries.clear();
    this.retainedBytes = 0;
  }
}
