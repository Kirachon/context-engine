import {
  clearExpandQueryCacheForTests,
  expandQuery,
  getExpandQueryCacheSizeForTests,
} from '../../../src/internal/retrieval/expandQuery.js';

describe('expandQuery', () => {
  afterEach(() => {
    clearExpandQueryCacheForTests();
  });

  it('adds focused identifier variants without broad generic rewrites', () => {
    const variants = expandQuery(
      'lunar-ranking-orchestrator checksum_guard drift_token',
      6,
      { mode: 'v2', profile: 'rich' }
    );

    expect(variants.map((variant) => variant.query)).toEqual(expect.arrayContaining([
      'lunar-ranking-orchestrator checksum_guard drift_token',
      'lunar-ranking-orchestrator',
      'lunar ranking orchestrator checksum guard drift token',
    ]));
    expect(variants.some((variant) => variant.query.startsWith('where '))).toBe(false);
    expect(variants.some((variant) => variant.query.startsWith('implementation of '))).toBe(false);
  });

  it('memoizes and invalidates cached expansions safely', () => {
    const query = 'verify-fixture-integrity schema_guard drift_token';

    expect(getExpandQueryCacheSizeForTests()).toBe(0);

    const first = expandQuery(query, 6, { mode: 'v2', profile: 'rich' });
    expect(getExpandQueryCacheSizeForTests()).toBe(1);

    first[0].query = 'mutated';
    const second = expandQuery(query, 6, { mode: 'v2', profile: 'rich' });
    expect(second[0].query).toBe(query);
    expect(getExpandQueryCacheSizeForTests()).toBe(1);

    clearExpandQueryCacheForTests();
    expect(getExpandQueryCacheSizeForTests()).toBe(0);
  });
});
