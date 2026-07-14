# Context Engine Remediation B0 Baseline Receipt

This append-only receipt freezes the starting state for `context-engine-remediation-plan-2026-07-14.md` before implementation waves edit runtime, CI, governance, or compatibility surfaces.

The machine-readable receipt is [`artifacts/plan/context-engine-remediation-b0-baseline.json`](../../artifacts/plan/context-engine-remediation-b0-baseline.json).

## Task receipt

| Field | Value |
| --- | --- |
| Run ID | `context-engine-remediation-20260714T085325Z-06ff69f` |
| Task / wave | `B0` / `wave-0` |
| Owner / lock | Governance / `F0` |
| Disposition | `implemented` |
| Timestamp UTC | `2026-07-14T08:53:25.5774124Z` |
| Commit / branch | `06ff69f72c5aee12768e713d42b217d8f62dcb16` / `main` |
| Original plan SHA-256 | `09e84fd7445cf781adc2708e3a01fef6ec716f256754e946e4a3f3d9051cf4de` |
| Machine receipt SHA-256 | `fe008fda3ac11041b463719e6aa099d7e6528ab668a1e848c8f3a92586401b6d` |
| Dirty tree SHA-256 | `cef5425a04b966d16c83e3f8a2e83ca5dd5987c162641de252f600906183fad1` |
| Unstaged diff SHA-256 | `2d560d296d29ba4d44eedfdc8bfd70a158d032b2f6732d3ff9705ea71c92b66c` |
| Staged diff SHA-256 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (empty) |
| Config tree SHA-256 | `a6b87a7899f8947a37a29372bae1327686af5fc3b327b88c9f68a1d41a265715` |

## Protected foreign dirty paths

The original plan transfers into the F0 execution ledger. Every other pre-existing dirty path below remains user-owned and protected from implementation edits:

- `artifacts/bench/mcp-compatibility-matrix.json`
- `docs/rollout-evidence/2026-05-31/mcp-compatibility-matrix.log`
- `artifacts/evals/mcp-compatibility.json`
- `artifacts/evals/mcp-compatibility.normalized.json`
- `artifacts/evals/mcp-eval-smoke.json`
- `artifacts/evals/mcp-eval-smoke.normalized.json`
- `context-engine-mcp-structured-results-swarm-plan.md`
- `context-engine.zip`
- `docs/context-engine-research-backed-enhancement-goal.md`
- `docs/plan-execution/openai-mcp-gap-closure-graph-artifact-contract.md`
- `docs/rollout-evidence/2026-03-04/readiness-check-output.log`
- `docs/rollout-evidence/2026-03-04/ws20-stage1-gate-output.log`
- `docs/rollout-evidence/2026-03-04/ws20-stage2-gate-output.log`
- `docs/rollout-evidence/2026-03-04/ws20-stage3-gate-output.log`
- `docs/rollout-evidence/2026-03-04/ws21-drill-check-output.log`
- `openai_mcp_enhancement_plan.md`
- `peer-context-engine-adoption-plan.md`
- `peer-context-engine-adoption-swarm-plan.md`

Exact length and SHA-256 values for all 19 original dirty entries are stored in the JSON receipt.

## Runtime, index, graph, and manifest

| Surface | Frozen value |
| --- | --- |
| Runtime | Node `v25.2.1`; npm `11.6.2`; Windows `10.0.26200.0` |
| Context Engine | server `1.9.0`; 52 tools; 21 capabilities |
| Manifest digest | `e37dc3a25140a069c4fb6bc57980ef7bff7e234c84f7784251714e80c266c9b2` |
| Index | `idle`, healthy, 817 files, indexed `2026-07-14T08:52:02.153Z` |
| Index state digest | `78bd2c343265c7471fb6124339d0fbb0e0f27f9f9efbd2c2c6a32dc96d0cf565` |
| Index fingerprint digest | `2360d28daaa5004ce61e2426bd80969567de816829839705d4889a54400440b2` |
| Graph | graph-backed and ready; artifact digest `2ce4689338e77f1e66fc712100c2ec42302e31db7c0c8e9294364196b4e7a831` |
| CE environment | no `CE_*` variables present in the capture process |

## Gate inventory at capture

The repository contract declares these PR blockers: `build`, `ci:check:mcp-smoke`, `ci:check:retrieval-holdout-fixture`, `ci:check:retrieval-quality-gate`, `ci:check:retrieval-shadow-canary-gate`, `ci:check:enhancement-error-taxonomy-report`, and `ci:check:enhance-prompt-contract`.

Five workflow files exist: `perf_gates.yml`, `release_perf_gate.yml`, `required-lane-catch-rate.yml`, `review_diff.yml`, and `test.yml`. B0 records their hashes but does not claim the declarations are wired or externally enforced. External branch-protection enforcement is `not-verified`; Q0 owns that truth split.

## Validation and rollback

- Forced index refresh completed in 4,428 ms with 817 files and zero errors.
- `tool_manifest` reported 52 tools at server version `1.9.0`.
- `trace_symbol(ContextServiceClient)` used graph-backed definition, reference, and call operations with no degradation.
- The baseline capture found 19 dirty entries and no staged paths.
- B0 changes no public contract. Rollback is an appended cancellation or supersession receipt; this baseline must not be deleted or rewritten.
