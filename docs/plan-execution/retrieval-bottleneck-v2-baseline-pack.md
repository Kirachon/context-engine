# Retrieval Bottleneck v2 Baseline Pack

Purpose: reproducible baseline commands and canonical artifact paths for `T1` execution.

## Baseline Scope

- Workspace: repo root (`D:\GitProjects\context-engine`)
- Evidence modes for KPI verdicts: `retrieve`, `search`
- Diagnostic-only mode: `scan` (not valid for final KPI pass/fail)

## Required Evidence Fields

Record these fields in every PR, nightly, and release note so the baseline pack is attachable without schema conversion.

| Field group | Required fields |
| --- | --- |
| Provenance | `timestamp_utc`, `commit_sha`, `branch_or_tag`, `workspace_fingerprint`, `index_fingerprint`, `dataset_id`, `dataset_hash`, `retrieval_provider`, `feature_flags_snapshot`, `node_version`, `os_version`, `cpu_model`, `ram`, `storage_type` |
| Scenario | `mode`, `tool`, `profile`, `state`, `query_family`, `repo_size`, `query_text`, `top_k`, `iterations`, `cold`, `bypass_cache` |
| Queue setup | `queue_lane`, `queue_depth`, `queue_reject_mode`, `timeout_budget_ms` |
| Queued-run evidence | `queue_wait_ms`, `retry_after_ms` (when saturated or rejected) |
| Evidence links | `baseline_artifact`, `candidate_artifact`, `transcript_path`, `gate_output_path` |

When the benchmark output nests provenance, keep the nested keys intact:
- `provenance.retrieval_provider`
- `provenance.bench_mode`
- `provenance.dataset_id`
- `provenance.dataset_hash`
- `provenance.workspace_fingerprint`

## Reproducible Command Set

Run from repo root in PowerShell.

1. Install deps and build
```powershell
npm ci
npm run build
```

2. Capture PR benchmark bundle
```powershell
npm run bench:ci:pr
```

3. Capture nightly bundle (optional for trend comparison)
```powershell
npm run bench:ci:nightly
```

4. Capture release bundle (median-of-3 candidate)
```powershell
npm run bench:ci:release
```

5. Capture retrieval quality + holdout + shadow/canary gate
```powershell
npm run -s ci:check:retrieval-quality-gate
npm run -s ci:check:retrieval-shadow-canary-gate
```

6. Capture governance/readiness validation
```powershell
npm run -s ci:check:ws21-rollback-drill
npm run -s ci:check:governance-artifacts
```

## Canonical Artifact Paths

| Category | Artifact Path | Producer |
| --- | --- | --- |
| PR baseline | `artifacts/bench/pr-baseline.json` | `npm run bench:ci:pr` |
| PR candidate | `artifacts/bench/pr-candidate.json` | `npm run bench:ci:pr` |
| Nightly baseline | `artifacts/bench/nightly-baseline.json` | `npm run bench:ci:nightly` |
| Nightly candidate | `artifacts/bench/nightly-candidate.json` | `npm run bench:ci:nightly` |
| Release run #1 | `artifacts/bench/release-candidate-run-1.json` | `npm run bench:ci:release` |
| Release run #2 | `artifacts/bench/release-candidate-run-2.json` | `npm run bench:ci:release` |
| Release run #3 | `artifacts/bench/release-candidate-run-3.json` | `npm run bench:ci:release` |
| Release median | `artifacts/bench/release-candidate-median.json` | `npm run bench:ci:release` |
| Quality telemetry | `artifacts/bench/retrieval-quality-telemetry.json` | `npm run -s ci:generate:retrieval-quality-telemetry` |
| Holdout check | `artifacts/bench/retrieval-holdout-check.json` | `npm run -s ci:check:retrieval-holdout-fixture` |
| Quality report | `artifacts/bench/retrieval-quality-report.json` | `npm run -s ci:generate:retrieval-quality-report` |
| Quality gate | `artifacts/bench/retrieval-quality-gate.json` | `npm run -s ci:check:retrieval-quality-gate` |
| Shadow/canary gate | `artifacts/bench/retrieval-shadow-canary-gate.json` | `npm run -s ci:check:retrieval-shadow-canary-gate` |
| Governance gate | `artifacts/bench/legacy-capability-parity-gate.json` | `npm run -s ci:check:governance-artifacts` |

## Baseline Recording Checklist

- [ ] Record commit SHA.
- [ ] Record dataset id/hash used by benchmark commands.
- [ ] Record environment fingerprint (OS, CPU class, Node version).
- [ ] Record active feature-flag snapshot.
- [ ] Keep command transcript paths in final T13 evidence pack.

## T1 Acceptance

- Commands above run without local path edits.
- Expected artifacts are produced at canonical paths.
- Baseline bundle is attachable to T13 report without schema conversion.
