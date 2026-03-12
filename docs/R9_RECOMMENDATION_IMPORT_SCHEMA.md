# R9 Recommendation Import Schema (CSV/MD)

Purpose: define a deterministic import contract for recommendation backlog ingestion in either CSV or Markdown table format.

## Scope

This schema applies to both:
- `docs/templates/r9-recommendation-import.template.csv`
- `docs/templates/r9-recommendation-import.template.md`

The canonical column set and order are identical across both formats.

## Canonical Columns

All columns are required unless noted otherwise.

| Order | Column | Type | Rule |
|---|---|---|---|
| 1 | `recommendation_id` | string | Required. Pattern `^R[0-9]+$`. Case-insensitive on ingest; normalized to uppercase. |
| 2 | `recommendation` | string | Required. Non-empty trimmed text. |
| 3 | `domain` | string | Required. Non-empty trimmed text. |
| 4 | `evidence` | string | Required. Non-empty trimmed text. |
| 5 | `impact` | integer | Required. Integer in `1..5`. |
| 6 | `urgency` | integer | Required. Integer in `1..5`. |
| 7 | `confidence` | integer | Required. Integer in `1..5`. |
| 8 | `effort` | integer | Required. Integer in `1..5`. |
| 9 | `risk` | integer | Required. Integer in `1..5`. |
| 10 | `score` | decimal | Required. Decimal string parseable to number (example: `18.00`). |
| 11 | `owner` | string | Required. Non-empty trimmed text. |
| 12 | `due_window` | string | Required. Enum: `0-30 days`, `31-60 days`, `61-90 days`. |
| 13 | `depends_on` | string | Required. `none` or semicolon-delimited recommendation IDs (example: `R4;R6`). |
| 14 | `success_metric` | string | Required. Non-empty trimmed text. |
| 15 | `validation` | string | Required. Non-empty trimmed text. |
| 16 | `rollback_abort` | string | Required. Non-empty trimmed text. |

## Format Rules

### CSV import

- Encoding: UTF-8.
- UTF-8 BOM is allowed. Importers must strip BOM from the first header token before column matching.
- Parsing must be RFC4180-compatible.
- Quoted commas and quoted newlines inside fields are valid and must not split columns/rows.
- Header match is strict after BOM strip and trim:
  - same 16 canonical columns
  - same order

### Markdown import

- Import source is the first Markdown table under the `## Recommendations` section.
- Header row must match the same 16 canonical columns and order.
- Escaped pipes (`\|`) and explicit line breaks (`<br>`) inside cells are allowed.
- Extra prose outside the table is ignored by import logic.

## Dependency Reference Rules

Field: `depends_on`

- `none` means no dependencies.
- Otherwise parse semicolon-delimited IDs.
- Each dependency ID must match `^R[0-9]+$`.
- IDs are normalized to uppercase and deduplicated per row.
- Self-dependency is invalid (`recommendation_id` cannot appear in its own `depends_on` set).
- Invalid dependency reference if:
  - token does not match `^R[0-9]+$`, or
  - referenced ID is neither in the current import payload nor in the existing backlog registry.

## Duplicate ID Handling

Duplicate `recommendation_id` entries in one import payload are invalid.

- Normalization for duplicate checks: trim + uppercase.
- On duplicates, fail import with actionable diagnostics listing conflicting IDs and source row numbers.

## Idempotency Rules

Natural key: `recommendation_id` (normalized to uppercase).

- Re-importing an identical payload must be a no-op.
- Re-importing with changed non-key fields must update the existing record (upsert), not create a duplicate.
- Duplicate rows for the same normalized ID in a single payload always fail (even if row content is identical).

## Failure Conditions Summary

Import must fail when:
1. Required header columns are missing, reordered, or renamed.
2. Any required field is empty after trim.
3. Numeric fields are out of range or malformed.
4. `due_window` is outside allowed enum values.
5. `depends_on` has malformed/self/unknown references.
6. Duplicate normalized `recommendation_id` exists in payload.
7. CSV row structure is broken after RFC4180 parsing.

## Deterministic Checker

Command:
- `npm run ci:check:r9-recommendation-import`

Notes:
- Checker validates both CSV and Markdown templates by default.
- Use `--known-id <R#>` for dependency references that are valid in the existing backlog but not present in the import payload.
- For targeted fixture checks, you can pass `--csv <path> --skip-md` or `--md <path> --skip-csv`.
