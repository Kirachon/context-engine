# Compatibility Replay Notes - 2026-02-28

Purpose: record replay validation results and intentional snapshot deltas after tool hardening waves.

## Commands Run
- `node --import tsx tests/snapshots/snapshot-harness.ts`
- `node --import tsx tests/snapshots/snapshot-harness.ts --update`
- `node --import tsx tests/snapshots/snapshot-harness.ts`

Final result:
- Replay suite status: `PASS` (`Snapshots verified.`)

## Intentional Deltas Captured

Updated baselines:
- `tests/snapshots/phase2/baseline/codebase_retrieval_auth.baseline.txt`
- `tests/snapshots/phase2/baseline/codebase_retrieval_database.baseline.txt`
- `tests/snapshots/phase2/baseline/codebase_retrieval_short.baseline.txt`
- `tests/snapshots/phase2/baseline/index_status_basic.baseline.txt`
- `tests/snapshots/phase2/baseline/tool_manifest_basic.baseline.txt`

Delta summary:
- `codebase_retrieval` snapshots now include additive `metadata.indexStatus` object.
- `index_status` snapshot now includes additive freshness lines (`Freshness`, `Freshness Summary`).
- `tool_manifest` snapshot reflects current server capability/tool inventory and version alignment (`1.9.0`), including review/static-analysis/reactive tool families.

## Compatibility Assessment
- No destructive contract removals detected in replay deltas.
- Shape changes are additive or expected version/capability inventory updates.
- Existing replay harness now verifies against current expected outputs.
