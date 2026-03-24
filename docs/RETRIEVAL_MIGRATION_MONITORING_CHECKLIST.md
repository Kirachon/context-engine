# Retrieval Migration Monitoring Checklist

Purpose:
- Track what is already implemented vs pending for legacy provider removal and retrieval-provider migration.
- Use as the operational source of truth for rollout readiness and cutover decisions.

Last updated: 2026-03-04

## A. Core Provider Migration

- [x] Added retrieval provider ID/type scaffolding (`legacy_provider`, `local_native`).
- [x] Added retrieval env resolver (`CE_RETRIEVAL_PROVIDER`, `CE_RETRIEVAL_FORCE_LEGACY`, shadow flags).
- [x] Added provider wrapper classes (legacy provider/local native).
- [x] Added `getActiveRetrievalProviderId()` in `ContextServiceClient`.
- [x] Switched semantic-search cache key namespace to retrieval provider ID.
- [x] Added non-blocking sampled shadow compare path in semantic search.
- [x] Added deterministic `local_native` fallback for indexing lifecycle paths (`indexWorkspace`, `indexFiles`) to avoid DirectContext dependency when selected.
- [x] Removed direct legacy SDK import ownership from `ContextServiceClient`; legacy loading now lives under provider runtime ownership.
- [x] Extract remaining direct-context lifecycle/orchestration logic fully out of `ContextServiceClient` into the legacy runtime implementation.
- [x] Route all index lifecycle/search through a single provider factory/registry (no provider branching in `ContextServiceClient` except factory call).

## B. State/Cache Safety

- [x] Add `provider_id` and `schema_version` to index state payloads in `JsonIndexStateStore`.
- [x] Validate state payload compatibility on load; fail safe with clear warning.
- [x] Prevent cache/state cross-contamination between providers beyond cache keying (state migration guards).
- [x] Add compatibility tests for loading old state without `provider_id/schema_version`.

## C. CI Safety Gates

- [x] Add dependency leak gate script:
  - fail if runtime retrieval code references the legacy SDK boundary outside the allowlisted provider runtime.
- [x] Add retrieval config precedence contract tests/gate:
  - `CE_RETRIEVAL_FORCE_LEGACY` precedence and invalid value behavior.
- [x] Add scoped dist/source parity check for retrieval/provider modules.
- [x] Wire new gates into `.github/workflows/review_diff.yml`.
- [x] Current dist parity gate clean on latest local validation pass.
- [x] Boundary sentinel test now enforces provider-runtime-only ownership for legacy SDK/`DirectContext` access (allowlist scoped to `src/retrieval/providers/legacyRuntime.ts`).

## D. Benchmark/Perf and Workflow Alignment

- [x] Bench script no longer hard-requires a legacy API token in all modes.
- [x] Bench suite mode selection not solely token-gated.
- [x] Added retrieval provider label in bench output/provenance.
- [x] Add provider matrix lanes in perf workflows (`local_native` required, legacy provider optional when secrets present).
- [x] Add parity artifact generation + CI threshold gates (overlap/reliability/perf deltas).

## E. Metadata/Docs

- [x] `codeReviewService` `model_used` now derived from active provider/model label with legacy fallback.
- [x] CLI help updated with retrieval provider env variable.
- [x] Package metadata wording moved away from legacy-SDK-first phrasing.
- [x] Replace remaining runtime/user-facing hardcoded legacy-SDK labels where no compatibility reason exists.

## F. Rollout Operations

- [x] Add explicit rollback drill checklist/runbook artifact in repo (`rollback_event`, RTO evidence).
  - Artifact: `docs/WS21_ROLLBACK_DRILL_TEMPLATE.md` (validated by `scripts/ci/check-ws21-rollback-drill.ts`).
- [x] Add measurable go/no-go thresholds as machine-readable config for CI enforcement.
  - Config: `config/rollout-go-no-go-thresholds.json` (enforced by `scripts/ci/ws20-stage-gate.ts`).
- [x] Execute staged cutover gates:
  - `1% -> 10% -> 50% -> 100%` with automatic freeze/rollback triggers.
  - Evidence bundle: `docs/rollout-evidence/2026-03-04/`
  - WS20 artifacts: `ws20-stage1-canary-1pct.yaml`, `ws20-stage2-ramp-10-50.yaml`, `ws20-stage3-ga-100pct.yaml`
  - Trigger evidence: `freeze-rollback-triggers.json`, `ws21-rollback-drill-log.md`
  - Gate outputs: `ws20-stage1-gate-output.log`, `ws20-stage2-gate-output.log`, `ws20-stage3-gate-output.log`, `ws21-drill-check-output.log`, `readiness-check-output.log`

## Evidence to attach before default flip

- [x] Passing CI-equivalent local gate suite with new retrieval gates.
- [x] Provider parity report artifact generated for baseline/candidate replay.
- [x] Rollback drill evidence (>= 3 successful runs, target RTO met).
- [x] No contract regressions across `semantic_search`, `codebase_retrieval`, `enhance_prompt`, `review_auto`.

## Latest local validation pass (2026-03-04)

- `npm run -s ci:check:retrieval-dependency-boundary` -> PASS (`Scanned 6 runtime retrieval file(s).`)
- `npm run -s test -- tests/ci/checkRetrievalProviderBoundary.test.ts` -> PASS (`5 tests, 5 passed`)
- `npm run -s ci:check:retrieval-config-precedence` -> PASS
- `npm run -s ci:check:retrieval-provider-dist-parity` -> PASS (`Checked 6 retrieval provider module(s).`)
- `npm run -s ci:check:governance-artifacts` -> PASS (`checks=30`)
- `npm run -s ci:check:ws21-rollback-drill` -> PASS
- `node --import tsx scripts/ci/check-rollout-readiness.ts` -> PASS
- `npm run -s test -- tests/ci/checkGovernanceArtifacts.test.ts` -> PASS (`3 tests, 3 passed`)
- `npm run -s test -- tests/ci/retrievalParityGate.test.ts` -> PASS (`3 tests, 3 passed`)
- `node --import tsx scripts/ci/retrieval-parity-gate.ts --bench-baseline artifacts/bench/pr-baseline.json --bench-candidate artifacts/bench/pr-candidate.json --out docs/rollout-evidence/2026-03-04/retrieval-parity-report.json` -> PASS (`gate_status=pass`)
- `npm test -- --runInBand tests/tools/search.test.ts tests/tools/codebaseRetrieval.test.ts tests/tools/enhance.test.ts tests/tools/reviewAuto.test.ts` -> PASS (`4 suites, 73 tests`)
- `node --import tsx scripts/ci/ws20-stage-gate.ts --artifact docs/rollout-evidence/2026-03-04/ws20-stage1-canary-1pct.yaml --stage 1` -> PASS (`checks=9`)
- `node --import tsx scripts/ci/ws20-stage-gate.ts --artifact docs/rollout-evidence/2026-03-04/ws20-stage2-ramp-10-50.yaml --stage 2` -> PASS (`checks=18`)
- `node --import tsx scripts/ci/ws20-stage-gate.ts --artifact docs/rollout-evidence/2026-03-04/ws20-stage3-ga-100pct.yaml --stage 3` -> PASS (`checks=8`)
- `node --import tsx scripts/ci/check-ws21-rollback-drill.ts docs/rollout-evidence/2026-03-04/ws21-rollback-drill-log.md` -> PASS
- `node --import tsx scripts/ci/check-rollout-readiness.ts docs/rollout-evidence/2026-03-04/ws20-stage1-gate-output.log docs/rollout-evidence/2026-03-04/ws20-stage2-gate-output.log docs/rollout-evidence/2026-03-04/ws20-stage3-gate-output.log docs/rollout-evidence/2026-03-04/ws21-drill-check-output.log docs/rollout-evidence/2026-03-04/freeze-rollback-triggers.json` -> PASS

Boundary ownership note:
- `src/mcp/serviceClient.ts` no longer directly imports the legacy SDK.
- Legacy SDK/`DirectContext` ownership boundary is scoped to provider runtime modules and currently allowlisted at `src/retrieval/providers/legacyRuntime.ts`.
- `ContextServiceClient` delegates legacy runtime initialization/orchestration through `ensureLegacyRuntimeContext(...)` in `src/retrieval/providers/legacyRuntime.ts`; lifecycle ownership now resides at the provider runtime boundary.
