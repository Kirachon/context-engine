# Context Engine MCP Server - Architecture Enhancement Blueprint

## Executive Summary

This document provides a comprehensive architecture plan for safely implementing the **Diff-first, Policy-driven Code Reviewer** as described in the code review specification, along with additional open-source enhancements. The plan preserves all 38 existing MCP tools, maintains compatibility with Codex, Claude, Cursor, and other MCP clients, and follows the established 5-layer architecture.

**Target Version**: v2.0.0  
**Current Version**: v1.8.0  
**Primary Enhancement**: Enterprise-grade Code Review System

---

## Table of Contents

1. [Current State Analysis](#current-state-analysis)
2. [Feature Inventory](#feature-inventory)
3. [Risk Assessment](#risk-assessment)
4. [Implementation Phases](#implementation-phases)
5. [Compatibility Matrix](#compatibility-matrix)
6. [Testing Strategy](#testing-strategy)
7. [Rollback Plan](#rollback-plan)
8. [Appendix: Technical Specifications](#appendix-technical-specifications)

---

## Current State Analysis

### Existing Architecture (5 Layers)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Layer 4: Agent Clients (Codex CLI, Claude, Cursor, Antigravity)         │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │ MCP Protocol (stdio)
┌───────────────────────────────────┴─────────────────────────────────────┐
│ Layer 3: MCP Interface Layer                                            │
│ - 38 MCP Tools                                                          │
│ - src/mcp/server.ts, src/mcp/tools/                                     │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │ TypeScript Interfaces
┌───────────────────────────────────┴─────────────────────────────────────┐
│ Layer 2.5: Internal Shared Handlers                                      │
│ - src/internal/handlers/                                                 │
│ - Retrieval, Context, Enhancement, Performance                          │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
┌───────────────────────────────────┴─────────────────────────────────────┐
│ Layer 2: Context Service Layer                                           │
│ - ContextServiceClient (src/mcp/serviceClient.ts)                        │
│ - Planning Services (src/mcp/services/)                                  │
│ - Reactive Review Services (src/reactive/)                               │
│ - Code Review Service (src/mcp/services/codeReviewService.ts)            │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │ CLI/SDK Calls
┌───────────────────────────────────┴─────────────────────────────────────┐
│ Layer 1: Core Context Engine (Auggie SDK)                                │
│ - @augmentcode/auggie-sdk                                                │
│ - Semantic search, embeddings, indexing                                  │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
┌───────────────────────────────────┴─────────────────────────────────────┐
│ Layer 5: Storage Backend (Auggie internal + local persistence)           │
│ - .context-engine/plans/ (plan persistence)                              │
│ - .augment-context-state.json (index state)                              │
│ - .memories/ (persistent memories)                                       │
└─────────────────────────────────────────────────────────────────────────┘
```

### Current Tool Inventory (38 Tools)

| Category | Tools | Status |
|----------|-------|--------|
| Core Context | `index_workspace`, `codebase_retrieval`, `semantic_search`, `get_file`, `get_context_for_prompt`, `enhance_prompt`, `tool_manifest` | ✅ Stable |
| Index Management | `index_status`, `reindex_workspace`, `clear_index` | ✅ Stable |
| Memory | `add_memory`, `list_memories` | ✅ Stable |
| Planning | `create_plan`, `refine_plan`, `visualize_plan`, `execute_plan` | ✅ Stable |
| Plan Persistence | `save_plan`, `load_plan`, `list_plans`, `delete_plan` | ✅ Stable |
| Approval Workflow | `request_approval`, `respond_approval` | ✅ Stable |
| Execution Tracking | `start_step`, `complete_step`, `fail_step`, `view_progress` | ✅ Stable |
| History | `view_history`, `compare_plan_versions`, `rollback_plan` | ✅ Stable |
| Code Review | `review_changes`, `review_git_diff` | ✅ Stable |
| Reactive Review | `reactive_review_pr`, `get_review_status`, `pause_review`, `resume_review`, `get_review_telemetry`, `scrub_secrets`, `validate_content` | ✅ Stable |

### Existing Capabilities Assessment

| Capability | Implementation | Gaps for Enterprise Review |
|------------|---------------|---------------------------|
| Diff Parsing | `CodeReviewService.parseDiff()` | ✅ Complete |
| Context Fetching | `ContextServiceClient.semanticSearch()` | ✅ Complete |
| Secret Scrubbing | `SecretScrubber` (15+ patterns) | ✅ Complete |
| Validation Pipeline | `ValidationPipeline` (Tier1/Tier2) | ✅ Complete |
| Structured Output | `ReviewResult` schema | ⚠️ Needs enhancement |
| Deterministic Checks | Partial (validation rules) | ❌ Needs invariants system |
| Risk Scoring | Not implemented | ❌ New feature needed |
| Change Classification | Not implemented | ❌ New feature needed |
| Context Planning | Basic (hardcoded limits) | ⚠️ Needs diff-first planning |
| LLM Two-Pass Review | Not implemented | ❌ New feature needed |
| CI/GitHub Integration | Not implemented | ❌ New feature needed |

---

## Feature Inventory

### Phase 1: Foundation (MUST-HAVE)

#### 1.1 Standard Review Input Model
**Justification**: Enterprise usage starts with PR diffs. All tooling hinges on correct diff parsing.

| Component | Description | Open-Source Dependencies |
|-----------|-------------|-------------------------|
| Diff Parser Enhancement | Parse unified diff → structured hunks with file paths + changed line ranges | `diff-parse` (npm) or custom |
| Change Classifier | Classify: feature/bugfix/refactor/infra/docs | Rule-based + heuristics |
| Input Schema | Support `diff`, `changed_files[]`, optional `base_sha`, `head_sha`, `repo_root` | JSON Schema validation |

**Files to Create/Modify**:
```
src/reviewer/
├── diff/
│   ├── parse.ts           # Enhanced diff parser
│   ├── classify.ts        # Change classification
│   └── risk.ts            # Risk scoring
```

#### 1.2 Deterministic Preflight
**Justification**: Fast, reliable baseline checks before any LLM involvement.

| Check | Implementation | Confidence |
|-------|---------------|------------|
| Files touched count | Count from diff | 1.0 |
| Hot zones detection | Pattern matching against paths | 0.95 |
| Public API changes | AST analysis (exports, function signatures) | 0.9 |
| Config/infra changes | Path pattern matching | 1.0 |
| Tests touched | Path pattern matching | 1.0 |

**Risk Score Formula**:
```typescript
riskScore = baseScore
  + (filesChanged > 10 ? 1 : 0)
  + (hotzonesHit * 0.5)
  + (publicApiChanged ? 1.5 : 0)
  + (configChanged ? 0.5 : 0)
  + (testsNotTouched ? 1 : 0);
```

#### 1.3 Structured Review Output Schema
**Justification**: Non-negotiable for CI/GitHub/IDE integration.

```typescript
// src/reviewer/types.ts
interface EnterpriseReviewResult {
  run_id: string;                    // UUID for tracking
  risk_score: number;                // 1-5 scale
  classification: ChangeType;        // feature/bugfix/refactor/infra/docs
  hotspots: string[];                // Detected sensitive areas
  summary: string;                   // High-level summary
  findings: EnterpriseFinding[];     // Detailed findings
  stats: ReviewStats;                // Token usage, files processed
  metadata: ReviewMetadata;          // Timing, model info
}

interface EnterpriseFinding {
  id: string;                        // F001, F002, etc.
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  category: ReviewCategory;
  confidence: number;                // 0-1
  title: string;                     // Max 80 chars
  location: CodeLocation;
  evidence: string[];                // Code snippets proving the issue
  impact: string;
  recommendation: string;
  suggested_patch?: string;          // Optional unified diff
}
```

#### 1.4 New MCP Tool: `review_diff`
**Justification**: Single canonical entrypoint for GitHub/CI/IDE integration.

```typescript
// Tool Definition
export const reviewDiffTool = {
  name: 'review_diff',
  description: 'Enterprise-grade code review with structured JSON output',
  inputSchema: {
    type: 'object',
    properties: {
      diff: { type: 'string', description: 'Unified diff content' },
      changed_files: { type: 'array', items: { type: 'string' } },
      base_sha: { type: 'string' },
      head_sha: { type: 'string' },
      options: {
        type: 'object',
        properties: {
          confidence_threshold: { type: 'number', default: 0.55 },
          max_findings: { type: 'number', default: 20 },
          categories: { type: 'array', items: { type: 'string' } },
          invariants_path: { type: 'string' }
        }
      }
    },
    required: ['diff']
  }
};
```

### Phase 2: Enterprise Trust (Policy & Invariants)

#### 2.1 Invariants System
**Justification**: Deterministic, high-confidence checks that enterprises can trust.

**Configuration Format** (`.review-invariants.yml`):
```yaml
security:
  - id: SEC001
    rule: "Any endpoint handler must call requireAuth() before accessing req.user"
    paths: ["src/api/**", "src/routes/**"]
    severity: CRITICAL

  - id: SEC002
    rule: "No raw SQL string concatenation with user input"
    paths: ["src/db/**", "src/models/**"]
    severity: CRITICAL

reliability:
  - id: REL001
    rule: "All caught errors must be logged with context"
    paths: ["src/**"]
    severity: HIGH

architecture:
  - id: ARC001
    rule: "Controllers cannot import DB layer directly"
    paths: ["src/controllers/**"]
    severity: MEDIUM
```

**Files to Create**:
```
src/reviewer/checks/
├── invariants/
│   ├── load.ts          # YAML config loader
│   ├── runner.ts        # Invariant check execution
│   └── types.ts         # Invariant types
```

#### 2.2 Static Analyzer Adapters
**Open-Source Integrations**:

| Tool | Purpose | Integration Method |
|------|---------|-------------------|
| ESLint | JavaScript/TypeScript analysis | spawn + parse JSON output |
| Semgrep | Pattern-based security scanning | spawn + SARIF output |
| TypeScript Compiler | Type checking | `tsc --noEmit` + parse errors |

**Adapter Interface**:
```typescript
interface StaticAnalyzerAdapter {
  name: string;
  supportedLanguages: string[];
  analyze(files: string[], options: AnalyzerOptions): Promise<AnalyzerFinding[]>;
}
```

#### 2.3 Noise Gate Rules
**Justification**: Enterprise reviewers fail when they spam. Gate low-value findings.

```typescript
// src/reviewer/post/calibrate.ts
const NOISE_GATES = {
  skipLLMPass: (preflight: PreflightResult) =>
    preflight.riskScore <= 2 &&
    preflight.invariantViolations === 0 &&
    preflight.testsTouched,

  dropStyleFindings: (finding: Finding) =>
    finding.category === 'style' && !config.includeStyle,

  suppressLowConfidence: (finding: Finding) =>
    finding.confidence < 0.55
};
```

### Phase 3: LLM Integration (Two-Pass Review)

#### 3.1 Context Planning Engine
**Justification**: Diff-first context selection prevents token waste.

```typescript
// src/reviewer/context/planner.ts
interface ContextPlan {
  budget: number;                    // Total token budget
  allocations: ContextAllocation[];  // Per-file allocations
  strategy: 'focused' | 'broad';     // Based on diff size
}

interface ContextAllocation {
  file: string;
  priority: number;                  // 1-10
  tokenBudget: number;
  sections: CodeSection[];           // Specific ranges to include
  reason: string;                    // Why this context matters
}

// Priority calculation
function calculatePriority(file: string, diff: ParsedDiff): number {
  let priority = 5;
  if (diff.isNewFile) priority += 2;
  if (diff.hasPublicApiChanges) priority += 3;
  if (isHotzone(file)) priority += 2;
  if (diff.linesChanged > 50) priority += 1;
  return Math.min(priority, 10);
}
```

#### 3.2 Two-Pass LLM Review
**Justification**: Separate passes for different concerns improves accuracy.

**Pass 1: Structural Analysis**
- Focus: Architecture, API design, patterns
- Context: Full file context for changed files
- Output: High-level findings

**Pass 2: Detailed Analysis**
- Focus: Logic bugs, edge cases, security
- Context: Focused on specific hunks + dependencies
- Output: Line-level findings

```typescript
// src/reviewer/llm/twoPass.ts
async function twoPassReview(
  diff: ParsedDiff,
  context: ContextPlan,
  options: ReviewOptions
): Promise<ReviewResult> {
  // Pass 1: Structural
  const structuralPrompt = buildStructuralPrompt(diff, context);
  const structuralFindings = await llmCall(structuralPrompt, {
    temperature: 0.1,
    maxTokens: 2000
  });

  // Pass 2: Detailed (only if Pass 1 found issues or high risk)
  if (shouldRunDetailedPass(structuralFindings, options)) {
    const detailedPrompt = buildDetailedPrompt(diff, context, structuralFindings);
    const detailedFindings = await llmCall(detailedPrompt, {
      temperature: 0.2,
      maxTokens: 4000
    });
    return mergeFindings(structuralFindings, detailedFindings);
  }

  return structuralFindings;
}
```

#### 3.3 Prompt Templates
**Location**: `src/reviewer/prompts/`

```typescript
// src/reviewer/prompts/structural.ts
export const STRUCTURAL_PROMPT = `
You are reviewing a code change. Focus on:
1. Architecture and design patterns
2. Public API changes and backward compatibility
3. Error handling patterns
4. Test coverage gaps

DIFF:
{{diff}}

CONTEXT:
{{context}}

INVARIANTS TO CHECK:
{{invariants}}

Respond with JSON matching this schema:
{{schema}}
`;
```

### Phase 4: CI/GitHub Integration

#### 4.1 GitHub Action
**File**: `.github/actions/context-engine-review/action.yml`

```yaml
name: 'Context Engine Code Review'
description: 'AI-powered code review with structured output'
inputs:
  github-token:
    description: 'GitHub token for PR comments'
    required: true
  confidence-threshold:
    description: 'Minimum confidence for findings'
    default: '0.55'
  fail-on-critical:
    description: 'Fail the check if critical issues found'
    default: 'true'
runs:
  using: 'node20'
  main: 'dist/index.js'
```

#### 4.2 PR Comment Formatter
**Justification**: Structured output → readable PR comments.

```typescript
// src/reviewer/output/github.ts
function formatPRComment(result: EnterpriseReviewResult): string {
  const header = `## 🔍 Code Review Summary\n\n`;
  const riskBadge = getRiskBadge(result.risk_score);
  const stats = formatStats(result.stats);
  const findings = formatFindings(result.findings);

  return `${header}${riskBadge}\n\n${stats}\n\n${findings}`;
}

function getRiskBadge(score: number): string {
  const colors = { 1: '🟢', 2: '🟢', 3: '🟡', 4: '🟠', 5: '🔴' };
  return `**Risk Level**: ${colors[score]} ${score}/5`;
}
```

### Phase 5: Open-Source Ecosystem Integration

#### 5.1 MCP Tool Ecosystem Compatibility
**Existing MCP Servers to Integrate With**:

| MCP Server | Purpose | Integration |
|------------|---------|-------------|
| `@modelcontextprotocol/server-github` | GitHub API access | Complement with review |
| `@modelcontextprotocol/server-filesystem` | File access | Already compatible |
| `@modelcontextprotocol/server-memory` | Persistent memory | Already compatible |

#### 5.2 Static Analysis Tool Integration
**Open-Source Tools to Leverage**:

| Tool | License | Integration Priority |
|------|---------|---------------------|
| ESLint | MIT | HIGH - TypeScript/JavaScript |
| Semgrep | LGPL-2.1 | HIGH - Security patterns |
| Biome | MIT | MEDIUM - Fast linting |
| Oxc | MIT | MEDIUM - Rust-based parser |
| tree-sitter | MIT | HIGH - AST parsing |

#### 5.3 New MCP Tools for Ecosystem

```typescript
// Additional tools to add
const ecosystemTools = [
  {
    name: 'run_static_analysis',
    description: 'Run static analysis tools on specified files',
    // Wraps ESLint, Semgrep, etc.
  },
  {
    name: 'get_ast',
    description: 'Get AST for a file using tree-sitter',
    // Enables custom analysis
  },
  {
    name: 'check_invariants',
    description: 'Check code against project invariants',
    // Standalone invariant checking
  }
];
```

---

## Risk Assessment

### Breaking Change Analysis

| Change | Risk Level | Mitigation |
|--------|-----------|------------|
| New `review_diff` tool | LOW | Additive, no existing tool modified |
| Enhanced `ReviewResult` schema | MEDIUM | Backward-compatible fields, old fields preserved |
| New dependencies (tree-sitter, etc.) | MEDIUM | Optional, graceful degradation |
| Invariants system | LOW | Opt-in via config file |
| LLM integration | MEDIUM | Configurable, can disable |

### Compatibility Risks

| Client | Risk | Notes |
|--------|------|-------|
| Codex CLI | LOW | Uses stdio, no changes to protocol |
| Claude Desktop | LOW | Standard MCP, additive tools |
| Cursor | LOW | Standard MCP, additive tools |
| Antigravity | LOW | Standard MCP, additive tools |
| Custom MCP clients | LOW | Schema-compliant additions |

### Performance Risks

| Concern | Mitigation |
|---------|------------|
| Large diffs (>1000 lines) | Chunked processing, already implemented |
| LLM latency | Two-pass with early exit, caching |
| Static analysis overhead | Parallel execution, result caching |
| Memory usage | Streaming diff parsing, bounded context |

---

## Implementation Phases

### Phase 1: Foundation (Weeks 1-2)
**Goal**: Core diff parsing and structured output

| Task | Priority | Effort | Dependencies |
|------|----------|--------|--------------|
| Enhanced diff parser | P0 | 3d | None |
| Change classifier | P0 | 2d | Diff parser |
| Risk scoring | P0 | 2d | Diff parser |
| `review_diff` tool | P0 | 3d | All above |
| Unit tests | P0 | 2d | All above |

**Deliverable**: `review_diff` tool with deterministic preflight

### Phase 2: Enterprise Trust (Weeks 3-4)
**Goal**: Invariants and static analysis integration

| Task | Priority | Effort | Dependencies |
|------|----------|--------|--------------|
| Invariants loader | P0 | 2d | None |
| Invariants runner | P0 | 3d | Loader |
| ESLint adapter | P1 | 2d | None |
| Semgrep adapter | P1 | 2d | None |
| Noise gate rules | P0 | 2d | Phase 1 |
| Integration tests | P0 | 2d | All above |

**Deliverable**: Deterministic checks with configurable invariants

### Phase 3: LLM Integration (Weeks 5-6)
**Goal**: Two-pass LLM review with context planning

| Task | Priority | Effort | Dependencies |
|------|----------|--------|--------------|
| Context planner | P0 | 3d | Phase 1 |
| Structural pass | P0 | 3d | Context planner |
| Detailed pass | P0 | 3d | Structural pass |
| Prompt templates | P0 | 2d | None |
| Finding merger | P0 | 2d | Both passes |
| E2E tests | P0 | 2d | All above |

**Deliverable**: Full two-pass review with structured output

### Phase 4: CI/GitHub (Weeks 7-8)
**Goal**: Production-ready CI integration

| Task | Priority | Effort | Dependencies |
|------|----------|--------|--------------|
| GitHub Action | P0 | 3d | Phase 3 |
| PR comment formatter | P0 | 2d | Phase 3 |
| SARIF output | P1 | 2d | Phase 3 |
| CLI enhancements | P1 | 2d | Phase 3 |
| Documentation | P0 | 2d | All above |

**Deliverable**: GitHub Action + CLI for CI pipelines

---

## Compatibility Matrix

### MCP Protocol Compatibility

| Feature | MCP 1.0 | MCP 1.1 | Notes |
|---------|---------|---------|-------|
| Tool definitions | ✅ | ✅ | Standard schema |
| Streaming responses | ✅ | ✅ | Already implemented |
| Progress notifications | ✅ | ✅ | Already implemented |
| Resource subscriptions | ❌ | ✅ | Future enhancement |

### Client Compatibility

| Client | Version | Status | Notes |
|--------|---------|--------|-------|
| Codex CLI | 0.1.x | ✅ Tested | Primary development target |
| Claude Desktop | 1.x | ✅ Tested | Full compatibility |
| Cursor | 0.x | ✅ Tested | Full compatibility |
| Antigravity | 0.x | ⚠️ Untested | Expected compatible |
| VS Code MCP | 0.x | ⚠️ Untested | Expected compatible |

### Node.js Compatibility

| Version | Status | Notes |
|---------|--------|-------|
| 18.x | ✅ | Minimum supported |
| 20.x | ✅ | Recommended |
| 22.x | ✅ | Tested |

---

## Testing Strategy

### ⚠️ CRITICAL: Test-Driven Implementation Requirement

**Every implementing agent MUST run tests after each code change.**

This is non-negotiable for the enterprise code review system. The current project has **213 existing tests** that must continue to pass, plus new tests for enterprise features.

### Test Execution Requirements by Phase

#### Phase 1: Foundation (Weeks 1-2)
| Task | Required Tests | Pass Criteria |
|------|---------------|---------------|
| Diff parser | `tests/reviewer/diff/parse.test.ts` | 100% coverage on parse functions |
| Change classifier | `tests/reviewer/diff/classify.test.ts` | All classification scenarios pass |
| Risk scoring | `tests/reviewer/diff/risk.test.ts` | Risk scores match expected values |
| `review_diff` tool | `tests/tools/reviewDiff.test.ts` | MCP protocol compliance |

**Phase 1 Gate**: `npm test` must show 213+ tests passing (all existing + new)

#### Phase 2: Enterprise Trust (Weeks 3-4)
| Task | Required Tests | Pass Criteria |
|------|---------------|---------------|
| Invariants loader | `tests/reviewer/checks/invariants.test.ts` | YAML parsing, validation |
| Invariants runner | `tests/reviewer/checks/runner.test.ts` | All invariant types execute |
| ESLint adapter | `tests/reviewer/adapters/eslint.test.ts` | Correct SARIF output parsing |
| Semgrep adapter | `tests/reviewer/adapters/semgrep.test.ts` | Correct finding extraction |

**Phase 2 Gate**: `npm run test:reviewer` must pass + backward compat tests

#### Phase 3: LLM Integration (Weeks 5-6)
| Task | Required Tests | Pass Criteria |
|------|---------------|---------------|
| Context planner | `tests/reviewer/context/planner.test.ts` | Token budget respected |
| Structural pass | `tests/reviewer/llm/structural.test.ts` | Mocked LLM responses |
| Detailed pass | `tests/reviewer/llm/detailed.test.ts` | Finding merge logic |

**Phase 3 Gate**: `npm run test:llm` with mocked providers + `npm test` all green

#### Phase 4: CI/GitHub (Weeks 7-8)
| Task | Required Tests | Pass Criteria |
|------|---------------|---------------|
| GitHub Action | `tests/integration/github-action.test.ts` | Action YAML valid |
| PR formatter | `tests/reviewer/output/github.test.ts` | Markdown output correct |
| Client compat | `tests/integration/client-compat.test.ts` | All 5 clients work |

**Phase 4 Gate**: Full test suite + manual client testing matrix

### Test Directory Structure (New + Existing)

```
tests/
├── setup.ts                         # Existing Jest setup
├── serviceClient.test.ts            # Existing
├── tools/                           # Existing tool tests
│   ├── codebaseRetrieval.test.ts
│   ├── reactiveReview.test.ts
│   ├── reviewDiff.test.ts           # NEW: Phase 1
│   └── ...
├── services/                        # Existing service tests
│   ├── codeReviewService.test.ts
│   ├── reactiveReviewService.test.ts
│   └── ...
├── reviewer/                        # NEW: Enterprise review tests
│   ├── diff/
│   │   ├── parse.test.ts
│   │   ├── classify.test.ts
│   │   └── risk.test.ts
│   ├── checks/
│   │   ├── invariants.test.ts
│   │   ├── runner.test.ts
│   │   └── adapters/
│   │       ├── eslint.test.ts
│   │       └── semgrep.test.ts
│   ├── context/
│   │   └── planner.test.ts
│   ├── llm/
│   │   ├── structural.test.ts
│   │   ├── detailed.test.ts
│   │   └── twoPass.test.ts
│   ├── output/
│   │   ├── github.test.ts
│   │   └── sarif.test.ts
│   └── post/
│       ├── calibrate.test.ts
│       └── dedupe.test.ts
├── integration/
│   ├── timeoutResilience.test.ts    # Existing
│   ├── zombieSessionRecovery.test.ts # Existing
│   ├── reviewDiffFull.test.ts       # NEW: Full review flow
│   ├── github-action.test.ts        # NEW: CI integration
│   ├── client-compat.test.ts        # NEW: Multi-client
│   └── mcp-protocol.test.ts         # NEW: Protocol compliance
├── fixtures/                        # NEW: Test data
│   ├── diffs/
│   │   ├── simple_change.diff
│   │   ├── large_refactor.diff
│   │   ├── security_issue.diff
│   │   └── api_breaking.diff
│   ├── invariants/
│   │   └── sample_invariants.yml
│   └── expected/
│       └── review_results/
└── e2e/                             # NEW: End-to-end
    ├── real_pr_review.test.ts
    └── large_diff.test.ts
```

### NPM Scripts Configuration

Already added to `package.json`:

```json
{
  "scripts": {
    "test": "node --experimental-vm-modules node_modules/jest/bin/jest.js",
    "test:watch": "node --experimental-vm-modules node_modules/jest/bin/jest.js --watch",
    "test:coverage": "node --experimental-vm-modules node_modules/jest/bin/jest.js --coverage",
    "test:reviewer": "node --experimental-vm-modules node_modules/jest/bin/jest.js --testPathPatterns=tests/reviewer",
    "test:llm": "node --experimental-vm-modules node_modules/jest/bin/jest.js --testPathPatterns=tests/reviewer/llm",
    "test:integration": "node --experimental-vm-modules node_modules/jest/bin/jest.js --testPathPatterns=tests/integration",
    "test:compat": "node --experimental-vm-modules node_modules/jest/bin/jest.js --testPathPatterns=client-compat",
    "test:existing": "node --experimental-vm-modules node_modules/jest/bin/jest.js --testPathIgnorePatterns=tests/reviewer",
    "test:ci": "node --experimental-vm-modules node_modules/jest/bin/jest.js --ci --coverage --maxWorkers=2",
    "test:quick": "node --experimental-vm-modules node_modules/jest/bin/jest.js --onlyChanged",
    "precommit": "npm run build && npm run test:quick",
    "validate": "npm run build && npm test && npm run verify"
  }
}
```

**Current Test Status**: 394 tests (382 passing + 12 todo for future implementation)

### Backward Compatibility Test Suite

```typescript
// tests/integration/client-compat.test.ts
describe('MCP Client Compatibility', () => {
  const EXISTING_TOOLS = [
    'index_workspace', 'codebase_retrieval', 'semantic_search',
    'get_file', 'get_context_for_prompt', 'enhance_prompt',
    // ... all 38 tools
  ];

  test('all existing tools still registered', async () => {
    const manifest = await server.getToolManifest();
    for (const tool of EXISTING_TOOLS) {
      expect(manifest.tools.find(t => t.name === tool)).toBeDefined();
    }
  });

  test('existing tool schemas unchanged', async () => {
    // Compare against baseline schemas
    const baseline = await loadBaseline('tool-schemas.json');
    const current = await server.getToolManifest();

    for (const tool of EXISTING_TOOLS) {
      const baselineTool = baseline.tools.find(t => t.name === tool);
      const currentTool = current.tools.find(t => t.name === tool);
      expect(currentTool.inputSchema).toEqual(baselineTool.inputSchema);
    }
  });

  test('new tools are additive only', async () => {
    const manifest = await server.getToolManifest();
    const newTools = manifest.tools.filter(t => !EXISTING_TOOLS.includes(t.name));

    // New tools should not conflict with existing
    for (const tool of newTools) {
      expect(EXISTING_TOOLS).not.toContain(tool.name);
    }
  });
});
```

### CI/CD Configuration

Create `.github/workflows/test.yml`:

```yaml
name: Test Suite

on:
  push:
    branches: [main, develop, 'feature/**']
  pull_request:
    branches: [main, develop]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18.x, 20.x, 22.x]

    steps:
      - uses: actions/checkout@v4

      - name: Use Node.js ${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build

      - name: Run existing tests (baseline)
        run: npm run test:existing

      - name: Run enterprise reviewer tests
        run: npm run test:reviewer
        continue-on-error: false

      - name: Run integration tests
        run: npm run test:integration

      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/lcov.info

  compatibility:
    runs-on: ubuntu-latest
    needs: test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20.x'
          cache: 'npm'

      - run: npm ci
      - run: npm run build

      - name: Test MCP Protocol Compliance
        run: npm run test:compat

      - name: Verify 38 existing tools unchanged
        run: npm run test -- --testPathPattern=client-compat

  quality-gates:
    runs-on: ubuntu-latest
    needs: [test, compatibility]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20.x'
          cache: 'npm'

      - run: npm ci
      - run: npm run build

      - name: Coverage threshold check
        run: npm run test:coverage -- --coverageThreshold='{"global":{"branches":75,"functions":80,"lines":80}}'

      - name: Verify no breaking changes
        run: |
          npm run test:compat
          echo "✅ All compatibility tests passed"
```

---

## Agent Implementation Instructions

### 🤖 MANDATORY: Instructions for Implementing Agents

When delegating implementation to AI agents (Codex, Claude, Cursor, Copilot, etc.), include these explicit instructions:

#### Standard Prompt Prefix (Copy This)

```markdown
## IMPLEMENTATION RULES - READ FIRST

You are implementing features for the Context Engine MCP Server.
The project has 213 existing tests that MUST continue to pass.

### Test Execution Requirements

1. **After EVERY code change**, run: `npm test`
2. **Before marking any task complete**, verify: `npm run validate`
3. **If tests fail**, fix immediately before proceeding
4. **Never commit code with failing tests**

### Test Commands Reference
- `npm test` - Run all tests (REQUIRED after every change)
- `npm run test:quick` - Fast check of changed files only
- `npm run test:reviewer` - Enterprise reviewer tests only
- `npm run validate` - Full build + test + verify

### Iteration Pattern (FOLLOW THIS)

For each implementation task:
1. Write/modify code
2. Run `npm run build` - fix any TypeScript errors
3. Run `npm test` - fix any test failures
4. Only then move to next task

### Failure Recovery

If tests fail:
1. Read the error message carefully
2. Check if you broke existing functionality
3. Fix the issue in your code
4. Run tests again
5. Repeat until all tests pass

DO NOT skip tests. DO NOT proceed with failing tests.
```

#### Phase-Specific Instructions

**Phase 1 (Foundation) Prompt:**
```markdown
## Phase 1: Foundation Implementation

Implement diff parsing, classification, and risk scoring.

TESTING REQUIREMENTS:
- Create `tests/reviewer/diff/parse.test.ts` BEFORE implementing `src/reviewer/diff/parse.ts`
- Each function must have corresponding tests
- Run `npm test` after each file change
- Target: 213 existing tests + ~20 new tests passing

DO NOT proceed to next task until `npm test` shows all green.
```

**Phase 2 (Enterprise Trust) Prompt:**
```markdown
## Phase 2: Enterprise Trust Implementation

Implement invariants system and static analyzer adapters.

TESTING REQUIREMENTS:
- Write invariant loader tests first (TDD approach)
- Mock ESLint/Semgrep in adapter tests
- Run `npm run test:reviewer` after each change
- Run `npm test` before completing any task
- Target: 233 existing tests + ~30 new tests passing

Verify backward compatibility: `npm run test:compat`
```

**Phase 3 (LLM Integration) Prompt:**
```markdown
## Phase 3: LLM Integration Implementation

Implement two-pass LLM review with context planning.

TESTING REQUIREMENTS:
- ALL LLM calls must be mocked in tests
- Use fixtures in `tests/fixtures/` for test data
- Run `npm run test:llm` for quick iteration
- Run full `npm test` before marking complete
- Target: 263 tests + ~25 new tests passing

Mock example:
```typescript
jest.mock('../llm/client', () => ({
  callLLM: jest.fn().mockResolvedValue({ findings: [] })
}));
```
```

**Phase 4 (CI/GitHub) Prompt:**
```markdown
## Phase 4: CI/GitHub Integration Implementation

Implement GitHub Action and PR formatting.

TESTING REQUIREMENTS:
- Test GitHub Action YAML is valid
- Test PR comment markdown rendering
- Run client compatibility tests: `npm run test:compat`
- Run FULL test suite: `npm test`
- Target: 288 tests + ~25 new tests passing

Before completing Phase 4:
1. `npm run validate` must pass
2. All 38 existing tools must work
3. Manual test with MCP Inspector: `npm run inspector`
```

### Test Failure Handling Protocol

```typescript
// Agent should follow this decision tree

if (testsFailAfterChange) {
  if (failingTestsAreNew) {
    // Fix implementation to match test expectations
    fixImplementation();
  } else if (failingTestsAreExisting) {
    // CRITICAL: You broke backward compatibility
    revertChange();
    analyzeWhatBroke();
    reimplementWithCompatibility();
  }

  runTestsAgain();

  if (stillFailing) {
    // Do NOT proceed - ask for help
    requestHumanReview();
  }
}
```

### Verification Checkpoints

| Checkpoint | Command | Expected Result |
|------------|---------|-----------------|
| After each file | `npm run build` | No TypeScript errors |
| After each feature | `npm test` | All tests green |
| End of each day | `npm run validate` | Build + Test + Verify pass |
| Before PR | `npm run test:ci` | CI simulation passes |
| Before merge | `npm run test:compat` | All clients compatible |

---

## Rollback Plan

### Feature Flags
All new features are gated behind feature flags:

```typescript
// src/config/features.ts
export const FEATURE_FLAGS = {
  ENTERPRISE_REVIEW: process.env.CE_ENTERPRISE_REVIEW === 'true',
  TWO_PASS_LLM: process.env.CE_TWO_PASS_LLM === 'true',
  INVARIANTS: process.env.CE_INVARIANTS === 'true',
  STATIC_ANALYSIS: process.env.CE_STATIC_ANALYSIS === 'true',
};
```

### Rollback Procedures

| Scenario | Action | Recovery Time |
|----------|--------|---------------|
| New tool breaks client | Disable tool registration | < 1 min |
| LLM integration fails | Disable TWO_PASS_LLM flag | < 1 min |
| Performance regression | Revert to previous version | < 5 min |
| Breaking schema change | Deploy schema migration | < 30 min |

### Version Compatibility

```typescript
// src/reviewer/compat.ts
export function ensureBackwardCompatibility(
  result: EnterpriseReviewResult
): LegacyReviewResult {
  return {
    // Map new fields to old schema
    findings: result.findings.map(f => ({
      type: f.category,
      severity: f.severity.toLowerCase(),
      message: f.title,
      file: f.location.file,
      line: f.location.startLine,
    })),
    summary: result.summary,
  };
}
```

---

## Appendix: Technical Specifications

### A.1 Directory Structure (New Files)

```
src/
├── reviewer/                    # NEW: Enterprise review system
│   ├── index.ts                 # Public API
│   ├── types.ts                 # Type definitions
│   ├── diff/
│   │   ├── parse.ts             # Diff parsing
│   │   ├── classify.ts          # Change classification
│   │   └── risk.ts              # Risk scoring
│   ├── checks/
│   │   ├── preflight.ts         # Deterministic preflight
│   │   ├── invariants/
│   │   │   ├── load.ts          # Config loader
│   │   │   ├── runner.ts        # Invariant execution
│   │   │   └── types.ts         # Invariant types
│   │   └── adapters/
│   │       ├── eslint.ts        # ESLint adapter
│   │       ├── semgrep.ts       # Semgrep adapter
│   │       └── types.ts         # Adapter interface
│   ├── context/
│   │   ├── planner.ts           # Context planning
│   │   └── fetcher.ts           # Context fetching
│   ├── llm/
│   │   ├── twoPass.ts           # Two-pass review
│   │   ├── structural.ts        # Structural analysis
│   │   └── detailed.ts          # Detailed analysis
│   ├── prompts/
│   │   ├── structural.ts        # Structural prompt
│   │   ├── detailed.ts          # Detailed prompt
│   │   └── templates.ts         # Shared templates
│   ├── post/
│   │   ├── calibrate.ts         # Noise gating
│   │   ├── dedupe.ts            # Deduplication
│   │   └── format.ts            # Output formatting
│   └── output/
│       ├── github.ts            # GitHub PR comments
│       ├── sarif.ts             # SARIF format
│       └── json.ts              # JSON output
├── mcp/
│   └── tools/
│       └── reviewDiff.ts        # NEW: review_diff tool
```

### A.2 Dependencies to Add

```json
{
  "dependencies": {
    "diff-parse": "^2.0.0",      // Diff parsing
    "yaml": "^2.3.0",            // Invariants config (already have)
    "ajv": "^8.12.0"             // JSON Schema validation (already have)
  },
  "optionalDependencies": {
    "tree-sitter": "^0.21.0",    // AST parsing
    "tree-sitter-typescript": "^0.21.0"
  }
}
```

### A.3 Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CE_ENTERPRISE_REVIEW` | Enable enterprise review | `false` |
| `CE_TWO_PASS_LLM` | Enable two-pass LLM review | `true` |
| `CE_INVARIANTS` | Enable invariants checking | `true` |
| `CE_STATIC_ANALYSIS` | Enable static analysis | `true` |
| `CE_CONFIDENCE_THRESHOLD` | Minimum finding confidence | `0.55` |
| `CE_MAX_FINDINGS` | Maximum findings per review | `20` |
| `CE_RISK_THRESHOLD` | Risk score for detailed pass | `3` |

### A.4 API Endpoints (HTTP Server)

```typescript
// src/http/routes/review.ts
router.post('/api/v1/review', async (req, res) => {
  const { diff, options } = req.body;
  const result = await reviewDiff(diff, options);
  res.json(result);
});

router.get('/api/v1/review/:runId', async (req, res) => {
  const result = await getReviewResult(req.params.runId);
  res.json(result);
});
```

### A.5 Metrics and Telemetry

```typescript
// src/reviewer/telemetry.ts
interface ReviewMetrics {
  run_id: string;
  duration_ms: number;
  files_analyzed: number;
  lines_changed: number;
  findings_count: number;
  tokens_used: {
    input: number;
    output: number;
  };
  passes_executed: number;
  cache_hits: number;
  static_analysis_duration_ms: number;
}
```

---

## Summary

This blueprint provides a comprehensive, low-risk path to implementing enterprise-grade code review capabilities while:

1. **Preserving all 38 existing MCP tools** - No breaking changes
2. **Maintaining client compatibility** - Codex, Claude, Cursor all continue working
3. **Following established patterns** - Uses existing 5-layer architecture
4. **Enabling gradual rollout** - Feature flags for all new capabilities
5. **Integrating open-source tools** - ESLint, Semgrep, tree-sitter
6. **Supporting CI/CD** - GitHub Action, SARIF output, structured JSON

The implementation is designed to be completed in 8 weeks with clear milestones and rollback procedures at each phase.
```
```


