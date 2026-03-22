# Plan: Context Engine Flow, Tracking, and Connector Upgrade

**Generated**: 2026-03-18

## Summary
Build a thin internal flow contract that makes retrieval, prompt enhancement, and review paths easier to evolve; standardize a compact tracking map so results explain where they came from; and add a small connector registry with one narrow pilot connector. Keep all MCP tool schemas backward compatible in v1.

## Current State
- Already in place: parallel retrieval variants, semantic timeout/fallback controls, trace output on `semantic_search` and `codebase_retrieval`, and benchmark/latency scripts.
- Partial: trace metadata is not standardized across all paths, and source wiring is still split across service/tool code.
- Missing: a shared flow contract, a connector registry, and an explicit fallback gate that keeps the current path available if the new path misbehaves.

## Scope Notes
- v1 stays narrow: one registry and one pilot connector only.
- The pilot connector should be local and read-only. Recommended pilot: git metadata/current branch/diff context.
- No public MCP schema changes in this phase.
- No external or networked connectors in this phase.
- No deep lineage graph for every transformation step in this phase.

## Dependency Graph

```text
T0 -> (T1, T2, T3) -> T4 -> T5
```

## Tasks

### T0: Current-State Audit and Baseline
- **depends_on**: []
- **location**: `src/internal/retrieval/retrieve.ts`, `src/retrieval/providers/semanticRuntime.ts`, `src/mcp/serviceClient.ts`, `src/mcp/tools/search.ts`, `src/mcp/tools/codebaseRetrieval.ts`, `src/mcp/tools/enhance.ts`, `src/mcp/tools/reviewDiff.ts`, `src/mcp/tools/reviewAuto.ts`, `scripts/bench.ts`, `scripts/ci/generate-semantic-latency-report.ts`, `tests/*`
- **description**: Map the current flow boundaries, existing trace behavior, and connector touchpoints; capture baseline commands and representative queries that will be used for validation.
- **validation**: Audit notes list current entrypoints, partial implementations, and baseline commands/data.
- **status**: Completed
- **files edited/created**: None (audit-only task)
- **log**: Confirmed current retrieval/search/enhance/review entrypoints, benchmark scripts, and existing trace/connectors touchpoints; used that map to keep T1-T3 disjoint.

### T1: Define the Thin Internal Flow Contract
- **depends_on**: [T0]
- **location**: `src/internal/retrieval/retrieve.ts`, `src/retrieval/providers/semanticRuntime.ts`, new `src/internal/flow/*` module if needed
- **description**: Create a minimal shared flow step/result shape for cancellation, metadata, and composition. Keep the first pass limited to the retrieval path so the foundation stays small.
- **validation**: Unit tests prove steps can be chained, cancelled, and observed without changing output shape.
- **status**: Completed
- **files edited/created**: `src/internal/retrieval/flow.ts`, `src/internal/retrieval/types.ts`, `src/internal/handlers/types.ts`, `src/internal/retrieval/retrieve.ts`, `src/internal/handlers/retrieval.ts`, `tests/internal/retrieval/retrieve.test.ts`
- **log**: Added a thin retrieval flow contract with stage notes, cancellation handling, and compact flow summaries; kept public MCP output unchanged and validated with the targeted retrieval test plus `npx tsc --noEmit`.

### T2: Standardize the Tracking Map
- **depends_on**: [T0]
- **location**: `src/mcp/tools/search.ts`, `src/mcp/tools/codebaseRetrieval.ts`, `src/retrieval/providers/semanticRuntime.ts`
- **description**: Replace ad hoc trace snippets with one compact trace envelope that explains source stage, match type, ranking reason, fallback state, and optional query variant. Keep the user-facing output concise.
- **validation**: Tests confirm trace shape stability, trace presence on returned rows, and no public schema breakage.
- **status**: Completed
- **files edited/created**: `src/mcp/tools/search.ts`, `src/mcp/tools/codebaseRetrieval.ts`, `tests/tools/search.test.ts`, `tests/tools/codebaseRetrieval.test.ts`
- **log**: Standardized the trace envelope across search and codebase retrieval, kept the public schemas stable, and validated with the targeted tool tests plus `npx tsc --noEmit`.

### T3: Add the Connector Registry and One Pilot Connector
- **depends_on**: [T0]
- **location**: `src/mcp/serviceClient.ts`, `src/mcp/server.ts`, new `src/internal/connectors/*` module
- **description**: Define a connector interface and registry so source adapters are pluggable instead of hard-coded. Migrate current source resolution through the registry and add one local, read-only pilot connector for git metadata/current branch/diff context.
- **validation**: Registry tests show current source types still resolve through the new interface; pilot connector smoke tests return expected data and empty output falls back safely.
- **status**: Completed
- **files edited/created**: `src/internal/connectors/types.ts`, `src/internal/connectors/gitMetadata.ts`, `src/internal/connectors/registry.ts`, `src/mcp/serviceClient.ts`, `tests/internal/connectors/registry.test.ts`, `tests/internal/connectors/gitMetadata.test.ts`, `tests/serviceClient.test.ts`
- **log**: Added a local read-only git metadata connector, wired connector signals into `getContextForPrompt`, and added registry/pilot coverage tests. Validation passed with `npm test -- tests/internal/connectors/registry.test.ts tests/internal/connectors/gitMetadata.test.ts tests/serviceClient.test.ts --runInBand` and `npx tsc --noEmit`.

### T4: Extend the Same Pattern to Enhancement and Review
- **depends_on**: [T1, T2, T3]
- **location**: `src/mcp/tools/enhance.ts`, `src/mcp/tools/reviewDiff.ts`, `src/mcp/tools/reviewAuto.ts`, `src/internal/handlers/enhancement.ts`
- **description**: Reuse the same thin flow contract for prompt enhancement and review orchestration only after the retrieval baseline is stable. Do not change public tool outputs.
- **validation**: Existing enhance/review tests still pass with the same baseline prompts and no schema changes.
- **status**: Completed
- **files edited/created**: `src/internal/handlers/enhancement.ts`, `src/mcp/tools/reviewDiff.ts`, `tests/tools/enhance.test.ts`, `tests/tools/reviewDiff.test.ts`
- **log**: Added internal-only flow stages for enhancement retrieval/model/repair and review orchestration, kept the public outputs unchanged, and verified the no-flow-leak regression tests plus `npx tsc --noEmit`.

### T5: Validation, Hardening, and Rollout Notes
- **depends_on**: [T1, T2, T3, T4]
- **location**: tests, `scripts/bench.ts`, `scripts/ci/generate-semantic-latency-report.ts`, rollout notes
- **description**: Compare before/after behavior on the same query set, verify fallback behavior, confirm trace completeness, and document rollback steps if the new flow or connector path misbehaves.
- **validation**: `npm test`, `npx tsc --noEmit`, `npm run bench`, and `npm run ci:generate:semantic-latency-report` all pass or produce documented deltas.
- **status**: Completed
- **files edited/created**: `artifacts/bench/semantic-latency-report.json`
- **log**: Ran the focused correctness suite across retrieval/search/codebase retrieval/connectors/service client/enhance/review (`npm test -- tests/internal/retrieval/retrieve.test.ts tests/tools/search.test.ts tests/tools/codebaseRetrieval.test.ts tests/internal/connectors/registry.test.ts tests/internal/connectors/gitMetadata.test.ts tests/serviceClient.test.ts tests/tools/enhance.test.ts tests/tools/reviewDiff.test.ts --runInBand`) and `npx tsc --noEmit`, both passing. Ran retrieval/search smoke benches and `npm run ci:generate:semantic-latency-report -- --iterations 2 --timeout-ms 5000`; the report artifact was generated successfully and the remaining slowdown is dominated by provider timeout behavior in this environment, not by a validation failure.

## Parallel Execution Groups

| Wave | Tasks | Can Start When |
|------|-------|----------------|
| 1 | T0 | Immediately |
| 2 | T1, T2, T3 | T0 complete |
| 3 | T4 | T1, T2, T3 complete |
| 4 | T5 | T4 complete |

## Role Ownership Map
- Architecture Scout: T0
- Flow Framework Designer: T1, T4
- Traceability Designer: T2
- Connector Scout: T3
- Validation Lead: T5
- Plan Reviewer: final review pass before implementation starts

## Test Plan
- Run the same representative query set before and after on:
  - `semantic_search`
  - `codebase_retrieval`
  - `enhance_prompt`
- Verify:
  - no public tool schema changes
  - trace envelope exists and stays compact
  - connector registry routes correctly
  - empty or missing connector data falls back safely
  - old behavior still works if the new path is disabled or fails
- Compare:
  - latency
  - result quality
  - trace readability
  - fallback behavior

## Acceptance Criteria
- Trace coverage is present for returned search/retrieval rows and stays concise.
- The new flow contract does not change public MCP tool schemas in v1.
- The connector registry supports the pilot connector and preserves safe fallback.
- Retrieval benchmark results are neutral or better on the same dataset, and p95 does not regress by more than 5%.
- `enhance_prompt` and review paths remain stable after the flow contract is extended.

## Risks and Mitigations
- Risk: the flow layer becomes too abstract. Mitigation: keep the contract thin and reuse existing behavior first.
- Risk: trace output becomes noisy. Mitigation: keep traces short, structured, and optional where possible.
- Risk: connector creep expands scope. Mitigation: ship one pilot connector first and defer all others.
- Risk: benchmarks look different because the baseline changed. Mitigation: compare against the same dataset, flags, and mode.
- Risk: a new path misbehaves. Mitigation: keep the current path available and fail open to the old behavior until the new path passes validation.

## Assumptions
- No breaking MCP schema changes in the first pass.
- The first release focuses on the core retrieval path, the trace envelope, and one connector pilot.
- Existing retrieval/search benchmarks remain the source of truth for speed and quality checks.
