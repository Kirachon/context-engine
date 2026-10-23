import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContextServiceClient } from '../src/mcp/serviceClient.js';
import { FEATURE_FLAGS } from '../src/config/features.js';
import { getResultCacheScope } from '../src/internal/handlers/cacheScope.js';
import { internalRetrieveCode } from '../src/internal/handlers/retrieval.js';
import { getInternalCache, setInternalCache } from '../src/internal/handlers/performance.js';
import { readWorkspaceText } from '../src/workspace/openWorkspaceFile.js';
import { handleCodebaseRetrieval } from '../src/mcp/tools/codebaseRetrieval.js';

const deferred = () => { let resolve!: () => void; const promise=new Promise<void>(r=>{resolve=r;}); return {promise,resolve}; };

describe('retrieval review regressions',()=>{
  const flags={...FEATURE_FLAGS};
  let workspace:string,client:ContextServiceClient;
  beforeEach(()=>{
    Object.assign(FEATURE_FLAGS,{retrieval_local_repair_v1:true,index_state_store:true,
      retrieval_sqlite_fts5_v1:false,retrieval_chunk_search_v1:false,retrieval_quality_guard_v1:false});
    workspace=path.join(process.cwd(),'.context-engine/review-fixtures',randomUUID());
    fs.mkdirSync(path.join(workspace,'src'),{recursive:true});
    fs.writeFileSync(path.join(workspace,'src/cache.ts'),'export const legacyMarker = "cache value";');
    client=new ContextServiceClient(workspace);
  });
  afterEach(()=>{Object.assign(FEATURE_FLAGS,flags);jest.restoreAllMocks();});

  it('preserves actionable analysis-budget errors through the public retrieval handler',async()=>{
    FEATURE_FLAGS.index_state_store=false;
    jest.spyOn(process,'memoryUsage').mockReturnValue({...process.memoryUsage(),rss:0});
    fs.writeFileSync(path.join(workspace,'src/cache.ts'),'\n'.repeat(400000));
    await expect(handleCodebaseRetrieval({query:'cache',profile:'fast',top_k:5},client))
      .rejects.toThrow(/analysis memory budget exceeded; narrow include_paths/);
  });
  it('preserves actionable budget errors from semantic fallback',async()=>{
    FEATURE_FLAGS.index_state_store=false;
    fs.writeFileSync(path.join(workspace,'src/cache.ts'),'\n'.repeat(400000));
    jest.spyOn((client as any).retrievalProvider,'search').mockRejectedValue(new Error('synthetic provider failure') as never);
    await expect(client.semanticSearch('cache',5)).rejects.toThrow(/narrow include_paths/);
  });

  it('bounds reads when a file grows after the size snapshot',async()=>{
    const file=path.join(workspace,'src/growing.ts');fs.writeFileSync(file,'tiny');
    const original=fs.promises.open.bind(fs.promises);let consumed=0,grew=false;
    jest.spyOn(fs.promises,'open').mockImplementation((async(...args:any[])=>{
      const handle=await (original as any)(...args),stat=handle.stat.bind(handle),read=handle.read.bind(handle);
      jest.spyOn(handle,'stat').mockImplementation((async(options:any)=>{
        const snapshot=await stat(options);
        if(!options?.bigint&&!grew){grew=true;fs.appendFileSync(file,'x'.repeat(1024));}
        return snapshot;
      }) as any);
      jest.spyOn(handle,'read').mockImplementation((async(...readArgs:any[])=>{
        const result=await (read as any)(...readArgs);consumed+=result.bytesRead;return result;
      }) as any);
      return handle;
    }) as any);
    await expect(readWorkspaceText(workspace,file,32)).rejects.toThrow(/too large/);
    expect(grew).toBe(true);expect(consumed).toBeLessThanOrEqual(33);
  });

  it('rejects an outside directory swap between discovery and opening without reading its content',async()=>{
    await client.indexWorkspace();
    const outside=path.join(path.dirname(workspace),randomUUID());fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside,'cache.ts'),'synthetic outside marker');
    const original=fs.promises.open.bind(fs.promises);let swapped=false,readOutside:ReturnType<typeof jest.spyOn>|undefined;
    jest.spyOn(fs.promises,'open').mockImplementation((async(file:any,...args:any[])=>{
      if(!swapped&&path.resolve(String(file))===path.join(workspace,'src/cache.ts')){
        swapped=true;fs.renameSync(path.join(workspace,'src'),path.join(workspace,'saved-src'));
        fs.symlinkSync(outside,path.join(workspace,'src'),process.platform==='win32'?'junction':'dir');
        // POSIX O_NOFOLLOW protects final links; here the swapped ancestor is
        // validated after opening and before any content read.
        const handle=await (original as any)(file,...args);readOutside=jest.spyOn(handle,'read');return handle;
      }
      return (original as any)(file,...args);
    }) as any);
    expect(await client.getResultCacheScope()).toBeNull();expect(swapped).toBe(true);
    expect(readOutside).toBeDefined();expect(readOutside).not.toHaveBeenCalled();
  });

  it.each(['semantic','keyword'])('does not republish %s results after clearCache during final validation',async mode=>{
    const entered=deferred(),release=deferred();let calls=0;
    jest.spyOn(client,'getResultCacheScope').mockImplementation(async()=>{
      if(++calls===2){entered.resolve();await release.promise;}return 'trusted-corpus';
    });
    jest.spyOn((client as any).retrievalProvider,'search').mockResolvedValue([
      {path:'src/cache.ts',content:'legacyMarker cache value',lines:'1-1',relevanceScore:1},
    ] as never);
    const set=jest.spyOn(client as any,mode==='semantic'?'setCachedSearch':'setCachedKeywordFallbackSearch');
    const request=mode==='semantic'?client.semanticSearch('legacyMarker'):
      (client as any).keywordFallbackSearch('legacyMarker',5);
    await entered.promise;client.clearCache();release.resolve();await request;
    expect(set).not.toHaveBeenCalled();
  });
  it('never reads swapped outside content during a bypassed fallback without index state',async()=>{
    FEATURE_FLAGS.index_state_store=false;
    const outside=path.join(path.dirname(workspace),randomUUID());fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside,'cache.ts'),'export const outsideMarker = "synthetic outside marker";');
    const original=fs.promises.open.bind(fs.promises);let swapped=false,readOutside:ReturnType<typeof jest.spyOn>|undefined;
    jest.spyOn(fs.promises,'open').mockImplementation((async(file:any,...args:any[])=>{
      if(!swapped&&path.resolve(String(file))===path.join(workspace,'src/cache.ts')){
        swapped=true;fs.renameSync(path.join(workspace,'src'),path.join(workspace,'saved-src'));
        fs.symlinkSync(outside,path.join(workspace,'src'),process.platform==='win32'?'junction':'dir');
        const handle=await (original as any)(file,...args);readOutside=jest.spyOn(handle,'read');return handle;
      }
      return (original as any)(file,...args);
    }) as any);
    expect(await (client as any).keywordFallbackSearch('outsideMarker',5,{bypassCache:true})).toEqual([]);
    expect(swapped).toBe(true);expect(readOutside).toBeDefined();expect(readOutside).not.toHaveBeenCalled();
  });
  it.each(['sqlite','chunk'])('rejects cancellation while the %s backend is pending',async backend=>{
    const controller=new AbortController(),entered=deferred(),release=deferred();
    const search=jest.fn(async()=>{entered.resolve();await release.promise;
      return [{path:'src/cache.ts',content:'cache value',lines:'1-1',relevanceScore:1}];});
    jest.spyOn(client as any,'isLexicalSqliteSearchEnabled').mockReturnValue(backend==='sqlite');
    jest.spyOn(client as any,'isChunkAwareExactSearchEnabled').mockReturnValue(backend==='chunk');
    jest.spyOn(client as any,'getLexicalSqliteSearchEngine').mockReturnValue({search});
    jest.spyOn(client as any,'getChunkSearchEngine').mockReturnValue({search});
    const pending=(client as any).keywordFallbackSearch('cache',5,{bypassCache:true,signal:controller.signal});
    await entered.promise;controller.abort();release.resolve();await expect(pending).rejects.toThrow();
    expect((client as any).keywordFallbackSearchCache.size).toBe(0);
  });

  it('passes cancellation through the cache-scope adapter',async()=>{
    const controller=new AbortController(),entered=deferred(),release=deferred();
    const getter=jest.fn(async(signal?:AbortSignal)=>{expect(signal).toBe(controller.signal);entered.resolve();await release.promise;return 'scope';});
    const pending=getResultCacheScope({getResultCacheScope:getter},controller.signal);
    await entered.promise;controller.abort();release.resolve();await expect(pending).rejects.toThrow();
  });

  it.each([1,2])('cancels handler cache validation at scan %i without publishing',async scan=>{
    const previous=getInternalCache(),controller=new AbortController(),entered=deferred(),release=deferred();let calls=0;
    const cache={get:jest.fn(()=>undefined),set:jest.fn()};setInternalCache(cache);
    const getter=jest.fn(async(signal?:AbortSignal)=>{
      expect(signal).toBe(controller.signal);if(++calls===scan){entered.resolve();await release.promise;}return 'scope';
    });
    const service={getResultCacheScope:getter,getActiveRetrievalProviderId:()=> 'local_native',
      localKeywordSearch:jest.fn(async()=>[{path:'src/cache.ts',content:'cache value',lines:'1-1',relevanceScore:1}]),
      semanticSearch:jest.fn(async()=>[])} as any;
    try{
      const pending=internalRetrieveCode('cache value',service,{topK:5,enableExpansion:false,enableRerank:false,signal:controller.signal});
      await entered.promise;controller.abort();release.resolve();await expect(pending).rejects.toThrow();
      expect(cache.set).not.toHaveBeenCalled();
    }finally{setInternalCache(previous);}
  });

  it('keeps default-off health checks lightweight',()=>{
    FEATURE_FLAGS.retrieval_local_repair_v1=false;
    const discover=jest.spyOn(client as any,'discoverWorkspaceFilesSync');
    const refresh=jest.spyOn(client as any,'refreshCorpusFreshness');
    client.getCompositeHealth();expect(discover).not.toHaveBeenCalled();expect(refresh).not.toHaveBeenCalled();
  });

  it('keeps default-off semantic caching and in-flight dedup without index state',async()=>{
    FEATURE_FLAGS.retrieval_local_repair_v1=false;FEATURE_FLAGS.index_state_store=false;
    const scope=jest.spyOn(client,'getResultCacheScope');
    const provider=jest.spyOn((client as any).retrievalProvider,'search').mockResolvedValue([
      {path:'src/cache.ts',content:'cache value',lines:'1-1',relevanceScore:1},
    ] as never);
    await client.semanticSearch('cache value');await client.semanticSearch('cache value');
    expect(provider).toHaveBeenCalledTimes(1);expect(scope).not.toHaveBeenCalled();
    provider.mockClear();
    await Promise.all([client.semanticSearch('concurrent',5,{bypassCache:true}),
      client.semanticSearch('concurrent',5,{bypassCache:true})]);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('keeps default-off keyword result and discovery caches without corpus hashing',async()=>{
    FEATURE_FLAGS.retrieval_local_repair_v1=false;FEATURE_FLAGS.index_state_store=false;
    const scope=jest.spyOn(client,'getResultCacheScope'),read=jest.spyOn(client,'getFile');
    const discover=jest.spyOn(client as any,'getCachedFallbackFiles');
    const search=()=> (client as any).keywordFallbackSearch('legacyMarker',5);
    expect((await search()).length).toBe(1);expect((await search()).length).toBe(1);
    expect(scope).not.toHaveBeenCalled();expect(read).toHaveBeenCalledTimes(1);
    expect(discover).toHaveBeenCalledWith({bypassCache:false});
  });
});
