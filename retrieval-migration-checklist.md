# OpenAI Retrieval Migration Checklist

## Scope
- [ ] Migrate `semantic_search` and `codebase_retrieval` retrieval backend from Auggie retrieval-only to OpenAI-backed local vector option.
- [ ] Keep public tool contracts unchanged.
- [ ] Preserve `searchAndAsk` path as separate `AIProvider` concern.

## M1 – Safe Scaffold (No Behavior Change)
- [ ] Add retrieval provider abstraction layer.
  - [ ] Add `RetrievalProvider` interface (`search`, `indexWorkspace`, `indexFiles`, `clearIndex`, `getIndexStatus`, `health`).
  - [ ] Add provider IDs: `augment`, `openai_local_vector`.
  - [ ] Add retrieval provider factory.
- [ ] Implement/port Auggie retrieval provider as adapter.
  - [ ] Move all `DirectContext.search` formatted parsing into Auggie retrieval provider.
  - [ ] Keep existing behavior when `CE_RETRIEVAL_PROVIDER=augment`.
- [ ] Add provider-scoped cache and index paths.
  - [ ] Namespace by provider + model + chunking profile + index fingerprint.
  - [ ] Ensure no cache cross-contamination between providers.
- [ ] Route `semanticSearch` + index lifecycle through retrieval provider.
  - [ ] `ContextServiceClient.semanticSearch`
  - [ ] `indexWorkspace`
  - [ ] `indexFiles`
  - [ ] `clearIndex`
- [ ] Add runtime preflight for active retrieval provider.
  - [ ] Verify writable index path.
  - [ ] Verify provider env settings are valid.
  - [ ] Verify index fingerprint/state compatibility.
- [ ] Observability schema for retrieval.
  - [ ] Emit backend/mode tags in retrieval metrics.
  - [ ] Add structured logs with `backend`, `mode`, `fallback_reason`, `query_hash`, `duration_ms`.
- [ ] Preserve contract compatibility.
  - [ ] `semantic_search` output shape and empty-result behavior.
  - [ ] `codebase_retrieval` JSON schema and metadata fields unchanged.
- [ ] Validation (no implementation changes visible to clients).
  - [ ] Targeted tool contract tests pass.
  - [ ] Existing snapshot baselines pass.
  - [ ] CI performance guardrails unchanged.

## M2 – OpenAI Vector Provider + Shadow
- [ ] Implement `openai_local_vector` provider.
  - [ ] Deterministic chunking and embedding pipeline.
  - [ ] Local artifact format and manifest persisted under namespaced path.
  - [ ] Incremental indexing via file hash map.
  - [ ] Query embedding + vector scoring + normalized `SearchResult` mapping.
- [ ] Add environment controls.
  - [ ] `CE_RETRIEVAL_PROVIDER`
  - [ ] `CE_RETRIEVAL_OPENAI_EMBED_MODEL`
  - [ ] `CE_RETRIEVAL_OPENAI_BATCH_SIZE`
  - [ ] `CE_RETRIEVAL_OPENAI_MAX_RETRIES`
  - [ ] `CE_RETRIEVAL_OPENAI_TIMEOUT_MS`
  - [ ] `CE_RETRIEVAL_SHADOW_MODE`
  - [ ] `CE_RETRIEVAL_SHADOW_SAMPLE_RATE`
  - [ ] `CE_RETRIEVAL_SHADOW_TIMEOUT_MS`
- [ ] Add non-blocking shadow execution.
  - [ ] Primary response from active provider.
  - [ ] Shadow result only for telemetry.
  - [ ] Shadow timeout hard cap and failure isolation.
- [ ] Add rollout safety controls.
  - [ ] `CE_RETRIEVAL_FORCE_AUGGIE`
  - [ ] `CE_RETRIEVAL_CANARY_PERCENT`
- [ ] Add divergence and quality metrics.
  - [ ] overlap@k
  - [ ] unique_files@k
  - [ ] latency delta
  - [ ] zero-result and error rates by backend
- [ ] Add quality gate enforcement script.
  - [ ] Fail if overlap < 0.85 or unique file drop > 10%.

## M3 – Canary
- [ ] Enable OpenAI primary on canary slice.
  - [ ] Ramp `5% -> 25% -> 50%`.
  - [ ] Validate each stage holds for configured window.
- [ ] Keep fallback path active.
  - [ ] Per-query fail-open to Auggie on timeout/unhealthy/retry exhaustion.
  - [ ] Log and count fallback reason.
- [ ] Add canary rollback triggers.
  - [ ] Error-rate breach threshold.
  - [ ] Zero-result-rate breach.
  - [ ] Overlap/unique_files gate regression.
  - [ ] Latency p95 breach.
- [ ] Run blast-radius checks.
  - [ ] `get_context_for_prompt`
  - [ ] enhancement path
  - [ ] HTTP tool endpoints

## M4 – Default Switch
- [ ] Set OpenAI local-vector as default backend.
- [ ] Retain one-button rollback controls.
- [ ] Keep reduced shadowing for burn-in window.
- [ ] Confirm runbook and rollback evidence.
- [ ] Final docs update and operator-facing docs.
- [ ] 24h stability window with no P1/P0 incidents.

## Contract / Regression Tests
- [ ] Required unit/integration tests
  - [ ] `codebase_retrieval` output schema unchanged.
  - [ ] `semantic_search` output schema unchanged.
  - [ ] Provider resolution + env validation.
  - [ ] Retrieval-provider contract tests.
  - [ ] Cache isolation tests.
  - [ ] Index lifecycle tests (`indexWorkspace`, `indexFiles`, `clearIndex`).
  - [ ] Failure-injection tests.
    - [ ] Timeout
    - [ ] 429 and retries
    - [ ] malformed parse / provider malformed response
    - [ ] corrupted local index
    - [ ] partial variant failures
- [ ] CI and gate coverage
  - [ ] Baseline and replay snapshots.
  - [ ] Old-client fixture parity.
  - [ ] WS19 SLO checks.
  - [ ] bench:pr, bench:nightly, bench:release thresholds.
  - [ ] overlap and unique_files gates enabled.

## Deployment & Rollback
- [ ] Document mixed OS gotchas.
  - [ ] `CE_HASH_NORMALIZE_EOL=true` policy.
  - [ ] path normalization.
  - [ ] worker/index-mode startup preflight.
- [ ] Rollback drill executed.
  - [ ] Set `CE_RETRIEVAL_FORCE_AUGGIE=true`.
  - [ ] Set `CE_RETRIEVAL_SHADOW_MODE=false`.
  - [ ] Set `CE_RETRIEVAL_CANARY_PERCENT=0`.
  - [ ] Restart and validate metrics return to baseline.
