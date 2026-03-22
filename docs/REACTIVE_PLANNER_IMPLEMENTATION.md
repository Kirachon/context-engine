# Reactive AI Code Review Engine (v2.2) - Implementation Plan

> Status: active

## Executive Summary

This document provides a comprehensive, phased implementation plan for the Reactive AI Code Review Engine as specified in `Reactive_Planner.md`. The implementation follows a **safety-first, extend-existing** approach that enhances existing services rather than creating parallel systems, reducing code duplication by ~60% while preserving all existing MCP tools and functionality.

**Key Design Decision (v2.2)**: Instead of creating separate parallel systems, this plan **extends existing services** to support reactive capabilities, ensuring consistency, reducing maintenance burden, and leveraging battle-tested code.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Consolidation Strategy](#2-consolidation-strategy)
3. [Phase 1: Enhanced Context & Cache](#3-phase-1-enhanced-context--cache)
4. [Phase 2: Extended Execution Tracking](#4-phase-2-extended-execution-tracking)
5. [Phase 3: Extended Persistence & Telemetry](#5-phase-3-extended-persistence--telemetry)
6. [Phase 4: Guardrails & Security](#6-phase-4-guardrails--security)
7. [Risk Assessment](#7-risk-assessment)
8. [Testing Strategy](#8-testing-strategy)
9. [Rollback Procedures](#9-rollback-procedures)
10. [Performance Benchmarks](#10-performance-benchmarks)
11. [Monitoring & Observability](#11-monitoring--observability)

---

## 1. Architecture Overview

### 1.1 Current System Architecture (To Be Enhanced)

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 4: Agent Clients (Codex CLI, Cursor, Claude Desktop)      │
├─────────────────────────────────────────────────────────────────┤
│ Layer 3: MCP Interface (server.ts, 28+ tools)                   │
│          └── Planning Tools: create_plan, refine_plan, etc.     │
│          └── Review Tools: review_changes, review_git_diff      │
│          └── NEW: Reactive Tools (additive only)                │
├─────────────────────────────────────────────────────────────────┤
│ Layer 2: Service Layer (ENHANCED, not replaced)                 │
│          └── ContextServiceClient  [+commit-keyed caching]      │
│          └── ExecutionTrackingService [+parallel execution]     │
│          └── PlanningService [+reactive DAG analysis]           │
│          └── PlanPersistenceService [+SQLite backend option]    │
│          └── PlanHistoryService [+reactive versioning]          │
├─────────────────────────────────────────────────────────────────┤
│ Layer 1: Core Engine (legacy SDK runtime - DirectContext)       │
├─────────────────────────────────────────────────────────────────┤
│ Layer 5: Storage Backend (legacy runtime + Optional SQLite)     │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 Consolidated Reactive Architecture (Extend, Don't Duplicate)

```
┌─────────────────────────────────────────────────────────────────┐
│ NEW: Reactive Coordinator (Thin Orchestration Layer)            │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ ReactiveReviewService     │ Guardrail Pipeline              │ │
│ │ (coordinates existing     │ (validation, secrets, HITL)     │ │
│ │  services for reactive)   │                                 │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                             │                                   │
│                             ▼                                   │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ ENHANCED: Layer 2 Service Layer                             │ │
│ │ ┌─────────────────┬─────────────────┬─────────────────────┐ │ │
│ │ │ContextService   │ ExecutionTrack  │ PlanningService     │ │ │
│ │ │ +commitCache()  │ +parallelExec() │ +analyzeDependencies│ │ │
│ │ │ +prefetch()     │ +workerPool()   │ (already exists!)   │ │ │
│ │ ├─────────────────┼─────────────────┼─────────────────────┤ │ │
│ │ │ PlanPersistence │ PlanHistory     │ CodeReviewService   │ │ │
│ │ │ +sqliteBackend  │ +reactivePlans  │ (unchanged)         │ │ │
│ │ └─────────────────┴─────────────────┴─────────────────────┘ │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### 1.3 Design Principles

| Principle | Implementation |
|-----------|----------------|
| **Extend, Don't Duplicate** | Enhance existing services with reactive capabilities via feature flags |
| **Backward Compatible** | All 28+ existing MCP tools continue unchanged |
| **Single Source of Truth** | One caching system, one persistence layer, one execution tracker |
| **Incremental Rollout** | Feature flags control activation of each enhancement |
| **MCP Compliant** | New tools follow existing patterns in `src/mcp/tools/` |
| **Fail-Safe** | Graceful degradation to existing sync behavior |
| **~60% Less Code** | Leverage existing implementations instead of parallel systems |

---

## 2. Consolidation Strategy

### 2.1 Duplication Analysis (What We Avoid)

The original v2.1 plan proposed creating parallel systems that would duplicate existing functionality:

| Proposed (v2.1) | Existing Equivalent | Consolidation (v2.2) |
|-----------------|---------------------|----------------------|
| `ContextProxy` (new cache) | `ContextServiceClient.searchCache` | Extend existing cache with commit-hash keys |
| `DAGParser` (new dependency analysis) | `PlanningService.analyzeDependencies()` | Enhance existing topological sort |
| `DAGDispatcher` (new execution) | `ExecutionTrackingService` | Add parallel execution to existing service |
| `sqliteStore.ts` (new persistence) | `PlanPersistenceService` | Add SQLite backend option |
| `TelemetryCollector` (new metrics) | Existing duration/token tracking | Extend existing telemetry hooks |
| Separate versioning | `PlanHistoryService` | Use existing version tracking |

**Code Reduction**: ~60% less new code by extending vs. duplicating.

### 2.2 Services to Enhance (Not Replace)

| Service | Location | Enhancement |
|---------|----------|-------------|
| `ContextServiceClient` | `src/mcp/serviceClient.ts` | Add commit-keyed cache, prefetching |
| `ExecutionTrackingService` | `src/mcp/services/executionTrackingService.ts` | Add parallel execution, worker pool |
| `PlanningService` | `src/mcp/services/planningService.ts` | Expose `analyzeDependencies()` for reactive use |
| `PlanPersistenceService` | `src/mcp/services/planPersistenceService.ts` | Add SQLite backend option |
| `PlanHistoryService` | `src/mcp/services/planHistoryService.ts` | Support reactive plan versioning |

### 2.3 New Components (Truly New, Minimal)

```
src/reactive/
├── types.ts                     # Reactive-specific type extensions
├── ReactiveReviewService.ts     # Thin coordinator over existing services
├── validation/
│   ├── tier1Deterministic.ts    # Syntax, build, schema checks (new)
│   ├── tier2Heuristic.ts        # Secret scanning, permissions (new)
│   └── pipeline.ts              # Validation orchestration (new)
├── guardrails/
│   ├── secretScrubber.ts        # API key/secret masking (new)
│   ├── tokenLimiter.ts          # Token budget enforcement (new)
│   └── hitlCheckpoint.ts        # Human-in-the-loop gates (new)
├── deduplication.ts             # Comment hash tracking (new)
└── index.ts                     # Public API exports
```

**Note**: No separate `orchestration/`, `persistence/`, or `telemetry/` directories - these leverage existing services.

### 2.4 New MCP Tools (Additive)

| Tool Name | Purpose | Phase |
|-----------|---------|-------|
| `reactive_review_pr` | Initiate reactive PR review with DAG orchestration | 2 |
| `get_review_status` | Check status of ongoing reactive review | 2 |
| `pause_review` | Pause at HITL checkpoint | 3 |
| `resume_review` | Resume from checkpoint with approval | 3 |
| `get_review_telemetry` | Retrieve telemetry for a review | 3 |

---

## 3. Phase 1: Enhanced Context & Cache

**Duration**: 1 week (reduced from 1-2 weeks by reusing existing cache)
**Risk Level**: Low
**Rollback**: Set `REACTIVE_COMMIT_CACHE=false`, existing cache behavior restored

### 3.1 Objectives

- **Extend** `ContextServiceClient` with commit-hash keyed caching (not new class)
- Add look-ahead prefetching to existing cache infrastructure
- Leverage existing `InternalCache` from `src/internal/handlers/performance.ts`

### 3.2 Technical Specifications

#### 3.2.1 ContextServiceClient Enhancement (Extend Existing)

```typescript
// ENHANCE: src/mcp/serviceClient.ts (add to existing class)

export interface CommitCacheOptions {
  enable_commit_keying: boolean;  // Default: false (feature flag)
  enable_prefetch: boolean;       // Default: true when commit_keying enabled
  prefetch_depth: number;         // Default: 2 (levels of dependencies)
}

// Add to existing ContextServiceClient class:
export class ContextServiceClient {
  // EXISTING: searchCache already provides LRU caching
  private searchCache: Map<string, CacheEntry<SearchResult[]>> = new Map();

  // NEW: Commit-keyed cache extension (reuses same cache infrastructure)
  private commitCacheEnabled: boolean = false;
  private currentCommitHash: string | null = null;

  // NEW METHOD: Enable commit-based cache keying
  enableCommitCache(commitHash: string): void {
    this.commitCacheEnabled = true;
    this.currentCommitHash = commitHash;
  }

  // NEW METHOD: Generate commit-aware cache key
  private getCommitAwareCacheKey(query: string, topK: number): string {
    const baseKey = `${query}:${topK}`;
    if (this.commitCacheEnabled && this.currentCommitHash) {
      return `${this.currentCommitHash.substring(0, 12)}:${baseKey}`;
    }
    return baseKey;  // Fallback to existing behavior
  }

  // NEW METHOD: Prefetch context for files (background)
  async prefetchFilesContext(filePaths: string[], commitHash?: string): Promise<void> {
    if (commitHash) this.enableCommitCache(commitHash);

    // Use setImmediate to avoid blocking
    setImmediate(async () => {
      for (const filePath of filePaths) {
        try {
          await this.semanticSearch(`file:${filePath}`, 5);
        } catch (e) {
          console.error(`[prefetch] Failed for ${filePath}:`, e);
        }
      }
    });
  }

  // EXISTING METHOD: semanticSearch (modify cache key generation)
  async semanticSearch(query: string, topK: number = 10): Promise<SearchResult[]> {
    // Use commit-aware cache key when enabled
    const cacheKey = this.getCommitAwareCacheKey(query, topK);
    const cached = this.getCachedSearch(cacheKey);
    if (cached) {
      console.error(`[semanticSearch] Cache hit for query: ${query}`);
      return cached;
    }
    // ... rest of existing implementation
  }

  // NEW METHOD: Invalidate cache for a specific commit
  invalidateCommitCache(commitHash?: string): void {
    if (!commitHash) {
      this.clearCache();
      return;
    }
    const prefix = commitHash.substring(0, 12);
    for (const key of this.searchCache.keys()) {
      if (key.startsWith(prefix)) {
        this.searchCache.delete(key);
      }
    }
  }

  // NEW METHOD: Get cache statistics
  getCacheStats(): { size: number; hitRate: number; commitKeyed: boolean } {
    return {
      size: this.searchCache.size,
      hitRate: this.cacheHitRate,  // Track hits/misses
      commitKeyed: this.commitCacheEnabled,
    };
  }
}
```

#### 3.2.2 Leverage Existing InternalCache

```typescript
// REUSE: src/internal/handlers/performance.ts already provides:
export interface InternalCache {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T, ttlMs?: number): void;
}

// REUSE: src/internal/handlers/context.ts already has caching:
export async function internalContextBundle(
  query: string,
  serviceClient: ContextServiceClient,
  options: ContextOptions
): Promise<ContextBundle> {
  const cache = getInternalCache();
  const cacheKey = `context:${query}:${JSON.stringify(options ?? {})}`;
  // ...existing caching logic
}

// ENHANCE: Add commit-hash to cache key when reactive mode enabled
function getReactiveCacheKey(query: string, options: ContextOptions, commitHash?: string): string {
  const base = `context:${query}:${JSON.stringify(options ?? {})}`;
  return commitHash ? `${commitHash.substring(0, 12)}:${base}` : base;
}
```

### 3.3 Implementation Checklist

- [ ] Add `enableCommitCache()` method to `ContextServiceClient`
- [ ] Add `prefetchFilesContext()` method to `ContextServiceClient`
- [ ] Add commit-aware cache key generation (feature-flagged)
- [ ] Add `invalidateCommitCache()` method
- [ ] Add `getCacheStats()` method
- [ ] Create `src/reactive/types.ts` with reactive-specific interfaces
- [ ] Unit tests for new cache behavior
- [ ] Integration tests verifying backward compatibility

### 3.4 Success Criteria

| Metric | Target | Measurement |
|--------|--------|-------------|
| Cache hit rate | >70% on repeat queries | Existing telemetry |
| Context retrieval latency | <100ms for cached | Performance tests |
| Memory usage | <50MB cache overhead (same as existing) | Memory profiling |
| Backward compatibility | 100% existing tests pass | Test suite |

---

## 4. Phase 2: Extended Execution Tracking

**Duration**: 1-2 weeks (reduced from 2-3 weeks by reusing existing services)
**Risk Level**: Medium
**Rollback**: Set `REACTIVE_PARALLEL_EXEC=false`, falls back to sequential

### 4.1 Objectives

- **Extend** `ExecutionTrackingService` with parallel execution support (not new dispatcher)
- **Leverage** existing `PlanningService.analyzeDependencies()` (not new DAG parser)
- Add worker pool to existing execution infrastructure

### 4.2 Technical Specifications

#### 4.2.1 Reactive Type Extensions

```typescript
// src/reactive/types.ts (minimal new types, extend existing)

import { EnhancedPlanOutput, PlanStep, DependencyGraph } from '../mcp/types/planning.js';

// Extend existing PlanStep with reactive execution metadata
export interface ReactiveStepExtension {
  execution_model?: {
    parallel_safe: boolean;
    priority: number;        // 0 = highest
    timeout_ms: number;
    retry_count: number;
  };
  context_metadata?: {
    commit_hash: string;
    token_budget: number;
  };
}

// Extend existing EnhancedPlanOutput for reactive use
export interface ReactivePlan extends EnhancedPlanOutput {
  reactive_mode: true;
  context_metadata: {
    commit_hash: string;
    base_ref: string;
    token_budget: number;
    pr_number?: number;
  };
}

// Reuse existing DependencyGraph from PlanningService
// No need to redefine DAG structure!
```

#### 4.2.2 ExecutionTrackingService Enhancement (Extend Existing)

```typescript
// ENHANCE: src/mcp/services/executionTrackingService.ts

export interface ParallelExecutionOptions {
  max_workers: number;              // Default: 3
  enable_parallel: boolean;         // Feature flag
  node_timeout_ms: number;          // Default: 60000
}

// Add to existing ExecutionTrackingService class:
export class ExecutionTrackingService {
  // EXISTING: executionStates already tracks all step state
  private executionStates: Map<string, PlanExecutionState> = new Map();

  // NEW: Parallel execution support
  private parallelOptions: ParallelExecutionOptions = {
    max_workers: 3,
    enable_parallel: false,  // Off by default
    node_timeout_ms: 60000,
  };
  private activeWorkers: Map<string, Promise<void>> = new Map();

  // NEW METHOD: Enable parallel execution mode
  enableParallelExecution(options?: Partial<ParallelExecutionOptions>): void {
    this.parallelOptions = { ...this.parallelOptions, ...options, enable_parallel: true };
  }

  // NEW METHOD: Execute ready steps in parallel (leverages existing state)
  async executeReadyStepsParallel(
    planId: string,
    plan: EnhancedPlanOutput,
    executor: (step: PlanStep) => Promise<void>
  ): Promise<void> {
    if (!this.parallelOptions.enable_parallel) {
      // Fallback to sequential (existing behavior)
      const readySteps = this.getReadySteps(planId);
      for (const stepNum of readySteps) {
        const step = plan.steps?.find(s => s.step_number === stepNum);
        if (step) await executor(step);
      }
      return;
    }

    // Parallel execution with worker limit
    const readySteps = this.getReadySteps(planId);
    const stepPromises: Promise<void>[] = [];

    for (const stepNum of readySteps) {
      // Respect worker limit
      if (this.activeWorkers.size >= this.parallelOptions.max_workers) {
        await Promise.race(this.activeWorkers.values());
      }

      const step = plan.steps?.find(s => s.step_number === stepNum);
      if (!step) continue;

      const stepPromise = this.executeStepWithTimeout(planId, step, executor);
      this.activeWorkers.set(`${planId}:${stepNum}`, stepPromise);
      stepPromises.push(stepPromise);
    }

    await Promise.allSettled(stepPromises);
  }

  // NEW METHOD: Execute step with timeout
  private async executeStepWithTimeout(
    planId: string,
    step: PlanStep,
    executor: (step: PlanStep) => Promise<void>
  ): Promise<void> {
    const stepNum = step.step_number || 0;
    this.startStep(planId, stepNum);  // Use existing method

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Step timeout')), this.parallelOptions.node_timeout_ms);
      });

      await Promise.race([executor(step), timeoutPromise]);
      // completeStep is called by the executor
    } catch (error) {
      this.failStep(planId, stepNum, {} as EnhancedPlanOutput, {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.activeWorkers.delete(`${planId}:${stepNum}`);
    }
  }

  // EXISTING: getReadySteps() already calculates next executable steps!
  // EXISTING: startStep(), completeStep(), failStep() already track state!
}
```

#### 4.2.3 Leverage Existing Dependency Analysis (No New DAG Parser!)

```typescript
// REUSE: src/mcp/services/planningService.ts already has:
export class PlanningService {
  // THIS ALREADY EXISTS - use it for reactive!
  analyzeDependencies(steps: PlanStep[]): DependencyGraph {
    const nodes: DependencyNode[] = steps.map(step => ({
      step_number: step.step_number || 0,
      can_parallelize: !step.depends_on?.length,
      estimated_effort: step.estimated_effort || 'medium',
    }));

    // Calculate execution order (topological sort) - ALREADY IMPLEMENTED!
    const executionOrder = this.topologicalSort(steps, edges);

    // Find critical path - ALREADY IMPLEMENTED!
    const criticalPath = this.findCriticalPath(steps, edges);

    // Find parallel groups - ALREADY IMPLEMENTED!
    const parallelGroups = this.findParallelGroups(steps, edges);

    return {
      nodes,
      edges,
      critical_path: criticalPath,
      parallel_groups: parallelGroups,  // <-- Use this for reactive!
      execution_order: executionOrder,
    };
  }
}

// ReactiveReviewService simply calls existing method:
const dependencyGraph = planningService.analyzeDependencies(plan.steps);
const parallelGroups = dependencyGraph.parallel_groups;  // Already computed!
```

### 4.3 Implementation Checklist

- [ ] Add `enableParallelExecution()` to `ExecutionTrackingService`
- [ ] Add `executeReadyStepsParallel()` to `ExecutionTrackingService`
- [ ] Add worker limit enforcement with `activeWorkers` map
- [ ] Add timeout handling with `executeStepWithTimeout()`
- [ ] Create `src/reactive/types.ts` with reactive extensions
- [ ] Create `src/reactive/ReactiveReviewService.ts` (thin coordinator)
- [ ] Unit tests for parallel execution
- [ ] Integration tests verifying backward compatibility

### 4.4 Success Criteria

| Metric | Target | Measurement |
|--------|--------|-------------|
| Parallel efficiency | >2x speedup for 3+ independent nodes | Benchmarks |
| Backward compatibility | 100% existing tests pass | Test suite |
| Worker utilization | >80% during execution | Existing telemetry |

---

## 5. Phase 3: Extended Persistence & Telemetry

**Duration**: 1 week (reduced by extending existing PlanPersistenceService)
**Risk Level**: Low
**Rollback**: Set `REACTIVE_SQLITE_BACKEND=false`, falls back to JSON files

### 5.1 Objectives

- **Extend** `PlanPersistenceService` with optional SQLite backend (not new persistence layer)
- Add hash-based comment deduplication (new, minimal)
- **Extend** existing duration/token tracking (not new telemetry system)
- **Use** `PlanHistoryService` for reactive plan versioning (existing)

### 5.2 Technical Specifications

#### 5.2.1 PlanPersistenceService Enhancement (Extend Existing)

```typescript
// ENHANCE: src/mcp/services/planPersistenceService.ts

export type PersistenceBackend = 'json' | 'sqlite';

export interface PersistenceOptions {
  backend: PersistenceBackend;           // Default: 'json' (existing behavior)
  sqlite_path?: string;                   // Default: '~/.context-engine/reactive.db'
  enable_telemetry_table: boolean;        // Default: false
}

// Add to existing PlanPersistenceService class:
export class PlanPersistenceService {
  // EXISTING: JSON file-based storage (unchanged)
  private plansDir: string;

  // NEW: Optional SQLite backend
  private backend: PersistenceBackend = 'json';
  private db: Database | null = null;

  // NEW METHOD: Initialize SQLite backend (optional)
  async initializeSQLiteBackend(options?: PersistenceOptions): Promise<void> {
    if (options?.backend !== 'sqlite') return;

    this.backend = 'sqlite';
    const dbPath = options.sqlite_path || path.join(this.plansDir, 'reactive.db');
    this.db = new Database(dbPath);

    // Create tables (additive, doesn't affect JSON storage)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        plan_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS comment_hashes (
        hash TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        finding_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);
    `);
  }

  // EXISTING METHOD: savePlan (enhanced with backend selection)
  async savePlan(
    plan: EnhancedPlanOutput,
    options: SavePlanOptions = {}
  ): Promise<PersistenceResult> {
    if (this.backend === 'sqlite' && this.db) {
      return this.savePlanToSQLite(plan, options);
    }
    // Existing JSON behavior (unchanged)
    return this.savePlanToJSON(plan, options);
  }

  // NEW METHOD: SQLite-specific save
  private async savePlanToSQLite(
    plan: EnhancedPlanOutput,
    options: SavePlanOptions
  ): Promise<PersistenceResult> {
    const planId = plan.id || `plan_${Date.now()}`;
    const stmt = this.db!.prepare(`
      INSERT OR REPLACE INTO plans (id, name, goal, status, version, plan_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      planId,
      options.name || plan.goal?.substring(0, 50) || 'Untitled',
      plan.goal || '',
      'ready',
      plan.version || 1,
      JSON.stringify(plan),
      new Date().toISOString(),
      new Date().toISOString()
    );
    return { success: true, plan_id: planId };
  }

  // EXISTING METHOD: loadPlan (enhanced with backend selection)
  async loadPlan(planId: string): Promise<EnhancedPlanOutput | null> {
    if (this.backend === 'sqlite' && this.db) {
      const row = this.db.prepare('SELECT plan_json FROM plans WHERE id = ?').get(planId);
      return row ? JSON.parse((row as { plan_json: string }).plan_json) : null;
    }
    // Existing JSON behavior (unchanged)
    return this.loadPlanFromJSON(planId);
  }
}
```

#### 5.2.2 Deduplication Service (New, Minimal)

```typescript
// src/reactive/deduplication.ts (new, but minimal)

import crypto from 'crypto';
import { ReviewFinding } from '../mcp/types/codeReview.js';

export class DeduplicationService {
  private db: Database | null;
  private inMemoryHashes: Set<string> = new Set();  // Fallback

  constructor(db?: Database) {
    this.db = db || null;
  }

  // Generate hash for a finding
  hashFinding(finding: ReviewFinding): string {
    const normalized = {
      file: finding.code_location.file_path,
      start: finding.code_location.line_range.start,
      end: finding.code_location.line_range.end,
      title: finding.title.toLowerCase().trim(),
      category: finding.category,
    };
    return crypto.createHash('sha256')
      .update(JSON.stringify(normalized))
      .digest('hex')
      .substring(0, 16);
  }

  // Check if finding already exists
  isDuplicate(finding: ReviewFinding): boolean {
    const hash = this.hashFinding(finding);
    if (this.db) {
      const row = this.db.prepare('SELECT 1 FROM comment_hashes WHERE hash = ?').get(hash);
      return !!row;
    }
    return this.inMemoryHashes.has(hash);
  }

  // Record a new finding
  recordFinding(finding: ReviewFinding, planId: string): void {
    const hash = this.hashFinding(finding);
    if (this.db) {
      this.db.prepare(`
        INSERT OR IGNORE INTO comment_hashes (hash, plan_id, finding_id, file_path, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(hash, planId, finding.id, finding.code_location.file_path, new Date().toISOString());
    } else {
      this.inMemoryHashes.add(hash);
    }
  }
}
```

#### 5.2.3 Extend Existing Telemetry (Not New Collector)

```typescript
// ENHANCE: Existing telemetry is already tracked in services
// Example from ExecutionTrackingService:

export interface StepExecutionState {
  // EXISTING fields:
  step_number: number;
  status: StepExecutionStatus;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;     // <-- Already tracked!

  // NEW: Add tokens tracking (extend existing)
  tokens_used?: number;

  // NEW: Add reactive metadata
  reactive_metadata?: {
    cache_hit: boolean;
    parallel_group: number;
    retry_count: number;
  };
}

// ENHANCE: PlanHistoryService already tracks versions!
// Use it directly for reactive plans:
planHistoryService.recordVersion(reactivePlan, 'reactive_review', 'Reactive PR review');
```

### 5.3 Implementation Checklist

- [ ] Add `initializeSQLiteBackend()` to `PlanPersistenceService`
- [ ] Add SQLite-aware `savePlan()` and `loadPlan()` methods
- [ ] Create `src/reactive/deduplication.ts` (minimal)
- [ ] Add `tokens_used` field to `StepExecutionState`
- [ ] Add `reactive_metadata` field to `StepExecutionState`
- [ ] Use existing `PlanHistoryService` for versioning
- [ ] Unit tests for SQLite backend
- [ ] Integration tests verifying JSON fallback

### 5.4 Success Criteria

| Metric | Target | Measurement |
|--------|--------|-------------|
| Duplicate detection accuracy | >99% | Test suite |
| DB query latency | <10ms for lookups | Benchmarks |
| Backward compatibility | 100% JSON tests pass | Test suite |
| Storage efficiency | <1MB per 1000 reviews | Disk usage |

---

## 6. Phase 4: Guardrails & Security

**Duration**: 1-2 weeks
**Risk Level**: Medium
**Rollback**: Set `REACTIVE_GUARDRAILS=false`, uses existing review flow

### 6.1 Objectives

- Implement 3-tier validation pipeline (new, required)
- Add secret scrubbing before LLM egress (new, required)
- Enforce token budget limits (new, required)
- Create HITL checkpoint mechanism (new, integrates with existing approval workflow)

**Note**: This phase contains truly new functionality that doesn't duplicate existing services.

### 6.2 Technical Specifications

#### 6.2.1 3-Tier Validation Pipeline

```typescript
// src/reactive/validation/pipeline.ts (new, no duplication)

export type ValidationTier = 'deterministic' | 'heuristic' | 'llm';

export interface ValidationResult {
  tier: ValidationTier;
  passed: boolean;
  findings: ValidationFinding[];
  abort: boolean;      // Tier 1: abort entire review
  block: boolean;      // Tier 2: block branch/merge
  duration_ms: number;
}

export interface ValidationFinding {
  id: string;
  tier: ValidationTier;
  type: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  file_path?: string;
  line?: number;
}

export class ValidationPipeline {
  private tier1: Tier1Validator;
  private tier2: Tier2Validator;
  private codeReviewService: CodeReviewService;  // Reuse existing for Tier 3

  constructor(codeReviewService: CodeReviewService);

  // Run full validation pipeline
  async validate(plan: ReactivePlan): Promise<ValidationResult[]>;

  // Run single tier
  async runTier(tier: ValidationTier, plan: ReactivePlan): Promise<ValidationResult>;

  // Tier 3 uses existing CodeReviewService (no duplication)
  private async runTier3(plan: ReactivePlan): Promise<ValidationResult> {
    // Delegates to existing codeReviewService.reviewChanges()
    const result = await this.codeReviewService.reviewChanges({
      diff: plan.context_metadata.diff,
      options: { categories: ['correctness', 'security'] },
    });
    return this.convertToValidationResult(result, 'llm');
  }
}
```

#### 6.2.2 Tier 1: Deterministic Checks

```typescript
// src/reactive/validation/tier1Deterministic.ts (new, required)

export class Tier1Validator {
  // Syntax validation (parse errors)
  async checkSyntax(files: ParsedDiffFile[]): Promise<ValidationFinding[]>;

  // Schema validation (JSON, YAML, etc.)
  async checkSchemas(files: ParsedDiffFile[]): Promise<ValidationFinding[]>;

  // Build validation (if CI info available)
  async checkBuild(commitHash: string): Promise<ValidationFinding[]>;
}
```

#### 6.2.3 Tier 2: Heuristic Checks

```typescript
// src/reactive/validation/tier2Heuristic.ts (new, required)

export class Tier2Validator {
  // Secret/credential detection
  async scanSecrets(diff: string): Promise<ValidationFinding[]>;

  // Permission/access control changes
  async checkPermissions(files: ParsedDiffFile[]): Promise<ValidationFinding[]>;

  // Dependency vulnerability check
  async checkDependencies(files: ParsedDiffFile[]): Promise<ValidationFinding[]>;
}

// Secret patterns (regex-based)
const SECRET_PATTERNS = [
  { name: 'AWS Key', pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'GitHub Token', pattern: /ghp_[a-zA-Z0-9]{36}/g },
  { name: 'Private Key', pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g },
  { name: 'API Key Generic', pattern: /['"][a-zA-Z0-9_-]{32,}['"]/g },
];
```

#### 6.2.4 Secret Scrubbing

```typescript
// src/reactive/guardrails/secretScrubber.ts (new, required)

export class SecretScrubber {
  private patterns: RegExp[];

  constructor(additionalPatterns?: RegExp[]);

  // Scrub secrets from text before LLM egress
  scrub(text: string): { scrubbed: string; found: SecretMatch[] };

  // Check if text contains secrets
  containsSecrets(text: string): boolean;
}

export interface SecretMatch {
  type: string;
  position: number;
  length: number;
  masked: string;  // e.g., "AKIA****XXXX"
}
```

#### 6.2.5 Token Budget Enforcement

```typescript
// src/reactive/guardrails/tokenLimiter.ts

export interface TokenBudget {
  total: number;           // Default: 10000
  remaining: number;
  used_by_step: Map<string, number>;
}

export class TokenLimiter {
  private budget: TokenBudget;

  constructor(totalBudget: number);

  // Request tokens for a step
  request(stepId: string, estimated: number): boolean;

  // Record actual usage
  record(stepId: string, actual: number): void;

  // Check remaining budget
  canProceed(estimated: number): boolean;

  // Get usage report
  getReport(): TokenBudgetReport;
}
```

#### 6.2.6 HITL Checkpoint (Integrates with Existing Approval Workflow)

```typescript
// src/reactive/guardrails/hitlCheckpoint.ts
// NOTE: Integrates with existing request_approval/respond_approval tools

import { ApprovalRequest } from '../mcp/types/planning.js';

export interface Checkpoint extends ApprovalRequest {
  // Extends existing ApprovalRequest type
  checkpoint_type: 'reactive_review';
  validation_tier?: ValidationTier;
}

export class HITLCheckpointService {
  private approvalService: ApprovalService;  // Reuse existing!

  constructor(approvalService: ApprovalService) {
    this.approvalService = approvalService;
  }

  // Create a checkpoint (pauses execution) - uses existing approval workflow
  async createCheckpoint(planId: string, stepId: string, reason: string): Promise<Checkpoint> {
    // Delegates to existing approval service
    const request = await this.approvalService.requestApproval({
      plan_id: planId,
      step_id: stepId,
      type: 'proceed',
      message: `[Reactive Review] ${reason}`,
    });
    return { ...request, checkpoint_type: 'reactive_review' };
  }

  // Approve and resume - uses existing respond_approval
  async approve(checkpointId: string, approver: string): Promise<void> {
    await this.approvalService.respondToApproval(checkpointId, {
      approved: true,
      responder: approver,
    });
  }

  // Reject and abort - uses existing respond_approval
  async reject(checkpointId: string, approver: string, reason: string): Promise<void> {
    await this.approvalService.respondToApproval(checkpointId, {
      approved: false,
      responder: approver,
      notes: reason,
    });
  }

  // Get pending checkpoints - filters existing approvals
  async getPending(planId?: string): Promise<Checkpoint[]> {
    const pending = await this.approvalService.getPendingApprovals(planId);
    return pending.filter(a => (a as Checkpoint).checkpoint_type === 'reactive_review');
  }
}
```

### 6.3 Implementation Checklist

- [ ] Implement `Tier1Validator` with syntax checks
- [ ] Implement `Tier2Validator` with secret scanning
- [ ] Create `SecretScrubber` with pattern library
- [ ] Implement `TokenLimiter` with budget tracking
- [ ] Create `HITLCheckpointService` (wraps existing approval workflow)
- [ ] Add pipeline orchestration
- [ ] Unit tests for each validator
- [ ] Security tests for secret detection

### 6.4 Success Criteria

| Metric | Target | Measurement |
|--------|--------|-------------|
| Secret detection rate | >95% for known patterns | Security tests |
| False positive rate | <5% | Manual review |
| Token budget adherence | 100% | Existing telemetry |
| Backward compatibility | Existing approval tests pass | Test suite |

---

## 7. Risk Assessment

### 7.1 Risk Matrix

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Breaking existing MCP tools | Very Low | Critical | Extend services, not replace; feature flags |
| Performance regression | Low | High | Reuse existing optimized cache |
| SQLite corruption | Low | Medium | WAL mode, JSON fallback always available |
| Token budget exceeded | Medium | Medium | Hard limits, early termination |
| Secret leakage to LLM | Low | Critical | Multi-layer scrubbing, pattern updates |
| Worker pool deadlock | Low | High | Timeouts, watchdog, circuit breaker |
| Duplication drift | Low | Medium | Code review, single source of truth |

### 7.2 Dependency Risks

| Dependency | Risk | Mitigation |
|------------|------|------------|
| Legacy SDK runtime | API changes | Pin version, adapter layer |
| SQLite (better-sqlite3) | Native module issues | Fallback to JSON files (existing) |
| Git operations | Permission/access | Graceful error handling |
| Existing services | Interface changes | Version checks, feature flags |

---

## 8. Testing Strategy

### 8.1 Test Categories

| Category | Scope | Tools |
|----------|-------|-------|
| Unit Tests | Individual functions/classes | Jest |
| Integration Tests | Service interactions | Jest + Mocks |
| E2E Tests | Full review workflow | Jest + Test fixtures |
| Performance Tests | Latency, throughput | Custom benchmarks |
| Security Tests | Secret detection, scrubbing | Dedicated test suite |
| **Backward Compat Tests** | Existing functionality | **All existing tests** |

### 8.2 Test File Structure (Consolidated)

```
tests/
├── services/                          # EXISTING - add reactive tests here
│   ├── codeReviewService.test.ts      # Existing
│   ├── executionTrackingService.test.ts  # Existing + parallel exec tests
│   ├── planningService.test.ts        # Existing + reactive DAG tests
│   └── planPersistenceService.test.ts # Existing + SQLite backend tests
├── reactive/                          # NEW - only truly new functionality
│   ├── types.test.ts
│   ├── deduplication.test.ts
│   ├── validation/
│   │   ├── tier1.test.ts
│   │   ├── tier2.test.ts
│   │   └── pipeline.test.ts
│   ├── guardrails/
│   │   ├── secretScrubber.test.ts
│   │   ├── tokenLimiter.test.ts
│   │   └── hitlCheckpoint.test.ts
│   └── integration/
│       ├── fullWorkflow.test.ts
│       └── backwardCompatibility.test.ts
└── fixtures/
    ├── sample-diffs/
    └── expected-results/
```

### 8.3 Coverage Requirements

| Phase | Minimum Coverage | Target Coverage |
|-------|------------------|-----------------|
| Phase 1 | 80% | 90% |
| Phase 2 | 75% | 85% |
| Phase 3 | 85% | 95% |
| Phase 4 | 90% | 95% |

### 8.4 Backward Compatibility Tests

```typescript
// tests/reactive/integration/backwardCompatibility.test.ts

describe('Backward Compatibility', () => {
  it('should not modify existing MCP tool signatures', async () => {
    // Verify all 28+ existing tools unchanged
  });

  it('should not break create_plan functionality', async () => {
    // Test existing planning workflow
  });

  it('should not break review_changes functionality', async () => {
    // Test existing code review workflow
  });

  it('should allow opt-out of reactive features', async () => {
    // Test with REACTIVE_ENABLED=false
  });
});
```

---

## 9. Rollback Procedures

### 9.1 Per-Phase Rollback

| Phase | Rollback Steps | Time Estimate |
|-------|----------------|---------------|
| Phase 1 | 1. Set `REACTIVE_COMMIT_CACHE=false`<br>2. Restart MCP server<br>3. Existing cache behavior restored | 2 minutes |
| Phase 2 | 1. Set `REACTIVE_PARALLEL_EXEC=false`<br>2. Restart MCP server<br>3. Sequential execution restored | 2 minutes |
| Phase 3 | 1. Set `REACTIVE_SQLITE_BACKEND=false`<br>2. JSON file persistence restored<br>3. (Optional) Delete SQLite file | 2 minutes |
| Phase 4 | 1. Set `REACTIVE_GUARDRAILS=false`<br>2. Existing review flow restored<br>3. (Optional) Delete `src/reactive/guardrails/` | 2 minutes |

**Note**: Rollback is simpler because we extend existing services rather than replace them.

### 9.2 Full Rollback

```bash
# Full rollback to pre-reactive state
# Since we extend services, just disable feature flags:
export REACTIVE_ENABLED=false
npm run build
npm run test

# Or remove reactive-specific code (optional):
rm -rf src/reactive/
rm -f ~/.context-engine/reactive.db
npm run build
npm run test
```

### 9.3 Feature Flags (Aligned with Consolidation)

```typescript
// src/reactive/config.ts

export interface ReactiveConfig {
  // Master switch
  enabled: boolean;                    // REACTIVE_ENABLED

  // Per-phase switches (aligned with consolidated approach)
  commit_cache: boolean;               // REACTIVE_COMMIT_CACHE (Phase 1)
  parallel_exec: boolean;              // REACTIVE_PARALLEL_EXEC (Phase 2)
  sqlite_backend: boolean;             // REACTIVE_SQLITE_BACKEND (Phase 3)
  guardrails: boolean;                 // REACTIVE_GUARDRAILS (Phase 4)

  // Tuning parameters
  max_workers: number;                 // REACTIVE_MAX_WORKERS (default: 3)
  token_budget: number;                // REACTIVE_TOKEN_BUDGET (default: 10000)
  cache_ttl_ms: number;                // REACTIVE_CACHE_TTL (default: 300000)
}

export function getConfig(): ReactiveConfig {
  return {
    enabled: process.env.REACTIVE_ENABLED !== 'false',
    commit_cache: process.env.REACTIVE_COMMIT_CACHE === 'true',      // Opt-in
    parallel_exec: process.env.REACTIVE_PARALLEL_EXEC === 'true',    // Opt-in
    sqlite_backend: process.env.REACTIVE_SQLITE_BACKEND === 'true',  // Opt-in
    guardrails: process.env.REACTIVE_GUARDRAILS === 'true',          // Opt-in
    max_workers: parseInt(process.env.REACTIVE_MAX_WORKERS || '3', 10),
    token_budget: parseInt(process.env.REACTIVE_TOKEN_BUDGET || '10000', 10),
    cache_ttl_ms: parseInt(process.env.REACTIVE_CACHE_TTL || '300000', 10),
  };
}

// NOTE: All reactive features are OPT-IN by default
// This ensures zero impact on existing functionality until explicitly enabled
```

---

## 10. Performance Benchmarks

### 10.1 Baseline Metrics (Current System)

| Operation | Current P50 | Current P95 | Target P50 | Target P95 |
|-----------|-------------|-------------|------------|------------|
| Context retrieval | 500ms | 1500ms | 100ms (cached) | 300ms |
| Code review (single) | 3000ms | 8000ms | 2000ms | 5000ms |
| PR review (5 files) | 15000ms | 30000ms | 5000ms | 12000ms |
| DAG parsing | N/A | N/A | 200ms | 500ms |

### 10.2 Benchmark Suite

```typescript
// benchmarks/reactive.bench.ts

import { bench, describe } from 'vitest';

describe('ContextProxy Performance', () => {
  bench('cache hit', async () => {
    // Measure cached context retrieval
  });

  bench('cache miss', async () => {
    // Measure uncached context retrieval
  });

  bench('prefetch 5 files', async () => {
    // Measure background prefetch
  });
});

describe('DAG Execution Performance', () => {
  bench('3 parallel nodes', async () => {
    // Measure parallel execution speedup
  });

  bench('10 sequential nodes', async () => {
    // Measure sequential execution
  });

  bench('mixed DAG (15 nodes)', async () => {
    // Measure realistic PR scenario
  });
});
```

### 10.3 Scalability Limits

| Dimension | Soft Limit | Hard Limit | Notes |
|-----------|------------|------------|-------|
| Files per PR | 50 | 200 | Beyond 200, split review |
| Lines changed | 1000 | 5000 | Token budget constraint |
| Concurrent reviews | 5 | 10 | Worker pool saturation |
| Cache entries | 500 | 1000 | Memory constraint |

---

## 11. Monitoring & Observability

### 11.1 Telemetry Events (Extend Existing)

```typescript
// ENHANCE: Extend existing telemetry in ExecutionTrackingService
// No new telemetry/types.ts file needed!

// Existing StepExecutionState already tracks:
// - started_at, completed_at, duration_ms
// - status (pending, running, completed, failed)

// NEW: Add reactive-specific event types to existing logging
export type ReactiveEventType =
  | 'reactive.cache.hit'
  | 'reactive.cache.miss'
  | 'reactive.parallel.started'
  | 'reactive.parallel.completed'
  | 'reactive.validation.tier1'
  | 'reactive.validation.tier2'
  | 'reactive.guardrail.secret_detected'
  | 'reactive.guardrail.token_limit'
  | 'reactive.checkpoint.created'
  | 'reactive.checkpoint.resolved';

// Use existing console.error logging pattern (already in codebase)
function logReactiveEvent(type: ReactiveEventType, data: Record<string, unknown>): void {
  console.error(`[reactive] ${type}:`, JSON.stringify(data));
}
```

### 11.2 Metrics Dashboard

| Metric | Type | Alert Threshold |
|--------|------|-----------------|
| `reactive.reviews.total` | Counter | N/A |
| `reactive.reviews.duration_ms` | Histogram | P95 > 30s |
| `reactive.cache.hit_rate` | Gauge | < 50% |
| `reactive.workers.utilization` | Gauge | > 90% sustained |
| `reactive.tokens.used` | Counter | N/A |
| `reactive.tokens.budget_exceeded` | Counter | > 0 |
| `reactive.secrets.detected` | Counter | > 0 (alert) |
| `reactive.validation.failures` | Counter | P0: > 0 |

### 11.3 Logging Strategy

```typescript
// Structured logging with levels
console.error(JSON.stringify({
  level: 'info',
  component: 'reactive',
  subcomponent: 'dispatcher',
  event: 'step.completed',
  plan_id: planId,
  step_id: stepId,
  duration_ms: 1234,
  tokens_used: 456,
  timestamp: new Date().toISOString(),
}));
```

### 11.4 Health Checks

```typescript
// src/reactive/health.ts

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  components: {
    cache: ComponentHealth;
    workers: ComponentHealth;
    database: ComponentHealth;
    auggie_sdk: ComponentHealth;
  };
  timestamp: string;
}

export async function getHealth(): Promise<HealthStatus>;
```

---

## 12. Implementation Timeline (Revised)

### 12.1 Gantt Chart Overview (Accelerated by Consolidation)

```
Week 1:    Phase 1 - Enhanced Context & Cache
           [██████████████]  (reduced from 2 weeks)

Week 2-3:  Phase 2 - Extended Execution Tracking
           [████████████████████████████]  (reduced from 3 weeks)

Week 4:    Phase 3 - Extended Persistence & Telemetry
           [██████████████]  (reduced from 2 weeks)

Week 5-6:  Phase 4 - Guardrails & Security
           [████████████████████████████]  (unchanged - truly new)

Week 7:    Integration Testing & Documentation
           [██████████████]

Week 8:    Beta Rollout (10% traffic)
           [██████████████]

Week 9:    GA Release
           [██████████████]
```

**Total: 9 weeks (reduced from 12 weeks by consolidation)**

### 12.2 Milestones (Revised)

| Milestone | Target Date | Deliverables |
|-----------|-------------|--------------|
| M1: Enhanced Cache | Week 1 | Commit-keyed cache in ContextServiceClient |
| M2: Parallel Execution | Week 3 | Parallel execution in ExecutionTrackingService |
| M3: SQLite Backend | Week 4 | SQLite option in PlanPersistenceService |
| M4: Guardrails | Week 6 | Validation pipeline, secret scrubbing |
| M5: Beta | Week 8 | Feature-flagged rollout |
| M6: GA | Week 9 | Full release, documentation |

### 12.3 Code Reduction Summary

| Original v2.1 | Consolidated v2.2 | Reduction |
|---------------|-------------------|-----------|
| ~15 new files | ~8 new files | 47% fewer files |
| ~3000 lines new code | ~1200 lines new code | 60% less code |
| 12 weeks | 9 weeks | 25% faster |
| 6 new services | 0 new services (extend existing) | 100% reuse |

---

## 13. Appendix

### 13.1 References

- [Reactive_Planner.md](./Reactive_Planner.md) - Original specification
- [ARCHITECTURE.md](../ARCHITECTURE.md) - System architecture
- [docs/archive/PLANNING_WORKFLOW.md](../docs/archive/PLANNING_WORKFLOW.md) - Existing planning tools
- Industry Research:
  - Airflow/Dagster for DAG orchestration patterns
  - CodeRabbit/Codex for review automation
  - SonarQube for static analysis patterns

### 13.2 Glossary

| Term | Definition |
|------|------------|
| DAG | Directed Acyclic Graph - execution model for review nodes |
| HITL | Human-in-the-Loop - manual approval checkpoints |
| Commit-Keyed Cache | Cache entries keyed by git commit hash for consistency |
| Blast Radius | Semantic analysis of downstream impact |
| Token Budget | Maximum LLM tokens per review (default: 10,000) |
| Consolidation | Strategy of extending existing services vs. creating new ones |

### 13.3 Change Log

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 2.1 | 2024-12-24 | AI Assistant | Initial implementation plan |
| 2.2 | 2024-12-24 | AI Assistant | **Consolidation revision**: Extend existing services instead of creating parallel systems. Reduced timeline from 12 to 9 weeks. Reduced new code by 60%. |

---

*This document is the authoritative implementation guide for the Reactive AI Code Review Engine. All implementation work should follow this specification to ensure compatibility with the existing Context Engine MCP server.*

**Key Principle**: Extend, don't duplicate. Every new feature should first check if existing services can be enhanced rather than creating parallel implementations.
