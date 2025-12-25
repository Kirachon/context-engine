/**
 * Unit tests for ResponseCache (Phase 2)
 * 
 * Tests the multi-layer caching system:
 * - Memory cache (LRU)
 * - Commit cache
 * - File hash cache
 */

import { ResponseCache, generateContentHash, type CacheKey } from '../../src/reactive/cache/ResponseCache.js';
import type { ReviewFinding } from '../../src/reactive/executors/AIAgentStepExecutor.js';

describe('ResponseCache', () => {
    let cache: ResponseCache;

    beforeEach(() => {
        cache = new ResponseCache({
            enable_memory_cache: true,
            enable_commit_cache: true,
            enable_file_hash_cache: true,
            max_memory_cache_size: 10,
            cache_ttl_ms: 60000, // 1 minute
        });
    });

    afterEach(() => {
        cache.clear();
    });

    describe('Basic Operations', () => {
        it('should store and retrieve from cache', () => {
            const key: CacheKey = {
                commit_hash: 'abc123',
                file_path: 'src/test.ts',
                content_hash: 'hash1',
                step_description: 'Review security',
            };

            const findings: ReviewFinding[] = [{
                file: 'src/test.ts',
                severity: 'error',
                category: 'security',
                message: 'Test finding',
            }];

            cache.set(key, findings);
            const result = cache.get(key);

            expect(result).not.toBeNull();
            expect(result?.findings).toEqual(findings);
        });

        it('should return null for cache miss', () => {
            const key: CacheKey = {
                commit_hash: 'abc123',
                file_path: 'src/missing.ts',
                content_hash: 'hash1',
                step_description: 'Review security',
            };

            const result = cache.get(key);
            expect(result).toBeNull();
        });
    });

    describe('Memory Cache Layer', () => {
        it('should hit memory cache on second access', () => {
            const key: CacheKey = {
                commit_hash: 'abc123',
                file_path: 'src/test.ts',
                content_hash: 'hash1',
                step_description: 'Review',
            };

            cache.set(key, []);
            cache.get(key); // First access
            const result = cache.get(key); // Second access

            expect(result).not.toBeNull();
            expect(result?.cache_layer).toBe('memory');

            const stats = cache.getStats();
            expect(stats.memory_hits).toBeGreaterThan(0);
        });

        it('should enforce LRU eviction', () => {
            const maxSize = 3;
            const smallCache = new ResponseCache({
                max_memory_cache_size: maxSize,
            });

            // Fill cache beyond capacity
            for (let i = 0; i < 5; i++) {
                const key: CacheKey = {
                    commit_hash: 'abc123',
                    file_path: `src/file${i}.ts`,
                    content_hash: `hash${i}`,
                    step_description: 'Review',
                };
                smallCache.set(key, []);
            }

            // First entries should be evicted
            const oldKey: CacheKey = {
                commit_hash: 'abc123',
                file_path: 'src/file0.ts',
                content_hash: 'hash0',
                step_description: 'Review',
            };

            // Should be evicted (cache miss)
            const result = smallCache.get(oldKey);
            expect(result).toBeNull();

            smallCache.clear();
        });
    });

    describe('Commit Cache Layer', () => {
        it('should retrieve from commit cache', () => {
            const key: CacheKey = {
                commit_hash: 'commit1',
                file_path: 'src/test.ts',
                content_hash: 'hash1',
                step_description: 'Review',
            };

            cache.set(key, []);
            cache.clear(); // Clear memory cache only

            // Should still hit commit cache
            const result = cache.get(key);
            expect(result).not.toBeNull();
        });

        it('should invalidate commit cache', () => {
            const key: CacheKey = {
                commit_hash: 'commit1',
                file_path: 'src/test.ts',
                content_hash: 'hash1',
                step_description: 'Review',
            };

            cache.set(key, []);
            cache.invalidateCommit('commit1');

            const result = cache.get(key);
            expect(result).toBeNull();
        });
    });

    describe('File Hash Cache Layer', () => {
        it('should match files with same content', () => {
            const key1: CacheKey = {
                commit_hash: 'commit1',
                file_path: 'src/test.ts',
                content_hash: 'same-content-hash',
                step_description: 'Review',
            };

            const key2: CacheKey = {
                commit_hash: 'commit2', // Different commit
                file_path: 'src/test.ts',
                content_hash: 'same-content-hash', // Same content
                step_description: 'Review',
            };

            const findings: ReviewFinding[] = [{
                file: 'src/test.ts',
                severity: 'warning',
                category: 'maintainability',
                message: 'Test',
            }];

            cache.set(key1, findings);
            const result = cache.get(key2);

            // Should hit file hash cache even with different commit
            expect(result).not.toBeNull();
            expect(result?.cache_layer).toBe('file_hash');
        });

        it('should invalidate file cache', () => {
            const key: CacheKey = {
                commit_hash: 'commit1',
                file_path: 'src/test.ts',
                content_hash: 'hash1',
                step_description: 'Review',
            };

            cache.set(key, []);
            cache.invalidateFile('src/test.ts');

            const result = cache.get(key);
            expect(result).toBeNull();
        });
    });

    describe('Cache Statistics', () => {
        it('should track hit rate', () => {
            const key: CacheKey = {
                commit_hash: 'abc123',
                file_path: 'src/test.ts',
                content_hash: 'hash1',
                step_description: 'Review',
            };

            cache.set(key, []);
            cache.get(key); // Hit
            cache.get({ ...key, file_path: 'src/missing.ts' }); // Miss

            const stats = cache.getStats();
            expect(stats.hits).toBe(1);
            expect(stats.misses).toBe(1);
            expect(stats.total_requests).toBe(2);
            expect(stats.hit_rate).toBe(0.5);
        });

        it('should track cache layer hits', () => {
            const key: CacheKey = {
                commit_hash: 'abc123',
                file_path: 'src/test.ts',
                content_hash: 'hash1',
                step_description: 'Review',
            };

            cache.set(key, []);
            cache.get(key); // Memory hit

            const stats = cache.getStats();
            expect(stats.memory_hits).toBeGreaterThan(0);
        });

        it('should reset statistics', () => {
            const key: CacheKey = {
                commit_hash: 'abc123',
                file_path: 'src/test.ts',
                content_hash: 'hash1',
                step_description: 'Review',
            };

            cache.set(key, []);
            cache.get(key);
            cache.resetStats();

            const stats = cache.getStats();
            expect(stats.hits).toBe(0);
            expect(stats.misses).toBe(0);
            expect(stats.total_requests).toBe(0);
        });
    });

    describe('TTL Expiration', () => {
        it('should expire old cache entries', async () => {
            const shortCache = new ResponseCache({
                cache_ttl_ms: 100, // 100ms TTL
            });

            const key: CacheKey = {
                commit_hash: 'abc123',
                file_path: 'src/test.ts',
                content_hash: 'hash1',
                step_description: 'Review',
            };

            shortCache.set(key, []);

            // Should hit immediately
            let result = shortCache.get(key);
            expect(result).not.toBeNull();

            // Wait for expiration
            await new Promise(resolve => setTimeout(resolve, 150));

            // Should miss after expiration
            result = shortCache.get(key);
            expect(result).toBeNull();

            shortCache.clear();
        });
    });

    describe('generateContentHash', () => {
        it('should generate consistent hashes', () => {
            const content = 'test content';
            const hash1 = generateContentHash(content);
            const hash2 = generateContentHash(content);

            expect(hash1).toBe(hash2);
            expect(hash1).toHaveLength(16);
        });

        it('should generate different hashes for different content', () => {
            const hash1 = generateContentHash('content1');
            const hash2 = generateContentHash('content2');

            expect(hash1).not.toBe(hash2);
        });
    });
});
