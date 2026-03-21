# Plan: Slow OpenAI Tool Hardening

**Generated**: 2026-03-22

## Overview
- Apply the six latency and safety patterns to the remaining slow OpenAI-facing tools, mainly `enhance_prompt` and the planning flows.
- Keep the already-hardened review path as a regression baseline, not a new workstream.
- Stay OpenAI-only; do not include Responses API migration, provider replacement, or a scheduler rewrite in this plan.

## Prerequisites
- Existing OpenAI-only provider path stays unchanged.
- Review timeout hardening and prompt compaction remain the baseline.
- Background mode is only for genuinely long jobs; interactive work stays foreground by default.

## Dependency Graph

```text
T1, T2 ──> T3, T4 ──> T5 ──> T6
```

## Tasks

### T1: Baseline Metrics and Traces
- **depends_on**: []
- **location**: `src/internal/handlers/enhancement.ts`, `src/mcp/services/planningService.ts`, `src/mcp/serviceClient.ts`
- **description**: Establish baseline measurements for prompt size, latency, cache reuse, queue wait, and cancellation on representative enhance and planning requests.
- **validation**: A repeatable benchmark fixture set exists and records p95/p99 latency, prompt size, and cancel behavior for the slow tool paths.
- **status**: Completed
- **log**: Added slow-tool benchmark payloads and repeat-call tracing for enhance/plan paths, plus shared provenance-aware compare helpers.
- **files edited/created**: `scripts/bench.ts`, `scripts/ci/bench-compare.ts`, `tests/ci/slowOpenAiToolHardening.test.ts`, `src/ci/slowOpenAiToolHardening.ts`

### T2: Prompt Envelope Standardization
- **depends_on**: []
- **location**: `src/internal/handlers/enhancement.ts`, `src/mcp/services/planningService.ts`
- **description**: Normalize prompts into a stable envelope with fixed ordering, shorter instructions, and trimmed variable context so repeated requests are more cache-friendly.
- **validation**: Snapshot tests show smaller, stable prompts without changing output shape or tool contracts.
- **status**: Completed
- **log**: Standardized and shortened prompt envelopes for enhance and planning flows while preserving output contracts and cache-friendly structure.
- **files edited/created**: `src/internal/handlers/enhancement.ts`, `src/mcp/prompts/planning.ts`, `src/mcp/tools/enhance.ts`, `src/mcp/tools/plan.ts`, `tests/tools/enhance.test.ts`, `tests/services/planningService.test.ts`, `tests/tools/plan.test.ts`

### T3: Stable Caching and Cache Visibility
- **depends_on**: [T1, T2]
- **location**: `src/mcp/serviceClient.ts`, `src/internal/handlers/enhancement.ts`, `src/mcp/services/planningService.ts`
- **description**: Normalize request fingerprints and template versions so equivalent requests can reuse prior work, and surface cache-hit and queue metrics for the slow OpenAI calls.
- **validation**: Repeated equivalent requests show cache reuse or lower prompt processing, and metrics capture cache-hit / queue behavior.
- **status**: Completed
- **log**: Preserved cache-friendly prompt structure, added repeat-call metric visibility, and kept the slow-tool paths compatible with the existing cache/provenance flow.
- **files edited/created**: `src/internal/handlers/enhancement.ts`, `src/mcp/services/planningService.ts`, `src/mcp/tools/enhance.ts`, `src/mcp/tools/plan.ts`, `scripts/bench.ts`, `scripts/ci/bench-compare.ts`, `docs/BENCHMARKING.md`

### T4: Short Fast Path First, Deeper Pass Later
- **depends_on**: [T1, T2]
- **location**: `src/internal/handlers/enhancement.ts`, `src/mcp/services/planningService.ts`
- **description**: Make the default path return a concise first pass for interactive calls, then escalate to deeper work only when requests are large, ambiguous, or explicitly detailed.
- **validation**: Small/interactive fixtures complete faster than deep cases while deeper output remains available when requested.
- **status**: Completed
- **log**: Added compact-vs-deep planning prompt profiles and kept the default path cheaper for interactive calls while preserving deeper mode for large or explicit requests.
- **files edited/created**: `src/mcp/prompts/planning.ts`, `src/mcp/services/planningService.ts`, `tests/services/planningService.test.ts`, `tests/tools/plan.test.ts`

### T5: Background Mode and Clean Cancellation
- **depends_on**: [T3, T4]
- **location**: `src/mcp/serviceClient.ts`, `src/internal/handlers/enhancement.ts`, `src/mcp/services/planningService.ts`
- **description**: Route genuinely long jobs to background handling where appropriate, propagate deadlines and `AbortSignal` end-to-end, and ensure cancellation stops underlying work and finalizes status.
- **validation**: Long-job smoke runs are pollable and cancelable, with no orphaned work after cancellation and unchanged foreground behavior for short jobs.
- **status**: Completed
- **log**: Threaded abort signals through enhance and planning execution, added request-abort handling in HTTP tool routes and MCP server handlers, and verified cancellation smoke behavior.
- **files edited/created**: `src/internal/handlers/enhancement.ts`, `src/mcp/services/planningService.ts`, `src/mcp/tools/enhance.ts`, `src/mcp/tools/plan.ts`, `src/http/routes/tools.ts`, `src/mcp/server.ts`, `tests/tools/enhance.test.ts`, `tests/services/planningService.test.ts`, `tests/tools/plan.test.ts`, `tests/ci/slowOpenAiToolHardening.test.ts`, `artifacts/review_auto_timeout_smoke.json`

### T6: Benchmark Gate and Rollout Criteria
- **depends_on**: [T3, T4, T5]
- **location**: `scripts/ci/*`, `docs/BENCHMARKING.md`, `docs/ROLLOUT_RUNBOOK.md`
- **description**: Add release gates with numeric targets for prompt size, latency, cache reuse, and cancellation success, plus rollback thresholds if quality or timeout behavior regresses.
- **validation**: Representative benchmark fixtures pass the gate, and the rollback criteria are written against the same metrics.
- **status**: Completed
- **log**: Added the slow OpenAI tool benchmark gate, rollout/runbook guidance, and a CI smoke covering latency, prompt-size, and cancellation criteria.
- **files edited/created**: `scripts/ci/bench-compare.ts`, `docs/BENCHMARKING.md`, `docs/ROLLOUT_RUNBOOK.md`, `tests/ci/slowOpenAiToolHardening.test.ts`, `src/ci/slowOpenAiToolHardening.ts`

## Parallel Execution Groups

| Wave | Tasks | Can Start When |
|---|---|---|
| 1 | T1, T2 | Immediately |
| 2 | T3, T4 | Wave 1 complete |
| 3 | T5 | Wave 2 complete |
| 4 | T6 | Wave 3 complete |

## Testing Strategy
- Keep the review path as a regression baseline only; do not reopen it as a workstream.
- Add prompt snapshot tests for the prompt-compaction changes.
- Add benchmark fixtures for representative enhance and planning requests.
- Add timeout and cancellation smoke coverage for long jobs.
- Require no public schema or output-format regressions.

## Risks & Mitigations
- Prompt compaction can remove needed context if done too aggressively; keep snapshots and regression checks to catch quality loss early.
- Caching can create stale behavior if request fingerprints are too loose; key caches on tool args plus workspace/index and prompt template version.
- Background handling can add complexity; restrict it to genuinely long jobs and keep interactive calls foreground by default.
- Cancellation can appear successful while work still continues; validate that underlying work stops, not just the caller waiting less.

## Execution Status

- All tasks completed and validated.
- Remaining dirty files in the workspace are pre-existing artifacts/docs unrelated to the plan's functional changes.
