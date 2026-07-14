# Context Engine Remediation Q4a Pre-change Compatibility Goldens Receipt

This receipt documents `Q4a — Pre-change compatibility goldens` from
`context-engine-remediation-plan-2026-07-14.md`. It is additive evidence only;
it does not alter B0 baseline evidence, G0a/G0b governance, Q0 gate-truth
contracts, or K0's compatibility/rollback envelope. Q4a is built strictly on
top of K0 -- `config/ci/compatibility-rollback-envelope.json` and
`docs/plan-execution/context-engine-remediation-k0-compatibility-envelope-2026-07-14.md`
were read but not edited.

The machine-readable golden inventory is
[`config/ci/q4a-prechange-goldens.json`](../../config/ci/q4a-prechange-goldens.json),
validated by
[`tests/ci/q4aPrechangeGoldens.test.ts`](../../tests/ci/q4aPrechangeGoldens.test.ts),
with a deterministic fingerprint receipt at
[`artifacts/plan/context-engine-remediation-q4a-goldens.json`](../../artifacts/plan/context-engine-remediation-q4a-goldens.json).

## Task receipt

| Field | Value |
| --- | --- |
| Task / wave | `Q4a` / `wave-0` |
| Owner / lock | Compatibility / `F9` |
| Depends on | `K0`, `Q0`, `G0b` (all completed) |
| Disposition | `implemented` |
| Files edited | `config/ci/q4a-prechange-goldens.json`, `tests/ci/q4aPrechangeGoldens.test.ts`, `artifacts/plan/context-engine-remediation-q4a-goldens.json`, this receipt |

## What Q4a freezes

Q4a is a **golden-suite inventory and per-task allow-list**, not a new
snapshot corpus. It deliberately reuses existing suites as the frozen
pre-change goldens instead of duplicating large fixtures:

- **MCP manifest / output schema** — `tests/mcp/discoverability.test.ts`,
  `tests/mcp/outputSchemaContract.test.ts`, `tests/ci/checkToolManifestParity.test.ts`.
- **MCP legacy text / transport parity** — `tests/integration/client-compat.test.ts`,
  `tests/integration/mcpErrorParity.test.ts`, `tests/integration/mcpTransportParity.test.ts`,
  `tests/integration/mcpHttpTransport.test.ts`, `tests/snapshots/oldClientFixtures.test.ts`
  (plus the `tests/snapshots/phase2/baseline/**` fixture set).
- **REST mappings** — `tests/integration/httpCompatibility.test.ts`,
  `tests/mcp/discoverability.test.ts`, `tests/integration/retrievalStatusRoute.test.ts`,
  pointed at the single production mapping function
  `listRestApiToolMappings()`.
- **Security/auth** — `tests/integration/httpHardening.test.ts`,
  `tests/integration/httpAuthScopes.test.ts`, `tests/ci/localTransportContract.test.ts`,
  `tests/ci/mcpCompatibilityMatrix.test.ts` (this is the family S1 must preserve
  for loopback binds while changing the unauthenticated-remote-bind default).
- **Privacy/observability** — `tests/telemetry/auditLog.test.ts`,
  `tests/ai/contract/privacyBoundary.test.ts` (the family S2 must preserve).
- **Graph cold-start/degraded** — `tests/internal/graph/persistentGraphStore.test.ts`,
  `tests/tools/graphNativeTools.test.ts`, `tests/mcp/graphNativeRegistration.test.ts`
  (the family C2a must preserve while adding defensive artifact validation).
- **Git status correctness** — `tests/utils/gitUtils.test.ts` (C1's own suite).
- **Planning contract** — `tests/services/planningService.test.ts`,
  `tests/tools/plan.test.ts`, `tests/tools/planManagement.contract.test.ts`,
  `tests/tools/planLifecycle.contract.test.ts`, `tests/services/planPersistenceService.test.ts`
  (C0a must extend additively without breaking saved-plan schema).
- **Cache identity / semantic cache** — `tests/serviceClient.test.ts` (cache
  management and semantic-search-cache describe blocks exercising
  `getCommitAwareCacheKey()`), `tests/cache/ResponseCache.test.ts`,
  `tests/reactive/cache/ResponseCache.test.ts` (the family C3 is the approved
  task allowed to change, per the K0 rollback policy's cache rule).
- **Reactive numeric configuration** — `tests/integration/timeoutResilience.test.ts`,
  `tests/tools/reactiveReview.test.ts`, explicitly flagged
  `characterization_gap: true` because no dedicated `tests/config/env.test.ts`
  boundary-case suite exists yet; C4 is expected to add it rather than Q4a
  fabricating a synthetic pre-change golden.
- **Cancellation/session placeholders** — `tests/integration/mcpErrorParity.test.ts`,
  `tests/integration/mcpTransportParity.test.ts`, `tests/integration/timeoutResilience.test.ts`,
  `tests/integration/zombieSessionRecovery.test.ts`, `tests/integration/mcpHttpTransport.test.ts`.
  No cancellation vocabulary exists pre-change, so this family points only at
  the suites that already characterize today's (uncancellable) request/session
  lifecycle for R1a and R2 to preserve; it explicitly `inherits_to: Q4b`, the
  hard post-change parity gate defined later in Wave 3.

## Task-to-golden mapping (Wave 1/2)

Per the plan card's acceptance criterion ("every Wave 1/2 change names the
golden it is allowed to change"), `task_golden_map` in the inventory names,
for each required task id, its `allowed_goldens` (family keys),
`allowed_to_change` (concrete suite paths), and `must_not_change_without_delta`
(suites in an adjacent family it depends on but does not own):

| Task | Owner/lock | Allowed to change | Must not change without delta |
| --- | --- | --- | --- |
| `S1` | HTTP transport / F3 | `httpHardening.test.ts`, `httpAuthScopes.test.ts` | `localTransportContract.test.ts`, `config/ci/local-transport-contract.json`, `config/ci/mcp-compatibility-matrix.json` |
| `S2` | Security observability / F1 | `auditLog.test.ts`, `privacyBoundary.test.ts` | `serviceClient.test.ts` |
| `C2a` | Retrieval/graph / F6 | `persistentGraphStore.test.ts` | `graphNativeTools.test.ts`, `graphNativeRegistration.test.ts` |
| `C1` | Core orchestration / F5 | `gitUtils.test.ts` | (none) |
| `C0a` | Planning / F2 | `planningService.test.ts`, `plan.test.ts` | `planManagement.contract.test.ts`, `planLifecycle.contract.test.ts`, `planPersistenceService.test.ts` |
| `C3` | Core orchestration / F5 | `serviceClient.test.ts`, `ResponseCache.test.ts` (both copies) | (none — C3 is the approved cache-key-format owner) |
| `C4` | Runtime configuration / F10 | `timeoutResilience.test.ts`, `reactiveReview.test.ts`, may add `tests/config/env.test.ts` | (none) |
| `R1a` | Runtime contract / F11 | `mcpErrorParity.test.ts`, `mcpTransportParity.test.ts` | `timeoutResilience.test.ts`, `zombieSessionRecovery.test.ts` |
| `R2` | HTTP transport / F3 | `mcpHttpTransport.test.ts`, `zombieSessionRecovery.test.ts` | `httpHardening.test.ts`, `httpAuthScopes.test.ts` |

Tasks not listed above (`C0b`, `R1b`, `R3a`, `R3b1-3`, `C2b`, `R4`, `R5`,
`R1c`, `R6`, `Q1`-`Q3d`, `M1`-`M3`) are recorded in `inheritance_note` as
inheriting their pre-change posture through their dependency chain and are
gated for post-change parity by `Q4b` rather than re-deriving a Q4a entry, per
the plan's Wave 3 `Q4b` task description ("Extend Q4a for cancellation,
session lifecycle, health additions, auth, errors, metrics, and structured
results").

## Validation matrix

The inventory's `validation_matrix` maps each of the plan card's seven
required dimensions (`success`, `invalid_input`, `handler_error`,
`legacy_text`, `structured_output`, `auth_decision`, `degraded_behavior`) to
at least one existing suite that already exercises it, so the paired test can
assert every dimension has real coverage rather than being an unchecked
assertion in this document.

## Fingerprint receipt

`artifacts/plan/context-engine-remediation-q4a-goldens.json` records
deterministic sha256 fingerprints (no wall-clock or random input) of:

- the live 52-tool manifest name set (`getToolManifest()`) and 52-tool
  runtime registry (`buildToolRegistryEntries()`) — both hash to the same
  value, confirming manifest/runtime agreement;
- the live 20-route REST mapping set (`listRestApiToolMappings()`);
- the live 14-tool output-schema-covered set (`listConvertedToolsWithOutputSchema()`);
- the exact sha256 of `config/ci/q4a-prechange-goldens.json` itself, so any
  future edit to the golden inventory is a detectable, intentional delta.

`tests/ci/q4aPrechangeGoldens.test.ts` recomputes each fingerprint from the
live production sources and asserts equality with the receipt, in the same
pattern K0's paired test uses for its envelope.

## Validation

The paired test file:

1. Asserts the inventory declares `task_id: "Q4a"` and
   `depends_on: ["K0", "Q0", "G0b"]` with an empty `intentional_deltas` ledger.
2. Confirms the K0/B0 receipts it references by path exist, without copying
   their contents.
3. Recursively resolves every golden-family `suites`/`fixtures`/`live_sources`
   path to a real file, and fails closed on a mutation case that injects a
   non-existent path.
4. Asserts every required Wave 1/2 task id (`S1`, `S2`, `C2a`, `C1`, `C0a`,
   `C3`, `C4`, `R1a`, `R2`) has a non-empty `allowed_goldens` and
   `allowed_to_change` list with a non-empty rationale.
5. Cross-checks that every `allowed_goldens` family name is real, every
   `allowed_to_change`/`must_not_change_without_delta` suite path resolves,
   and every `allowed_to_change` suite is actually a member of one of the
   task's declared families (catches a copy-paste mismatch).
6. Confirms all seven validation-matrix dimensions are covered by at least
   one real, existing suite.
7. Confirms later tasks are recorded under `inherits_via_q4b` rather than
   duplicated into `task_golden_map`.
8. Confirms `reactive_numeric_config` is honestly flagged as a
   characterization gap.
9. Cross-checks the fingerprint receipt's 52-tool, REST-mapping, and
   output-schema-covered hashes against live production sources, and
   confirms the receipt's recorded sha256 of the golden inventory file
   matches the file's actual current contents.

This is inventory, allow-listing, and fingerprint verification only: no
production security/HTTP/planning/Git/graph/cache code was changed, no
remediation plan markdown was edited, and `.memories/**`/G0b files were not
touched.

## Test commands and results

```
npm.cmd test -- --runInBand tests/ci/q4aPrechangeGoldens.test.ts
```

Result: **1 test suite, 14 tests, all passed** (`Time: 2.514 s`).

```
npm.cmd test -- --runInBand tests/ci/compatibilityRollbackEnvelope.test.ts
```

Result (regression check that K0 is untouched): **1 test suite, 13 tests, all
passed** (`Time: 2.367 s`).

## Suggested plan-card update for Q4a

| Field | Value |
| --- | --- |
| Status | completed |
| Disposition | `implemented` |
| Log | Golden inventory `config/ci/q4a-prechange-goldens.json` freezes, by pointer, eleven pre-change golden families (MCP manifest/output-schema, legacy-text/transport parity, REST mappings, security/auth, privacy/observability, graph cold-start/degraded, Git status, planning contract, cache identity/semantic cache, reactive numeric config, cancellation/session placeholders) built on existing suites, and names, for every required Wave 1 task (`S1`, `S2`, `C2a`, `C1`, `C0a`, `C3`, `C4`, `R1a`, `R2`), the exact golden(s) it is allowed to change plus adjacent goldens it must not change without an intentional-delta receipt. A deterministic sha256 fingerprint receipt (`artifacts/plan/context-engine-remediation-q4a-goldens.json`) pins the live 52-tool manifest/runtime-registry set, 20-route REST mapping set, 14-tool output-schema-covered set, and the golden inventory's own content hash. Later Wave 2/3/4 tasks inherit via `Q4b`. Focused suite: 14/14 passed; K0's suite remains 13/13 passed (untouched). |
| Files edited | `config/ci/q4a-prechange-goldens.json`, `tests/ci/q4aPrechangeGoldens.test.ts`, `artifacts/plan/context-engine-remediation-q4a-goldens.json`, `docs/plan-execution/context-engine-remediation-q4a-prechange-goldens-2026-07-14.md` |

This update is left for the orchestrator to apply to
`context-engine-remediation-plan-2026-07-14.md`, since that file is
governance-owned and out of scope for this task's allowed edits.
