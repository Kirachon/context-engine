import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContextServiceClient } from '../src/mcp/serviceClient.js';
import { FEATURE_FLAGS } from '../src/config/features.js';
import { evaluateIndexFreshness } from '../src/mcp/tooling/indexFreshness.js';
import { buildIndexStatusStructuredContent } from '../src/mcp/tools/status.js';

describe('local repair service integration', () => {
  let workspace: string;
  let client: ContextServiceClient;
  const previous={...FEATURE_FLAGS};
  const write=(file:string,content:string)=>{const target=path.join(workspace,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content);};
  const search=(query:string,options:Record<string,unknown>={})=>(client as any).keywordFallbackSearch(query,5,{bypassCache:true,...options});
  beforeEach(()=>{
    workspace=path.join(process.cwd(),'.context-engine/experiments/local-retrieval-repair-20261022/test-workspaces',randomUUID());
    fs.mkdirSync(workspace,{recursive:true});
    Object.assign(FEATURE_FLAGS,{retrieval_local_repair_v1:true,retrieval_sqlite_fts5_v1:false,retrieval_chunk_search_v1:false});
    client=new ContextServiceClient(workspace);
  });
  afterEach(()=>{Object.assign(FEATURE_FLAGS,previous);jest.restoreAllMocks();});
  it('discovers an untracked eligible file beyond the old cutoff and respects ignored files and scope',async()=>{
    for(let i=0;i<170;i++)write(`src/aaa${i}.ts`,'// unrelated implementation');
    write('src/zzz.ts','export function saveDurableCheckpoints() { return checkpointStore.save(); }');
    write('.gitignore','ignored/\n');write('ignored/private.ts','saveDurableCheckpoints');
    expect((await search('save durable checkpoints implementation')).map((r:any)=>r.path)).toContain('src/zzz.ts');
    expect((await search('save durable checkpoints')).map((r:any)=>r.path)).not.toContain('ignored/private.ts');
    expect(await search('save durable checkpoints',{includePaths:['src/aaa*']})).toEqual([]);
    expect(await search('save durable checkpoints',{excludePaths:['src/zzz.ts']})).toEqual([]);
  });
  it('invalidates ignore decisions on same-size rule edits even without index state',async()=>{
    FEATURE_FLAGS.index_state_store=false;
    write('alpha/cache.ts','export function sharedCheckpoint() {}');
    write('bravo/cache.ts','export function sharedCheckpoint() {}');
    write('.contextignore','alpha/\n');
    expect((await search('shared checkpoint')).map((r:any)=>r.path)).toEqual(['bravo/cache.ts']);
    const ignoreFile=path.join(workspace,'.contextignore');const original=fs.statSync(ignoreFile);
    write('.contextignore','bravo/\n');fs.utimesSync(ignoreFile,original.atime,original.mtime);
    expect((await search('shared checkpoint')).map((r:any)=>r.path)).toEqual(['alpha/cache.ts']);
    fs.unlinkSync(ignoreFile);
    expect((await search('shared checkpoint')).map((r:any)=>r.path).sort()).toEqual(['alpha/cache.ts','bravo/cache.ts']);
    const compute=jest.spyOn(client as any,'computeShouldIgnorePath');
    await search('shared checkpoint');await search('shared checkpoint');
    expect(compute).not.toHaveBeenCalled();
  });

  it('reads changed same-size content and newly created files on the next request',async()=>{
    write('src/cache.ts','const alphaToken = 1;');
    expect((await search('alpha')).length).toBe(1);
    write('src/cache.ts','const bravoToken = 1;');
    expect(await search('alpha')).toEqual([]);
    expect((await search('bravo')).length).toBe(1);
    write('src/new.ts','const newCheckpoint = 1;');
    expect((await search('new checkpoint')).map((r:any)=>r.path)).toContain('src/new.ts');
  });
  it('reuses analysis only after a fresh read and drops stale result hits after mutation',async()=>{
    FEATURE_FLAGS.index_state_store=true;
    write('src/cache.ts','export const alphaValue = 1;');
    await client.indexWorkspace();
    const getFile=jest.spyOn(client as any,'getFallbackSearchFileContent');
    const run=(query:string)=>(client as any).keywordFallbackSearch(query,5,{bypassCache:false});
    expect((await run('alpha')).map((r:any)=>r.path)).toContain('src/cache.ts');
    getFile.mockClear();
    expect((await run('alpha')).length).toBe(1);
    expect(getFile).not.toHaveBeenCalled();
    write('src/cache.ts','export const bravoValue = 1;');
    expect(await run('alpha')).toEqual([]);
    expect(getFile).toHaveBeenCalled();
    expect((await run('bravo')).map((r:any)=>r.path)).toContain('src/cache.ts');
    client.clearCache();
    expect((client as any).localRepairAnalysisCache.entries.size).toBe(0);
  });
  it('separates both semantic and keyword cache identities by repair/scorer version',()=>{
    const enabled=(client as any).getKeywordFallbackSearchCacheKey('cache',5);
    const semantic=(client as any).getCommitAwareCacheKey('cache',5);
    FEATURE_FLAGS.retrieval_local_repair_v1=false;
    expect((client as any).getKeywordFallbackSearchCacheKey('cache',5)).not.toBe(enabled);
    expect((client as any).getCommitAwareCacheKey('cache',5)).not.toBe(semantic);
  });
  it('aborts during reads and never returns or caches partial results',async()=>{
    write('src/cache.ts','export function clearCacheKeys() {}');
    const controller=new AbortController();const getFile=(client as any).getFallbackSearchFileContent.bind(client);
    jest.spyOn(client as any,'getFallbackSearchFileContent').mockImplementation(async (...args: any[])=>{const result=await getFile(...args);controller.abort();return result;});
    await expect(search('clear cache keys',{signal:controller.signal})).rejects.toThrow();
    expect((client as any).keywordFallbackSearchCache.size).toBe(0);
  });
  it('keeps Unicode paths and rejects a junction to another workspace',async()=>{
    write('src/évidence.ts','export function verifyRésumé() { return résumé; }');
    expect((await search('verify résumé')).map((r:any)=>r.path)).toContain('src/évidence.ts');
    const other=path.join(path.dirname(workspace),randomUUID());fs.mkdirSync(other,{recursive:true});
    fs.writeFileSync(path.join(other,'outside.ts'),'export function outsideSecretMarker() {}');
    fs.symlinkSync(other,path.join(workspace,'linked'),process.platform==='win32'?'junction':'dir');
    expect(await search('outside secret marker')).toEqual([]);
  });
  it('finds Unicode-only queries through the service guard and preserves disabled behavior',async()=>{
    write('src/新規.ts','export const 保存記録 = true;');
    write('src/архив.ts','export const сохранение = true;');
    for (const [query,file] of [['保存記録','src/新規.ts'],['сохранение','src/архив.ts']]) {
      const results=await search(query);
      expect(results.map((r:any)=>r.path)).toEqual([file]);
      expect(results[0].lines).toBe('1-1');
      expect(await search(query,{excludePaths:[file]})).toEqual([]);
    }
    FEATURE_FLAGS.retrieval_local_repair_v1=false;
    expect(await search('保存記録')).toEqual([]);
  });
  it('honors include:docs when applying implementation preference',async()=>{
    write('src/cache.ts','export const cacheKeys = true;');
    write('docs/cache.md','cache keys implemented\n'.repeat(30));
    expect((await search('Where are cache keys implemented?'))[0].path).toBe('src/cache.ts');
    expect((await search('Where are cache keys implemented? include:docs'))[0].path).toBe('docs/cache.md');
  });
  it('uses fresh async status scans and detects same-size changes with restored timestamps',async()=>{
    FEATURE_FLAGS.index_state_store=true;
    write('src/cache.ts','export const alphaValue = 1;');
    await client.indexWorkspace();
    const refresh=jest.spyOn(client as any,'refreshCorpusFreshness');
    expect((await client.getIndexStatusAsync()).isStale).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    const file=path.join(workspace,'src/cache.ts'),stat=fs.statSync(file);
    write('src/cache.ts','export const bravoValue = 1;');fs.utimesSync(file,stat.atime,stat.mtime);
    expect((await client.getIndexStatusAsync()).isStale).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    expect(await client.getResultCacheScope()).toBeNull();
    const controller=new AbortController();controller.abort();
    await expect(client.getIndexStatusAsync(controller.signal)).rejects.toThrow();
  });
  it('keeps async status fallback for empty, uninitialized and disabled repair states',async()=>{
    expect((await client.getIndexStatusAsync()).indexAvailability).toBe('empty_workspace');
    write('src/cache.ts','export const cache = true;');
    expect((await client.getIndexStatusAsync()).indexAvailability).toBe('uninitialized');
    FEATURE_FLAGS.retrieval_local_repair_v1=false;
    const original=jest.spyOn(client,'getIndexStatus');
    await client.getIndexStatusAsync();expect(original).toHaveBeenCalled();
  });
  it('does not classify binary-only eligible files as an empty workspace',async()=>{
    FEATURE_FLAGS.index_state_store=true;
    write('src/binary.ts','\u0000binary data');
    await client.indexWorkspace();
    expect((await client.getIndexStatusAsync()).indexAvailability).toBe(client.getIndexStatus().indexAvailability);
    expect((await client.getIndexStatusAsync()).indexAvailability).not.toBe('empty_workspace');
  });
  it('distinguishes an empty workspace, timestamp-only state and an available index',async()=>{
    expect(client.getIndexStatus().indexAvailability).toBe('empty_workspace');
    write('src/cache.ts','export const cacheKeys = [];');
    (client as any).indexStatus.lastIndexed=new Date().toISOString();
    const status=client.getIndexStatus();
    expect(status.indexAvailability).toBe('uninitialized');
    expect(evaluateIndexFreshness(status).code).toBe('unindexed');
    expect(status.components?.corpus.state).not.toBe('ready');
    await client.indexWorkspace();
    expect(client.getIndexStatus().indexAvailability).toBe('available');
    await search('cache keys');
    const structured=buildIndexStatusStructuredContent(client.getIndexStatus());
    expect(structured.retrieval).toMatchObject({lastExecutedBackend:'file-scan',repairEnabled:true,embeddingsEnabled:false});
  });
});
