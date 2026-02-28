# All Tools Enhancement Execution Tracker

This tracker is the live checklist for the current implementation wave.

## Scope
- Target: P0 critical fixes before broader all-42 tool optimization.
- Goal: make benchmarking and rollout gating trustworthy and auditable.

## Workstreams

### WS1 - Benchmark Provenance and Integrity
Owner: Agent A
Files:
- `scripts/ci/run-bench-suite.ts`
- (optional) `scripts/ci/bench-compare.ts`
- `docs/BENCHMARKING.md` (if schema/usage updates are needed)

Checklist:
- [x] Baseline provenance validation implemented (no same-commit self-baseline).
- [x] Required benchmark metadata schema added and enforced.
- [x] Mode/dataset parity checks implemented.
- [x] Clear fail reasons on provenance/integrity violations.

### WS2 - Release Gate Mode + Artifact Alignment
Owner: Agent B
Files:
- `scripts/ci/release-bench.ts`
- `.github/workflows/release_perf_gate.yml`
- (optional) `package.json` scripts

Checklist:
- [x] Release workflow `mode` input is enforced by release benchmark script.
- [x] Artifact output paths are aligned across script and workflow upload paths.
- [x] Baseline/candidate handling is explicit and deterministic.
- [x] Clear fail reasons for invalid mode/path/missing artifacts.

### WS3 - Inventory Parity + Deep Readiness Checks
Owner: Agent C
Files:
- `src/mcp/tools/manifest.ts`
- (optional) new script under `scripts/ci/` for tool parity checks
- `scripts/ci/check-rollout-readiness.ts`
- `.github/workflows/perf_gates.yml` (only if needed to invoke new checks)
- `docs/ROLLOUT_RUNBOOK.md` (if readiness criteria are expanded)

Checklist:
- [x] `tool_manifest` tool list updated to match live registered tools.
- [x] Parity check path exists for `ListTools` vs manifest inventory.
- [x] Readiness checker validates quality (not only file existence).
- [x] Rollout no-go conditions are machine-checkable where feasible.

## Validation Gates (Coordinator)
- [x] `npx tsc --noEmit`
- [x] Focused tests for changed behavior (tools/docs contracts and CI scripts where applicable)
- [x] `npm run bench:ci:pr`
- [x] `npm run bench:ci:nightly`
- [x] `npm run bench:ci:release`
- [x] `node --import tsx scripts/ci/check-rollout-readiness.ts`
- [x] `node --import tsx scripts/ci/check-tool-manifest-parity.ts`

## Status Log
- [x] Tracker created.
- [x] Agents spawned and running.
- [x] Agent outputs integrated.
- [x] Validation complete.
- [x] Ready for commit/review.

## Wave 2 - Multi-Agent Implementation (Current)
Goal: broaden enhancements across the MCP tooling layer with low-risk, high-signal hardening.

### WS4 - Server Dispatch + Registry Cohesion
Owner: Agent D
Files:
- `src/mcp/server.ts`

Checklist:
- [x] Centralize tool registry for list + dispatch coherence.
- [x] Remove duplicate tool definitions between `list_tools` and dispatcher.
- [x] Keep response/error contract backward compatible.

### WS5 - Cross-Tool Input Guardrails
Owner: Agent E
Files:
- `src/mcp/tools/context.ts`
- `src/mcp/tools/enhance.ts`
- `src/mcp/tools/codeReview.ts`

Checklist:
- [x] Add missing type/range checks (`include_related`, `min_relevance`, etc.).
- [x] Add bounded length guards for large string inputs.
- [x] Keep existing output format unchanged.

### WS6 - Reactive Review Argument Hardening
Owner: Agent F
Files:
- `src/mcp/tools/reactiveReview.ts`
- `tests/tools/reactiveReview.test.ts`

Checklist:
- [x] Harden `changed_files` parsing and validation.
- [x] Add bounds checks for numeric args and key string args.
- [x] Add/adjust tests for new validation behavior.

### Wave 2 Validation Gates (Coordinator)
- [x] `npx tsc --noEmit`
- [x] `npx jest tests/tools/context.test.ts tests/tools/reviewChanges.test.ts tests/tools/reactiveReview.test.ts`
- [x] `node --import tsx scripts/ci/check-tool-manifest-parity.ts`
- [x] `node --import tsx scripts/ci/check-rollout-readiness.ts`
