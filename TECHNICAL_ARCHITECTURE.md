# Context Engine - Technical Architecture Deep Dive

## System Overview

Context Engine is a sophisticated MCP (Model Context Protocol) server that provides AI-powered code analysis, review, and planning capabilities. This document provides a detailed technical breakdown of the system architecture.

## Core Architecture Layers

### Layer 1: MCP Protocol Layer (`src/index.ts`, `src/mcp/server.ts`)

**Purpose**: Handle MCP protocol communication and tool registration

**Key Components**:
- **Server Initialization**: Stdio transport setup
- **Tool Registry**: 20+ tools registered with schemas
- **Request Routing**: Tool invocation and response handling
- **Error Handling**: Protocol-level error management

**Tools Exposed**:
```typescript
// Core Context
- index_workspace, codebase_retrieval, semantic_search
- get_file, get_context_for_prompt, enhance_prompt

// Index Management
- index_status, reindex_workspace, clear_index, tool_manifest

// Memory
- add_memory, list_memories

// Planning (Phase 1)
- create_plan, refine_plan, visualize_plan, execute_plan

// Plan Management (Phase 2)
- save_plan, load_plan, list_plans, delete_plan
- request_approval, respond_approval
- start_step, complete_step, fail_step
- view_progress, view_history, compare_plan_versions, rollback_plan

// Code Review
- review_changes, review_git_diff, review_diff, check_invariants, run_static_analysis

// Reactive Review (Phase 4)
- reactive_review_pr, get_review_status, pause_review, resume_review, get_review_telemetry
- scrub_secrets, validate_content
```

### Layer 2: Service Layer (`src/mcp/services/`)

**Purpose**: Business logic and orchestration

#### A. Context Service Client (`serviceClient.ts`)
```typescript
class ContextServiceClient {
  // Core capabilities
  - semanticSearch(query, options): SearchResult[]
  - getFile(path): FileContent
  - getContextForPrompt(query, options): ContextBundle
  
  // Caching
  - getCacheStats(): { hitRate, size, commitKeyed }
  - clearCache(): void
  
  // Workspace
  - getWorkspacePath(): string
  - getWorkspaceInfo(): WorkspaceMetadata
}
```

**Caching Strategy**:
- **L1**: In-memory LRU cache (search results, file contents)
- **L2**: Commit-keyed cache (invalidates on git changes)
- **L3**: Persistent disk cache (embeddings, responses)

#### B. Code Review Service (`codeReviewService.ts`)
```typescript
class CodeReviewService {
  // Review orchestration
  - reviewDiff(diff, options): ReviewResult
  - buildMetadata(startTime, opts): ReviewMetadata
  
  // Finding management
  - filterFindings(findings, threshold): Finding[]
  - deduplicateFindings(findings): Finding[]
}
```

**Review Pipeline**:
1. **Preflight**: Deterministic checks (risk scoring, hotspots)
2. **Invariants**: Custom rule enforcement
3. **Static Analysis**: TypeScript/Semgrep (optional)
4. **LLM Analysis**: Two-pass semantic review (optional)
5. **Post-processing**: Filtering, deduplication, formatting

#### C. Planning Service (`planningService.ts`)
```typescript
class PlanningService {
  // Plan generation
  - generatePlan(goal, context): EnhancedPlanOutput
  - analyzeDependencies(plan): DependencyGraph
  
  // Execution
  - executePlanStep(planId, stepNumber): StepResult
  - getExecutionStatus(planId): ExecutionStatus
}
```

**Plan Structure**:
```typescript
interface EnhancedPlanOutput {
  id: string;
  goal: string;
  scope: { included, excluded, assumptions, constraints };
  mvp_features: Feature[];
  nice_to_have_features: Feature[];
  steps: Step[];  // Ordered execution steps
  dependencies: { [stepNumber]: number[] };
  architecture: { notes, patterns_used, diagrams };
  risks: Risk[];
}
```

#### D. Execution Tracking Service (`executionTrackingService.ts`)
```typescript
class ExecutionTrackingService {
  // State management
  - initializeExecution(planId, plan): ExecutionState
  - startStep(planId, stepNumber): StepState
  - completeStep(planId, stepNumber, options): StepState
  
  // Parallel execution
  - executeStepWithTimeout(planId, stepNumber, executor): Result
  - executeParallelSteps(planId, plan, executor): Result[]
  
  // Resilience
  - circuitBreaker: { state, failures, threshold }
  - retryLogic: { maxRetries, backoff }
  - timeoutProtection: { stepTimeout, sessionTimeout }
}
```

**Execution States**:
- `pending`: Not yet ready (blocked by dependencies)
- `ready`: Dependencies met, can execute
- `executing`: Currently running
- `completed`: Successfully finished
- `failed`: Execution error
- `skipped`: Intentionally bypassed

### Layer 3: Review Engine (`src/reviewer/`)

#### A. Diff Analysis (`reviewDiff.ts`)
```typescript
async function reviewDiff(input: ReviewInput): Promise<EnterpriseReviewResult> {
  // 1. Parse diff
  const parsed = parseUnifiedDiff(input.diff);
  
  // 2. Deterministic preflight
  const preflight = runDeterministicPreflight(parsed);
  // - Risk score (1-5)
  // - Change classification
  // - Hotspot detection
  // - File change analysis
  
  // 3. Run invariants
  const invariants = await runInvariants(parsed, config);
  
  // 4. Static analysis (optional)
  if (options.enable_static_analysis) {
    const static = await runStaticAnalyzers({
      analyzers: ['tsc', 'semgrep'],
      timeout: 60000
    });
  }
  
  // 5. LLM analysis (optional)
  if (options.enable_llm_review && riskScore >= threshold) {
    const llm = await runTwoPassLLM({
      structural: buildStructuralPrompt(),
      detailed: buildDetailedPrompt()
    });
  }
  
  // 6. Merge and filter findings
  const findings = dedupeFindingsById([...invariants, ...static, ...llm]);
  
  // 7. Build result
  return {
    run_id, risk_score, classification, hotspots,
    summary, findings, should_fail, fail_reasons,
    stats, metadata
  };
}
```

#### B. Invariants System (`checks/invariants/`)

**Configuration** (`.review-invariants.yml`):
```yaml
security:
  - id: SEC001
    rule: "If req.user is used, requireAuth() must be present"
    paths: ["src/api/**"]
    severity: CRITICAL
    category: security
    action: when_require
    when:
      regex:
        pattern: "req\\.user"
    require:
      regex:
        pattern: "requireAuth\\("

  - id: SEC002
    rule: "No eval() allowed"
    paths: ["src/**"]
    severity: HIGH
    category: security
    action: deny
    deny:
      regex:
        pattern: "\\beval\\("
```

**Actions**:
- `deny`: Pattern must NOT appear
- `when_require`: If `when` matches, `require` must also match
- `warn`: Pattern triggers warning (non-blocking)

#### C. Static Analyzers (`checks/adapters/`)

**TypeScript Analyzer** (`tsc.ts`):
```typescript
async function runTscAnalyzer(input, opts) {
  // Run: npx tsc --noEmit --pretty false
  const result = await runCommand({
    command: 'npx',
    args: ['--no-install', 'tsc', '--noEmit'],
    timeout: opts.timeoutMs
  });
  
  // Parse output: "src/a.ts(12,5): error TS2322: ..."
  const errors = parseTscOutput(result.stdout);
  
  // Convert to findings
  return {
    analyzer: 'tsc',
    findings: errors.map(toFinding),
    duration_ms: result.duration_ms
  };
}
```

**Semgrep Analyzer** (`semgrep.ts`):
```typescript
async function runSemgrepAnalyzer(input, opts) {
  // Run: semgrep --json --config auto --quiet <files>
  const result = await runCommand({
    command: 'semgrep',
    args: ['--json', '--config', 'auto', ...input.changed_files],
    timeout: opts.timeoutMs
  });
  
  // Parse JSON output
  const results = JSON.parse(result.stdout);
  
  // Convert to findings
  return {
    analyzer: 'semgrep',
    findings: results.results.map(toFinding),
    duration_ms: result.duration_ms
  };
}
```

### Layer 4: Reactive Review System (`src/reactive/`)

**Purpose**: Asynchronous, long-running review sessions with progress tracking

```typescript
class ReactiveReviewService {
  // Session management
  - startReview(prMetadata): sessionId
  - getStatus(sessionId): ReviewStatus
  - pauseReview(sessionId): void
  - resumeReview(sessionId): void
  // (Note: cancel is supported internally but not currently exposed as an MCP tool)
  
  // Execution
  - executeReviewStep(sessionId, stepNumber): StepResult
  
  // Monitoring
  - detectZombieSessions(): sessionId[]
  - recoverSession(sessionId): void
  
  // Telemetry
  - sessionStartTimes: Map<sessionId, timestamp>
  - sessionFindings: Map<sessionId, count>
  - sessionTokensUsed: Map<sessionId, tokens>
}
```

**Session Lifecycle**:
```
pending → planning → ready → executing → completed
                                      ↓
                                   paused → resumed
                                      ↓
                                   failed/cancelled
```

**Zombie Detection**:
- **Trigger**: No activity for 2+ minutes while in active state
- **Detection**: Periodic health checks (every 30s)
- **Recovery**: Automatic session cleanup or manual resume

## Data Flow

### 1. Code Review Flow
```
User Request (diff)
  ↓
MCP Tool (review_diff)
  ↓
CodeReviewService
  ↓
reviewDiff() orchestrator
  ├→ parseUnifiedDiff()
  ├→ runDeterministicPreflight()
  ├→ runInvariants()
  ├→ runStaticAnalyzers()
  └→ runTwoPassLLM()
  ↓
Merge & Filter Findings
  ↓
Format Output (JSON/SARIF/Markdown)
  ↓
Return to User
```

### 2. Reactive Review Flow
```
User Request (PR metadata)
  ↓
reactive_review_pr tool
  ↓
ReactiveReviewService.startReview()
  ├→ Create session
  ├→ Generate plan (PlanningService)
  ├→ Initialize execution (ExecutionTrackingService)
  └→ Return sessionId
  ↓
Background Execution
  ├→ Execute steps in parallel
  ├→ Track progress
  ├→ Update telemetry
  └→ Handle failures/retries
  ↓
User polls get_review_status
  ↓
Return progress + findings
```

### 3. Planning & Execution Flow
```
User Request (goal)
  ↓
create_plan tool
  ↓
PlanningService.generatePlan()
  ├→ Analyze requirements
  ├→ Break down into steps
  ├→ Build dependency graph
  └→ Return EnhancedPlanOutput
  ↓
save_plan tool (optional)
  ↓
execute_plan tool (per step or batch)
  ↓
ExecutionTrackingService
  ├→ Check dependencies
  ├→ Execute with timeout
  ├→ Handle retries
  ├→ Update state
  └→ Trigger dependent steps
  ↓
view_progress tool
  ↓
Return execution progress
```

## Performance Optimizations

### 1. Caching
- **Search Results**: 5-minute TTL
- **File Contents**: Commit-keyed invalidation
- **Embeddings**: Persistent disk cache
- **LLM Responses**: 3-layer cache (memory → disk → remote)

### 2. Parallel Execution
- **Worker Pool**: CPU-aware concurrency (default: CPU cores - 1)
- **Step Parallelization**: Execute independent steps concurrently
- **Timeout Protection**: Per-step and per-session timeouts

### 3. Circuit Breaker
- **Failure Threshold**: 3 consecutive failures
- **Fallback**: Switch to sequential execution
- **Reset**: After 60s or 2 consecutive successes

### 4. Chunked Processing
- **Large Diffs**: Split into manageable chunks
- **Batch Size**: Configurable (default: 10 files)
- **Progress Tracking**: Per-chunk telemetry

## Telemetry & Observability

### Metrics Collected
```typescript
interface ReviewStats {
  files_changed: number;
  lines_added: number;
  lines_removed: number;
  duration_ms: number;
  deterministic_checks_executed: number;
  invariants_executed?: number;
  static_analyzers_executed?: number;
  llm_passes_executed?: number;
  llm_findings_added?: number;
  timings_ms?: {
    preflight?: number;
    invariants?: number;
    static_analysis?: number;
    context_fetch?: number;
    secrets_scrub?: number;
    llm_structural?: number;
    llm_detailed?: number;
  };
}

interface ReviewStatus {
  session: ReviewSession;
  progress: { completed_steps, total_steps, percentage };
  telemetry: {
    start_time: string;
    elapsed_ms: number;
    tokens_used: number;
    cache_hit_rate: number;
    last_activity_ms?: number;
    appears_stalled?: boolean;
  };
  findings_count: number;
}
```

### Logging Strategy
- **Console**: Structured JSON logs
- **Levels**: ERROR, WARN, INFO, DEBUG
- **Context**: sessionId, planId, stepNumber
- **Performance**: Duration tracking for all operations

## Testing Strategy

### Test Coverage
- **Unit Tests**: 397 tests across 35 suites
- **Integration Tests**: End-to-end workflows
- **Snapshot Tests**: Output format validation
- **Manual Tests**: AI agent executor

### Key Test Areas
1. **Diff Parsing**: Various git diff formats
2. **Invariants**: Rule matching and violation detection
3. **Static Analyzers**: TypeScript and Semgrep integration
4. **LLM Integration**: Prompt building and response parsing
5. **Execution Tracking**: State transitions and dependencies
6. **Reactive Reviews**: Session lifecycle and zombie detection
7. **Caching**: Hit rates and invalidation
8. **Error Handling**: Timeouts, retries, circuit breaker

## Security Considerations

### 1. Input Validation
- Diff sanitization (secrets scrubbing)
- Path traversal prevention
- Command injection protection

### 2. Secrets Management
- Environment variable support
- Session file encryption
- No secrets in logs

### 3. Isolation
- No network exposure (stdio only)
- Workspace sandboxing
- Process isolation for static analyzers

## Deployment

### Requirements
- Node.js 18+
- TypeScript 5.3+
- Git (for diff analysis)
- Optional: TypeScript project (for tsc analyzer)
- Optional: Semgrep (for semgrep analyzer)

### Configuration
```json
{
  "mcpServers": {
    "context-engine": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "AUGGIE_API_KEY": "your-key"
      }
    }
  }
}
```

### Monitoring
- Health checks via `get_workspace_info`
- Telemetry via `get_review_telemetry`
- Cache stats via `getCacheStats()`
- Session status via `get_review_status`

---

**Version**: 1.8.0  
**Last Updated**: 2025-12-26  
**Maintainer**: Context Engine Team
