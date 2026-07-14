# Context Engine Remediation K0 Compatibility and Rollback Envelope Receipt

This receipt documents `K0 — Compatibility and rollback envelope` from
`context-engine-remediation-plan-2026-07-14.md`. It is additive evidence only; it
does not alter B0 baseline evidence, G0a governance, or Q0 gate-truth contracts.

The machine-readable envelope is
[`config/ci/compatibility-rollback-envelope.json`](../../config/ci/compatibility-rollback-envelope.json),
validated by
[`tests/ci/compatibilityRollbackEnvelope.test.ts`](../../tests/ci/compatibilityRollbackEnvelope.test.ts).

## Task receipt

| Field | Value |
| --- | --- |
| Task / wave | `K0` / `wave-0` |
| Owner / lock | Compatibility / `F9` (read-only anchors across F2-F8) |
| Disposition | `implemented` |
| Depends on | `G0a` (completed) |
| Files edited | `config/ci/compatibility-rollback-envelope.json`, `tests/ci/compatibilityRollbackEnvelope.test.ts`, this receipt |

## What the envelope freezes

The envelope is a pointer-and-inventory document: for every compatibility
surface it names the live production file(s) that are the actual source of
truth, plus (where available) the existing parity test that already enforces
that surface. It intentionally does not duplicate values that drift (for
example, it does not copy the 14 output-schema definitions or the full
discoverability metadata) — it points at the module and lets the paired test
diff live behavior against the envelope's declarative expectations.

- **52-tool MCP contract** — `expected_tool_count: 52` and the full sorted
  tool-name list are pinned in `mcp_tool_contract`, resolved against
  `src/mcp/tools/manifest.ts`, the runtime registry built in
  `src/mcp/server.ts`/`src/mcp/toolRegistry.ts`, and the existing
  `tests/mcp/discoverability.test.ts` / `tests/mcp/outputSchemaContract.test.ts`
  parity suites. The 14 tools with converted JSON-schema `structuredContent`
  validation are pinned separately (`output_schema_covered_tools`), resolved
  against `src/mcp/utils/outputSchemaContract.ts`.
- **Input/output/error/text/structured contracts** — pinned to
  `src/mcp/types/toolResult.ts`, `src/mcp/utils/resultBuilder.ts`, and the
  three existing MCP parity suites (`mcpErrorParity`, `mcpTransportParity`,
  `client-compat`) that already characterize legacy text vs. structured
  content vs. error envelopes.
- **REST mappings** — pinned to the single production mapping function
  `listRestApiToolMappings()` in `src/mcp/tooling/discoverability.ts`, the
  route handlers in `src/http/routes/tools.ts`/`status.ts`/`health.ts`, and
  the `/api/v1` mount in `src/http/httpServer.ts`. The 20 known tool-route
  paths and 3 non-tool routes (`/health`, `/status`, `/retrieval/status`) are
  enumerated for direct diffing.
- **Auth/config precedence** — CLI flags (`src/index.ts`), HTTP auth env vars
  `CONTEXT_ENGINE_HTTP_AUTH_ENABLED` / `CONTEXT_ENGINE_HTTP_AUTH_TOKENS`
  (`src/http/authScopes.ts`, default disabled), bounded numeric env helpers
  (`src/config/env.ts`), and all 26 feature-flag names/kill-switch env var
  (`src/config/features.ts`) are pinned with their live source files.
- **Plan/index/cache/graph artifact formats** — every preferred/legacy
  workspace-artifact file-name pair (index state, chunk/dense/LanceDB/lexical
  indexes, context state, index fingerprint, search/context caches, embedding
  reuse cache, graph metadata + payload, startup lock) is pinned to its owning
  module constant so a later rename is a detectable, intentional delta.
- **Node matrix / flags** — the CI test matrix (`18.x, 20.x, 22.x` from
  `.github/workflows/test.yml`) and the four workflows pinned to Node 20 are
  recorded, along with the fact that `package.json` declares no `engines`
  field today (`package_engines_declared: false`), so a later engines
  addition or matrix change is visible as a delta rather than silent drift.
- **Rollback policy** — restates the plan's `Frozen invariants` and
  `Wave-level rollback rules` sections by reference and pins the K0-specific
  rule: revert only the proposed contract amendment in this file; never
  rewrite B0 baseline evidence.
- **Baseline pointer** — `baseline_receipt` points at the B0 machine receipt
  (`artifacts/plan/context-engine-remediation-b0-baseline.json`) and its human
  summary, without copying or restating B0's frozen fingerprint values.
- **`intentional_deltas`** — starts as an empty array; later tasks append an
  entry (with approval) instead of silently editing a frozen section.

## Validation

The paired test file loads the envelope and, for every claim:

1. Recursively collects every path-like string referenced anywhere in the
   JSON and asserts each one resolves to a real file on disk (fails closed if
   a claimed path is missing — verified with a mutation case pointing at a
   nonexistent file).
2. Cross-checks the frozen 52-tool name list against the live
   `getToolManifest()` output and the live runtime tool registry built by
   `buildToolRegistryEntries()`.
3. Cross-checks the 14-tool output-schema-covered set against
   `listConvertedToolsWithOutputSchema()`.
4. Cross-checks the 20 REST tool-route paths against the live
   `listRestApiToolMappings()` output (method + path + mount prefix).
5. Greps the claimed auth/CLI source files for the literal env var and flag
   names to catch a rename that the JSON pointer alone would not catch.
6. Cross-checks the 26 feature-flag names against
   `getFeatureFlagsFromEnv()`.
7. Cross-checks `package.json` version/`engines` truthfulness and the live CI
   Node matrix parsed from the workflow YAML.
8. Asserts the rollback policy is non-empty and the source plan file contains
   the `Frozen invariants` and `Wave-level rollback rules` sections it cites.

This is inventory + resolution only: no golden fixture, snapshot, or baseline
value is rewritten by this task.

## Test commands and results

```
npm.cmd test -- --runInBand tests/ci/compatibilityRollbackEnvelope.test.ts
```

Result: **1 test suite, 13 tests, all passed** (`Time: 5.378 s`).

## Suggested plan-card update for K0

| Field | Value |
| --- | --- |
| Status | completed |
| Disposition | `implemented` |
| Log | Compatibility/rollback envelope `config/ci/compatibility-rollback-envelope.json` freezes the 52-tool MCP name set, the 14-tool output-schema-covered set, REST tool-route mappings (`listRestApiToolMappings()`), auth/config precedence (CLI flags, HTTP auth env vars, 26 feature flags), plan/index/cache/graph artifact file-name conventions, the CI Node matrix, and rollback policy by pointer to live production files, each resolved and cross-checked by `tests/ci/compatibilityRollbackEnvelope.test.ts` (13/13 passing). `intentional_deltas` starts empty for later tasks to append with approval. |
| Files edited | `config/ci/compatibility-rollback-envelope.json`, `tests/ci/compatibilityRollbackEnvelope.test.ts`, `docs/plan-execution/context-engine-remediation-k0-compatibility-envelope-2026-07-14.md` |

This update is left for the orchestrator to apply to
`context-engine-remediation-plan-2026-07-14.md`, since that file is
governance-owned and out of scope for this task's allowed edits.
