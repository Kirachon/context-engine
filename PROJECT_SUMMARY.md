# Project Summary: Context Engine MCP Server (Native Runtime)

Last updated: 2026-03-12

## What We Now Run

Context Engine is a local-first MCP server that now runs on a **native local retrieval stack**.
The active path is no longer dependent on Auggie SDK runtime behavior.

## Current Status

- Runtime mode: `local_native` (active)
- Dependency boundary: no `@augmentcode/auggie` dependency in `package.json`
- Version: `1.9.0`
- Tool inventory: `42` tools (from `tool_manifest`)

## What Changed From Before

- Before: retrieval behavior was tied to Auggie-era implementation paths.
- Now: retrieval, ranking controls, reliability gates, and rollout evidence are native in this repo.
- Before: older docs referenced Auggie-managed storage/embedding flow.
- Now: docs and CI gates track local-native parity and quality directly.

## Measured Results

Evidence artifacts:
- `artifacts/bench/legacy-capability-parity-gate.json`
- `artifacts/bench/retrieval-parity-pr.json`
- `artifacts/bench/retrieval-quality-report.json`

Latest outcomes:
- Parity gate: `pass` with `overall_score=100.00`
- Retrieval quality gate: `pass` (`10/10`)
- Quality improvement vs baseline:
  - `nDCG@10`: `+14.0%`
  - `MRR@10`: `+12.5%`
  - `Recall@50`: `+22.0%`

## Practical Meaning

- Relevant answers appear earlier in results.
- The first useful hit shows up sooner.
- More relevant items are included in top result windows.

## Key Docs

- `README.md`
- `ARCHITECTURE.md`
- `docs/AUGGIE_ADOPTION_AND_REMOVAL_TRACKER.md`
- `docs/LOCAL_NATIVE_SEARCH_QUALITY_UPGRADE_PLAN.md`

