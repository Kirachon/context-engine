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
