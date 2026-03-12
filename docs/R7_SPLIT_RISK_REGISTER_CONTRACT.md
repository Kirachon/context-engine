# R7 Split Risk Register Contract

Purpose: define a deterministic, checker-enforceable two-register model for recommendation `R7` (delivery risk vs runtime risk).

## Scope

This contract defines:
- required artifact files
- required fields and validation rules
- review cadence and stale-record rules

This contract does not define implementation code for the checker.

## Required Artifacts

Both files are required for a passing check:
- `artifacts/governance/r7-delivery-risk-register.json`
- `artifacts/governance/r7-runtime-risk-register.json`

## Register Structure

Each artifact must be a JSON object with this top-level shape:

```json
{
  "schema_version": "1.0",
  "register_type": "delivery|runtime",
  "register_owner": "non-empty string",
  "generated_at_utc": "YYYY-MM-DDTHH:MM:SSZ",
  "last_review_utc": "YYYY-MM-DDTHH:MM:SSZ",
  "next_review_utc": "YYYY-MM-DDTHH:MM:SSZ",
  "risks": []
}
```

Checker expectations:
- no additional top-level register types are allowed
- `risks` must be an array (empty arrays are allowed only when explicitly justified in `empty_register_reason`)
- all timestamps must be valid UTC ISO-8601 (`Z` suffix)

## Required Field Matrix

| Field | Delivery Register | Runtime Register | Rule (checker-enforceable) |
|---|---|---|---|
| `schema_version` | required | required | exact value `1.0` |
| `register_type` | required | required | exact value `delivery` for delivery file; `runtime` for runtime file |
| `register_owner` | required | required | non-empty string |
| `generated_at_utc` | required | required | valid UTC timestamp |
| `last_review_utc` | required | required | valid UTC timestamp |
| `next_review_utc` | required | required | valid UTC timestamp; must be later than `last_review_utc` |
| `risks` | required | required | array of objects |
| `risks[].risk_id` | required | required | pattern `^DR-[0-9]{3}$` (delivery) or `^RR-[0-9]{3}$` (runtime); unique within file |
| `risks[].title` | required | required | non-empty string, max 120 chars |
| `risks[].status` | required | required | enum: `open`, `watch`, `mitigated`, `closed` |
| `risks[].likelihood` | required | required | enum: `low`, `medium`, `high` |
| `risks[].impact` | required | required | enum: `low`, `medium`, `high`, `critical` |
| `risks[].trigger` | required | required | non-empty string |
| `risks[].mitigation` | required | required | non-empty string |
| `risks[].contingency` | required | required | non-empty string |
| `risks[].owner` | required | required | non-empty string |
| `risks[].opened_at_utc` | required | required | valid UTC timestamp |
| `risks[].last_review_utc` | required | required | valid UTC timestamp |
| `risks[].next_review_utc` | required | required | valid UTC timestamp; must be later than `risks[].last_review_utc` |
| `risks[].evidence_ref` | required | required | non-empty string path or URL |
| `risks[].delivery_milestone` | required | not allowed | enum: `0-30`, `31-60`, `61-90` |
| `risks[].dependency_refs` | required | not allowed | non-empty array of recommendation IDs (example: `R4`) |
| `risks[].runtime_surface` | not allowed | required | non-empty string (service/tool/flow scope) |
| `risks[].detect_signal` | not allowed | required | non-empty string (alert/log/metric trigger) |

## Review Cadence

Default cadence for both registers:
- review at least once every 7 calendar days
- do not allow stale register metadata or stale risk items

Checker pass/fail rules:
1. `last_review_utc` at register level must be within the last 7 days at check time.
2. `next_review_utc` at register level must be no more than 7 days after `last_review_utc`.
3. Each `risks[].last_review_utc` must be within the last 7 days at check time.
4. Each `risks[].next_review_utc` must be no more than 7 days after `risks[].last_review_utc`.
5. Any record violating cadence fails the check.

Operational expectation:
- delivery register review is included in weekly planning/governance review
- runtime register review is included in weekly ops/reliability review

## Failure Conditions Summary

Checker must fail when:
- either required register artifact is missing
- field is missing, malformed, out-of-enum, or marked `not allowed` for that register type
- risk IDs are not unique within a register
- cadence rules are violated at register level or risk-item level
