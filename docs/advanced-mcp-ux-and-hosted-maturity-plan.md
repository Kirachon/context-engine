# Plan: Advanced MCP UX and Hosted Maturity

**Generated**: 2026-04-11

> Status: Planning-only follow-on artifact
>
> This document is not the active delivery plan.
> `context-engine-improvement-swarm-plan.md` remains the single active execution plan.
> `ARCHITECTURE.md` remains the architecture reference.

## Summary
This plan defines the next-stage work that can begin only after the local MCP transport contract, gate-tier contract, and retrieval calibration receipts are stable. It keeps advanced MCP UX and hosted maturity additive: no capability should be advertised or enabled before the corresponding runtime behavior, tests, and rollout receipts exist.

The goal is to turn the current local-first MCP surface into a cleaner next-step roadmap for:
- resource subscriptions
- dynamic list-changed notifications
- completions
- tasks
- hosted deployment maturity

This artifact is intentionally planning-only. It does not authorize runtime changes by itself.

## Entry Criteria
Do not start implementation work from this plan until all of the following remain green and unchanged as the current source of truth:
- `config/ci/local-transport-contract.json`
- `config/ci/gate-tier-contract.json`
- `config/ci/retrieval-calibration-contract.json`
- `src/mcp/serviceClient.ts` receipt surfaces for `IndexResult.skipReasons`, `IndexResult.fileOutcomes`, and `ContextBundle.metadata.truncationReasons`

If any of those contracts or receipt surfaces change, re-freeze them first and update this plan before beginning advanced MCP UX or hosted-maturity work.

## Scope Lock
- In scope for the next stage:
  - define the rollout order for subscriptions and dynamic notifications
  - define a narrow contract for completions
  - decide whether MCP tasks should be implemented, deferred, or replaced by existing plan/execution surfaces
  - define hosted deployment maturity prerequisites for auth, origin policy, session lifecycle, and observability
  - define readiness gates and rollback points for each capability
- Out of scope for this plan:
  - changing the existing local transport contract
  - enabling unsupported MCP capabilities early
  - changing retrieval defaults, token budgets, or large-file behavior
  - inventing a second evaluation stack
  - introducing new runtime behavior during this docs slice

## Planning Principles
- Capability flags follow tested runtime behavior, never the other way around.
- Local receipts remain the release gate for any hosted path.
- Hosted maturity is an extension of the local-first server, not a separate product line.
- If an MCP capability can be satisfied by an existing Context Engine surface, prefer mapping and reuse over parallel systems.
- Every new capability needs:
  - an explicit contract
  - deterministic integration coverage
  - blocker vs report-only validation placement
  - a rollback path independent from unrelated features

## Dependency Graph

```text
P1 -> P2 -> P5 -> P6
P1 -> P3 -> P5
P1 -> P4 -> P5
P2 -> P6
```

## Tasks

### P1: Freeze Advanced Capability Admission Rules
- **depends_on**: []
- **location**: future planning/docs surfaces only
- **description**: Define the admission rules that every advanced MCP capability must satisfy before it can be advertised. This includes runtime support, deterministic tests, and a clear mapping to the existing gate-tier contract.
- **acceptance criteria**:
  - capability rollout requires a runtime contract, integration tests, and gate placement
  - no capability is allowed to bypass `config/ci/local-transport-contract.json`
  - the rule is explicit that unsupported capabilities stay disabled and unadvertised

### P2: Plan Subscriptions and Dynamic Notifications
- **depends_on**: [P1]
- **location**: future server registration, transport, and watcher/event surfaces
- **description**: Define the implementation order for MCP resource subscriptions and list-changed notifications. Split the work into a contract freeze first, then an implementation lane tied to actual watcher/index events, not synthetic notifications.
- **acceptance criteria**:
  - `resources.subscribe` stays off until a real subscription lifecycle exists
  - list-changed notifications are tied to deterministic event sources
  - session cleanup and delete semantics from the local transport contract remain the baseline for subscription cleanup
  - notification rollout includes replay/drop behavior and unknown-session handling

### P3: Plan Completions Capability
- **depends_on**: [P1]
- **location**: future tool/prompt metadata and capability registration surfaces
- **description**: Evaluate whether MCP completions provide meaningful value beyond existing discoverability and prompt/resource surfaces. If yes, define a narrow first version focused on safe suggestions for tool arguments or prompt parameters rather than broad agent-side generation.
- **acceptance criteria**:
  - completions scope is explicitly narrow and additive
  - the plan states which existing manifest/discoverability data will source completions
  - no completion path is allowed to invent unsupported tool arguments or hidden capabilities

### P4: Plan Tasks Capability vs Existing Plan Execution Surfaces
- **depends_on**: [P1]
- **location**: future planning/docs surfaces only
- **description**: Decide whether MCP tasks should be implemented as a new server capability or whether existing `create_plan`, `execute_plan`, approval, and progress tools already satisfy the product need. Treat this as a product-and-contract decision first, not an implementation assumption.
- **acceptance criteria**:
  - the decision compares MCP tasks against current plan/execution workflows
  - the plan names the minimal bridging path if tasks are adopted
  - the plan allows an explicit defer/no-go decision instead of forcing feature parity for its own sake

### P5: Plan Hosted Maturity Baseline
- **depends_on**: [P2, P3, P4]
- **location**: future HTTP server, middleware, deployment docs, and observability surfaces
- **description**: Define the hosted-readiness baseline that must exist before any non-local deployment guidance is considered complete. Cover auth posture, origin configuration, session lifecycle, request tracing, structured logging, metrics, and operational rollback.
- **acceptance criteria**:
  - hosted auth remains a separate explicit contract from the current disabled-by-default auth hook
  - origin policy is defined as an allowlist with environment-specific configuration rather than relaxed local rules
  - session retention, cleanup, and rate-limiting expectations are documented
  - logging/metrics requirements map back to existing gate tiers instead of creating a disconnected ops track

### P6: Final Readiness Gate for Advanced MCP UX
- **depends_on**: [P2, P5]
- **location**: future test/gate/docs surfaces
- **description**: Define the final readiness review required before any advanced MCP UX or hosted-maturity slice can ship. This gate should consume the local transport contract, gate-tier contract, retrieval calibration contract, and the capability-specific contracts created in this stage.
- **acceptance criteria**:
  - the gate lists blocker checks, report-only checks, and rollback triggers
  - capability advertisement parity is re-validated before release
  - hosted rollout cannot proceed if local receipts regress

## Recommended Execution Order
1. Freeze capability admission rules so later work cannot backdoor early advertisement.
2. Decide subscriptions/notifications first because they interact most directly with transport/session behavior.
3. Evaluate completions and tasks as separate product-contract decisions instead of bundling them into one implementation wave.
4. Define hosted maturity only after the UX capability decisions are bounded.
5. Use one final readiness gate to decide what enters the next implementation roadmap.

## Required Contracts for the Next Implementation Plan
The next implementation-facing plan should not start until it creates or updates the following explicit contracts:
- advanced capability admission contract
- subscriptions and notifications contract
- completions contract or defer decision
- tasks decision record or bridge contract
- hosted auth/origin/session contract
- advanced MCP UX readiness gate

## Validation
- Doc-only consistency check:
  - this plan references the current frozen receipt artifacts by exact path
  - this plan does not claim unsupported capabilities are already available
  - this plan leaves runtime behavior and existing contracts unchanged

## Assumptions
- The current local transport contract is the only approved baseline for `/mcp`.
- Retrieval calibration and large-file receipts are stable enough to act as upstream evidence, but they are not permission to change retrieval defaults in the next stage.
- Hosted maturity should be staged after local-first correctness, not in parallel with transport re-interpretation.
- T13 will consolidate active docs after this artifact exists; this document is the input for that cleanup, not the cleanup itself.
