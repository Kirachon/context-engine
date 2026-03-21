# Benchmarking

This repo includes an opt-in benchmark harness to quantify performance changes without running production traffic.

For consistent comparisons over time, also follow `docs/PERF_DATASET.md`.

Release-stream KPI contract for the user-visible retrieval upgrade:
- Relevance: `nDCG@10 >= +8%`, `MRR@10 >= +6%`, `Recall@50 >= +10%` vs approved baseline.
- Latency on large dataset: `p50 <= -20%`, `p95 <= -25%` vs approved baseline.
- Reliability: no error-rate regression and fallback-state checks must pass.

For the first stabilization wave, treat the benchmark slice matrix in `docs/PERF_DATASET.md` as part of the contract. The Track A goal is `no-regression + reliability`; use latency as a diagnostic signal until the new baseline is stable.

## Quick Start

Provider requirements summary:
- `scan` mode: no external provider token required.
- `index`, `search`, and `retrieve` default to `CE_RETRIEVAL_PROVIDER=openai_session`.
- Legacy provider token variables are archival-only and not part of the active default path.

### 1) Local scan (no provider token needed)

```bash
npm run bench -- --mode scan --workspace .
```

To include raw file read throughput:

```bash
npm run bench -- --mode scan --workspace . --read
```

### 2) Workspace indexing

```bash
npm run bench -- --mode index --workspace .
```

### 3) Search latency via `scripts/bench.ts` (indexed state recommended)

```bash
npm run bench -- --mode search --workspace . --query "file watcher" --topk 10 --iterations 25
```

Cold (no-cache) search timings:

```bash
npm run bench -- --mode search --workspace . --query "file watcher" --topk 10 --iterations 25 --cold
```

To benchmark “deep” semantic_search mode via MCP (higher accuracy, slower), use the tool with:
- `mode: "deep"`
- optionally `bypass_cache: true` for a true cold measurement
- optionally `timeout_ms` to cap worst-case latency

### 4) Retrieval pipeline latency via `scripts/bench.ts` (fast vs deep)

The `semantic_search` tool uses an internal retrieval pipeline. You can benchmark that pipeline directly:

```bash
npm run bench -- --mode retrieve --workspace . --query "file watcher" --topk 10 --iterations 25 --retrieve-mode fast
npm run bench -- --mode retrieve --workspace . --query "file watcher" --topk 10 --iterations 25 --retrieve-mode deep
```

Holdout dataset runs (for non-overfit quality checks):

```bash
npm run bench -- --mode retrieve --workspace . --dataset-id holdout_v1 --iterations 25 --retrieve-mode fast
npm run bench -- --mode search --workspace . --dataset-id holdout_v1 --iterations 25
```

To measure worst-case behavior (no caches), use very small iteration counts:

```bash
npm run bench -- --mode retrieve --workspace . --query "file watcher" --topk 10 --iterations 2 --retrieve-mode deep --bypass-cache --cold
```

## Output

- Human-readable by default.
- Use `--json` for machine-readable output:

```bash
npm run bench -- --mode search --workspace . --query "search queue" --iterations 50 --json
```

## Compare baseline vs candidate

`scripts/ci/bench-compare.ts` compares two JSON outputs from `scripts/bench.ts` and exits non-zero when thresholds are breached.

### Required inputs

1. Baseline JSON (usually from `main` or last release)
2. Candidate JSON (current PR/branch)

### Basic compare command

```bash
npm run bench:compare -- --baseline bench-baseline.json --candidate bench-candidate.json --metric payload.timing.p95_ms --max-regression-pct 10 --max-regression-abs 25
```

### Threshold meanings

- `--max-regression-pct`: maximum allowed slowdown in percent.  
  Example: baseline `100ms`, candidate `109ms`, threshold `10` => pass; `111ms` => fail.
- `--max-regression-abs`: maximum allowed slowdown in absolute units of the chosen metric.  
  For latency metrics this is milliseconds.
- If either threshold is exceeded, the script exits with code `1`.
- If no threshold is provided, default is `--max-regression-pct 10`.
- For throughput metrics where higher is better, add `--higher-is-better`.

## PR / nightly / release command examples

### PR (candidate gate, compares p95 search latency)

Create candidate JSON:

```bash
npm run bench -- --mode search --workspace . --query "search queue" --topk 10 --iterations 25 --json > bench-candidate.json
```

Compare against baseline (default `bench:pr` policy):

```bash
npm run bench:pr
```

`bench:pr` expects:
- baseline: `bench-baseline.json`
- candidate: `bench-candidate.json`
- metric: `payload.timing.p95_ms`
- thresholds: `10%` and `25ms`

### Nightly (refresh baseline)

```bash
npm run bench -- --mode search --workspace . --query "search queue" --topk 10 --iterations 50 --json > bench-baseline.json
```

This is typically run on the default branch after code freeze windows or after known infra changes.

### Release (stricter final check example)

```bash
npm run bench -- --mode search --workspace . --query "search queue" --topk 10 --iterations 50 --json > bench-candidate.json
npm run bench:compare -- --baseline bench-baseline.json --candidate bench-candidate.json --metric payload.timing.p95_ms --max-regression-pct 5 --max-regression-abs 15
```

## Measurement protocol (recommended)

- Record machine details + dataset definition (`docs/PERF_DATASET.md`).
- Capture the evidence fields below for every baseline, candidate, and queued run.
- Keep the tool/profile/state/query-family/repo-size slice labels in the artifact so baseline and candidate runs are comparable.
- Use the same query text, `top_k`, and queue-lane labeling across baseline and candidate runs.
- Prefer `>= 3` replicates for release decisions; use more when the p95 spread is noisy.
- Prefer `--json` output for comparisons.
- Use a fixed query set for p50/p95 latency tracking.

## Required evidence fields

Every benchmark artifact should carry these fields so the run is reproducible without extra context.

| Field group | Required fields |
| --- | --- |
| Provenance | `timestamp_utc`, `commit_sha`, `branch_or_tag`, `workspace_fingerprint`, `index_fingerprint`, `dataset_id`, `dataset_hash`, `retrieval_provider`, `feature_flags_snapshot`, `node_version`, `os_version` |
| Scenario | `tool`, `profile`, `state`, `query_family`, `repo_size`, `query_text`, `top_k`, `iterations`, `mode`, `cold`, `bypass_cache` |
| Queue setup | `queue_lane`, `queue_depth`, `queue_reject_mode`, `timeout_budget_ms` |
| Queued-run evidence | `queue_wait_ms`, `retry_after_ms` (when saturated or rejected) |
| Result summary | `p50_ms`, `p95_ms`, `error_rate`, `cache_hit_rate`, `artifact_path`, `notes` |

If the artifact format nests provenance, keep the nested keys intact:
- `provenance.retrieval_provider`
- `provenance.bench_mode`
- `provenance.dataset_id`
- `provenance.dataset_hash`
- `provenance.workspace_fingerprint`

Missing provenance or queue metadata means the artifact is incomplete for gate review.

Current CI benchmark artifacts also carry a reproducibility lock for:
- `timestamp_utc`
- `commit_sha`
- `branch_or_tag`
- `bench_mode`
- `workspace_fingerprint`
- `index_fingerprint`
- `dataset_id`
- `dataset_hash`
- `retrieval_provider`
- `feature_flags_snapshot`
- `node_version`
- `os_version`
- `env_fingerprint`

The benchmark compare step now rejects missing or mismatched workspace, index, dataset, provider, or feature-flag provenance.

## Telemetry dictionary

Use these metric names when reading Prometheus output or benchmark artifacts for the slow-path investigation:

| Metric | Meaning | Notes |
| --- | --- | --- |
| `context_engine_search_and_ask_duration_seconds` | End-to-end `searchAndAsk` duration. | Includes queue wait and provider execution. |
| `context_engine_search_and_ask_queue_wait_seconds` | Time spent waiting before the provider starts work. | Useful for saturation and fairness analysis. |
| `context_engine_search_and_ask_execution_seconds` | Time spent inside the active provider call after queue admission. | Helps separate provider cost from queueing cost. |
| `context_engine_search_and_ask_queue_depth` | In-flight + waiting requests in the queue. | Labeled by lane (`interactive` / `background`). |
| `context_engine_search_and_ask_total` | Total `searchAndAsk` calls received. | Use as the denominator for rates. |
| `context_engine_search_and_ask_rejected_total` | Calls rejected before execution. | Labeled by rejection reason. |
| `context_engine_search_and_ask_errors_total` | Calls that failed after admission. | Excludes admission rejections. |

## Telemetry data-quality gates

Use these checks when evaluating benchmark or rollout telemetry snapshots:
- Missing required fields: fail the snapshot instead of inferring values.
- Duplicate events within a single run: fail the snapshot and inspect the emitter.
- Out-of-order timestamps within a single run: fail the snapshot and inspect buffering/clock skew.
- Unbounded label growth or series churn: fail or hold the gate when label cardinality grows unexpectedly.
- Metric update drops: treat `context_engine_metrics_dropped_total` growth as a hard investigation signal.
- Queue evidence should show a consistent lane, depth, and reject mode across the run window.

## Shadow parity framework

This is a rollout measurement spec, not a runtime change. It defines the evidence shape needed to compare the legacy retrieval path against the LanceDB-first candidate path before canary or release promotion.

Use the existing provenance lock plus shadow-specific pairing metadata so the legacy and candidate artifacts are comparable without guessing.

### Comparison inputs

Shadow comparison artifacts should be built from the same:
- `dataset_id` and `dataset_hash`
- `workspace_fingerprint` and `index_fingerprint`
- `feature_flags_snapshot` and `env_fingerprint`
- `tool`, `profile`, `state`, `query_family`, `repo_size`, `query_text`, `top_k`, and `queue_lane`
- `CE_RETRIEVAL_SHADOW_COMPARE_ENABLED` and `CE_RETRIEVAL_SHADOW_SAMPLE_RATE` settings

### Parity dimensions

| Dimension | Required evidence | Gate interpretation |
| --- | --- | --- |
| Overlap | `overlap_at_k`, `unique_files_at_k`, exact-path agreement, exact-symbol agreement, per-query mismatch samples | Large overlap drops are a rollout hold, even when latency is better |
| Error | `error_rate`, `empty_result_rate`, `fallback_rate`, `timeout_rate`, `reject_rate`, plus deltas vs legacy | Candidate must not introduce new failure modes or widen fallback/reject behavior |
| Latency | `p50_ms`, `p95_ms`, `p99_ms`, `queue_wait_ms`, `execution_ms`, and compare overhead | Candidate should meet the latency budget in `docs/BENCHMARKING_GATES.md`; queue pressure stays visible separately |

### Required shadow artifact fields

Any shadow compare artifact should retain the benchmark provenance lock and add:

| Field group | Required fields |
| --- | --- |
| Provenance | `timestamp_utc`, `commit_sha`, `branch_or_tag`, `workspace_fingerprint`, `index_fingerprint`, `dataset_id`, `dataset_hash`, `retrieval_provider`, `feature_flags_snapshot`, `node_version`, `os_version`, `env_fingerprint` |
| Shadow compare metadata | `shadow_compare_enabled`, `shadow_sample_rate`, `shadow_pair_id`, `comparison_role`, `comparison_window_start`, `comparison_window_end`, `query_fingerprint`, `paired_query_count`, `legacy_artifact_path`, `candidate_artifact_path` |
| Parity summary | `overlap_at_k`, `unique_files_at_k`, `error_rate_delta`, `empty_result_rate_delta`, `fallback_rate_delta`, `p95_latency_delta`, `queue_wait_p95_delta`, `notes` |

If the runtime does not emit one of these fields directly, the benchmark runner or rollout wrapper should append it so the compare artifact still has enough context for gate review.

### Required evidence outputs

- raw legacy shadow artifact
- raw candidate shadow artifact
- shadow compare summary report
- per-query mismatch sample list
- provenance integrity check result
- rollout decision record with `proceed`, `hold`, or `rollback`

### Gate linkage

- PR and nightly gates still use the benchmark thresholds in `docs/BENCHMARKING_GATES.md`.
- Shadow parity evidence is required for canary and release promotion when shadow compare is enabled.
- If the parity report is incomplete, the stage stays on hold.
- If overlap or error budgets fail, treat the change as a rollback candidate even if latency improves.

## Tuning knobs

These environment variables affect indexing behavior:
- `CE_INDEX_USE_WORKER=true|false` (default: enabled)
- `CE_INDEX_FILES_WORKER_THRESHOLD=200` (default)
- `CE_INDEX_BATCH_SIZE=10` (default)
- `CE_DEBUG_INDEX=true` / `CE_DEBUG_SEARCH=true`

These environment variables affect caching/telemetry:
- `CE_SEARCH_CACHE_TTL_MS=60000` (in-memory search TTL; default 60s)
- `CE_PERSISTENT_CACHE_TTL_MS=604800000` (persistent cache TTL; default 7d)
- `CE_PERSIST_SEARCH_CACHE_MAX_ENTRIES=500` (default)
- `CE_PERSIST_CONTEXT_CACHE_MAX_ENTRIES=100` (default)

Retrieval rollout feature flags (all default `false`):
- `CE_RETRIEVAL_REWRITE_V2=true|false`
- `CE_RETRIEVAL_RANKING_V2=true|false`
- `CE_RETRIEVAL_REQUEST_MEMO_V2=true|false`
- `CE_RETRIEVAL_HYBRID_V1=true|false`
- `CE_RETRIEVAL_RANKING_V3=true|false`
- `CE_CONTEXT_PACKS_V2=true|false`
- `CE_RETRIEVAL_QUALITY_GUARD_V1=true|false`

## Track A tuning backlog

Use this order when baseline evidence says the live path is still too slow:
1. Keep queue pressure visible first: confirm `observe`/`shadow` saturation evidence before changing defaults.
2. Reduce retrieval fan-out before expanding quality work: keep `maxVariants`, `perQueryTopK`, and expansion bounded.
3. Tighten timeout budgets only after queue telemetry is stable and repeatable.
4. Keep index-state and cache toggles on for repeated live-work paths where safety allows it.
5. Re-run the benchmark slice matrix after every tuning change so regressions stay isolated.

## CI benchmark suite scripts

The CI wrappers below generate baseline + candidate artifacts and then call `scripts/ci/bench-compare.ts`.

### PR mode

```bash
npm run bench:ci:pr
```

Behavior:
- Writes `artifacts/bench/pr-baseline.json` and `artifacts/bench/pr-candidate.json`.
- KPI mode-lock: probes `retrieve`, then `search` by default; `scan` is excluded so low-signal scan fallback cannot pass the PR KPI gate.
- Optional local diagnostic override: set `BENCH_SUITE_ALLOW_SCAN_FALLBACK=true` to re-enable `scan` probe fallback for PR runs.
- Probe checks now require runnable JSON output with a comparable latency metric (not only exit code `0`).
- Probe failure diagnostics include the configured probe timeout value.
- Honors `CE_RETRIEVAL_PROVIDER` when set and picks the first runnable mode allowed by policy.
- Includes `provenance.retrieval_provider` in suite artifacts for traceability.
- Compares with PR thresholds:
  - `--max-regression-pct 12`
  - `--max-regression-abs 30`

Related env knobs:
- `BENCH_SUITE_ALLOW_SCAN_FALLBACK=true|false` (PR default: `false`)
- `BENCH_SUITE_PROBE_TIMEOUT_MS` (probe timeout budget included in error diagnostics)
- `BENCH_SUITE_PR_ITERATIONS=<n>` (optional local override; default `30`)
- `BENCH_SUITE_NIGHTLY_ITERATIONS=<n>` (optional override; default `80`)

Optional strict mode-lock gate (fails if baseline/candidate bench mode is not `retrieve` or `search`):

```bash
npm run ci:check:bench-mode-lock
```

Optional holdout fixture guard before quality gate:

```bash
node --import tsx scripts/ci/check-retrieval-holdout-fixture.ts --fixture-pack config/ci/retrieval-quality-fixture-pack.json
```

### Nightly mode

```bash
npm run bench:ci:nightly
```

Behavior:
- Uses larger iteration counts than PR mode.
- Writes `artifacts/bench/nightly-baseline.json` and `artifacts/bench/nightly-candidate.json`.
- Runs compare with nightly thresholds:
  - `--max-regression-pct 8`
  - `--max-regression-abs 20`

### Release helper

```bash
npm run bench:ci:release
```

Behavior:
- Expects baseline at `artifacts/bench/nightly-baseline.json` (override via `--baseline`).
- Runs candidate benchmark 3 times.
- Writes:
  - `artifacts/bench/release-candidate-run-1.json`
  - `artifacts/bench/release-candidate-run-2.json`
  - `artifacts/bench/release-candidate-run-3.json`
  - `artifacts/bench/release-candidate-median.json`
- Compares `payload.timing.p95_ms` using median candidate p95 vs baseline with release thresholds:
  - `--max-regression-pct 5`
  - `--max-regression-abs 15`
- Fails with a clear error if fewer than 3 candidate runs succeed.
