# Performance Dataset & Measurement Protocol

This repo includes `scripts/bench.ts` and `docs/BENCHMARKING.md` for opt-in performance measurements. This document defines a **repeatable** dataset + protocol so results don’t drift over time.

## Record the environment

When publishing benchmark results, include:

- Date/time
- OS + version
- CPU model + core count
- RAM
- Storage type (SSD/HDD)
- Node.js version
- Git commit SHA and branch/tag
- Workspace fingerprint or index fingerprint
- Retrieval provider and active feature flags
- Legacy provider URL override (default vs custom; archival)
- Whether the workspace was already indexed (state present)
- Benchmark mode and dataset id/hash
- Queue lane, queue depth, timeout budget, and reject mode for queued runs

## Dataset definition

Pick **one or more** representative repos and record:

- Repo name (or anonymized label)
- Total files and indexable files
- Approx total bytes
- Notable characteristics (monorepo, generated files, language mix)

## Benchmark slice matrix

Use the smallest grid that still exposes the slowness problem:

| Slice | Values to record | Why it matters |
| --- | --- | --- |
| Tool | `semantic_search`, `codebase_retrieval`, `retrieve`, `searchAndAsk` | Separates the public tool contracts from the internal retrieval path. |
| Profile | `fast`, `balanced`, `rich` | Shows how much fan-out and rerank budget changes latency. |
| State | `warm`, `cold`, `queued` | Distinguishes cache wins from queue pressure and first-run cost. |
| Query family | exact symbol, file path, config, docs/setup, debugging/root-cause, cross-file behavior, test discovery, recency-sensitive | Keeps the benchmark aligned to real operator work. |
| Repo size | `small`, `medium`, `large` | Prevents a single repo from hiding scale-related regressions. |

Required run rules:

- Run the same query text across baseline and candidate artifacts.
- Keep `top_k` fixed for a given slice when comparing runs.
- Use at least `3` replicates for release decisions.
- Record the lane and queue depth for queued scenarios.
- Treat missing slice metadata as a failed benchmark artifact, not a partial pass.

Recommended sizes:

- Small: ~1k–5k files
- Medium: ~10k–20k files
- Large: ~50k+ files

## Query set definition (for search/retrieve)

Use a fixed set of queries so p95 comparisons are meaningful. Example set:

- “file watcher”
- “indexWorkspaceInBackground”
- “semanticSearch cache”
- “WorkerPoolOptimizer”
- “diff parsing”

Map each query to a family from the slice matrix above. A good release suite should include at least one query from each family that exists in the target repository.

Record:

- `top_k` values (e.g., 5 and 10)
- Iterations (e.g., 25–50)
- Whether cold runs are used
- Whether the run was queued, and if so, the queue lane / depth / retry policy

## Warm vs cold definition

- Warm: same `ContextServiceClient` instance reused and caches enabled.
- Cold: `--cold` (new client per iteration), optionally `--bypass-cache` where supported.
- Queued: a benchmark run that intentionally starts with one or more in-flight requests in the same lane so queue wait becomes visible in the artifact.

## Output format

Prefer machine-readable output for comparisons:

```bash
npm run bench -- --mode search --workspace . --query "file watcher" --topk 10 --iterations 25 --json
```

Store results as a small table in a PR description or a separate markdown note:

- Baseline (commit SHA)
- After change (commit SHA)
- Δ% for key metrics (p50/p95, index elapsed, RSS if captured)
