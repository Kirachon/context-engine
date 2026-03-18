# Retrieval Bottleneck v2 Execution Board

Purpose: track delivery for `T0/T1/T2/T3/T4/T5a/T6/T11/T12/T13` with explicit ownership, dependency waves, and acceptance contract.

## Task Checklist

| Task | Title | Owner | Status | Depends On | Primary Artifact |
| --- | --- | --- | --- | --- | --- |
| T0 | Contract + Ownership Gate | Worker C (Docs), Swarm Lead (Sign-off) | [x] Done (docs) | - | `docs/plan-execution/retrieval-bottleneck-v2-execution-board.md` |
| T1 | Baseline + Repro Pack | Worker C (Docs), Benchmark Owner (Run) | [x] Done (docs) | T0 | `docs/plan-execution/retrieval-bottleneck-v2-baseline-pack.md` |
| T2 | Bench Hang Reproduction (`T6a`) | Worker A (Bench) | [x] Done | T1 | `scripts/ci/run-bench-suite.ts` (probe metric validation) |
| T3 | Bench Hang Fix (`T6b`) | Worker A (Bench) | [x] Done | T2 | `src/ci/benchSuiteModePolicy.ts`, `scripts/ci/run-bench-suite.ts` |
| T4 | Bottleneck Map / Impact Envelope | Worker C (Docs), Perf Owner (Data) | [x] Done (docs) | T1 | `docs/RETRIEVAL_IMPACT_MAP.md`, this board |
| T5a | Early Best-Practice Constraint Pass | Worker C (Docs), Tech Lead (Approval) | [x] Done (docs) | T1 | this board (acceptance contract + guardrails) |
| T6 | Implementation Scaffold + Conflict-Safe Ordering | Worker C (Docs), Implementation Owners A/B | [x] Done (docs scaffold) | T4, T5a | this board (waves + boundaries) |
| T11 | Benchmark Integrity Gate | Swarm Lead (Code), Worker A (Bench) | [x] Done | T3 | `scripts/ci/check-bench-mode-lock.ts`, `tests/ci/checkBenchModeLock.test.ts` |
| T12 | Safety Drills + Canary Abort Controls | Worker C (Docs), Ops Owner (Execution) | [x] Done (docs) | T6 | `docs/plan-execution/retrieval-bottleneck-v2-safety-drills.md` |
| T13 | Final Evidence Pack + Rollout Verdict | Worker C (Docs), Release Approver (Sign) | [x] Done (template) | T12 | `docs/plan-execution/retrieval-bottleneck-v2-evidence-pack-template.md` |

Status legend:
- `Done (docs)`: planning artifact is ready.
- Execution evidence still required from task owners for runtime/code work.

## Ownership Matrix

| Lane | Responsibility | Primary Owner | Backup | Done When |
| --- | --- | --- | --- | --- |
| Governance | Contract lock, acceptance, sign-off checkpoints | Swarm Lead | Release Approver | Contract fields complete and approved |
| Baseline | Repro commands + artifact capture | Benchmark Owner | Runtime Owner | Baseline artifacts reproducible from clean workspace |
| Performance Analysis | Stage latency decomposition + risk envelope | Perf Owner | Retrieval Owner | Ranked hotspots + mitigation mapping published |
| Implementation Coordination | File ownership and wave execution ordering | Implementation Owners A/B | Swarm Lead | No same-file collision across waves |
| Safety/Ops | Kill switch, rollback, auto-abort drills | Ops Owner | On-call | Drill artifacts pass deterministic checks |
| Evidence/Reporting | Final T13 report assembly | Worker C (Docs) | Swarm Lead | T13 pack complete and signable |

## Dependency Waves

1. Wave 1: `T0`
2. Wave 2: `T1`
3. Wave 3: `T2`, `T4`, `T5a` (parallel-safe after T1)
4. Wave 4: `T3`
5. Wave 5: `T6`
6. Wave 6: `T11` (integrity gate), `T12` (drill docs)
7. Wave 7: `T13`

Execution controls:
- Do not start a wave unless all upstream dependencies are marked complete with evidence links.
- If any gate fails in a wave, stop progression and apply rollback/runbook controls before retry.
- Keep code edits out of docs lane unless explicitly reassigned.

## Acceptance Contract

| Task | Required Acceptance Checks | Required Evidence |
| --- | --- | --- |
| T0 | Owners, boundaries, dependencies, and KPI contract explicitly captured | This board with ownership matrix + acceptance table |
| T1 | Commands run from repo root produce expected baseline artifacts | Baseline pack command log + artifact paths |
| T2 | Probe path rejects non-comparable benchmark output | `run-bench-suite` probe metric validation and timeout diagnostics |
| T3 | PR mode lock defaults to `retrieve/search` and provides explicit local override | Bench policy module + tests |
| T4 | Bottleneck stages and hotspot ranking documented | `docs/RETRIEVAL_IMPACT_MAP.md` references + ranked notes |
| T5a | Latency vs quality constraints explicit and non-contradictory | Constraint section in board and linked gate docs |
| T6 | Conflict-safe ordering + ownership boundaries defined | Dependency waves + lane ownership table |
| T11 | KPI acceptance rejects low-signal benchmark mode artifacts | `ci:check:bench-mode-lock` output + passing test evidence |
| T12 | Drill procedures include kill switch, per-flag rollback, and canary abort | Safety drills doc + generated drill artifacts |
| T13 | Final report template includes baseline/candidate deltas, risk, rollback, verdict | T13 evidence pack template populated with real outputs |

Release-quality constraints:
- KPI verdicts for pass/fail must be based on `retrieve/search` mode evidence, not `scan`.
- Baseline/candidate comparisons must include dataset id/hash, commit SHA, and flag snapshot.
- Rollout recommendation must include explicit `GO` or `NO-GO` signature block.
