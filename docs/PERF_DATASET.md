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
- Legacy provider URL override (default vs custom; archival)
- Whether the workspace was already indexed (state present)

## Dataset definition

Pick **one or more** representative repos and record:

- Repo name (or anonymized label)
- Total files and indexable files
- Approx total bytes
- Notable characteristics (monorepo, generated files, language mix)

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

Record:

- `top_k` values (e.g., 5 and 10)
- Iterations (e.g., 25–50)
- Whether cold runs are used

## Warm vs cold definition

- Warm: same `ContextServiceClient` instance reused and caches enabled.
- Cold: `--cold` (new client per iteration), optionally `--bypass-cache` where supported.

## Output format

Prefer machine-readable output for comparisons:

```bash
npm run bench -- --mode search --workspace . --query "file watcher" --topk 10 --iterations 25 --json
```

Store results as a small table in a PR description or a separate markdown note:

- Baseline (commit SHA)
- After change (commit SHA)
- Δ% for key metrics (p50/p95, index elapsed, RSS if captured)
