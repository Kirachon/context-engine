# OpenAI MCP Gap Closure Ownership and Gate Pack

Purpose: freeze execution ownership, compatibility surfaces, evidence requirements, provenance rules, and wave stop/go gates for the program defined in `openai-mcp-gap-closure-swarm-plan.md`.

This document is normative for execution. If a task conflicts with this pack, execution stops until the pack is updated or the task is re-sliced.

## How To Use This Pack

1. Claim exactly one file family before writing code.
2. Record the owner lane, task ID, and planned files in the active wave receipt.
3. Capture or refresh the required evidence for that wave.
4. Run only the gates listed for the claimed family and wave.
5. Do not start the next wave until every required receipt is present and every stop condition is false.

Dirty worktrees are allowed because this program is running with multiple workers. They are only valid when the receipt separates:
- files owned by the current task
- foreign dirty paths outside the claimed family

## Frozen Compatibility Surfaces

These surfaces are contract-frozen until a later wave explicitly updates the contract and refreshes the matching evidence.

| Surface | Current repo anchors | Frozen contract |
| --- | --- | --- |
| Stdio MCP | `src/mcp/server.ts`, `src/mcp/tools/manifest.ts`, `src/mcp/tooling/discoverability.ts`, `tests/mcp/discoverability.test.ts`, `tests/snapshots/phase2/baseline/tool_manifest_basic.baseline.txt` | Tool registration remains additive-first. `SERVER_CAPABILITY_PARITY` capability shapes, prompt/resource exposure, `context-engine://tool-manifest`, and `tool_manifest` output stay stable unless a wave explicitly re-baselines them. |
| Streamable HTTP MCP | `src/http/httpServer.ts`, `tests/integration/mcpHttpTransport.test.ts` | `/mcp` stays the streamable MCP surface with `POST`, additive `GET`, and `DELETE` session teardown. Session lifecycle continues to use `mcp-session-id`; initialize is required for new sessions; missing sessions return JSON-RPC session-not-found errors; allowed local-origin policy and SSE response behavior stay stable. |
| `/api/v1` REST | `src/http/routes/tools.ts`, `src/http/httpServer.ts`, `tests/integration/httpCompatibility.test.ts` | Route inventory stays frozen at `GET /status`, `GET /retrieval/status`, and `POST /index`, `/search`, `/symbol-search`, `/symbol-references`, `/symbol-definition`, `/call-relationships`, `/codebase-retrieval`, `/enhance-prompt`, `/plan`, `/context`, `/file`, `/review-changes`, `/review-git-diff`, `/review-auto`. Validation envelope shapes and request-id header behavior stay compatible unless re-baselined. |
| Shared manifest/discoverability vocabulary | `src/mcp/tools/manifest.ts`, `src/mcp/tooling/discoverability.ts`, `tests/mcp/discoverability.test.ts`, `tests/snapshots/phase2/baseline/tool_manifest_basic.baseline.txt` | Tool ids, prompt ids, resource ids, titles, usage hints, safety hints, and related-surface wiring are the single source of truth for both stdio MCP and HTTP MCP discovery. Any intentional change must update both runtime assertions and snapshot evidence in the same wave. |

## Single-Writer File Families

Only one worker or branch may own a family at a time. If a task needs files from two families, it must be split or serialized before implementation starts.

| Family ID | File family | Primary owner lane | Typical waves | Hard rule |
| --- | --- | --- | --- | --- |
| F0 | `docs/plan-execution/**` | Docs and evidence | T0, T1, T3, T5a, T13 | Docs lane does not edit code. Code lanes do not rewrite execution docs unless reassigned. |
| F1 | `src/mcp/openaiTaskRuntime.ts`, `src/internal/handlers/enhancement.ts`, `src/mcp/services/planningService.ts`, `src/mcp/services/codeReviewService.ts`, AI-runtime tests | Runtime contract | T2, T4a, T4b | Runtime semantics stay in one lane; no retrieval or review lane edits here without a handoff. |
| F2 | `src/internal/retrieval/**`, future graph modules, retrieval tests | Retrieval and graph | T5a, T5b, T8 | Graph and retrieval persistence work stays isolated from transport and review registration work. |
| F3 | `src/mcp/serviceClient.ts`, `tests/serviceClient.test.ts` | Core orchestration | T2, T5b, T7, T8, T11a, T11b | `serviceClient.ts` is always single-writer. If two tasks need it, the later task waits. |
| F4 | `src/mcp/tools/search.ts`, symbol-tool tests | Symbol tools | T7, T8, T10a | Search/symbol work does not share a wave writer with `serviceClient.ts` unless the wave plan explicitly serializes the edits. |
| F5 | `src/mcp/server.ts`, prompt/resource registration, `SERVER_CAPABILITY_PARITY`, launcher/runtime MCP tests | Stdio MCP adapter | T10a, T10b, T11a, T11b, T12 | Cross-transport adapter changes require parity receipts before merge because HTTP MCP imports the same registry and prompt/resource builders. |
| F6 | `src/http/httpServer.ts`, `tests/integration/mcpHttpTransport.test.ts` | HTTP MCP transport | T3, T6, T12 | `/mcp` session lifecycle and origin policy are single-writer and cannot be modified in parallel with REST route inventory changes. |
| F7 | `src/http/routes/tools.ts`, `tests/integration/httpCompatibility.test.ts` | REST parity | T12 | `/api/v1` route inventory and envelopes are single-writer. Any new route or payload change must ship with updated route-inventory evidence. |
| F8 | `src/mcp/tools/manifest.ts`, `src/mcp/tooling/discoverability.ts`, `tests/mcp/discoverability.test.ts`, `tests/snapshots/phase2/baseline/tool_manifest_basic.baseline.txt` | Manifest and discoverability | T1, T7, T10a, T10b, T12 | Manifest and discoverability move together. Snapshot updates without runtime assertion updates are invalid, and vice versa. |
| F9 | `src/reviewer/**`, `src/mcp/tools/reviewDiff.ts`, `src/mcp/tools/reviewAuto.ts`, `src/reactive/ReactiveReviewService.ts`, review tests | Review pipeline | T2, T9, T12 | Review architecture stays single-writer because `review_diff` stability is a program-level gate. |
| F10 | `src/metrics/**`, `src/telemetry/**`, new `src/observability/**`, observability tests | Observability | T3, T6, T12 | Telemetry initialization and propagation stay in one lane to avoid startup-order drift. |

## Required Evidence Artifacts

Every wave must produce bounded receipts. If an artifact is unchanged from the previous wave, reuse is allowed only when the receipt explicitly says `reused_from_wave` and the commit SHA has not changed for the anchored files.

| Artifact ID | Required contents | Canonical anchors |
| --- | --- | --- |
| `baseline_bundle_receipt` | `baseline_snapshot_id`, `commit_sha`, `branch_or_tag`, `dirty_tree_receipt`, `staged_tree_receipt`, `feature_flag_snapshot`, `workspace_fingerprint` | T0 baseline slice, repo root, `git status --short`, relevant env/flag capture |
| `manifest_receipt` | `manifest_snapshot_id`, `tool_manifest_version`, `tool_count`, `capability_list_hash`, `snapshot_path`, `sha256` | `src/mcp/tools/manifest.ts`, `tests/snapshots/phase2/baseline/tool_manifest_basic.baseline.txt` |
| `discoverability_receipt` | `discoverability_assertions_id`, `prompt_ids`, `resource_ids`, `tool_ids_changed`, `sha256` | `src/mcp/tooling/discoverability.ts`, `tests/mcp/discoverability.test.ts` |
| `stdio_parity_receipt` | tool/prompt/resource inventory result, capability parity note, command/test output hash | `src/mcp/server.ts`, discoverability tests, launcher/runtime MCP smoke when applicable |
| `http_mcp_receipt` | `/mcp` initialize, session reuse, `GET /mcp`, `DELETE /mcp`, origin policy results, command/test output hash | `src/http/httpServer.ts`, `tests/integration/mcpHttpTransport.test.ts` |
| `rest_parity_receipt` | route inventory, response-envelope checks, validation-envelope checks, command/test output hash | `src/http/routes/tools.ts`, `tests/integration/httpCompatibility.test.ts` |
| `retrieval_receipt` | dataset or fixture pack id, retrieval artifact hashes, explainability/provenance assertions, fallback notes | retrieval fixtures, `artifacts/bench/*`, retrieval tests |
| `review_receipt` | review artifact snapshot hashes, timeout/noise regression checks, changed-line or diff-local evidence | review snapshots/tests, `scripts/ci/check-review-timeout-contract.ts`, `scripts/ci/review-auto-timeout-smoke.ts` |
| `telemetry_receipt` | startup order check, correlation/request-id evidence, redaction result, additive-default note | observability tests and any generated telemetry artifact |
| `wave_signoff_receipt` | `wave_id`, `task_ids`, `owner_lanes`, `files_touched`, `gates_run`, `go_or_no_go`, approver | current wave evidence summary in `docs/plan-execution/` or linked artifact pack |

## Provenance Rules

Every receipt in this program is invalid unless it includes all of the following:

| Field | Rule |
| --- | --- |
| `timestamp_utc` | UTC ISO-8601 timestamp for when the receipt was created. |
| `wave_id` and `task_ids` | Must name the exact wave and tasks covered by the receipt. |
| `owner_lane` | Must match one lane from the file-family table. Mixed-lane receipts are not allowed. |
| `commit_sha` | Full commit SHA from the workspace at receipt time. |
| `dirty_tree_receipt` | `git status --short` output captured verbatim or hashed with stored raw attachment path. |
| `foreign_dirty_paths` | Required whenever the tree is dirty from another worker. Must list paths outside the claimed family. |
| `feature_flag_snapshot` | Explicit environment or config values for any feature flags that affect the touched surface. |
| `command_or_test` | Exact command, test file, or script used to generate the receipt. |
| `anchored_files` | Concrete paths the receipt is intended to freeze. |
| `artifact_sha256` | Required for JSON, snapshot, markdown, or text artifacts that are referenced by id. |
| `intentional_deltas` | Required whenever a frozen contract changes. Must explain why the delta is allowed in that wave. |

Additional rules:
- Snapshot updates without a matching receipt are invalid.
- Copying forward hashes from an older commit is invalid.
- If a task touches `src/mcp/server.ts`, `src/http/httpServer.ts`, `src/http/routes/tools.ts`, `src/mcp/tools/manifest.ts`, or `src/mcp/tooling/discoverability.ts`, the receipt must list the transport surface affected.
- If a task touches both a runtime family and a transport family, stop and re-slice unless the wave gate explicitly allows it.

## Wave Stop/Go Gates

### Wave 0: T0 Program Contract, Ownership, and Gate Pack

Go only if:
- this ownership/gate pack exists and names concrete file families
- the sibling baseline bundle exists with `baseline_bundle_receipt`
- `manifest_receipt`, `discoverability_receipt`, `http_mcp_receipt`, and `rest_parity_receipt` anchor the current compatibility surfaces

Stop if:
- any frozen family already has two active writers
- the baseline bundle does not include dirty/staged-tree provenance
- compatibility surfaces are described only narratively, without file/test anchors

### Wave 1: T1 Freeze Current Contracts and Gap Baseline

Go only if:
- Wave 0 is green
- the gap ledger links back to the Wave 0 receipts
- no manifest/discoverability delta appears without a refreshed `manifest_receipt`

Stop if:
- the gap ledger introduces new contract claims that lack current repo anchors
- transport parity is modified before the baseline is frozen

### Wave 2: T2, T3, T5a

Go only if:
- Wave 1 is green
- T2 runtime work has a single F1/F3 owner and a `wave_signoff_receipt`
- T3 observability work stays inside F10 plus any explicitly claimed transport family
- T5a graph artifact contract stays in F0/F2 only

Stop if:
- runtime outcome semantics change without new receipts for affected AI-backed callers
- telemetry work changes startup behavior without a `telemetry_receipt`
- graph contract work writes persistent graph code before the contract is frozen

### Wave 3: T4a, T5b, T6

Go only if:
- Wave 2 receipts prove runtime semantics, telemetry architecture, and graph artifact contract are frozen
- T5b owns F2 and any required F3 changes serially, not in parallel with another F3 writer
- T6 has `telemetry_receipt` plus `http_mcp_receipt` when `/mcp` behavior changes

Stop if:
- graph persistence lands without rebuild/idempotence evidence
- telemetry initialization requires unplanned edits across multiple owner lanes

### Wave 4: T4b, T7

Go only if:
- T4a registry extraction receipts are green
- graph persistence receipts are green
- T7 claims F4, F8, and any F3 edits in serialized order with an updated `manifest_receipt`

Stop if:
- graph-backed symbol behavior ships without explicit fallback evidence
- manifest/discoverability changes are made without snapshot and runtime assertion refresh

### Wave 5: T8, T9

Go only if:
- Wave 4 is green
- T8 has `retrieval_receipt` proving explainability and provenance behavior
- T9 has `review_receipt` proving diff-native review stability and timeout/noise checks

Stop if:
- retrieval explainability is consumed downstream before its own contract is frozen
- review architecture changes expand scope into transport registration or manifest families without re-slicing

### Wave 6: T10a, T10b, T11a, T11b

Go only if:
- graph-backed symbol and retrieval receipts are green
- each task claims a distinct family or a serialized handoff for `src/mcp/server.ts` and `src/mcp/serviceClient.ts`
- new tool registration work includes refreshed `manifest_receipt` and `discoverability_receipt`

Stop if:
- two tasks want `src/mcp/server.ts`, `src/mcp/serviceClient.ts`, or `src/mcp/tooling/discoverability.ts` at the same time
- new tools are added without deterministic degraded-mode evidence

### Wave 7: T12

Go only if:
- prior waves have stable receipts for runtime, retrieval, review, and telemetry
- `stdio_parity_receipt`, `http_mcp_receipt`, and `rest_parity_receipt` are all rerun after metadata changes
- manifest/discoverability vocabulary is additive and re-baselined

Stop if:
- stdio MCP, streamable HTTP MCP, and `/api/v1` surfaces drift in naming, metadata, or availability
- parity is asserted from code inspection only, without test or script output

### Wave 8: T13

Go only if:
- all previous wave receipts are attached or linked
- final readiness work adds no brand-new contract checks for the first time
- the readiness pack includes explicit `GO` or `NO-GO`

Stop if:
- any prior wave is missing a receipt
- final readiness depends on undocumented manual steps

## Minimum Validation Matrix By Surface

These are the minimum checks that must remain green whenever the corresponding surface is touched.

| Surface touched | Minimum validation |
| --- | --- |
| `src/mcp/tools/manifest.ts` or `src/mcp/tooling/discoverability.ts` | `tests/mcp/discoverability.test.ts` plus refreshed `tests/snapshots/phase2/baseline/tool_manifest_basic.baseline.txt` receipt when output changes |
| `src/mcp/server.ts` | Discoverability/runtime MCP checks plus any transport parity receipt affected by shared registry changes |
| `src/http/httpServer.ts` | `tests/integration/mcpHttpTransport.test.ts` |
| `src/http/routes/tools.ts` | `tests/integration/httpCompatibility.test.ts` |
| review pipeline files | review-focused tests plus timeout/noise gate receipts |
| retrieval or graph files | retrieval/graph fixture or artifact receipts tied to the touched contract |

## T0 Completion Standard

T0 is complete only when:
- this pack is present in `docs/plan-execution/`
- the baseline bundle from the parallel T0 slice exists and is linked by receipt id
- the current single-writer freeze is explicit for `src/mcp/serviceClient.ts`, `src/mcp/tools/search.ts`, `src/mcp/server.ts`, `src/mcp/tooling/discoverability.ts`, and review surfaces
- the three compatibility surfaces in this pack are anchored to the current repo structure
- wave-by-wave stop/go gates are usable without additional interpretation
