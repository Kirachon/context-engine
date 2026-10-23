import { describe, expect, it, jest } from '@jest/globals';
import { analyzeLocalDocument, LocalRepairAnalysisCache } from '../../../src/internal/retrieval/localRepairAnalysis.js';
import { rankLocalRepairDocuments } from '../../../src/internal/retrieval/localRepair.js';
import { tokenizeLocalSearch } from '../../../src/internal/retrieval/searchHeuristics.js';

describe('content-bound local repair analysis', () => {
  it('preserves full-text frequency and document length across lines and Unicode', () => {
    const file = 'src/résuméCache.ts';
    const content = '// HTTPResponseCache\r\nexport function updateCacheKeys() {\r\n return "İİİ résumé données cache_keys";\r\n}';
    const tokens = tokenizeLocalSearch(`${file}\n${content}`);
    const expected = new Map<string, number>();
    for (const term of tokens) expected.set(term, (expected.get(term) ?? 0) + 1);
    const analysis = analyzeLocalDocument(file, content);
    expect(analysis.length).toBe(tokens.length);
    expect([...analysis.frequencies]).toEqual([...expected]);
    expect(analysis.lines.join('\n')).toBe(content);
  });

  it('reuses identical content and invalidates same-size changed bytes', () => {
    const cache = new LocalRepairAnalysisCache();
    const first = cache.get('src/cache.ts', 'const alphaValue = 1;');
    expect(cache.get('src/cache.ts', 'const alphaValue = 1;')).toBe(first);
    const changed = cache.get('src/cache.ts', 'const bravoValue = 1;');
    expect(changed).not.toBe(first);
    expect(changed.frequencies.has('alpha')).toBe(false);
    expect(changed.frequencies.has('bravo')).toBe(true);
    expect(cache.get('src/other.ts', 'const bravoValue = 1;')).not.toBe(changed);
  });

  it('evicts by entry and estimated memory limits and clears explicitly', () => {
    const cache = new LocalRepairAnalysisCache(1);
    const first = cache.get('a.ts', 'cache');
    cache.get('b.ts', 'checkpoint');
    expect(cache.get('a.ts', 'cache')).not.toBe(first);
    const bounded = new LocalRepairAnalysisCache(512, 1);
    expect(bounded.get('a.ts', 'cache')).not.toBe(bounded.get('a.ts', 'cache'));
    const retained = cache.get('a.ts', 'cache');
    cache.clear();
    expect(cache.get('a.ts', 'cache')).not.toBe(retained);
  });

  it('never serves cached analysis to an aborted request', () => {
    const cache = new LocalRepairAnalysisCache();
    cache.get('a.ts', 'cache');
    const controller = new AbortController(); controller.abort();
    expect(() => cache.get('a.ts', 'cache', controller.signal)).toThrow();
    expect(() => analyzeLocalDocument('a.ts', 'cache', controller.signal)).toThrow();
  });

  it('does not publish partial analysis when cancellation arrives between lines', () => {
    const cache = new LocalRepairAnalysisCache();
    const controller = new AbortController();
    const original = controller.signal.throwIfAborted.bind(controller.signal);
    let checks = 0;
    const spy = jest.spyOn(controller.signal, 'throwIfAborted').mockImplementation(() => {
      if (++checks === 4) controller.abort();
      original();
    });
    const content = 'const firstCache = 1;\nconst finalCheckpoint = 2;';
    try { expect(() => cache.get('a.ts', content, controller.signal)).toThrow(); }
    finally { spy.mockRestore(); }
    const complete = cache.get('a.ts', content);
    expect(complete.frequencies.has('final')).toBe(true);
    expect(cache.get('a.ts', content)).toBe(complete);
  });

  it('keeps ranking, dense snippets, source lines and traces equal with reuse', () => {
    const documents = [
      { path: 'src/cache.ts', content: ['// cache', ...Array(24).fill(''), 'export function updateCacheKeys() {', ' cacheKeys.clear();', '}'].join('\r\n') },
      { path: 'src/other.ts', content: '// update cache keys\nexport const note = true;' },
    ];
    const cache = new LocalRepairAnalysisCache();
    for (const query of ['update cache keys', 'cache 305', 'other', 'Where are cache keys updated?']) {
      const expectedTrace: unknown[] = [], cachedTrace: unknown[] = [];
      const expected = rankLocalRepairDocuments(documents, query, 5, rows => expectedTrace.push(rows));
      const cached = rankLocalRepairDocuments(documents, query, 5, rows => cachedTrace.push(rows), undefined, {}, cache);
      expect(cached).toEqual(expected);
      expect(cachedTrace).toEqual(expectedTrace);
    }
    documents[0].content = 'export function removeCacheKeys() {}';
    expect(rankLocalRepairDocuments(documents, 'remove cache keys', 5, undefined, undefined, {}, cache))
      .toEqual(rankLocalRepairDocuments(documents, 'remove cache keys', 5));
  });
});
