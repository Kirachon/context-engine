# Benchmarking

This repo includes an opt-in benchmark harness to quantify performance changes without running production traffic.

For consistent comparisons over time, also follow `docs/PERF_DATASET.md`.

## Quick Start

### 1) Local scan (no Auggie creds needed)

```bash
npm run bench -- --mode scan --workspace .
```

To include raw file read throughput:

```bash
npm run bench -- --mode scan --workspace . --read
```

### 2) Workspace indexing (requires Auggie creds)

```bash
export AUGMENT_API_TOKEN=...
# optional:
export AUGMENT_API_URL=...

npm run bench -- --mode index --workspace .
```

### 3) Search latency (requires Auggie creds + indexed state)

```bash
export AUGMENT_API_TOKEN=...

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

### 4) Retrieval pipeline latency (fast vs deep)

The `semantic_search` tool uses an internal retrieval pipeline. You can benchmark that pipeline directly:

```bash
npm run bench -- --mode retrieve --workspace . --query "file watcher" --topk 10 --iterations 25 --retrieve-mode fast
npm run bench -- --mode retrieve --workspace . --query "file watcher" --topk 10 --iterations 25 --retrieve-mode deep
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
- Prefer `--json` output for comparisons.
- Use a fixed query set for p50/p95 latency tracking.

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

## CI benchmark suite scripts

The CI wrappers below generate baseline + candidate artifacts and then call `scripts/ci/bench-compare.ts`.

### PR mode

```bash
npm run bench:ci:pr
```

Behavior:
- Writes `artifacts/bench/pr-baseline.json` and `artifacts/bench/pr-candidate.json`.
- If `AUGMENT_API_TOKEN` is present: uses deterministic `retrieve` benchmark settings.
- If `AUGMENT_API_TOKEN` is missing: falls back to deterministic `scan` benchmark runs and normalizes output to `payload.timing.p95_ms` for comparison.
- Compares with PR thresholds:
  - `--max-regression-pct 12`
  - `--max-regression-abs 30`

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
