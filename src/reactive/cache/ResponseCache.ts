/**
 * Multi-Layer Response Cache for Reactive Code Review
 * 
 * Implements a 3-layer caching strategy:
 * 1. Memory Cache: In-process, fastest (LRU)
 * 2. Commit Cache: Git commit-based persistence
 * 3. File Hash Cache: Content-based deduplication
 * 
 * Target: 60-80% cache hit rate on subsequent reviews
 */

import crypto from 'crypto';
import type { ReviewFinding } from '../executors/AIAgentStepExecutor.js';

/**
 * Cache key structure for review results
 */
export interface CacheKey {
    /** Git commit hash */
    commit_hash: string;
    /** File path being reviewed */
    file_path: string;
    /** Hash of file content + context */
    content_hash: string;
    /** Review step description */
    step_description: string;
}

/**
 * Cached review result
 */
export interface CachedReviewResult {
    /** Review findings */
    findings: ReviewFinding[];
    /** Cache timestamp */
    cached_at: number;
    /** Cache layer that provided this result */
    cache_layer: 'memory' | 'commit' | 'file_hash';
}

/**
 * Cache statistics for telemetry
 */
export interface CacheStats {
    hits: number;
    misses: number;
    memory_hits: number;
    commit_hits: number;
    file_hash_hits: number;
    total_requests: number;
    hit_rate: number;
}

/**
 * Configuration for response cache
 */
export interface ResponseCacheConfig {
    /** Enable memory cache layer */
    enable_memory_cache: boolean;
    /** Enable commit cache layer */
    enable_commit_cache: boolean;
    /** Enable file hash cache layer */
    enable_file_hash_cache: boolean;
    /** Maximum memory cache size (entries) */
    max_memory_cache_size: number;
    /** Cache TTL in milliseconds */
    cache_ttl_ms: number;
}

const DEFAULT_CONFIG: ResponseCacheConfig = {
    enable_memory_cache: true,
    enable_commit_cache: true,
    enable_file_hash_cache: true,
    max_memory_cache_size: 1000,
    cache_ttl_ms: 3600000, // 1 hour
};

/**
 * Multi-Layer Response Cache
 * 
 * Provides fast caching of review results with automatic
 * layer fallback and invalidation strategies.
 */
export class ResponseCache {
    private config: ResponseCacheConfig;
    private stats: CacheStats;

    // Layer 1: Memory Cache (LRU)
    private memoryCache: Map<string, CachedReviewResult>;
    private cacheAccessOrder: string[];

    // Layer 2: Commit Cache (Map by commit hash)
    private commitCache: Map<string, Map<string, CachedReviewResult>>;

    // Layer 3: File Hash Cache (Content-based)
    private fileHashCache: Map<string, CachedReviewResult>;

    constructor(config: Partial<ResponseCacheConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.stats = {
            hits: 0,
            misses: 0,
            memory_hits: 0,
            commit_hits: 0,
            file_hash_hits: 0,
            total_requests: 0,
            hit_rate: 0,
        };

        this.memoryCache = new Map();
        this.cacheAccessOrder = [];
        this.commitCache = new Map();
        this.fileHashCache = new Map();
    }

    /**
     * Get cached review result for a file
     * 
     * Searches through cache layers in order:
     * 1. Memory cache (fastest)
     * 2. Commit cache (commit-specific)
     * 3. File hash cache (content-based)
     * 
     * @param key Cache key
     * @returns Cached result or null if not found
     */
    get(key: CacheKey): CachedReviewResult | null {
        this.stats.total_requests++;

        const cacheKeyStr = this.generateCacheKey(key);

        // Layer 1: Check memory cache
        if (this.config.enable_memory_cache) {
            const memoryResult = this.memoryCache.get(cacheKeyStr);
            if (memoryResult && this.isValid(memoryResult)) {
                this.recordHit('memory');
                this.updateAccessOrder(cacheKeyStr);
                return memoryResult;
            }
        }

        // Layer 2: Check commit cache
        if (this.config.enable_commit_cache) {
            const commitCacheEntries = this.commitCache.get(key.commit_hash);
            if (commitCacheEntries) {
                const commitResult = commitCacheEntries.get(cacheKeyStr);
                if (commitResult && this.isValid(commitResult)) {
                    this.recordHit('commit');
                    // Promote to memory cache
                    this.setMemoryCache(cacheKeyStr, commitResult);
                    return commitResult;
                }
            }
        }

        // Layer 3: Check file hash cache
        if (this.config.enable_file_hash_cache) {
            const fileHashKey = this.generateFileHashKey(key);
            const fileHashResult = this.fileHashCache.get(fileHashKey);
            if (fileHashResult && this.isValid(fileHashResult)) {
                this.recordHit('file_hash');
                // Promote to memory cache
                this.setMemoryCache(cacheKeyStr, fileHashResult);
                return fileHashResult;
            }
        }

        // Cache miss
        this.stats.misses++;
        this.updateHitRate();
        return null;
    }

    /**
     * Store review result in cache
     * 
     * @param key Cache key
     * @param findings Review findings to cache
     */
    set(key: CacheKey, findings: ReviewFinding[]): void {
        const cacheKeyStr = this.generateCacheKey(key);
        const result: CachedReviewResult = {
            findings,
            cached_at: Date.now(),
            cache_layer: 'memory',
        };

        // Store in all enabled cache layers
        if (this.config.enable_memory_cache) {
            this.setMemoryCache(cacheKeyStr, result);
        }

        if (this.config.enable_commit_cache) {
            this.setCommitCache(key.commit_hash, cacheKeyStr, result);
        }

        if (this.config.enable_file_hash_cache) {
            const fileHashKey = this.generateFileHashKey(key);
            this.fileHashCache.set(fileHashKey, result);
        }
    }

    /**
     * Invalidate cache entries for a specific commit
     * 
     * @param commitHash Git commit hash
     */
    invalidateCommit(commitHash: string): void {
        this.commitCache.delete(commitHash);
        console.error(`[ResponseCache] Invalidated commit cache for ${commitHash}`);
    }

    /**
     * Invalidate cache entries for a specific file
     * 
     * @param filePath File path
     */
    invalidateFile(filePath: string): void {
        // Remove from memory cache
        for (const [key, value] of this.memoryCache.entries()) {
            if (key.includes(filePath)) {
                this.memoryCache.delete(key);
            }
        }

        // Remove from file hash cache
        for (const [key] of this.fileHashCache.entries()) {
            if (key.includes(filePath)) {
                this.fileHashCache.delete(key);
            }
        }

        console.error(`[ResponseCache] Invalidated cache for file ${filePath}`);
    }

    /**
     * Clear all cache layers
     */
    clear(): void {
        this.memoryCache.clear();
        this.cacheAccessOrder = [];
        this.commitCache.clear();
        this.fileHashCache.clear();
        this.resetStats();
        console.error('[ResponseCache] All caches cleared');
    }

    /**
     * Get cache statistics
     */
    getStats(): CacheStats {
        return { ...this.stats };
    }

    /**
     * Reset cache statistics
     */
    resetStats(): void {
        this.stats = {
            hits: 0,
            misses: 0,
            memory_hits: 0,
            commit_hits: 0,
            file_hash_hits: 0,
            total_requests: 0,
            hit_rate: 0,
        };
    }

    // Private methods

    private generateCacheKey(key: CacheKey): string {
        return `${key.commit_hash}:${key.file_path}:${key.content_hash}:${this.hashString(key.step_description)}`;
    }

    private generateFileHashKey(key: CacheKey): string {
        return `${key.file_path}:${key.content_hash}`;
    }

    private hashString(str: string): string {
        return crypto.createHash('sha256').update(str).digest('hex').substring(0, 16);
    }

    private isValid(result: CachedReviewResult): boolean {
        const age = Date.now() - result.cached_at;
        return age < this.config.cache_ttl_ms;
    }

    private recordHit(layer: 'memory' | 'commit' | 'file_hash'): void {
        this.stats.hits++;
        if (layer === 'memory') {
            this.stats.memory_hits++;
        } else if (layer === 'commit') {
            this.stats.commit_hits++;
        } else if (layer === 'file_hash') {
            this.stats.file_hash_hits++;
        }
        this.updateHitRate();
    }

    private updateHitRate(): void {
        if (this.stats.total_requests > 0) {
            this.stats.hit_rate = this.stats.hits / this.stats.total_requests;
        }
    }

    private setMemoryCache(key: string, result: CachedReviewResult): void {
        // Implement LRU eviction
        if (this.memoryCache.size >= this.config.max_memory_cache_size) {
            const oldestKey = this.cacheAccessOrder.shift();
            if (oldestKey) {
                this.memoryCache.delete(oldestKey);
            }
        }

        this.memoryCache.set(key, result);
        this.updateAccessOrder(key);
    }

    private updateAccessOrder(key: string): void {
        // Remove if exists
        const index = this.cacheAccessOrder.indexOf(key);
        if (index > -1) {
            this.cacheAccessOrder.splice(index, 1);
        }
        // Add to end (most recently used)
        this.cacheAccessOrder.push(key);
    }

    private setCommitCache(commitHash: string, key: string, result: CachedReviewResult): void {
        if (!this.commitCache.has(commitHash)) {
            this.commitCache.set(commitHash, new Map());
        }
        this.commitCache.get(commitHash)!.set(key, result);
    }
}

/**
 * Generate content hash for a file
 * 
 * @param content File content
 * @returns SHA-256 hash (16 chars)
 */
export function generateContentHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
}
