# Plan: OpenAI MCP Gap Closure

**Generated**: 2026-04-23

## Overview
This plan converts the high-level `openai_mcp_enhancement_plan.md` roadmap into an execution-ready, dependency-aware implementation plan based on the repo's current state. It focuses only on the meaningful remaining gaps: formalizing the OpenAI runtime subsystem, building a persistent code graph, making retrieval graph-aware, completing the diff-native review architecture, modularizing oversized orchestration modules, standardizing tool ergonomics/explainability, and adding observability/evaluation.

The plan intentionally does not repeat work that is already substantially complete in the repo, such as HTTP background indexing, real git diff sourcing in reactive review, SQLite lexical indexing, LanceDB vector retrieval, or tree-sitter chunking foundations.

## Scope Lock
- In scope: execution-ready work needed to close the remaining `missing` and `partial` areas from `openai_mcp_enhancement_plan.md`.
- In scope: additive and staged refactors that preserve current MCP/HTTP tool behavior unless a task explicitly freezes a contract update first.
- In scope: OpenAI-only runtime evolution; no multi-provider expansion.
- Out of scope: local model backends, provider registry growth, large UI/client changes, and broad docs rewrites outside touched features.
- Out of scope: replacing the current retrieval stack wholesale; this plan extends the current SQLite/tree-sitter/LanceDB path.
- File surfaces likely to change:
  - `src/mcp/serviceClient.ts`
  - `src/mcp/server.ts`
  - `src/mcp/openaiTaskRuntime.ts`
  - `src/mcp/tools/*.ts`
  - `src/mcp/tooling/*.ts`
  - `src/internal/handlers/*.ts`
  - `src/internal/retrieval/*.ts`
  - `src/reviewer/**/*.ts`
  - `src/http/**/*.ts`
  - `src/metrics/**/*.ts` or new `src/observability/**/*.ts`
  - `tests/**/*.ts`
  - `docs/**/*.md`
  - `package.json`

## Prerequisites
- Current workspace index is healthy and refreshed before execution waves start.
- OpenAI runtime remains the only model-backed reasoning surface.
- Existing retrieval fixtures and review snapshots stay available for regression checks.
- External dependency constraints to honor during implementation:
  - OpenTelemetry JS should use `NodeSDK` startup-first initialization and explicit shutdown handling.
  - Tree-sitter graph extraction should preserve incremental-parse compatibility and expose deterministic traversal output.
  - LanceDB integration should keep embedded TypeScript usage with explicit metadata fields and refresh-safe table handling.

## Dependency Graph

```text
T0 -> T1 -> T2 -> T4a -> T4b -> T11a -> T13
T0 -> T1 -> T3 -> T6 -> T12 -> T13
T0 -> T1 -> T5a -> T5b -> T7 -> T10a -> T13
T0 -> T1 -> T5a -> T5b -> T7 -> T8 -> T10b -> T12 -> T13
T2 -> T9 -> T12
T3 -> T9
T8 -> T11a
T7 -> T11b -> T13
T5b -> T11b
```

## Tasks

### T0: Program Contract, Ownership, and Gate Pack
- **depends_on**: []
- **location**: `openai-mcp-gap-closure-swarm-plan.md`, `package.json`, `scripts/ci/`, `tests/snapshots/`, `docs/`, `src/http/httpServer.ts`, `src/http/routes/tools.ts`, `src/mcp/server.ts`, `src/mcp/tools/manifest.ts`, `src/mcp/tooling/discoverability.ts`
- **description**: Freeze the execution contract before any implementation wave starts. Produce the ownership matrix, touched-file boundaries, compatibility surfaces, required artifacts, provenance rules, and wave-by-wave hard gates. Explicitly include stdio MCP, streamable HTTP MCP, and `/api/v1` REST parity boundaries.
- **validation**: A replayable baseline bundle exists with `baseline_snapshot_id`, commit SHA, dirty/staged-tree receipt, feature-flag snapshot, manifest/discoverability snapshot IDs, retrieval artifact hashes, and review artifact snapshot hashes; single-writer ownership rules are documented for `serviceClient.ts`, `search.ts`, `server.ts`, `discoverability.ts`, and review surfaces; named stop/go gates are defined for each wave.
- **status**: Completed
- **log**: Added a replayable baseline bundle in `artifacts/plan/openai-mcp-gap-closure-baseline.json` and `docs/plan-execution/openai-mcp-gap-closure-t0-baseline.md`, and froze execution ownership/gates in `docs/plan-execution/openai-mcp-gap-closure-ownership-gate-pack.md`. The bundle records commit SHA, dirty/untracked receipts, feature-flag snapshot, manifest snapshot hash, retrieval artifact hashes, review artifact hash, and compatibility-surface anchors.
- **files edited/created**: `artifacts/plan/openai-mcp-gap-closure-baseline.json`, `docs/plan-execution/openai-mcp-gap-closure-t0-baseline.md`, `docs/plan-execution/openai-mcp-gap-closure-ownership-gate-pack.md`

### T1: Freeze Current Contracts and Gap Baseline
- **depends_on**: [T0]
- **location**: `openai_mcp_enhancement_plan.md`, `src/mcp/tools/manifest.ts`, `src/mcp/tooling/discoverability.ts`, `tests/snapshots/phase2/baseline/tool_manifest_basic.baseline.txt`, `docs/`
- **description**: Record the exact current-state baseline for the plan areas that remain open. Produce a compact gap ledger that maps each roadmap item to `done`, `partial`, or `missing`, plus the runtime/tool contracts that must remain stable during execution. This is the execution anchor for all later waves.
- **validation**: Baseline ledger exists, references current file surfaces accurately, identifies non-negotiable compatibility constraints for MCP/HTTP outputs and test snapshots, and links back to the immutable receipts frozen in `T0`.
- **status**: Completed
- **log**: Added `docs/plan-execution/openai-mcp-gap-closure-gap-ledger.md` to freeze the current-state implementation ledger against the `T0` baseline bundle. The ledger records which roadmap phases are already mostly done, which are partial, which remain missing, and which compatibility constraints stay frozen until later re-baseline waves.
- **files edited/created**: `docs/plan-execution/openai-mcp-gap-closure-gap-ledger.md`

### T2: Formalize the OpenAI Runtime Surface
- **depends_on**: [T1]
- **location**: `src/mcp/openaiTaskRuntime.ts`, `src/internal/handlers/enhancement.ts`, `src/mcp/tools/reviewDiff.ts`, `src/mcp/services/planningService.ts`, `src/mcp/services/codeReviewService.ts`, `tests/mcp/openaiTaskRuntime.test.ts`, `tests/tools/enhance.test.ts`, `tests/tools/reviewDiff.test.ts`, `tests/services/planningService.test.ts`, `tests/services/codeReviewService.test.ts`
- **description**: Refactor the existing OpenAI task runtime seam into an explicit subsystem contract with stable request/response metadata, prompt version ownership, parse validation rules, retry policy ownership, and telemetry hooks. Freeze runtime outcome semantics explicitly: `execution_outcome`, `parse_outcome`, and `consumer_outcome`. Cover all public AI-backed surfaces or explicitly mark legacy ones as frozen. Do this without changing the single-provider policy.
- **validation**: Runtime API is documented in code; enhancement, review, planning, and any retained legacy AI-backed surfaces have explicit runtime contracts; tests prove parse-failure handling, retries, aborts, prompt versioning, malformed-output handling, validation-failure accounting, and metadata stability.
- **status**: Completed
- **log**: Added explicit runtime outcome semantics to `src/mcp/openaiTaskRuntime.ts` by freezing `execution_outcome`, `parse_outcome`, and `consumer_outcome` on success, validation-degraded success, and error paths. Migrated `src/mcp/services/codeReviewService.ts` and `src/mcp/services/planningService.ts` onto the shared runtime with validation-aware JSON parsing and retry handling, while enhancement and `reviewDiff` were already using the runtime seam. Expanded `tests/mcp/openaiTaskRuntime.test.ts` and `tests/services/planningService.test.ts` to prove retry behavior and the stabilized runtime metadata path across planning, review, and degraded validation scenarios.
- **files edited/created**: `src/mcp/openaiTaskRuntime.ts`, `src/mcp/services/codeReviewService.ts`, `src/mcp/services/planningService.ts`, `tests/mcp/openaiTaskRuntime.test.ts`, `tests/services/planningService.test.ts`

### T3: Freeze Observability Architecture for Runtime + Retrieval
- **depends_on**: [T1]
- **location**: `package.json`, `src/metrics/`, `src/telemetry/`, `src/http/`, `src/mcp/server.ts`, `docs/`, `tests/`
- **description**: Define the observability seam before implementation. Choose where OpenTelemetry initialization lives, which request/correlation identifiers are added, what metrics remain in the existing metrics layer versus new OTel spans, and what additive behavior is allowed on MCP/HTTP routes. Freeze telemetry cardinality ceilings, allowed label/attribute sets, Prometheus/OTel coexistence, transport propagation rules, and redaction boundaries before implementation starts.
- **validation**: Design note and implementation contract exist; package additions are explicit; no ambiguity remains about startup order, span ownership, correlation/request ID flow, cardinality ceilings, coexistence rules, or redaction rules.
- **status**: Completed
- **log**: Added `docs/plan-execution/openai-mcp-gap-closure-t3-observability-contract.md` to freeze the observability seam before implementation. The contract anchors current `AsyncLocalStorage` request context, `/metrics` Prometheus behavior, MCP/HTTP ingress ownership, OpenTelemetry bootstrap/shutdown location, correlation-id flow, cardinality ceilings, allowed metric labels and span attributes, coexistence with the existing metrics registry, and redaction boundaries.
- **files edited/created**: `docs/plan-execution/openai-mcp-gap-closure-t3-observability-contract.md`

### T4a: Extract Prompt and Task Policy Registry
- **depends_on**: [T1, T2]
- **location**: `src/mcp/`, `src/internal/handlers/`, `src/mcp/prompts/`, `tests/mcp/`, `tests/tools/`
- **description**: Introduce an explicit prompt and task policy registry so prompt ownership, schema versioning, and task policies are centrally defined instead of scattered across handlers. The policy registry should centralize `prompt_version`, `response_schema_version`, `priority`, `timeout`, `retry`, `dedupe`, `validator`, and `degraded_mode` rules.
- **validation**: Prompt/task definitions are centralized with no-behavior-change extraction; tests prove equivalent task calls resolve to the same registry entries and versioned templates; prompt/template fixtures and malformed-response fixtures are frozen before caller migration begins.
- **status**: Completed
- **log**: Added `src/mcp/taskPolicyRegistry.ts` as the central registry for runtime-backed task metadata, then migrated planning, code review, review diff, and enhancement to resolve prompt/schema/priority ownership from that registry instead of scattering constants across handlers. Enhancement task/template metadata now lives in the registry too, and targeted tests freeze stable policy entries for enhancement, review, and planning resolution.
- **files edited/created**: `src/mcp/taskPolicyRegistry.ts`, `src/internal/handlers/enhancement.ts`, `src/mcp/services/planningService.ts`, `src/mcp/services/codeReviewService.ts`, `src/mcp/tools/reviewDiff.ts`, `tests/mcp/taskPolicyRegistry.test.ts`, `tests/tools/enhance.test.ts`, `tests/services/planningService.test.ts`, `tests/services/codeReviewService.test.ts`

### T4b: Migrate Callers to Policy Registry and Freeze Outcome Semantics
- **depends_on**: [T4a]
- **location**: `src/mcp/`, `src/internal/handlers/`, `src/mcp/prompts/`, `tests/mcp/`, `tests/tools/`
- **description**: Move enhancement, planning, review, and other covered AI-backed callers onto the new policy registry and align them with the runtime outcome semantics defined in `T2`.
- **validation**: Covered callers use the registry; behavior remains compatible; tests prove policy-driven timeouts, retries, dedupe, validation, and degraded-mode behavior are resolved centrally rather than inline.
- **status**: Completed
- **log**: Expanded `src/mcp/taskPolicyRegistry.ts` so runtime-backed task policies now own timeout envelopes, retry contracts, dedupe defaults, validation mode, and degraded-validation semantics in addition to prompt/schema metadata. Enhancement, planning, code review, and `review_diff` now resolve those runtime options through the registry instead of hand-rolling them inline, while `src/mcp/openaiTaskRuntime.ts` accepts caller-owned degraded-validation outcome semantics for soft validation failures. Focused tests freeze the new registry contract and verify policy-driven timeout, retry, dedupe, validation, and degraded behavior without changing caller-visible outputs.
- **files edited/created**: `src/mcp/taskPolicyRegistry.ts`, `src/mcp/openaiTaskRuntime.ts`, `src/internal/handlers/enhancement.ts`, `src/mcp/services/planningService.ts`, `src/mcp/services/codeReviewService.ts`, `src/mcp/tools/reviewDiff.ts`, `tests/mcp/taskPolicyRegistry.test.ts`, `tests/mcp/openaiTaskRuntime.test.ts`, `tests/tools/enhance.test.ts`, `tests/services/planningService.test.ts`, `tests/services/codeReviewService.test.ts`, `tests/tools/reviewDiff.test.ts`

### T5a: Freeze Graph Artifact Contract
- **depends_on**: [T1]
- **location**: `docs/`, new graph artifact locations under the workspace, `src/mcp/serviceClient.ts`, `src/internal/retrieval/`, `tests/`
- **description**: Freeze the graph artifact contract before persistent graph writes land. Define on-disk naming, schema/version stamps, rebuild triggers, mismatch behavior, cleanup rules, rollback posture, determinism receipts, and unsupported-language handling.
- **validation**: Graph artifact/version contract is documented and testable; determinism matrix, restart persistence expectations, rebuild idempotence, degraded-mode behavior, and rollback/delete rules are explicit and approved.
- **status**: Completed
- **log**: Added `docs/plan-execution/openai-mcp-gap-closure-t5a-graph-artifact-contract.md` to freeze the graph artifact family before persistent graph writes land. The contract defines artifact names, metadata fields, schema/version expectations, rebuild triggers, mismatch/corruption handling, cleanup and rollback boundaries, the initial supported-language matrix, bounded degraded states, and the receipt/test matrix required before graph-backed consumers can proceed.
- **files edited/created**: `docs/plan-execution/openai-mcp-gap-closure-t5a-graph-artifact-contract.md`

### T5b: Implement Persistent Graph Store
- **depends_on**: [T5a]
- **location**: `src/internal/retrieval/`, new `src/graph/` or `src/internal/graph/`, `src/mcp/serviceClient.ts`, `tests/internal/`, `tests/serviceClient.test.ts`
- **description**: Add a persistent graph layer backed by deterministic extraction outputs and durable local storage. Store files, symbols, definitions, references, imports, containment, and call edges, with extraction confidence and language provenance.
- **validation**: A graph index can be built and rebuilt locally; persisted graph artifacts survive process restarts; tests prove deterministic graph persistence, restart behavior, rebuild idempotence, stale and partial-graph behavior, and unsupported-language handling across the frozen language matrix.
- **status**: Completed
- **log**: Added `src/internal/graph/persistentGraphStore.ts` as the durable graph artifact layer, writing `.context-engine-graph/graph.json` plus `.context-engine-graph-index.json` with deterministic schema/version/workspace/source fingerprints, bounded degraded reasons, and restart-safe atomic writes. The first rollout stores files, symbols, definitions, references, imports, containment edges, and bounded call edges using the frozen supported-language matrix with heuristic parsing fallback when tree-sitter is unavailable. `src/mcp/serviceClient.ts` now refreshes graph artifacts after local-native workspace indexing, incremental indexing, and delete-prune flows, and clears only graph-local artifacts during `clearIndex()` without touching lexical/vector artifacts. Focused tests now cover persistence across restart, forced rebuild idempotence, unsupported-language degradation, corruption recovery, graph-only rollback cleanup, and local-native service-client integration receipts.
- **files edited/created**: `src/internal/graph/persistentGraphStore.ts`, `src/mcp/serviceClient.ts`, `tests/internal/graph/persistentGraphStore.test.ts`, `tests/serviceClient.test.ts`

### T6: Implement OpenTelemetry and Correlated Request Tracing
- **depends_on**: [T3]
- **location**: `package.json`, new `src/observability/` or `src/runtime/telemetry/`, `src/index.ts`, `src/http/**/*.ts`, `src/mcp/server.ts`, `src/mcp/openaiTaskRuntime.ts`, `tests/integration/`, `docs/`
- **description**: Add request-scoped tracing and correlation across HTTP, MCP, retrieval, and OpenAI runtime flows using an explicit startup path. Keep the change additive and compatible with current local workflows.
- **validation**: Telemetry bootstraps before application code; spans are emitted for request entry, retrieval, and model/runtime stages; correlation/request IDs are observable in logs/metadata where intended; integration tests cover startup-before-app-code, duplicate-init negatives, default-off/additive behavior, graceful shutdown, and log/metadata redaction.
- **status**: Completed
- **log**: Added startup-first observability scaffolding in `src/observability/otel.ts`, wired `src/index.ts` to own bootstrap and shutdown, moved stdio shutdown ownership out of `src/mcp/server.ts`, added stdio request-context creation so handled MCP requests no longer log as `[request:unknown]`, and threaded additive HTTP/runtime span hooks through `src/http/middleware/observability.ts`, `src/http/httpServer.ts`, `src/mcp/server.ts`, and `src/mcp/openaiTaskRuntime.ts`. Package manifests now declare the frozen OpenTelemetry tracing dependencies, focused tests cover default-off bootstrap, missing-dependency degradation, stdio request correlation, launcher startup/shutdown, MCP HTTP transport parity, and runtime regressions, and retrieval now emits additive pipeline, stage, and fanout-backend spans with focused no-op degradation coverage from `src/internal/retrieval/retrieve.ts` and `tests/internal/retrieval/retrieveObservability.test.ts`.
- **files edited/created**: `package.json`, `src/observability/otel.ts`, `src/http/middleware/observability.ts`, `src/http/middleware/index.ts`, `src/http/httpServer.ts`, `src/mcp/server.ts`, `src/index.ts`, `src/mcp/openaiTaskRuntime.ts`, `src/internal/retrieval/retrieve.ts`, `src/types/opentelemetry.d.ts`, `tests/observability/otel.test.ts`, `tests/mcp/serverObservability.test.ts`, `tests/launcher.test.ts`, `tests/internal/retrieval/retrieveObservability.test.ts`

### T7: Rebuild Symbol Tools on Top of the Graph
- **depends_on**: [T4b, T5b]
- **location**: `src/mcp/serviceClient.ts`, `src/mcp/tools/search.ts`, `src/mcp/tooling/discoverability.ts`, `src/mcp/tools/manifest.ts`, `tests/tools/search.test.ts`, `tests/serviceClient.test.ts`
- **description**: Replace the heuristic-first symbol definition/reference/call logic with graph-backed implementations and preserve heuristics only as controlled fallback paths. Keep current public tool names stable while improving internals.
- **validation**: Existing symbol tools continue to pass compatibility tests; new tests prove graph-backed correctness beats heuristic fallback on known fixtures; fallback reasons are surfaced when the graph is unavailable or incomplete; graph-backed symbol parity and degraded-mode tests pass before downstream consumers start.
- **status**: Completed
- **log**: Rebuilt `symbol_search`, `symbol_references`, `symbol_definition`, and `call_relationships` around persisted graph artifacts in `src/mcp/serviceClient.ts`, while preserving the prior heuristic implementation as a controlled fallback path. Symbol navigation now records explicit graph status and fallback reasons, `search.ts` surfaces those receipts in tool output, and manifest/discoverability metadata now describe the graph-backed behavior without changing public tool names. Focused tests now cover graph-backed definitions, references, and call edges after local-native indexing plus degraded fallback receipts when graph artifacts are unavailable.
- **files edited/created**: `src/mcp/serviceClient.ts`, `src/mcp/tools/search.ts`, `src/mcp/tooling/discoverability.ts`, `src/mcp/tools/manifest.ts`, `tests/serviceClient.test.ts`, `tests/tools/search.test.ts`

### T8: Make Retrieval Graph-Aware and Explainable
- **depends_on**: [T2, T5b, T7]
- **location**: `src/internal/retrieval/*.ts`, `src/internal/handlers/enhancement.ts`, `src/mcp/tools/context.ts`, `src/mcp/tools/search.ts`, `tests/internal/retrieval/`, `tests/tools/context.test.ts`, `tests/tools/codebaseRetrieval.test.ts`
- **description**: Thread graph-neighbor expansion, graph-aware rerank inputs, and provenance metadata into the existing retrieval/context assembly path. Add stable explainability fields for why files or chunks were selected.
- **validation**: Retrieval outputs include additive explainability and provenance for graph-aware selections; scoped and unscoped tests still pass; retrieval quality fixtures show no regression against named artifact thresholds and provenance equivalence rules; retrieval explainability/provenance receipts pass before any downstream tool or refactor consumes them.
- **status**: Completed
- **log**: Added graph-aware retrieval augmentation in `src/internal/retrieval/graphAware.ts` and wired `src/internal/retrieval/retrieve.ts` to load persisted graph artifacts, append graph-derived query variants, and attach stable provenance/explainability receipts to retrieval results without replacing the current semantic/lexical/dense flow. `codebase_retrieval` now surfaces additive `provenance` and `explainability` envelopes in `src/mcp/tools/codebaseRetrieval.ts`, and `get_context_for_prompt` can render additive selection signals when file contexts carry those receipts in `src/mcp/tools/context.ts`. Focused tests cover graph-driven variant expansion, graph-backed provenance/explainability serialization, and context rendering of selection receipts.
- **files edited/created**: `src/internal/retrieval/graphAware.ts`, `src/internal/retrieval/retrieve.ts`, `src/internal/retrieval/types.ts`, `src/mcp/tools/codebaseRetrieval.ts`, `src/mcp/tools/context.ts`, `tests/internal/retrieval/retrieve.test.ts`, `tests/tools/codebaseRetrieval.test.ts`, `tests/tools/context.test.ts`

### T9: Complete the Diff-Native Review Architecture
- **depends_on**: [T2, T3, T6]
- **location**: `src/reviewer/reviewDiff.ts`, `src/reviewer/checks/adapters/`, new `src/reviewer/context/` or `src/reviewer/pipeline/`, `src/mcp/tools/reviewDiff.ts`, `src/reactive/ReactiveReviewService.ts`, `tests/tools/reviewDiff.test.ts`, `tests/tools/reviewAuto.test.ts`, `tests/services/reactiveReviewService.test.ts`
- **description**: Factor the review pipeline into explicit diff-context, changed-line mapping, analyzer orchestration, and synthesis-normalization stages. Keep `review_diff` behavior stable while making the architecture pluggable and easier to extend. Freeze whether review remains diff-local or shares retrieval explainability/provenance interfaces before implementation diverges.
- **validation**: Review pipeline modules exist with clear ownership boundaries; static analyzer hooks and diff-context stages are separately testable; review artifacts and snapshots remain stable unless intentionally updated with documented reason; changed-line negatives, empty/rename/binary/malformed diff cases, direct `review_auto -> review_diff` timeout smoke, explicit-scope review guards, and chunked-review behavior all remain green.
- **status**: Completed
- **log**: Split the monolithic review path into explicit diff-context, analyzer orchestration, and synthesis/normalization stages by adding `src/reviewer/context/diffContext.ts`, `src/reviewer/pipeline/analyzerOrchestrator.ts`, and `src/reviewer/pipeline/synthesis.ts`, then rewiring `src/reviewer/reviewDiff.ts` to compose those stages without changing `review_diff` tool behavior. Focused coverage now proves changed-line negatives, rename-only diffs, binary diffs, malformed/empty scope handling, and analyzer-stage boundary behavior, while `review_auto` and reactive review compatibility remain green.
- **files edited/created**: `src/reviewer/context/diffContext.ts`, `src/reviewer/pipeline/analyzerOrchestrator.ts`, `src/reviewer/pipeline/synthesis.ts`, `src/reviewer/reviewDiff.ts`, `tests/tools/reviewDiff.test.ts`

### T10a: Add Graph-Native Symbol and Impact Tools
- **depends_on**: [T7]
- **location**: `src/mcp/tools/`, `src/mcp/server.ts`, `src/mcp/tooling/discoverability.ts`, `src/mcp/tools/manifest.ts`, `tests/tools/`, `tests/mcp/`
- **description**: Add the graph-native tools enabled by the new graph layer, at minimum `find_callers`, `find_callees`, `trace_symbol`, and `impact_analysis`. Keep naming, schemas, and discoverability metadata decision-complete before implementation.
- **validation**: New tools are registered in manifest/discoverability/server; schemas and outputs are snapshot-tested; tools return deterministic graph-backed results with explicit degraded-mode behavior.
- **status**: Completed
- **log**:
- Added additive graph-native MCP tools: `find_callers`, `find_callees`, `trace_symbol`, and `impact_analysis`.
- Registered the new tools in `server.ts`, `tool_manifest`, and discoverability metadata without renaming existing navigation tools.
- Added deterministic degraded-mode receipts to each new tool output, including explicit graph/fallback diagnostics and bounded direct-impact analysis semantics.
- Added focused behavior, snapshot, and registration coverage in `tests/tools/graphNativeTools.test.ts` and `tests/mcp/graphNativeRegistration.test.ts`.
- Focused discoverability/runtime smoke passed for the new surfaces; the broader legacy `tests/mcp/discoverability.test.ts` is still blocked by an unrelated TypeScript issue in `src/mcp/tools/context.ts`.
- **files edited/created**:
- `src/mcp/tools/findCallers.ts`
- `src/mcp/tools/findCallees.ts`
- `src/mcp/tools/traceSymbol.ts`
- `src/mcp/tools/impactAnalysis.ts`
- `src/mcp/server.ts`
- `src/mcp/tooling/discoverability.ts`
- `src/mcp/tools/manifest.ts`
- `tests/tools/graphNativeTools.test.ts`
- `tests/mcp/graphNativeRegistration.test.ts`
- `tests/mcp/discoverability.test.ts`

### T10b: Add `why_this_context` on Top of Retrieval Explainability
- **depends_on**: [T8]
- **location**: `src/mcp/tools/`, `src/mcp/server.ts`, `src/mcp/tooling/discoverability.ts`, `src/mcp/tools/manifest.ts`, `tests/tools/`, `tests/mcp/`
- **description**: Add `why_this_context` only after retrieval explainability/provenance is stable enough to support it. Keep the tool aligned with the shared explainability vocabulary rather than inventing a separate path.
- **validation**: Tool output is backed by the retrieval explainability contract from `T8`; schemas and outputs are snapshot-tested; degraded-mode behavior is explicit and deterministic.
- **status**: Completed
- **log**:
- Added `why_this_context` as a deterministic MCP tool that reuses `getContextForPrompt` and reports the existing retrieval `provenance` / `explainability` receipts rather than inventing a parallel explanation path.
- Registered `why_this_context` in server wiring, manifest capabilities, and discoverability metadata with explicit degraded-mode guidance.
- Added focused schema, output, and registration coverage for explainable and degraded context-selection cases.
- **files edited/created**:
- `src/mcp/tools/whyThisContext.ts`
- `src/mcp/server.ts`
- `src/mcp/tooling/discoverability.ts`
- `src/mcp/tools/manifest.ts`
- `tests/tools/whyThisContext.test.ts`
- `tests/mcp/graphNativeRegistration.test.ts`

### T11a: Extract Runtime and Retrieval Seams from `serviceClient.ts`
- **depends_on**: [T4b, T8]
- **location**: `src/mcp/serviceClient.ts`, new focused modules under `src/mcp/` or `src/internal/`, `src/mcp/server.ts`, `tests/serviceClient.test.ts`, `tests/integration/httpCompatibility.test.ts`
- **description**: Split `serviceClient.ts` by responsibility without changing public tool behavior. Extract runtime access and retrieval orchestration into focused modules with narrow interfaces before graph/lifecycle extraction begins.
- **validation**: Extracted runtime/retrieval modules have isolated tests; MCP/HTTP compatibility tests pass after refactor; no duplicated orchestration paths remain between extracted runtime/retrieval surfaces.
- **status**: Completed
- **log**:
- Extended `src/mcp/serviceClientRuntimeAccess.ts` so queued `searchAndAsk` execution, provider invocation, queue-depth metrics, and admission-time budget rejection all live behind the runtime seam instead of inside `ContextServiceClient`.
- Added `src/mcp/serviceClientRetrievalAccess.ts` to own retrieval runtime metadata, artifact metadata, provider callback construction, and provider-bound semantic search orchestration while keeping `ContextServiceClient` as the coordinator.
- Updated `src/mcp/serviceClient.ts` to delegate runtime and retrieval orchestration through the extracted seams, removing duplicated queue/provider wiring from the main service client body.
- Added focused seam coverage in `tests/serviceClient.test.ts` for runtime delegation and retrieval access delegation.
- Focused validation passed with `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/serviceClient.test.ts --runInBand` (`143` tests passed).
- Attempted `tests/integration/httpCompatibility.test.ts`, but it is currently blocked by an unrelated TypeScript error in `src/http/routes/tools.ts` (`top_k` undefined), outside this task's write scope.
- **files edited/created**:
- `src/mcp/serviceClient.ts`
- `src/mcp/serviceClientRuntimeAccess.ts`
- `src/mcp/serviceClientRetrievalAccess.ts`
- `src/mcp/serviceClientRetrievalRuntime.ts`
- `tests/serviceClient.test.ts`

### T11b: Extract Graph and Lifecycle Seams from `serviceClient.ts`
- **depends_on**: [T5b, T7]
- **location**: `src/mcp/serviceClient.ts`, new focused modules under `src/mcp/` or `src/internal/`, `src/mcp/server.ts`, `tests/serviceClient.test.ts`, `tests/integration/httpCompatibility.test.ts`
- **description**: Complete the `serviceClient.ts` modularization by extracting graph access and workspace/index lifecycle only after graph-backed behavior is stable.
- **validation**: Extracted graph/lifecycle modules have isolated tests; behavior parity, dependency-boundary checks, and workspace/index lifecycle smoke coverage all pass; no duplicated orchestration paths remain between extracted graph/lifecycle surfaces.
- **status**: Completed
- **log**:
  - Extracted graph store access, refresh, snapshot, and clear behavior into `src/mcp/serviceClientGraphAccess.ts`.
  - Extracted repeated local-native lifecycle finalize/clear orchestration into `src/mcp/serviceClientLifecycle.ts`, reducing duplication across workspace indexing, incremental indexing, delete pruning, and clear flows.
  - Added lifecycle smoke coverage proving persisted graph metadata refreshes after delete-pruning via `applyWorkspaceChanges`.
- **files edited/created**:
  - `src/mcp/serviceClient.ts`
  - `src/mcp/serviceClientGraphAccess.ts`
  - `src/mcp/serviceClientLifecycle.ts`
  - `tests/serviceClient.test.ts`

### T12: Standardize Tool Metadata, Explainability, and Transport Parity
- **depends_on**: [T6, T8, T9, T10a, T10b]
- **location**: `src/mcp/tooling/discoverability.ts`, `src/mcp/tools/manifest.ts`, `src/http/routes/tools.ts`, `src/http/httpServer.ts`, `src/mcp/server.ts`, `tests/mcp/discoverability.test.ts`, `tests/integration/httpCompatibility.test.ts`, `tests/snapshots/`
- **description**: Add a shared metadata contract across applicable tools for latency class, index requirements, git/graph requirements, provenance availability, and explainability fields. Ensure HTTP and MCP remain aligned where the same tool surface exists.
- **validation**: Manifest/discoverability reflects the new metadata; parity tests prove stdio MCP, streamable HTTP MCP, and `/api/v1` REST surfaces stay aligned; explainability fields are additive and snapshot-approved; metadata contract and smoke gates exist separately so registration, `tool_manifest`, and transport parity cannot drift silently.
- **status**: Completed
- **log**:
- Added shared discoverability `shared_contract` metadata for applicable tools, covering latency class, index/git/graph requirements, provenance availability, explainability fields, and declared transport parity.
- Added REST parity endpoints for `find_callers`, `find_callees`, `trace_symbol`, `impact_analysis`, `why_this_context`, and `tool_manifest`, keeping JSON contracts additive while leaving MCP tool names unchanged.
- Switched `/api/v1/codebase-retrieval` onto the graph-aware `handleCodebaseRetrieval` path so REST now carries the same additive provenance and explainability receipts as the MCP surface.
- Added parity gates proving manifest tool ids, runtime registration, streamable HTTP MCP `tools/list`, and declared REST mappings stay aligned.
- **files edited/created**:
- `src/mcp/tooling/discoverability.ts`
- `src/mcp/tools/manifest.ts`
- `src/http/routes/tools.ts`
- `tests/mcp/discoverability.test.ts`
- `tests/integration/httpCompatibility.test.ts`

### T13: Add Evaluation Gates and Final Readiness Pack
- **depends_on**: [T6, T10a, T10b, T11a, T11b, T12]
- **location**: `scripts/ci/`, `config/ci/`, `docs/`, `artifacts/bench/`, `tests/ci/`
- **description**: Add the final evidence-oriented gate for this program: graph accuracy fixtures, retrieval provenance checks, review precision/grounding checks, tracing/telemetry smoke checks, malformed-output accounting, and a final rollout/readiness document tying all completed waves together. This is the final aggregation gate, not the first serious one.
- **validation**: CI scripts and fixture packs exist; readiness doc lists required evidence artifacts and pass/fail thresholds; malformed-output handling and validation-failure accounting are explicitly covered; a dry-run of the new gate produces complete artifacts without manual patch-up.
- **status**: Completed
- **log**:
- Added a frozen `T13` readiness contract in `config/ci/openai-mcp-gap-closure-readiness-contract.json` so the final gate is pinned to the active plan, required dependency tasks, required docs, focused live-test lanes, retrieval provenance artifacts, and malformed-output accounting thresholds.
- Added `scripts/ci/check-openai-mcp-gap-closure-readiness.ts`, which aggregates plan dependency completion, validates retrieval and malformed-output receipts, optionally runs focused graph/review/tracing Jest lanes, and emits both a machine-readable gate artifact and a human-readable readiness pack.
- Added focused CI coverage for the readiness contract and aggregate gate, including a passing skip-live-tests dry-run and a failing dependency/threshold regression case.
- Ran a real dry-run with live checks: `node --import tsx scripts/ci/check-openai-mcp-gap-closure-readiness.ts`, which produced `artifacts/bench/openai-mcp-gap-closure-readiness-gate.json` and `docs/plan-execution/openai-mcp-gap-closure-final-readiness-pack.md` with overall status `pass`.
- Live dry-run evidence recorded passing focused lanes for graph accuracy, review precision/grounding, and tracing/telemetry smoke; retrieval provenance remained `pass` with `routing_receipt_coverage_pct=100`; malformed-output accounting remained `pass` with `malformed_event_count=0`.
- **files edited/created**:
- `config/ci/openai-mcp-gap-closure-readiness-contract.json`
- `scripts/ci/check-openai-mcp-gap-closure-readiness.ts`
- `tests/ci/openAiMcpGapClosureReadinessContract.test.ts`
- `tests/ci/checkOpenAiMcpGapClosureReadiness.test.ts`
- `artifacts/bench/openai-mcp-gap-closure-readiness-gate.json`
- `docs/plan-execution/openai-mcp-gap-closure-final-readiness-pack.md`

## Parallel Execution Groups

| Wave | Tasks | Can Start When |
|------|-------|----------------|
| 0 | T0 | Immediately |
| 1 | T1 | T0 complete |
| 2 | T2, T3, T5a | T1 complete |
| 3 | T4a, T5b, T6 | Their direct dependencies complete |
| 4 | T4b, T7 | Their direct dependencies complete |
| 5 | T8, T9 | Their direct dependencies complete; single-writer ownership gate must still be satisfied |
| 6 | T10a, T10b, T11a, T11b | Their direct dependencies complete |
| 7 | T12 | T6, T8, T9, T10a, T10b complete |
| 8 | T13 | T6, T10a, T10b, T11a, T11b, T12 complete |

## Wave Gates
- Wave 0 gate:
  - `T0` artifacts approved in-repo.
  - Ownership matrix and single-writer rules frozen for overlapping core files.
- Wave 2 gate:
  - Runtime outcome semantics, prompt/task policy receipts, and telemetry architecture contracts are frozen before deeper migrations proceed.
- Wave 4 gate:
  - Graph artifact contract and graph persistence receipts are proven before graph consumers and graph-backed symbol tools continue.
- Wave 5 gate:
  - Retrieval explainability/provenance receipts and review grounding/timeout/noise regressions pass before downstream tools or parity work continue.
- Wave 7 gate:
  - Transport parity, metadata parity, and explainability vocabulary are frozen across stdio MCP, streamable HTTP MCP, and `/api/v1` REST.
- Wave 8 gate:
  - Final readiness pack aggregates prior receipts; no new contract-free validation appears for the first time in `T13`.

## Testing Strategy
- Preserve existing behavior first:
  - run manifest/discoverability snapshot checks before and after each wave
  - keep MCP/HTTP compatibility tests green throughout refactors
- For runtime work:
  - unit-test prompt registry, task policy resolution, retries, parse validation, aborts, and telemetry metadata
  - add malformed-output fixtures and validation-failure accounting checks
- For graph work:
  - build deterministic fixture packs covering symbol definition, references, calls, and impact analysis
  - test persistence, rebuild behavior, degraded fallback behavior, restart behavior, and unsupported-language negatives
- For retrieval/review work:
  - reuse existing retrieval quality gates and review artifact snapshots
  - add explainability/provenance assertions rather than replacing current outputs wholesale
  - require named retrieval artifacts and provenance equivalence for comparisons: dataset hash, commit SHA, feature-flag snapshot, and snapshot ID
- For observability:
  - add startup/shutdown smoke tests, request tracing tests, additive metadata checks, duplicate-init negatives, and redaction checks
- Final evidence required before execution is considered ready:
  - green targeted test matrix for every touched wave
  - updated snapshots where intentional
  - benchmark/evaluation artifacts for graph, retrieval, and review slices
  - readiness document with explicit pass/fail receipts
  - malformed-output and validation-failure receipts for AI-backed surfaces

## Risks & Mitigations
- Graph work can overreach and stall execution.
  - Mitigation: implement graph-backed replacements in layers, with controlled heuristic fallback and fixture-gated rollout.
- Refactoring `serviceClient.ts` too early can create merge pain and regressions.
  - Mitigation: do not start extraction slices until the corresponding runtime/retrieval or graph contracts are frozen in `T4`/`T8` or `T5`/`T7`.
- Tool contract churn can break snapshots and downstream clients.
  - Mitigation: `T0` and `T1` freeze contract boundaries first; `T12` limits metadata changes to additive behavior.
- Tracing can become invasive or startup-fragile.
  - Mitigation: `T3` freezes startup, ownership, cardinality, and coexistence decisions before `T6` implementation.
- Same-wave ownership overlap can create avoidable merge conflicts and hidden regressions.
  - Mitigation: single-writer rule for `serviceClient.ts`, `search.ts`, `server.ts`, `discoverability.ts`, and review orchestration surfaces; tasks that violate ownership must be serialized or split before execution.
- Review architecture changes can silently increase noise.
  - Mitigation: keep `review_diff` artifact snapshots, explicit-scope guards, chunked review behavior, and invariant/static-analysis checks as regression gates through `T9`.
- This plan should stop and replan if:
  - graph extraction cannot achieve deterministic fixture stability on supported languages
  - transport parity breaks for MCP/HTTP tool surfaces
  - observability initialization requires broader runtime boot changes than `T3` allowed
  - refactor slices force simultaneous edits across the same core files in multiple waves beyond the declared ownership boundaries
