# Context Engine MCP Server - Comprehensive Summary (Native Era)

Last updated: 2026-03-12

## Executive Overview

Context Engine MCP Server is a local-first, agent-agnostic server that provides retrieval, context assembly, planning, and review workflows through MCP tools.

This repository has completed the migration from Auggie-era runtime reliance to a native local runtime path for active retrieval behavior.

## Current Runtime and Parity Position

- Active provider path: `local_native`
- Project package dependency on Auggie SDK: **not present** in `package.json`
- Capability parity gate status: **pass**
- Strict parity score: **100.00**

Primary evidence files:
- `artifacts/bench/auggie-capability-parity-gate.json`
- `artifacts/bench/retrieval-parity-pr.json`
- `artifacts/bench/retrieval-quality-report.json`

## Architecture Snapshot

The server uses a 5-layer architecture:

1. Retrieval and review engine (`local_native` runtime path)
2. Service orchestration (`src/mcp/serviceClient.ts`)
3. MCP interface and tool handlers (`src/mcp/server.ts`, `src/mcp/tools/*`)
4. MCP clients (Codex, Cursor, and other compatible agents)
5. Local state and artifacts (index state, caches, receipts, bench outputs)

## Capabilities

From current `tool_manifest`, the server exposes **42 tools** spanning:
- Retrieval and context tools
- Index lifecycle and diagnostics
- Plan creation/refinement/execution
- Plan persistence and history
- Approval and execution tracking
- Review and enterprise diff review
- Static analysis and invariants
- Reactive review session controls
- Secret scrubbing and content validation

## Quality Upgrade Outcome

The local-native quality rollout completed all staged gates (`observe -> shadow -> enforce -> default-on`).

Measured uplift vs baseline:
- `nDCG@10`: `+14.0%`
- `MRR@10`: `+12.5%`
- `Recall@50`: `+22.0%`

Quality report gate status: pass (`10/10` checks).

## Plain-Language Impact

- Useful results appear higher in the list.
- The first correct/useful result appears earlier.
- More relevant results are captured in the top result window.

## Operational Guardrails in Place

- Parity checks and strict history requirements
- Quality gates with explicit thresholds
- Rollout evidence receipts under `docs/rollout-evidence/`
- Legacy reference checks to prevent accidental dependency regression

## Documentation Sources of Truth

- `README.md` for top-level usage and current status
- `docs/LOCAL_NATIVE_SEARCH_QUALITY_UPGRADE_PLAN.md` for staged rollout and outcomes
- `docs/AUGGIE_ADOPTION_AND_REMOVAL_TRACKER.md` for migration tracking

## Notes on Historical Mentions

Some historical docs or changelog references may still mention Auggie context in a migration/comparison sense.
Those references are historical guardrails and parity context, not active runtime dependency claims.
