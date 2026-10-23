import { describe, expect, it } from '@jest/globals';
import { rankLocalRepairDocuments, selectLocalSnippet, prepareLocalRepairDocument, LocalRepairDocumentBuffer } from '../../../src/internal/retrieval/localRepair.js';
import { analyzeLocalDocument } from '../../../src/internal/retrieval/localRepairAnalysis.js';
import { tokenizeLocalSearch } from '../../../src/internal/retrieval/searchHeuristics.js';
import { getFeatureFlagsFromEnv } from '../../../src/config/features.js';

describe('local repair scorer', () => {
  it('preserves ranking and exact boosts with compact query statistics',()=>{
    const docs=[{path:'src/cache21.ts',content:'// refresh cache 21\nexport function refreshCache21() { return keys; }'},
      {path:'docs/cache.md',content:'refresh cache 21\n'.repeat(30)},
      {path:'src/other.ts',content:'export const cacheKeys = [21];'}];
    for(const query of ['Where are cache keys refreshed?','refresh cache 21','cache21.ts']){
      const compact=docs.map(d=>prepareLocalRepairDocument(d,query)).filter((d):d is NonNullable<typeof d>=>Boolean(d));
      const scores=(r:ReturnType<typeof rankLocalRepairDocuments>)=>r.map(x=>[x.path,x.score,x.relevanceScore]);
      expect(scores(rankLocalRepairDocuments(compact,query,10))).toEqual(scores(rankLocalRepairDocuments(docs,query,10)));
    }
  });
  it('retains no full corpus text or per-line analysis and enforces metadata limits',()=>{
    const buffer=new LocalRepairDocumentBuffer();
    const text='export function cacheValue() {}\n'+'// unrelated words\n'.repeat(2500);
    for(let i=0;i<300;i++)buffer.add(prepareLocalRepairDocument({path:`src/${i}.ts`,content:text},'cache value')!);
    expect(buffer.documents.every(d=>d.content===''&&d.prepared!.frequencies.size<=2)).toBe(true);
    expect(buffer.estimatedBytes).toBeLessThan(1024*1024);
    const limited=new LocalRepairDocumentBuffer(1024,1);limited.add(buffer.documents[0]);
    expect(()=>limited.add(buffer.documents[1])).toThrow(/memory budget/);
    expect(limited.documents).toHaveLength(1);
  });
  it('rejects pathological per-file analysis before allocating a set for every line',()=>{
    expect(()=>analyzeLocalDocument('src/cache.ts','\n'.repeat(400000))).toThrow(/analysis memory budget/);
  });
  it('is default-off in every profile and honors the explicit feature kill switch', () => {
    const before = { profile: process.env.CE_PERF_PROFILE, repair: process.env.CE_RETRIEVAL_LOCAL_REPAIR_V1, kill: process.env.CE_FEATURE_KILL_SWITCHES };
    try {
      delete process.env.CE_RETRIEVAL_LOCAL_REPAIR_V1; delete process.env.CE_FEATURE_KILL_SWITCHES;
      for (const profile of ['default', 'fast', 'quality']) {
        process.env.CE_PERF_PROFILE = profile;
        expect(getFeatureFlagsFromEnv().retrieval_local_repair_v1).toBe(false);
      }
      process.env.CE_RETRIEVAL_LOCAL_REPAIR_V1 = 'true';
      expect(getFeatureFlagsFromEnv().retrieval_local_repair_v1).toBe(true);
      process.env.CE_FEATURE_KILL_SWITCHES = 'retrieval_local_repair_v1';
      expect(getFeatureFlagsFromEnv().retrieval_local_repair_v1).toBe(false);
    } finally {
      for (const [name,value] of Object.entries({CE_PERF_PROFILE:before.profile,CE_RETRIEVAL_LOCAL_REPAIR_V1:before.repair,CE_FEATURE_KILL_SWITCHES:before.kill})) {
        if(value === undefined) delete process.env[name]; else process.env[name]=value;
      }
    }
  });
  it('shares identifier, acronym, snake case and conservative plural analysis', () => {
    expect(tokenizeLocalSearch('HTTPResponseCache cache_keys policies paths classes status')).toEqual(
      ['http', 'response', 'cache', 'cache', 'key', 'policy', 'path', 'class', 'status']);
  });
  it('ranks content before truncation without provider/factory location bonuses', () => {
    const docs = Array.from({length:180}, (_,i)=>({path:`src/aaa${i}.ts`,content:'export const irrelevant = true;'}));
    docs.push({path:'src/ai/providers/factory.ts',content:'// cache mentioned incidentally'});
    docs.push({path:'src/zzz.ts',content:'export function invalidateCacheKeys() { return cacheKeys.clear(); }'});
    const trace: unknown[] = [];
    const result=rankLocalRepairDocuments(docs,'invalidate cache keys',5,s=>trace.push(...s));
    expect(result[0].path).toBe('src/zzz.ts');
    expect(trace).toHaveLength(2);
  });
  it('prefers a queried declaration to an incidental mention with identical terms', () => {
    const result=rankLocalRepairDocuments([
      {path:'src/a.ts',content:'// refresh cache keys\nconst note = "refresh cache keys";'},
      {path:'src/z.ts',content:'export function refreshCacheKeys() { return cacheKeys.refresh(); }'},
    ],'refresh cache keys',2);
    expect(result[0].path).toBe('src/z.ts');
  });
  it('selects the strongest concentration with exact CRLF source lines', () => {
    const lines=['// cache',...Array(30).fill(''), 'export function updateCacheKeys() {', '  cacheKeys.clear();', '}'];
    const content=lines.join('\r\n');const snippet=selectLocalSnippet(content,'update cache keys')!;
    const [start,end]=snippet.lines.split('-').map(Number);
    expect(start).toBeGreaterThan(20);
    expect(snippet.content).toBe(content.split('\n').slice(start-1,end).join('\n'));
    expect(snippet.content).toContain('updateCacheKeys');
  });
  it('handles Unicode terms and uses deterministic path ties', () => {
    const result=rankLocalRepairDocuments([{path:'src/β.ts',content:'const résumé = "données";'},
      {path:'src/α.ts',content:'const résumé = "données";'}], 'résumé données',2);
    expect(result.map(x=>x.path)).toEqual(['src/α.ts','src/β.ts']);
    expect(result[0].relevanceScore).toBeGreaterThan(0);
  });
  it('honors abort before scoring and handles empty queries', () => {
    const controller=new AbortController();controller.abort();
    expect(()=>rankLocalRepairDocuments([], 'cache',5,undefined,controller.signal)).toThrow();
    expect(rankLocalRepairDocuments([{path:'a',content:'a'}],'where is the',5)).toEqual([]);
  });
  it('prefers implementation to repeated documentation, test and benchmark mentions for location questions', () => {
    const documents=[
      {path:'lib/security/validateLinks.ts',content:'export function validateLinks() { return resolveWorkspacePath(); }'},
      ...['docs/links.md','scripts/bench.mjs','tests/links.test.ts'].map(path=>({path,content:'// validate links workspace path\n'.repeat(25)})),
    ];
    const trace:any[]=[];
    const result=rankLocalRepairDocuments(documents,'Where are workspace links validated?',4,s=>trace.push(...s));
    expect(result[0].path).toBe('lib/security/validateLinks.ts');
    expect(trace.find(s=>s.path==='docs/links.md').implementationWeight).toBeLessThan(1);
  });
  it.each(['documentation','test','script','benchmark','configuration'])(
    'does not apply implementation preference to an explicit %s request', kind => {
      const trace:any[]=[];
      rankLocalRepairDocuments([{path:'docs/cache.md',content:'cache implementation'},
        {path:'src/cache.ts',content:'cache implementation'}],`Where is the cache ${kind}?`,2,s=>trace.push(...s));
      expect(trace.every(s=>s.implementationWeight===1)).toBe(true);
    });
  it('keeps literal supporting filenames eligible', () => {
    const docs=[{path:'scripts/cache.mjs',content:'export function cacheKeys() {}'},
      {path:'lib/unrelated.ts',content:'export const keys = true;'}];
    const trace:any[]=[];
    const result=rankLocalRepairDocuments(docs,'Where is `scripts/cache.mjs`?',2,s=>trace.push(...s));
    expect(result[0].path).toBe('scripts/cache.mjs');
    expect(trace[0].implementationWeight).toBe(1);
  });
  it('honors an explicit include-category override supplied by the caller', () => {
    const trace:any[]=[];
    rankLocalRepairDocuments([{path:'docs/cache.md',content:'cache keys'},
      {path:'src/cache.ts',content:'cache keys'}], 'Where are cache keys implemented?',2,
      s=>trace.push(...s),undefined,{preferImplementation:false});
    expect(trace.every(s=>s.implementationWeight===1)).toBe(true);
  });
  it('preserves scores and ordering among implementation files for location questions', () => {
    const documents=[
      {path:'src/cacheKeys.ts',content:'export function refreshCacheKeys() { return keys.refresh(); }'},
      {path:'lib/store.ts',content:'export function refreshStore() { return cacheKeys.refresh(); }'},
      {path:'app/cache.ts',content:'export const cacheKeys = ["refresh"];'},
    ];
    const query='Where are cache keys refreshed?';
    expect(rankLocalRepairDocuments(documents,query,3)).toEqual(
      rankLocalRepairDocuments(documents,query,3,undefined,undefined,{preferImplementation:false}));
  });
});
