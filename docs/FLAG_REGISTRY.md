# Flag Registry

Runtime and rollout control flags used by operators.

## Governance flags

| Flag | Type | Default | Owner | Purpose |
| --- | --- | --- | --- | --- |
| `CE_ROLLOUT_KILL_SWITCH` | boolean | `false` | On-call operator | Immediate runtime-first stop for new rollout behavior. |
| `CE_ROLLOUT_STAGE` | string | `dark_launch` | Release owner | Current active stage: `dark_launch`, `canary`, `controlled_ramp`, `ga_hardening`. |
| `CE_ROLLOUT_CANARY_PERCENT` | integer | `5` | Release owner | Percent of traffic in canary or controlled ramp. |
| `CE_ROLLOUT_ENFORCE_GATES` | boolean | `true` | Release owner | Blocks stage progression when KPI gates fail. |
| `CE_ROLLOUT_BASELINE_ID` | string | empty | Perf owner | Baseline dataset/run identifier used for gate comparisons. |
| `CE_RETRIEVAL_HYBRID_V1` | boolean | `false` | Search owner | Enables hybrid retrieval planning signals (semantic + keyword + symbol-aware). |
| `CE_RETRIEVAL_RANKING_V3` | boolean | `false` | Search owner | Enables stronger ranking signal set (v3) behind staged rollout. |
| `CE_CONTEXT_PACKS_V2` | boolean | `false` | Search owner | Enables richer context-pack output sections (why selected + dependency map). |
| `CE_RETRIEVAL_QUALITY_GUARD_V1` | boolean | `false` | Search owner | Enables quality-guard state reporting and blend/revert fallback controls. |
| `CE_RETRIEVAL_PROVIDER_V2` | boolean | `false` | Search owner | Enables provider-level V2 migration seam hooks while keeping legacy behavior as default. |
| `CE_RETRIEVAL_ARTIFACTS_V2` | boolean | `false` | Search owner | Enables versioned retrieval artifact metadata hooks for V2 migration evidence. |
| `CE_RETRIEVAL_SHADOW_CONTROL_V2` | boolean | `false` | Search owner | Enables V2 shadow/canary control-plane hooks without changing default caller responses. |

## Queue policy flags

Queue saturation is controlled by the search queue. Roll it out with `observe -> shadow -> enforce`.

| Flag | Type | Default | Owner | Purpose | Rollout use |
| --- | --- | --- | --- | --- | --- |
| `CE_SEARCH_AND_ASK_QUEUE_MAX` | integer | `50` | Search owner | Maximum in-flight + waiting requests for the interactive lane before saturation handling starts. | Start here during dark launch sizing. |
| `CE_SEARCH_AND_ASK_QUEUE_MAX_BACKGROUND` | integer | `50` | Search owner | Maximum queue size for the background lane. Keep this separate from interactive pressure. | Tune alongside the interactive cap when background work is expected. |
| `CE_SEARCH_AND_ASK_QUEUE_REJECT_MODE` | string | `enforce` | Search owner | Saturation mode: `observe`, `shadow`, or `enforce`. | Use `observe` first, `shadow` during sampled rehearsal, `enforce` only after rollout evidence is green. |

Reject mode guidance:
- `observe`: log saturation only. Do not reject requests. Use for initial dark launch and baseline collection.
- `shadow`: keep the user-visible path unchanged while monitoring saturation during sampled traffic or shadow rehearsal.
- `enforce`: reject overflow with `retry_after_ms`. Use only after observe/shadow evidence shows the queue caps are safe.

## Retrieval fallback and shadow flags

These env vars belong to the retrieval fallback domain, not the AI-provider runtime contract.

| Flag | Type | Default | Owner | Purpose |
| --- | --- | --- | --- | --- |
| `CE_SEMANTIC_EMPTY_ARRAY_COMPAT_FALLBACK` | boolean | `false` | Search owner | When the semantic provider returns explicit `[]`, allow a keyword fallback for compatibility with older retrieval behavior. |
| `CE_SEMANTIC_PARALLEL_FALLBACK` | boolean | `false` | Search owner | Warm the keyword fallback in parallel with the provider call so retrieval can recover faster on provider failure. |
| `CE_RETRIEVAL_SHADOW_COMPARE_ENABLED` | boolean | `false` | Search owner | Sample shadow comparisons between provider-backed retrieval and the fallback path. |
| `CE_RETRIEVAL_SHADOW_SAMPLE_RATE` | number | `0` | Search owner | Shadow comparison sampling rate between `0` and `1`. |

## Existing performance and telemetry flags (reference)

| Flag | Purpose |
| --- | --- |
| `CE_METRICS` | Enable in-process metrics collection. |
| `CE_HTTP_METRICS` | Expose HTTP `/metrics` endpoint when HTTP server is enabled. |
| `CE_TOOL_RESPONSE_CACHE` | Enable cross-request tool response caching (when index state is enabled). |
| `CE_SKIP_UNCHANGED_INDEXING` | Skip indexing unchanged files (when index state is enabled). |

## Operator usage

Enable kill switch:

```bash
export CE_ROLLOUT_KILL_SWITCH=true
```

Set stage:

```bash
export CE_ROLLOUT_STAGE=canary
export CE_ROLLOUT_CANARY_PERCENT=10
```

## Change policy

- Additive only: new flags must not break existing defaults.
- Any default change requires update to `docs/CONTRACT_FREEZE.md`.
- `CE_ROLLOUT_KILL_SWITCH` semantics are frozen for this rollout.
