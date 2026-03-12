# R5 Enhancement Error Taxonomy Contract

Date: 2026-03-12  
Owner: SRE/Platform  
Applies to: Recommendation R5 in `docs/CONTEXT_ENGINE_ENHANCEMENT_DECISION_PACKAGE_2026-03-12.md`

## Purpose
Define a deterministic, checklist-ready contract for enhancement error taxonomy reporting so release review can make machine-verifiable pass/fail decisions.

## Scope
- Source domain: enhancement failures from `enhance_prompt` error outputs and related extraction inputs.
- Primary taxonomy buckets required by R5:
  - `TRANSIENT_UPSTREAM`
  - `AUTH_CONFIG`
  - `QUOTA`
  - `UNKNOWN`
- This contract is normative for T3 and is designed for direct consumption by a later T4 checker/report generator.

## Canonical Output Artifact (Machine-Readable)
Required top-level JSON fields:

```json
{
  "schema_version": "1.0",
  "status": "PASS | FAIL | SKIP",
  "reporting_window": {
    "start_utc": "YYYY-MM-DDTHH:mm:ss.sssZ",
    "end_utc_exclusive": "YYYY-MM-DDTHH:mm:ss.sssZ"
  },
  "summary": {
    "total_events": "number",
    "processed_events": "number",
    "malformed_event_count": "number",
    "window_state": "HAS_EVENTS | ZERO_EVENTS",
    "threshold_result": "PASS | FAIL"
  },
  "counts_by_error_code": {
    "TRANSIENT_UPSTREAM": "number",
    "AUTH_CONFIG": "number",
    "QUOTA": "number",
    "UNKNOWN": "number"
  },
  "unknown_code_count": "number",
  "thresholds": {
    "max_transient_upstream": "number",
    "max_auth_config": "number",
    "max_quota": "number",
    "max_unknown": "number",
    "max_malformed": "number"
  },
  "violations": [
    {
      "id": "string",
      "message": "string"
    }
  ]
}
```

Schema constraints:
- `schema_version` must be exactly `1.0`.
- `status` must be one of `PASS|FAIL|SKIP`.
- `reporting_window.start_utc < reporting_window.end_utc_exclusive`.
- Every value in `counts_by_error_code` must be an integer >= 0.
- `unknown_code_count` must equal `counts_by_error_code.UNKNOWN`.
- `summary.total_events >= summary.processed_events >= 0`.
- `summary.malformed_event_count >= 0`.
- `summary.window_state` must be:
  - `ZERO_EVENTS` only when `summary.total_events = 0`.
  - `HAS_EVENTS` when `summary.total_events > 0`.

## Taxonomy Mapping Rules
Raw error signals must map deterministically as follows:

| Raw signal | Canonical bucket |
|---|---|
| `TRANSIENT_UPSTREAM` | `TRANSIENT_UPSTREAM` |
| `AUTH` | `AUTH_CONFIG` |
| `CONFIG` (forward-compatible, if emitted later) | `AUTH_CONFIG` |
| `QUOTA` | `QUOTA` |
| Any unrecognized code | `UNKNOWN` |
| Missing/blank/non-string code | `UNKNOWN` |

Deterministic requirements:
- Mapping is case-sensitive after trim normalization.
- No event may be dropped solely because its code is unknown.
- Unknown or malformed codes must still contribute to `summary.total_events`.

## Reporting Window Semantics
- Window is inclusive at start and exclusive at end: `[start_utc, end_utc_exclusive)`.
- Events outside the window must be excluded from `processed_events` and code counts.
- Invalid window parameters (missing timestamp, parse failure, or `start >= end`) are contract violations and must force `status=FAIL`.

Recommended release checklist window:
- Start: last approved release cutoff (UTC).
- End: current release checklist generation time (UTC, exclusive).

## Threshold Semantics
Threshold evaluation is deterministic and fail-closed:

1. Compute canonical counts from mapped events in the reporting window.
2. Evaluate each threshold independently:
   - `counts_by_error_code.TRANSIENT_UPSTREAM <= max_transient_upstream`
   - `counts_by_error_code.AUTH_CONFIG <= max_auth_config`
   - `counts_by_error_code.QUOTA <= max_quota`
   - `unknown_code_count <= max_unknown`
   - `summary.malformed_event_count <= max_malformed`
3. Any breach creates a `violations[]` entry and sets `summary.threshold_result=FAIL`.
4. Final `status`:
   - `FAIL` when any contract/schema/window/threshold violation exists.
   - `PASS` when no violations exist.
   - `SKIP` only when an explicit policy flag is provided by the caller (for example release blackout); absent explicit skip policy, do not emit `SKIP`.

Default threshold profile for deterministic checklist use:
- `max_unknown = 0`
- `max_malformed = 0`
- `max_transient_upstream`, `max_auth_config`, `max_quota` must be explicitly provided by the checklist configuration (no implicit defaults).

## Malformed Input Behavior
Malformed input includes (non-exhaustive):
- Missing required event fields (`timestamp_utc`, `error_code`).
- Non-ISO or non-UTC timestamps.
- Non-object event payloads.

Handling rules:
- Malformed rows increment `summary.malformed_event_count`.
- Malformed rows also count toward `summary.total_events`.
- If `error_code` is missing/invalid, classify as `UNKNOWN`.
- If timestamp is missing/invalid, row is not counted in `processed_events` or per-code counts (cannot be window-scoped), but still counts as malformed.
- Malformed input must never be silently discarded.

## Zero-Event Window Behavior
When no events are present in the reporting window:
- `summary.total_events = 0`
- `summary.processed_events = 0`
- `summary.window_state = ZERO_EVENTS`
- All `counts_by_error_code.* = 0`
- `unknown_code_count = 0`
- `status = PASS` unless separate schema/window violations exist

Rationale: zero incidents is a valid observable state and must produce a complete artifact instead of failing by absence.

## Checklist Readiness Requirements
A release checklist consumer must verify:
- Artifact contains required fields: `status`, `summary`, `counts_by_error_code`, `unknown_code_count`.
- `counts_by_error_code` includes all four canonical keys (`TRANSIENT_UPSTREAM`, `AUTH_CONFIG`, `QUOTA`, `UNKNOWN`).
- `unknown_code_count` equals `counts_by_error_code.UNKNOWN`.
- `summary.threshold_result` is `PASS` for release approval.
- Any missing required field, unknown key omission, or count mismatch forces checklist failure.
