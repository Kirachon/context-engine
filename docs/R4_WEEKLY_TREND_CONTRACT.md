# R4 Weekly Trend Contract

Date: 2026-03-12  
Owner: Search Owner  
Applies to: Recommendation R4 in `docs/CONTEXT_ENGINE_ENHANCEMENT_DECISION_PACKAGE_2026-03-12.md`

## Purpose
Define the contract for a weekly quality/parity trend artifact so CI and reviewers can make deterministic pass/fail decisions from archived evidence.

## Artifact Location and Naming
- Current artifact path: `artifacts/bench/r4-weekly-trend.json`
- Archive directory: `artifacts/bench/archive/r4-weekly/`
- Archive filename format: `r4-weekly-trend-<period_key>.json`

## Status Semantics
- `PASS`: Artifact is valid, period is accepted, archive write succeeded.
- `FAIL`: Contract violation; release/gate must fail.
- `SKIP`: Generator command-level outcome for policy/idempotent skip (no gate failure). Persisted artifact status remains `PASS` or `FAIL`.

Rules:
- `FAIL` is mandatory for schema drift, duplicate period keys with non-identical inputs, missing required upstream artifacts, or archive-write failure.
- `SKIP` is allowed only for policy-defined skip reasons (see `Skip Policy`).

## Skip Policy
- `SKIP` is valid only for:
  - `DUPLICATE_PERIOD_IDEMPOTENT` (same period key and same upstream input hashes).
  - `SCHEDULED_BLACKOUT` (approved maintenance/blackout window marker is present).
- Any other non-success condition must be emitted as `FAIL`.

## Canonical Artifact Schema
Required JSON object fields:

```json
{
  "schema_version": 1,
  "generated_at_utc": "YYYY-MM-DDTHH:mm:ss.sssZ",
  "status": "PASS | FAIL",
  "period": {
    "key": "YYYY-Www",
    "start_utc": "YYYY-MM-DDT00:00:00.000Z",
    "end_utc_exclusive": "YYYY-MM-DDT00:00:00.000Z"
  },
  "summary": {
    "headline": "string",
    "pass_checks": "number",
    "fail_checks": "number",
    "retention_archive_note": "string"
  },
  "metrics": {
    "strict_parity_score": "number",
    "quality_pass_rate": "number",
    "ndcg_delta_pct": "number",
    "mrr_delta_pct": "number",
    "recall_delta_pct": "number"
  },
  "checks": [
    {
      "id": "string",
      "status": "PASS | FAIL",
      "source": "string",
      "message": "string"
    }
  ],
  "retention": {
    "policy": "rolling_12_weeks",
    "retained_period_count": "number",
    "retention_archive_note": "string"
  },
  "inputs": {
    "parity_artifact_path": "string",
    "quality_artifact_path": "string",
    "parity_artifact_sha256": "hex",
    "quality_artifact_sha256": "hex",
    "out_path": "string",
    "archive_dir": "string"
  }
}
```

Schema constraints:
- `schema_version` must be exactly `1`.
- `status` must be one of `PASS|FAIL`.
- `period.key` must match `^\d{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$`.
- `period.start_utc < period.end_utc_exclusive`.
- `summary.pass_checks + summary.fail_checks` must equal `checks.length`.

## Period-Key Rules
- `period.key` uses ISO week (`YYYY-Www`) derived from `period.start_utc`.
- Exactly one accepted artifact is allowed per `period.key`.
- Re-run behavior:
  - If artifact for `period.key` does not exist in archive, write it and continue.
  - If artifact exists and input hashes are identical (`parity_artifact_sha256`, `quality_artifact_sha256`), keep existing archive file and return command-level `SKIP` with reason `DUPLICATE_PERIOD_IDEMPOTENT`.
  - If artifact exists and input hashes differ, return `FAIL` with error code `DUPLICATE_PERIOD_CONFLICT`.

## Retention Policy
- Retention mode: `rolling_12_weeks`.
- Keep the latest 12 accepted period artifacts (`status=PASS`).
- Never delete artifacts from the currently generated period.
- Retention cleanup failure is `FAIL` with error code `RETENTION_CLEANUP_FAILED`.

## Fail/Skip Behavior Matrix
- Missing input artifacts (`parity` or `quality`): `FAIL` (`MISSING_INPUT_ARTIFACT`).
- Duplicate period with non-identical inputs: `FAIL` (`DUPLICATE_PERIOD_CONFLICT`).
- Schema drift (missing required field, invalid enum/type, unsupported schema): `FAIL` (`SCHEMA_DRIFT`).
- Archive write failure (current or archive path): `FAIL` (`ARCHIVE_WRITE_FAILED`).
- Duplicate period with identical inputs (idempotent replay): command returns `SKIP` (`DUPLICATE_PERIOD_IDEMPOTENT`).
- Scheduled blackout/maintenance window with approved marker: command returns `SKIP` (`SCHEDULED_BLACKOUT`).

## Validation Requirements
- Contract validator must enforce all schema constraints before archive write.
- Validator must fail closed: unknown status or missing required fields always produce `FAIL`.
- Gate outcome is derived from artifact `status` and generator return code:
  - Artifact `PASS` + successful run -> gate pass
  - Artifact `FAIL` or generator error -> gate fail
  - Generator `SKIP` with valid reason -> gate neutral/pass-with-skip record
