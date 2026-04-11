import { ResponseCache, type CacheKey } from '../../../src/reactive/cache/ResponseCache.js';
import type { ReviewFinding } from '../../../src/reactive/executors/AIAgentStepExecutor.js';

function createKey(overrides: Partial<CacheKey> = {}): CacheKey {
    return {
        commit_hash: 'commit-1',
        file_path: 'src/example.ts',
        content_hash: 'content-hash',
        step_description: 'Review security',
        ...overrides,
    };
}

function createFindings(message: string): ReviewFinding[] {
    return [
        {
            file: 'src/example.ts',
            severity: 'warning',
            category: 'security',
            message,
            suggestion: 'Review this code path',
        },
    ];
}

describe('ResponseCache hardening', () => {
    it('evicts the oldest commit cache entries when commit capacity is exceeded', () => {
        const cache = new ResponseCache({
            enable_memory_cache: false,
            enable_commit_cache: true,
            enable_file_hash_cache: false,
            max_commit_cache_commits: 2,
        });

        const commit1Key = createKey({ commit_hash: 'commit-1', content_hash: 'hash-1' });
        const commit2Key = createKey({ commit_hash: 'commit-2', content_hash: 'hash-2' });
        const commit3Key = createKey({ commit_hash: 'commit-3', content_hash: 'hash-3' });

        cache.set(commit1Key, createFindings('commit-1'));
        cache.set(commit2Key, createFindings('commit-2'));
        cache.set(commit3Key, createFindings('commit-3'));

        expect(cache.get(commit1Key)).toBeNull();
        expect(cache.get(commit2Key)).toMatchObject({
            cache_layer: 'commit',
            findings: createFindings('commit-2'),
        });
        expect(cache.get(commit3Key)).toMatchObject({
            cache_layer: 'commit',
            findings: createFindings('commit-3'),
        });
    });

    it('isolates file-hash cache reuse by review step while preserving same-step hits', () => {
        const cache = new ResponseCache({
            enable_memory_cache: false,
            enable_commit_cache: false,
            enable_file_hash_cache: true,
        });

        const securityKey = createKey({
            commit_hash: 'commit-1',
            content_hash: 'shared-content',
            step_description: 'Review security',
        });
        const sameStepDifferentCommitKey = createKey({
            commit_hash: 'commit-2',
            content_hash: 'shared-content',
            step_description: 'Review security',
        });
        const differentStepKey = createKey({
            commit_hash: 'commit-3',
            content_hash: 'shared-content',
            step_description: 'Review style',
        });

        cache.set(securityKey, createFindings('security finding'));

        expect(cache.get(sameStepDifferentCommitKey)).toMatchObject({
            cache_layer: 'file_hash',
            findings: createFindings('security finding'),
        });
        expect(cache.get(differentStepKey)).toBeNull();
    });

    it('expires stale commit and file-hash entries before they can be reused', () => {
        jest.useFakeTimers();
        try {
            const start = new Date('2026-01-01T00:00:00.000Z');
            jest.setSystemTime(start);

            const cache = new ResponseCache({
                enable_memory_cache: false,
                enable_commit_cache: true,
                enable_file_hash_cache: true,
                cache_ttl_ms: 50,
            });

            const primaryKey = createKey({
                commit_hash: 'commit-1',
                content_hash: 'shared-content',
            });
            const sameContentDifferentCommitKey = createKey({
                commit_hash: 'commit-2',
                content_hash: 'shared-content',
            });

            cache.set(primaryKey, createFindings('ttl-protected finding'));

            expect(cache.get(primaryKey)).toMatchObject({
                cache_layer: 'commit',
                findings: createFindings('ttl-protected finding'),
            });
            expect(cache.get(sameContentDifferentCommitKey)).toMatchObject({
                cache_layer: 'file_hash',
                findings: createFindings('ttl-protected finding'),
            });

            jest.setSystemTime(new Date(start.getTime() + 51));

            expect(cache.get(primaryKey)).toBeNull();
            expect(cache.get(sameContentDifferentCommitKey)).toBeNull();
        } finally {
            jest.useRealTimers();
        }
    });

    it('treats content changes as file-hash cache misses even when path and step stay the same', () => {
        const cache = new ResponseCache({
            enable_memory_cache: false,
            enable_commit_cache: false,
            enable_file_hash_cache: true,
        });

        const originalKey = createKey({
            commit_hash: 'commit-1',
            content_hash: 'content-v1',
        });
        const sameContentDifferentCommitKey = createKey({
            commit_hash: 'commit-2',
            content_hash: 'content-v1',
        });
        const changedContentKey = createKey({
            commit_hash: 'commit-3',
            content_hash: 'content-v2',
        });

        cache.set(originalKey, createFindings('cached finding'));

        expect(cache.get(sameContentDifferentCommitKey)).toMatchObject({
            cache_layer: 'file_hash',
            findings: createFindings('cached finding'),
        });
        expect(cache.get(changedContentKey)).toBeNull();
    });

    it('clones stored findings, promoted entries, and returned results to prevent shared mutations', () => {
        const cache = new ResponseCache({
            enable_memory_cache: true,
            enable_commit_cache: true,
            enable_file_hash_cache: false,
            max_memory_cache_size: 1,
        });

        const primaryKey = createKey({
            commit_hash: 'commit-1',
            file_path: 'src/primary.ts',
            content_hash: 'hash-primary',
        });
        const secondaryKey = createKey({
            commit_hash: 'commit-1',
            file_path: 'src/secondary.ts',
            content_hash: 'hash-secondary',
        });

        const originalFindings = createFindings('original finding');
        cache.set(primaryKey, originalFindings);
        originalFindings[0].message = 'caller mutation';

        cache.set(secondaryKey, createFindings('secondary finding'));

        const commitResult = cache.get(primaryKey);

        expect(commitResult).toMatchObject({
            cache_layer: 'commit',
            findings: createFindings('original finding'),
        });

        commitResult!.findings[0].message = 'returned mutation';
        commitResult!.findings.push({
            file: 'src/primary.ts',
            severity: 'info',
            category: 'maintainability',
            message: 'extra mutation',
        });

        const memoryResult = cache.get(primaryKey);

        expect(memoryResult).toMatchObject({
            cache_layer: 'memory',
            findings: createFindings('original finding'),
        });
        expect(memoryResult?.findings).toHaveLength(1);
    });
});
