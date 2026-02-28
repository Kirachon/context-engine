# WS19 Quantitative SLO Gate

This document defines deterministic WS19 threshold enforcement from existing CI artifacts only (no external API calls).

Gate script:

```bash
node --import tsx scripts/ci/ws19-slo-gate.ts --family <review|index_search|planning_lifecycle> --artifact <artifact.json>
```

Exit codes:
- `0`: gate pass
- `1`: threshold breach or required metric missing
- `2`: usage/parsing error

## Per-family thresholds

### `review`
- `p95_ms <= 500` (required)
- `error_rate < 1.0%` (optional; skip if unavailable in artifact schema)
- `timeout_rate < 1.0%` (optional; skip if unavailable in artifact schema)
- `throughput` (optional; skip if unavailable)

### `index_search`
- `p95_ms <= 2000` (required)
- `error_rate < 0.5%` (optional; skip if unavailable in artifact schema)
- `timeout_rate < 0.5%` (optional; skip if unavailable in artifact schema)
- `throughput >= 100 files/s` when `payload.files_per_sec` is present
- `throughput >= 10 MB/s` when only `payload.mb_per_sec` is present
- `throughput` skipped when no throughput metric exists in the artifact

### `planning_lifecycle`
- `p95_ms <= 1000` (required)
- `error_rate < 1.0%` (optional; skip if unavailable in artifact schema)
- `timeout_rate < 1.0%` (optional; skip if unavailable in artifact schema)
- `throughput` (optional; skip if unavailable)

## Artifact mapping

### `p95_ms`
- `review`: `stats.duration_ms` (single-run latency proxy for p95)
- `index_search` / `planning_lifecycle`: first available
  - `payload.timing.p95_ms`
  - `payload.elapsed_ms`
  - `total_ms`

### `error_rate`
First available:
- `metrics.error_rate`
- `stats.error_rate`
- `summary.error_rate`
- `error_rate`

### `timeout_rate`
First available:
- `metrics.timeout_rate`
- `stats.timeout_rate`
- `summary.timeout_rate`
- `timeout_rate`

### `throughput`
First available:
- `payload.files_per_sec`
- `payload.mb_per_sec`

## Missing-metric policy

- Required metric (`p95_ms`) missing: **fail** (`exit 1`)
- Optional metric (`error_rate`, `timeout_rate`, `throughput`) missing: **skip with explicit message**

This policy is deterministic and additive; it keeps CI stable while artifact schemas evolve.

## Stale-cache correctness guard

For `index_search` artifacts:
- If mode is `search` or `retrieve`, artifact must indicate cold-path measurement via:
  - `payload.cold === true`, or
  - `payload.bypass_cache === true`
- If mode is `scan` or `index`, guard passes (no retrieval cache path involved)
- Unknown/missing mode: guard is skipped with explicit message

## CI wiring

- PR + nightly performance workflow:
  - `.github/workflows/perf_gates.yml`
  - artifact inputs:
    - `artifacts/bench/pr-candidate.json`
    - `artifacts/bench/nightly-candidate.json`
- Release performance workflow:
  - `.github/workflows/release_perf_gate.yml`
  - artifact input:
    - `artifacts/bench/release/release-candidate-median.json`
- Review workflow:
  - `.github/workflows/review_diff.yml`
  - artifact input:
    - `artifacts/review_diff_result.json`
