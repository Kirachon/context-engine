# Plan: MCP Confidence, Discoverability, Traceability, and Rerank Calibration

> Status: Reference-only after consolidation
>
> This roadmap documents a completed earlier wave and remains useful as scoped reference.
> `context-engine-improvement-swarm-plan.md` is the active delivery plan.
> `ARCHITECTURE.md` remains the architecture reference.

## Summary
Deliver the next Context Engine enhancement wave as four coordinated streams:

1. real-client MCP smoke coverage
2. richer discoverability metadata
3. request tracing across HTTP/REST/MCP
4. calibration and visibility for the existing rerank pipeline

This wave stays additive and low-risk:
- no tool, prompt, or resource renames
- no Inspector CLI dependency in CI
- no new reranker/model/provider
- no stdio protocol changes
- no default-on retrieval behavior change

Frozen decisions:
- The MCP smoke harness uses the official MCP SDK client against the existing `/mcp` endpoint.
- A single canonical metadata descriptor is the source of truth for runtime registration, `tool_manifest`, and prompt/resource discoverability metadata.
- `mcp-session-id` and request tracing are separate concepts: session ID stays session-scoped, request ID is generated per HTTP request.
- Tracing is user-visible only through an additive `x-context-engine-request-id` response header on HTTP/REST/MCP.
- Rerank work in this wave is diagnostics, gate calibration, and evidence only; any default profile change requires a later plan.
- Negative smoke assertions must key on stable protocol fields like HTTP status, JSON-RPC error code, and response shape, not full error-message text.

## Public Interfaces / Additive Changes
- New CI/dev script: `npm run ci:check:mcp-smoke`
- Additive `tool_manifest` metadata for titles, usage hints, examples, safety hints, and related surfaces
- Additive MCP tool annotations where supported by the SDK
- Additive HTTP/REST/MCP response header: `x-context-engine-request-id`
- Additive tracing/log correlation and metrics timing only; no text-mode output changes
- No new public rerank knobs beyond existing feature-flag/profile controls in this wave

## Dependency Graph
```text
T1 -> T2 -> T4b -> T5 -> T8
T1 -> T3a -> T3b -> T4a ->/
T1 -> T6a -> T6b -> T6c ->/
T1 -> T7a -> T7b -> T7c ->/
```

## Tasks

### T1: Freeze Contracts, Baselines, and Ownership
- **depends_on**: []
- **location**: `src/mcp/server.ts`, `src/mcp/tools/manifest.ts`, `tests/integration/mcpHttpTransport.test.ts`
- **description**: Freeze the current MCP surface, current smoke expectations, current manifest shape, current tracing behavior, and current retrieval ranking/perf evidence. Record the additive-only boundaries. Lock the metadata source-of-truth decision, the request ID vs session ID distinction, and the rule that smoke failures assert stable protocol fields rather than brittle error strings.
- **validation**: Current MCP transport tests, manifest parity checks, and current retrieval/perf gate commands serve as baseline receipts.

### T2: Add Real MCP Client Smoke Harness (Local Only)
- **depends_on**: [T1]
- **location**: new `scripts/ci/mcp-smoke.ts`, `src/http/httpServer.ts`
- **description**: Add a standalone Node smoke script that starts an in-process server and uses the official MCP SDK client plus Streamable HTTP client transport to exercise `/mcp` like a real client. Cover initialize, initialized notification, tools/resources/prompts listing, one resource read, one prompt get, one representative tool call, and negative cases using stable JSON-RPC error semantics.
- **validation**: The script passes locally, exits non-zero on protocol mismatch, and remains stable across repeated runs.

### T3a: Create Canonical Discoverability Descriptor
- **depends_on**: [T1]
- **location**: new shared metadata module under `src/mcp/tooling/`, `src/mcp/server.ts`, `src/mcp/tools/manifest.ts`
- **description**: Define one canonical descriptor for tool/prompt/resource discoverability metadata: title, usage hint, examples, safety hints, and related surfaces. Runtime registration and `tool_manifest` must both derive from this layer.
- **validation**: Descriptor coverage exists for the intended surfaced tools/prompts/resources, and generated runtime/manifest data stays aligned in tests.

### T3b: Add Additive Tool/Prompt/Resource Metadata
- **depends_on**: [T3a]
- **location**: `src/mcp/server.ts`, `src/mcp/tools/manifest.ts`, selected `src/mcp/tools/*.ts`
- **description**: Use the canonical descriptor to add runtime annotations/titles and enrich `tool_manifest` additively. Keep prompt/resource relationship metadata limited to what the current SDK/runtime can expose cleanly.
- **validation**: Existing names and argument contracts remain unchanged; metadata appears additively in runtime and manifest surfaces.

### T4a: Lock Metadata Contract and Snapshot Coverage
- **depends_on**: [T3b]
- **location**: snapshot/contract tests, manifest parity scripts
- **description**: Add deterministic coverage that verifies the canonical descriptor feeds both runtime registration and `tool_manifest` consistently. Assert stable fields and ordering without snapshotting incidental formatting.
- **validation**: Contract tests fail on missing titles/examples/safety hints or runtime/manifest drift.

### T4b: Extend Smoke Harness Assertions to the Finalized Metadata
- **depends_on**: [T2, T4a]
- **location**: `scripts/ci/mcp-smoke.ts`, `tests/integration/mcpHttpTransport.test.ts`
- **description**: Once metadata is stable, extend smoke assertions so the real-client path validates the expected additive metadata on list/get surfaces while keeping negative cases anchored to stable protocol fields.
- **validation**: Smoke still proves the baseline MCP protocol flow plus metadata presence without coupling to full payload text.

### T5: Wire Stable Smoke Harness into Main Review Workflow
- **depends_on**: [T4b]
- **location**: `.github/workflows/review_diff.yml`, `package.json`
- **description**: Add `ci:check:mcp-smoke` to the main review workflow as a dedicated step. Keep it separate from broad Jest execution so failures localize to the MCP client surface.
- **validation**: CI runs the smoke check as a distinct gate and local repro is one command.

### T6a: Add Request Context and Propagation
- **depends_on**: [T1]
- **location**: `src/http/middleware/logging.ts`, `src/http/httpServer.ts`, `src/mcp/server.ts`, `src/mcp/serviceClient.ts`
- **description**: Introduce a request context object with a per-request ID. Generate it at HTTP/REST/MCP entrypoints, propagate it through tool execution and long-running service flows, and keep `mcp-session-id` separate.
- **validation**: Representative HTTP/MCP requests retain the same functional responses while preserving request context through the service layer.

### T6b: Add Structured Logging and Metrics Correlation
- **depends_on**: [T6a]
- **location**: HTTP middleware, `src/mcp/server.ts`, `src/mcp/serviceClient.ts`, metrics/logging utilities
- **description**: Emit the request ID in logs and timing traces for representative tool paths. Do not use request IDs as metric labels; use them only for logs/correlation.
- **validation**: Logs/trace output include request IDs; metrics remain low-cardinality.

### T6c: Add the Public Trace Header and Integration Coverage
- **depends_on**: [T6b]
- **location**: `src/http/httpServer.ts`, HTTP integration tests
- **description**: Return `x-context-engine-request-id` on HTTP/REST/MCP responses. Do not add JSON response fields in this wave.
- **validation**: Integration tests prove one request ID per request, distinct from session ID, and no response-body contract regression.

### T7a: Freeze Rerank Baseline Evidence
- **depends_on**: [T1]
- **location**: `src/internal/retrieval/retrieve.ts`, existing retrieval/perf gate scripts, current artifacts/tests
- **description**: Capture current rerank gate state, fallback reasons, ranking-mode behavior, and perf/quality receipts before any calibration changes.
- **validation**: Existing rerank/retrieval/perf tests and gate commands are recorded as the before-state.

### T7b: Surface and Calibrate the Existing Rerank Path
- **depends_on**: [T7a]
- **location**: `src/internal/retrieval/retrieve.ts`, `src/internal/retrieval/rerank.ts`, retrieval diagnostics surfaces
- **description**: Improve visibility of rerank gate decisions, fallback reasons, and path selection. Keep `fast` conservative. Use existing feature-flag/profile controls for balanced/rich calibration only; do not add a new provider or change defaults.
- **validation**: Diagnostics clearly distinguish disabled, skipped, invoked, and fail-open states.

### T7c: Validate Rerank Calibration Against Existing Gates
- **depends_on**: [T7b]
- **location**: `tests/internal/retrieval/rerank.test.ts`, retrieval/perf gate tests/scripts
- **description**: Prove the calibration path with fail-open tests, latency checks, and existing retrieval/perf gates. Threshold changes are out of scope; if evidence shows thresholds are wrong, that becomes a separate follow-up.
- **validation**: Gate decision visibility, fail-open behavior, and latency/resource constraints remain within current acceptance boundaries.

### T8: Final Readiness, Docs, and Rollback Packet
- **depends_on**: [T5, T6c, T7c]
- **location**: docs plus CI evidence artifacts
- **description**: Add concise maintainer guidance for the smoke check, metadata source-of-truth, tracing behavior, and rerank evidence path. Record rollback boundaries per stream: smoke/CI, metadata, tracing, and rerank calibration.
- **validation**: A maintainer can run the smoke check locally, understand the additive metadata/tracing changes, and inspect rerank evidence without reading code first.

## Parallel Execution Groups
| Wave | Tasks | Can Start When |
|------|-------|----------------|
| 1 | T1 | Immediately |
| 2 | T2, T3a, T6a, T7a | T1 complete |
| 3 | T3b, T6b, T7b | T3a complete for T3b; T6a complete for T6b; T7a complete for T7b |
| 4 | T4a, T6c, T7c | T3b complete for T4a; T6b complete for T6c; T7b complete for T7c |
| 5 | T4b | T2 and T4a complete |
| 6 | T5 | T4b complete |
| 7 | T8 | T5, T6c, and T7c complete |

## Test Plan
- MCP smoke:
  - initialize + initialized notification
  - session reuse
  - tools/list, resources/list/read, prompts/list/get
  - one representative tool call
  - negative cases: invalid tool args, unknown resource URI, invalid prompt args
  - transport cleanup / close behavior
- Metadata parity:
  - canonical descriptor drives runtime registration and `tool_manifest`
  - additive titles/examples/safety hints present
  - no drift between runtime and manifest surfaces
- Tracing:
  - `x-context-engine-request-id` present on HTTP/REST/MCP responses
  - request ID is per request, not per session
  - request ID appears in logs/service correlation
  - request IDs are not emitted as metric labels
- Rerank calibration:
  - gate decision visibility
  - disabled/skipped/invoked/fail-open states
  - forced timeout/error fail-open tests
  - balanced/rich calibration evidence through existing retrieval/perf gates
  - no default behavior change for `fast`
- Workflow readiness:
  - `npm run ci:check:mcp-smoke` is locally reproducible
  - `review_diff.yml` runs the smoke check as a dedicated gate

## Assumptions and Defaults
- The smoke harness uses the current MCP SDK client and existing `/mcp` endpoint; Inspector CLI stays out of CI.
- The discoverability descriptor is the only metadata source of truth; `tool_manifest` will not maintain additive metadata separately.
- Request IDs are HTTP-request scoped; `mcp-session-id` remains session scoped.
- Public tracing change in this wave is limited to the response header; no JSON body changes are planned.
- Rerank work is strictly calibration and observability of the existing pipeline; any default-on profile change requires a separate evidence-backed plan.

## Execution Log
- Status: implemented
- Completed tasks:
  - `T2` real-client MCP smoke harness via `scripts/ci/mcp-smoke.ts`
  - `T3a` and `T3b` canonical discoverability descriptor plus additive runtime/manifest metadata
  - `T4a` and `T4b` discoverability contract coverage plus smoke assertions for canonical titles/metadata
  - `T5` dedicated `ci:check:mcp-smoke` workflow gate in `.github/workflows/review_diff.yml`
  - `T6a`, `T6b`, and `T6c` request context propagation, request-ID log correlation, and `x-context-engine-request-id` response header coverage
  - `T7a`, `T7b`, and `T7c` rerank-path diagnostics, fail-open visibility, and regression coverage
  - `T8` maintainer-ready plan artifact updated with implementation receipts
- Verification:
  - `npm run build`
  - `npm run ci:check:mcp-smoke`
  - `node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/mcp/discoverability.test.ts tests/integration/mcpHttpTransport.test.ts tests/integration/httpCompatibility.test.ts tests/internal/retrieval/rerank.test.ts tests/internal/retrieval/retrieve.test.ts`
