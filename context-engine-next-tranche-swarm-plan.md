# Context Engine Next Tranche Swarm Plan

## Summary
The current `context-engine-improvement-swarm-plan.md` is now a completed execution ledger, not the right artifact for upcoming work. The next tranche should split historical receipts from active planning, harden contract governance around the new CI/transport surfaces, and then deliver a bounded memory upgrade on top of the memory system that already exists in `src/mcp/tools/memory.ts` and `src/mcp/serviceClient.ts`.

This tranche stays additive and low-risk:
- no MCP tool renames
- no `/mcp` transport changes
- no hosted-auth rollout
- no speculative “memory palace” redesign
- no automatic memory capture by default

## Public Interfaces and Contracts
- Keep existing MCP memory tools unchanged: `add_memory`, `list_memories`.
- Keep existing memory categories unchanged: `preferences`, `decisions`, `facts`.
- Add only non-breaking optional memory metadata: `subtype`, `tags`, `priority`, `source`, `linked_files`, `linked_plans`, `evidence`, `created_at`, `updated_at`.
- Keep memory storage in `.memories/` markdown; extend parsing/writing rules rather than replacing the format.
- Add new `config/ci` governance artifacts for:
- contract lifecycle/ownership
- gate promotion policy
- decision-driving thresholds
- rollback evidence requirements
- `get_context_for_prompt` may assemble a bounded startup memory pack only when memory inclusion is enabled and relevance is high.
- `authHook` remains explicitly provisional local plumbing, not a hosted auth contract.

## Scope Lock
- In scope:
- split active planning from historical execution receipts
- define source-of-truth hierarchy and contract governance
- make retrieval receipts ratio-ready for existing gates
- add rollback evidence requirements for retrieval-changing work
- extend the existing memory system with richer metadata, startup memory packs, and better decision-first retrieval
- add explicit manual memory capture from plan/review workflows
- Out of scope:
- new MCP transport verbs or protocol changes
- hosted auth/session/origin productization
- automatic background memory capture by default
- lossy memory compression or “palace” abstractions
- new MCP tool names unless later blocked by a concrete implementation limit

## Dependency Graph
```text
T0 -> T1 -> T5 -> T9 -> T10
T0 -> T2 -> T3 -> T9
T0 -> T4 -> T9
T0 -> T6 -> T7 -> T9
T0 -> T6 -> T8 -> T9
```

## Tasks

### T0: Freeze the New Baseline
- **depends_on**: []
- **locations**: `ARCHITECTURE.md`, `context-engine-improvement-swarm-plan.md`, `docs/advanced-mcp-ux-and-hosted-maturity-plan.md`, `config/ci/*`, memory surfaces in `src/mcp/tools/memory.ts` and `src/mcp/serviceClient.ts`
- **description**: Confirm repo truth after the completed swarm tranche: which contracts exist, which plan is currently marked active, what memory capabilities already ship, and which advanced MCP items are still planning-only.
- **validation**: One baseline summary exists with no contradictions across architecture docs, CI contracts, and runtime surfaces.

### T1: Split Historical Ledger from Active Plan
- **depends_on**: [T0]
- **locations**: `ARCHITECTURE.md`, `context-engine-improvement-swarm-plan.md`, new active plan artifact
- **description**: Reclassify the completed swarm plan as an execution ledger and create a clean “next executable tranche” plan containing only unfinished work. Define the hierarchy `code + config/ci contracts > ARCHITECTURE.md > active plan > execution ledger`.
- **validation**: Exactly one active plan is referenced by architecture docs, and the old swarm plan is clearly historical.

### T2: Add Contract Governance and Promotion Rules
- **depends_on**: [T0]
- **locations**: new `config/ci` governance artifact, `gate-tier-contract.json`, architecture/reference docs
- **description**: Define lifecycle states (`active`, `planning-only`, `reference-only`, `retired`), ownership lanes, paired-test requirements, and the rule that deterministic checks are blockers while grader/LLM checks remain nightly until explicitly promoted.
- **validation**: Contract tests fail if a governed contract changes without paired tests or a declared consuming gate.

### T3: Add Thresholds and Rollback Evidence Contracts
- **depends_on**: [T2]
- **locations**: new `config/ci` thresholds artifact, new rollback-evidence artifact, `retrieval-calibration-contract.json`
- **description**: Add decision-driving thresholds only for stable metrics already used by the repo: `p95_latency`, `blank_result_rate`, `fallback_rate`, `scope_leakage_rate`, and large-file outcome ratios. Define required `baseline`, `candidate`, and `rollback` evidence for retrieval-changing slices.
- **validation**: Schema tests prove every behavior-changing retrieval PR can produce threshold-ready and rollback-ready artifacts from the same workload pack.

### T4: Make Retrieval Receipts Ratio-Ready
- **depends_on**: [T0]
- **locations**: retrieval/reporting surfaces, `serviceClient.ts`, retrieval-related tests and artifacts
- **description**: Add only the denominator fields and reason-code counters needed to compute the metrics from T3. Keep this narrow and additive; do not start a broad observability redesign.
- **validation**: Existing reports can compute rates without log scraping, and reason codes stay deterministic.

### T5: Freeze the Auth and Hosted Boundary
- **depends_on**: [T1]
- **locations**: `ARCHITECTURE.md`, `docs/advanced-mcp-ux-and-hosted-maturity-plan.md`
- **description**: State explicitly that `authHook` is local transport plumbing only. Hosted auth, remote session policy, and broader hosted maturity stay blocked until a separate approved contract exists.
- **validation**: No active planning document or capability description implies hosted auth is already designed or ready.

### T6: Define Memory v2 as an Extension of the Current System
- **depends_on**: [T0]
- **locations**: `src/mcp/tools/memory.ts`, `src/mcp/serviceClient.ts`, `docs/MEMORY_OPERATIONS_RUNBOOK.md`
- **description**: Keep current tools and categories, but extend stored memory entries with optional structured metadata. Use `subtype` for finer labels such as `review_finding`, `failed_attempt`, `incident`, or `plan_note` without changing the top-level category model.
- **validation**: Existing memory files still load unchanged, and new metadata is parsed and indexed without breaking current tools.

### T7: Add Startup Memory Pack Assembly
- **depends_on**: [T6]
- **locations**: `serviceClient.ts` context-assembly path, prompt-context tests
- **description**: Add a small, bounded startup memory pack for high-priority decisions, preferences, active constraints, and open risks. This is opt-in through existing memory-inclusion behavior and must stay token-bounded.
- **validation**: Relevant prompts receive a compact memory prelude; irrelevant prompts do not get bloated context.

### T8: Improve Memory Retrieval and Manual Capture
- **depends_on**: [T6]
- **locations**: memory retrieval logic in `serviceClient.ts`, plan/review memory handoff points, memory tests
- **description**: Rank memories using relevance plus priority, recency, and decision-ness. Add explicit manual capture from plan/review workflows so durable findings and decisions can be persisted with owner/evidence metadata. Automatic capture stays off by default.
- **validation**: Planning-style queries surface decisions/preferences ahead of archive facts, and one plan path plus one review path can emit stable memory entries.

### T9: Assemble the New Active Plan and Decision Register
- **depends_on**: [T1, T3, T4, T5, T7, T8]
- **locations**: new active plan artifact, `docs/advanced-mcp-ux-and-hosted-maturity-plan.md`
- **description**: Publish the next executable tranche with open work only, and move unresolved future questions into a compact decision register: subscriptions lifecycle semantics, completions scope, tasks vs current planning surfaces, hosted auth model, and whether automatic memory capture should ever graduate from manual mode.
- **validation**: The active plan is execution-ready, and advanced MCP UX items are clearly blocked by explicit prerequisites instead of being mixed into current delivery work.

### T10: Final Readiness Gate
- **depends_on**: [T9]
- **locations**: CI/test suite, doc-consistency checks, contract tests
- **description**: Verify source-of-truth alignment, governance enforcement, threshold/rollback artifact integrity, backward-compatible memory behavior, and startup-pack retrieval quality.
- **validation**: Contract tests, memory compatibility tests, doc-consistency checks, and existing smoke/build gates all pass together.

## Parallel Execution Groups
| Wave | Tasks |
|------|-------|
| 0 | T0 |
| 1 | T1, T2, T4, T6 |
| 2 | T3, T5, T7, T8 |
| 3 | T9 |
| 4 | T10 |

## Test Plan
- Backward-compatibility tests for existing memory files and existing `add_memory` / `list_memories` behavior.
- Context-assembly tests showing startup memory packs are bounded, relevant, and optional.
- Retrieval-report tests proving ratio metrics can be computed from artifacts alone.
- Governance contract tests proving lifecycle state, owner, paired-test, and gate-promotion rules are enforced.
- Doc-consistency tests verifying one active plan, one execution ledger, and a correct architecture reference chain.
- Existing build and MCP smoke remain required for readiness.

## Assumptions and Defaults
- The completed `context-engine-improvement-swarm-plan.md` is preserved as execution evidence, not reused as the live plan.
- Local-first behavior remains the baseline; hosted maturity is still planning-only.
- Deterministic checks stay as PR blockers; grader/LLM checks stay nightly/report-only until promoted by policy.
- Memory improvements extend the existing system rather than replacing it.
- Automatic memory capture is not enabled in this tranche; manual capture is the default safety posture.

## Execution Status (2026-04-11)
| Task | Status | Notes |
|------|--------|-------|
| T0 | Completed | Baseline and active-vs-ledger state validated against runtime/docs/contracts. |
| T1 | Completed | Active plan moved to `context-engine-next-tranche-swarm-plan.md`; prior swarm plan retained as execution ledger. |
| T2 | Completed | Added governance contract with hierarchy, lifecycle states, ownership lanes, and change-control policy. |
| T3 | Completed | Added decision-threshold and rollback-evidence contracts; wired into retrieval calibration contract/tests. |
| T4 | Completed | Added denominator receipts (`skipReasonTotal`, `fileOutcomeTotal`) for index ratio metrics. |
| T5 | Completed | Locked auth boundary as provisional local plumbing in transport contract/docs. |
| T6 | Completed | Verified existing metadata-aware memory model and documented structured metadata guidance. |
| T7 | Completed | Verified bounded startup memory pack behavior already present in context assembly + tests. |
| T8 | Completed | Verified metadata-aware memory ranking/manual capture posture already present; no auto-capture enabled. |
| T9 | Completed | Added unresolved decision register and aligned planning-only advanced MCP artifact. |
| T10 | Completed | Final readiness validation passed for contracts, docs consistency, memory behavior, build, and MCP smoke. |

## Execution Log
- Added governance and retrieval contracts:
  - `config/ci/governance-contract.json`
  - `config/ci/retrieval-decision-thresholds.json`
  - `config/ci/retrieval-rollback-evidence-contract.json`
- Updated contract wiring:
  - `config/ci/retrieval-calibration-contract.json`
  - `config/ci/local-transport-contract.json` (`auth_hook.status = provisional_local_plumbing_only`)
- Updated docs source-of-truth references and auth boundary notes:
  - `ARCHITECTURE.md`
  - `docs/advanced-mcp-ux-and-hosted-maturity-plan.md`
  - `docs/MEMORY_OPERATIONS_RUNBOOK.md`
- Added/updated contract and docs tests:
  - `tests/ci/governanceContract.test.ts`
  - `tests/ci/retrievalDecisionThresholdsContract.test.ts`
  - `tests/ci/retrievalRollbackEvidenceContract.test.ts`
  - `tests/ci/localTransportContract.test.ts`
  - `tests/ci/retrievalCalibrationContract.test.ts`
  - `tests/utils/docsContracts.test.ts`
- Added retrieval denominator receipt assertions:
  - `src/mcp/serviceClient.ts`
  - `tests/serviceClient.test.ts`
- Final readiness validation (T10):
  - `node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/ci/governanceContract.test.ts tests/ci/retrievalDecisionThresholdsContract.test.ts tests/ci/retrievalRollbackEvidenceContract.test.ts tests/ci/localTransportContract.test.ts tests/ci/retrievalCalibrationContract.test.ts tests/utils/docsContracts.test.ts tests/tools/memory.test.ts tests/serviceClient.test.ts`
  - `npm run build`
  - `npm run ci:check:mcp-smoke`
