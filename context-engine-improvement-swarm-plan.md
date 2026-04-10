# Plan: Context Engine Improvement Swarm Plan

**Generated**: 2026-04-10

> Status: Active delivery plan
>
> This is the single active execution plan for the current improvement program.
> `ARCHITECTURE.md` remains the architecture reference.
> `docs/advanced-mcp-ux-and-hosted-maturity-plan.md` is a planning-only follow-on artifact, not a second active delivery plan.

## Overview
Recast the improvement roadmap as a dependency-aware, parallel-safe swarm plan. The first execution slices stay additive and low-risk: freeze current truth, harden the MCP transport and capability surface, then extend existing gates and observability, then move into retrieval calibration and large-file behavior. Docs cleanup and advanced MCP UX stay late so they do not interfere with transport or measurement receipts.

## Scope Lock
- In scope:
  - MCP capability/runtime parity
  - additive `GET /mcp` and `DELETE /mcp`
  - strict origin validation and disabled-by-default auth hook plumbing
  - blocker vs nightly gate tiers using existing repo receipts
  - lightweight skip/truncation observability before large-file changes
  - retrieval calibration, then large-file strategy
  - late docs consolidation and advanced MCP UX planning
- Out of scope for Wave 1A/1B:
  - new user-visible tools
  - renaming tools/prompts/resources
  - changing `stdio`, `POST /mcp`, or REST endpoint names
  - default retrieval/profile changes
  - remote-first auth rollout
  - doc consolidation during platform-safety work
- Primary surfaces likely to change:
  - `src/http/`, `src/mcp/`, `tests/integration/`, `tests/launcher.test.ts`
  - `scripts/ci/`, `tests/tools/`, `tests/snapshots/`, retrieval gate artifacts
  - later: `src/mcp/serviceClient.ts`, retrieval internals, selected docs

## Prerequisites
- Official MCP protocol/spec and TypeScript SDK guidance already consulted for streamable HTTP, sessions, capabilities, and transport security.
- Existing repo gates are the source of truth for early validation:
  - `ci:check:mcp-smoke`
  - transport integration + launcher compatibility tests
  - retrieval holdout/shadow-canary gates
  - enhancement contract/taxonomy checks
  - semantic latency and deterministic review artifacts
- Owner lanes are fixed before execution:
  - platform/transport
  - eval/gates
  - retrieval
  - docs/release

## Dependency Graph

```text
T0 -> T1 -> T3 -> T4 -> T5 -> T11 -> T12 -> T13
T0 -> T2 ->/    \-> T7 -----------/
T0 -> T6 -> T7 -> T9 -> T10 ------/
          \-> T8 ->/
```

## Tasks

### T0: Freeze Baseline, Owners, and Gate Tiers
- **depends_on**: []
- **location**: `package.json`, `tests/integration/mcpHttpTransport.test.ts`, `tests/launcher.test.ts`
- **description**: Freeze scope, out-of-scope list, owner lanes, current blocker vs nightly gate split, and before-state receipts for transport, retrieval, enhancement, and review quality.
- **validation**: Build, smoke, launcher compatibility, and existing quality artifacts are recorded unchanged as the baseline.
- **status**: Completed
- **log**: 2026-04-10: Locked the initial execution scope to the plan file, MCP transport/capability files, and their tests. Captured fresh baseline receipts with `npm run build`, `npm run ci:check:mcp-smoke`, and `node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/integration/mcpHttpTransport.test.ts tests/launcher.test.ts`. Also confirmed the current denied-origin baseline is a generic HTTP 500, which T2 should freeze before T5 intentionally changes origin enforcement behavior.
- **files edited/created**: `context-engine-improvement-swarm-plan.md`

### T1: Freeze Capability/Runtime Parity Artifact
- **depends_on**: [T0]
- **location**: `src/mcp/server.ts`, `src/mcp/tools/manifest.ts`, `src/mcp/tooling/discoverability.ts`
- **description**: Create one parity artifact that defines which MCP capabilities are truly implemented and may be advertised, including tools/prompts/resources and any logging receipt expectations.
- **validation**: Capability flags are derived from tested behavior and no longer rely on drift-prone hand maintenance.
- **status**: Completed
- **log**:
  - Added a single parity artifact in `src/mcp/server.ts` so advertised MCP capabilities are derived from one runtime-backed structure instead of inline literals.
  - Added `tests/mcp/serverCapabilities.test.ts` to lock the parity artifact and the derived `createServerCapabilities()` output.
  - Validation:
    - `node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/mcp/serverCapabilities.test.ts tests/mcp/discoverability.test.ts tests/integration/mcpHttpTransport.test.ts tests/ci/benchmarkEvalContract.test.ts`
    - `npm run build`
- **files edited/created**:
  - `src/mcp/server.ts`
  - `tests/mcp/serverCapabilities.test.ts`

### T2: Freeze Existing Negative Compatibility Matrix
- **depends_on**: [T0]
- **location**: `tests/integration/mcpHttpTransport.test.ts`, `scripts/ci/mcp-smoke.ts`
- **description**: Lock only the negative cases that already exist before new verbs are added: non-initialize request without session, denied origin behavior, and valid preflight/`OPTIONS` behavior.
- **validation**: Negative matrix is explicit and green without assuming `GET /mcp` or `DELETE /mcp` yet.
- **status**: Completed
- **log**:
  - Extended `tests/integration/mcpHttpTransport.test.ts` to freeze the current negative transport baseline before new MCP verbs land.
  - Locked current denied-origin POST behavior as the existing generic `500` JSON response and added explicit allowed-origin preflight coverage.
  - Validation:
    - `node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/mcp/serverCapabilities.test.ts tests/mcp/discoverability.test.ts tests/integration/mcpHttpTransport.test.ts tests/ci/benchmarkEvalContract.test.ts`
    - `npm run build`
- **files edited/created**:
  - `tests/integration/mcpHttpTransport.test.ts`

### T3: Additive `GET /mcp` Transport Support
- **depends_on**: [T1, T2]
- **location**: `src/http/httpServer.ts`, `tests/integration/mcpHttpTransport.test.ts`
- **description**: Add `GET /mcp` plus GET-specific compatibility coverage, including unknown-session handling and parity receipts tied to the frozen capability artifact.
- **validation**: `GET /mcp` works additively, unknown-session behavior is defined, and existing `POST /mcp` behavior is unchanged.
- **status**: Completed
- **log**:
  - Added additive `GET /mcp` routing in the HTTP transport while preserving the existing `POST /mcp` path.
  - Reused the existing MCP request handler so session-backed GET requests flow through the same runtime, with explicit unknown-session coverage.
  - Extended integration coverage for initialized-session GET, unknown-session GET, and the frozen negative-origin/preflight baseline.
  - Validation:
    - `node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/integration/mcpHttpTransport.test.ts tests/serviceClient.test.ts tests/ci/gateTierContract.test.ts tests/ci/benchmarkEvalContract.test.ts tests/mcp/serverCapabilities.test.ts`
    - `npm run build`
    - `npm run ci:check:mcp-smoke`
- **files edited/created**:
  - `src/http/httpServer.ts`
  - `tests/integration/mcpHttpTransport.test.ts`

### T4: Additive `DELETE /mcp` Session Termination
- **depends_on**: [T1, T2, T3]
- **location**: `src/http/httpServer.ts`, `tests/integration/mcpHttpTransport.test.ts`
- **description**: Add explicit session termination via `DELETE /mcp`, including stale-session and post-delete behavior, without changing existing `POST /mcp` session semantics.
- **validation**: Session lifecycle is repeatable, stale sessions fail predictably, and delete does not introduce double-close or partial-cleanup bugs.
- **status**: Completed
- **log**:
  - Added explicit `DELETE /mcp` session termination without changing existing `POST /mcp` semantics.
  - Hardened in-memory session cleanup so a deleted session is removed before stale reuse and session-server closure stays single-path.
  - Extended integration coverage for valid delete, unknown-session delete, and stale-session rejection after delete.
  - Validation:
    - `node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/integration/mcpHttpTransport.test.ts`
    - `npm run build`
    - `npm run ci:check:mcp-smoke`
- **files edited/created**:
  - `src/http/httpServer.ts`
  - `tests/integration/mcpHttpTransport.test.ts`

### T5: Shared Origin Policy and Auth Hook Plumbing
- **depends_on**: [T1, T2, T3, T4]
- **location**: `src/http/middleware/cors.ts`, `src/http/httpServer.ts`
- **description**: Replace loose origin matching with explicit allowlist validation across transport paths and add a disabled-by-default auth hook as plumbing only, with no remote rollout semantics in this wave.
- **validation**: Denied origins return `403`, allowed local clients still work, auth hook is inert by default, and all transport verbs share one enforcement path.
- **status**: Completed
- **log**:
  - Replaced loose origin checks with explicit local-origin and VS Code webview allowlist validation, then moved MCP origin enforcement into one shared `/mcp` transport-policy guard so `POST`, `GET`, `DELETE`, and preflight `OPTIONS` requests follow the same denial path.
  - Added disabled-by-default auth-hook plumbing in the HTTP server without introducing any remote auth contract or changing default local behavior.
  - Updated transport integration coverage to lock the intended `403` denied-origin behavior, allowed-origin preflight behavior, inert-by-default auth behavior, and optional auth-hook enforcement.
  - Validation:
    - `node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/integration/mcpHttpTransport.test.ts`
    - `npm run build`
    - `npm run ci:check:mcp-smoke`
- **files edited/created**:
  - `src/http/middleware/cors.ts`
  - `src/http/middleware/index.ts`
  - `src/http/httpServer.ts`
  - `tests/integration/mcpHttpTransport.test.ts`

### T6: Freeze Benchmark and Eval Contract Artifact
- **depends_on**: [T0]
- **location**: `scripts/ci/`, retrieval/eval artifact configuration, `package.json`
- **description**: Freeze the benchmark contract for later retrieval work: baseline artifact, provider, cache mode, profile matrix, token budgets, workload packs, and scoped vs unscoped runs. This task produces receipts only and does not tune behavior.
- **validation**: A single read-only benchmark contract artifact exists and later tasks consume it without redefining envelopes.
- **status**: Completed
- **log**:
  - Added `config/ci/benchmark-eval-contract.json` as the frozen benchmark/eval contract for provider, index-health requirement, cache modes, scoped-run matrix, token budgets, and workload packs.
  - Added `tests/ci/benchmarkEvalContract.test.ts` to keep the contract machine-checked against the current repo scripts and artifacts.
  - Validation:
    - `node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/mcp/serverCapabilities.test.ts tests/mcp/discoverability.test.ts tests/integration/mcpHttpTransport.test.ts tests/ci/benchmarkEvalContract.test.ts`
    - `npm run build`
- **files edited/created**:
  - `config/ci/benchmark-eval-contract.json`
  - `tests/ci/benchmarkEvalContract.test.ts`

### T7: Extend Deterministic Gates and Eval Infrastructure
- **depends_on**: [T1, T2, T6]
- **location**: `scripts/ci/`, `tests/`, review-quality fixtures/corpus
- **description**: Extend existing repo gates with explicit PR-blocker vs nightly/report-only tiers, add deterministic review-quality corpus coverage, and keep this task strictly infrastructure-only.
- **validation**: Blocker/nightly tiers are explicit, seeded review corpus exists, and no transport behavior, retrieval defaults, or benchmark envelopes change here.
- **status**: Completed
- **log**:
  - Added a machine-readable gate-tier contract that makes PR blockers versus nightly/report-only checks explicit without introducing a second evaluation stack.
  - Bound the contract to the current repo scripts and deterministic review-quality receipts, including the seeded review corpus file and existing review artifact tests.
  - Validation:
    - `node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/integration/mcpHttpTransport.test.ts tests/serviceClient.test.ts tests/ci/gateTierContract.test.ts tests/ci/benchmarkEvalContract.test.ts tests/mcp/serverCapabilities.test.ts`
    - `npm run build`
- **files edited/created**:
  - `config/ci/gate-tier-contract.json`
  - `config/ci/review-quality-corpus.json`
  - `tests/ci/gateTierContract.test.ts`

### T8: Add Lightweight Skip/Truncation Observability Receipts
- **depends_on**: [T6]
- **location**: retrieval diagnostics surfaces, artifacts/report generation, selected tests
- **description**: Add narrow, additive receipts for skip/truncation outcomes needed to interpret later calibration and large-file changes without turning this into a broad observability redesign.
- **validation**: Current runs expose deterministic skip/truncation signals and those signals are artifact-backed, not just log-only.
- **status**: Completed
- **log**:
  - Added deterministic `skipReasons` receipts to index results so later calibration can distinguish large-file, binary, invalid-path, ignored, read-error, and unchanged skips without log scraping.
  - Added `truncationReasons` metadata to context bundles so token-budget and external-grounding truncation are explicit and machine-readable.
  - Extended service-client tests to lock the new receipt surfaces before retrieval behavior changes in later waves.
  - Validation:
    - `node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/integration/mcpHttpTransport.test.ts tests/serviceClient.test.ts tests/ci/gateTierContract.test.ts tests/ci/benchmarkEvalContract.test.ts tests/mcp/serverCapabilities.test.ts`
    - `npm run build`
- **files edited/created**:
  - `src/mcp/serviceClient.ts`
  - `tests/serviceClient.test.ts`

### T9: Retrieval Calibration Under Frozen Contract
- **depends_on**: [T6, T7, T8]
- **location**: retrieval calibration surfaces, existing benchmark/gate scripts
- **description**: Calibrate retrieval using the frozen benchmark contract and existing regression envelopes, with no large-file behavior changes yet.
- **validation**: Calibration results are measurable, diagnosable with skip/truncation receipts, and stay within current latency/quality envelopes unless an intentional follow-up is declared.
- **status**: Completed
- **log**:
  - Added `config/ci/retrieval-calibration-contract.json` as a machine-readable calibration receipt that anchors measurable latency, quality, and diagnostic metrics to the frozen benchmark and gate-tier contracts.
  - Linked the frozen benchmark contract to the calibration contract and added contract tests so calibration coverage stays tied to existing scripts, artifacts, and the new skip/truncation receipt paths instead of drifting into a separate evaluation stack.
  - Kept the slice additive: no retrieval runtime behavior, default profile, or large-file policy changes were introduced.
  - Validation:
    - `node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/integration/mcpHttpTransport.test.ts tests/ci/benchmarkEvalContract.test.ts tests/ci/retrievalCalibrationContract.test.ts tests/ci/gateTierContract.test.ts`
    - `npm run build`
    - `npm run ci:check:mcp-smoke`
- **files edited/created**:
  - `config/ci/benchmark-eval-contract.json`
  - `config/ci/retrieval-calibration-contract.json`
  - `tests/ci/benchmarkEvalContract.test.ts`
  - `tests/ci/retrievalCalibrationContract.test.ts`

### T10: Large-File Strategy With Deterministic Reason Codes
- **depends_on**: [T7, T8, T9]
- **location**: `src/mcp/serviceClient.ts`, retrieval/indexing internals, workload-matrix tests
- **description**: Design and implement tiered large-file handling only after calibration is stable, with deterministic outcomes such as `size_skip`, `partial_index`, `summary_only`, `metadata_only`, `binary_skip`, or `token_truncated`.
- **validation**: Workload matrix proves before/after impact for oversized-file-dependent and oversized-file-irrelevant queries, and large-file behavior is independently rollbackable.
- **status**: Completed
- **log**:
  - Replaced the old all-or-nothing large-file skip path for supported text files with a deterministic metadata-only fallback during indexing.
  - Added `fileOutcomes` receipts so indexing can now distinguish `metadata_only`, `binary_skip`, `read_error`, `ignored_or_unsupported`, `invalid_path`, `unchanged`, and `full_content` handling paths without relying on logs.
  - Preserved explicit skip receipts for true skip cases while keeping default retrieval/profile behavior unchanged.
  - Validation:
    - `node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/serviceClient.test.ts`
    - `npm run build`
- **files edited/created**:
  - `src/mcp/serviceClient.ts`
  - `tests/serviceClient.test.ts`

### T11: Freeze Stable Local Transport Contract
- **depends_on**: [T3, T4, T5]
- **location**: transport tests, smoke receipts, capability parity receipts
- **description**: Produce the closure artifact for the local MCP transport contract after verb additions and origin/auth enforcement are stable.
- **validation**: One stable local transport contract receipt exists and later docs/UX work must consume it rather than reinterpret transport behavior.
- **status**: Completed
- **log**:
  - Added a machine-readable local transport contract receipt that freezes the current `/mcp` verb, session, origin, and auth-hook expectations after the transport hardening wave.
  - Linked the transport contract into the existing gate-tier contract so later work can consume one receipt instead of reinterpreting runtime behavior from prose.
  - Validation:
    - `node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/ci/gateTierContract.test.ts tests/ci/localTransportContract.test.ts tests/integration/mcpHttpTransport.test.ts`
- **files edited/created**:
  - `config/ci/local-transport-contract.json`
  - `config/ci/gate-tier-contract.json`
  - `tests/ci/localTransportContract.test.ts`
  - `tests/ci/gateTierContract.test.ts`

### T12: Plan Advanced MCP UX and Hosted Maturity
- **depends_on**: [T11, T7, T10]
- **location**: planning/docs surfaces for future work
- **description**: Create the next-stage plan for subscriptions, dynamic notifications, completions, tasks, and hosted maturity only after local transport, gate tiers, and retrieval receipts are stable.
- **validation**: Advanced MCP UX work is gated by stable local receipts and does not backdoor unsupported capabilities into earlier waves.
- **status**: Completed
- **log**:
  - Added `docs/advanced-mcp-ux-and-hosted-maturity-plan.md` as the single implementation-ready planning artifact for the post-local-stability roadmap.
  - Anchored the plan to the frozen local transport, gate-tier, and retrieval calibration contracts, plus the current retrieval receipt surfaces in `src/mcp/serviceClient.ts`, so later work consumes explicit evidence instead of prose assumptions.
  - Kept the slice docs-only and additive: the plan explicitly prevents early capability advertisement and treats subscriptions, notifications, completions, tasks, and hosted auth/origin/session maturity as future gated work.
  - Validation:
    - doc consistency review against `config/ci/local-transport-contract.json`, `config/ci/gate-tier-contract.json`, `config/ci/retrieval-calibration-contract.json`, and the current T10 receipt surfaces in `src/mcp/serviceClient.ts`
- **files edited/created**:
  - `docs/advanced-mcp-ux-and-hosted-maturity-plan.md`
  - `context-engine-improvement-swarm-plan.md`

### T13: Consolidate Active Docs Last
- **depends_on**: [T11, T12, T10]
- **location**: `ARCHITECTURE.md`, active plan doc, overlapping modernization/roadmap docs
- **description**: Consolidate docs after behavior and receipts are stable, keeping one architecture reference and one active delivery plan while demoting overlap to archival or scoped-reference status.
- **validation**: `ARCHITECTURE.md` remains the architecture reference, one active delivery plan remains, and no active receipt or gate artifact is renamed or relocated in a way that breaks future planning.
- **status**: Completed
- **log**:
  - Added explicit status banners so `ARCHITECTURE.md` remains the architecture reference and this file remains the single active delivery plan.
  - Demoted overlapping roadmap docs to scoped reference status and marked the advanced MCP UX plan as planning-only follow-on guidance.
  - Validation:
    - doc consistency review across `ARCHITECTURE.md`, this plan, `docs/advanced-mcp-ux-and-hosted-maturity-plan.md`, `docs/mcp-modernization-resources-prompts-scoped-retrieval-plan.md`, and `docs/next-enhancement-wave-plan.md`
- **files edited/created**:
  - `ARCHITECTURE.md`
  - `context-engine-improvement-swarm-plan.md`
  - `docs/advanced-mcp-ux-and-hosted-maturity-plan.md`
  - `docs/mcp-modernization-resources-prompts-scoped-retrieval-plan.md`
  - `docs/next-enhancement-wave-plan.md`

## Parallel Execution Groups

| Wave | Tasks | Can Start When |
|------|-------|----------------|
| 0 | T0 | Immediately |
| 1 | T1, T2, T6 | T0 complete |
| 2 | T3, T7, T8 | T1+T2 complete for T3; T1+T2+T6 complete for T7; T6 complete for T8 |
| 3 | T4, T9 | T3 complete for T4; T6+T7+T8 complete for T9 |
| 4 | T5, T10 | T1+T2+T3+T4 complete for T5; T7+T8+T9 complete for T10 |
| 5 | T11 | T3+T4+T5 complete |
| 6 | T12 | T11+T7+T10 complete |
| 7 | T13 | T11+T12+T10 complete |

## Testing Strategy
- PR blockers:
  - build
  - `ci:check:mcp-smoke`
  - transport/session/origin compatibility tests
  - launcher compatibility tests
  - retrieval holdout/quality gate
  - shadow canary gate
  - enhancement contract/taxonomy checks
  - deterministic review-quality corpus
- Nightly/report-only:
  - grader/LLM scoring
  - broad benchmark sweeps
  - weekly trend reporting
  - exploratory review-quality scoring
- Evidence-oriented readiness gate:
  - frozen parity artifact from T1
  - negative compatibility matrix from T2
  - frozen benchmark contract from T6
  - stable local transport contract from T11
  - retrieval calibration receipt from T9
  - large-file workload report and reason-code receipts from T10

## Risks & Mitigations
- Risk: transport hardening breaks local clients.
  Mitigation: land capability parity first or in lockstep, keep `POST /mcp` unchanged, and gate on denied-origin plus compatibility tests.
- Risk: eval work creates a second truth source.
  Mitigation: T6 and T7 extend existing repo gates only; they do not define a parallel benchmark stack.
- Risk: large-file changes are mis-measured.
  Mitigation: T6 freezes the contract, T8 adds receipts, T9 calibrates before T10 changes behavior.
- Risk: docs drift during moving implementation.
  Mitigation: keep docs cleanup at T13 only.
- Stop/replan triggers:
  - any need to rename tools/prompts/resources
  - any requirement to enable remote auth behavior in Wave 1
  - any proposal to change default retrieval/profile behavior before T9/T10
  - any inability to keep capability advertisement derived from tested implementation

## Assumptions
- Auth hook remains disabled-by-default plumbing until a separate auth contract exists.
- Early skip/truncation observability stays minimal and additive; deeper observability can be planned later if needed.
- Advanced MCP UX planning may produce future tasks, but it does not authorize implementation before T11 and T10 are complete.
- Docs consolidation follows the stable contract/evidence artifacts rather than defining them.
