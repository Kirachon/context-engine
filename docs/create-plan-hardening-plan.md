# Plan: Harden `create_plan` with a Shared Contract, Scoped Context, and Diagnostics

**Generated**: 2026-04-10  
**Estimated Complexity**: Medium

## Overview
Keep `create_plan` as both an MCP tool and an MCP prompt, but make them share one canonical argument contract. Add discoverability polish, optional repo-scoped context filters, and additive wrapper-level diagnostics while leaving the persisted plan schema and current compact/deep heuristics unchanged.

## Scope Lock
- In scope: `create_plan` tool schema, MCP prompt metadata, scoped context plumbing, additive response diagnostics, and tests.
- Explicitly out of scope: new planning-only scope vocabulary, silent unscoped fallback, changing compact/deep selection rules, changing persisted `EnhancedPlanOutput` shape, or unrelated transport/resource work.
- The repo-wide `include_paths` / `exclude_paths` contract must be reused exactly as-is.

## Prerequisites
- Existing planning flow in `src/mcp/tools/plan.ts`, `src/mcp/services/planningService.ts`, `src/mcp/prompts/planning.ts`, and `src/mcp/server.ts`.
- Existing repo-wide path-scope helpers and validation conventions.
- No new external packages.

## Dependency Graph
```text
T1 -> T2 -> T3 -> T4 -> T6
T1 -> T2 -> T5 ->/
T2 -> T3 ->/
```

## Tasks

### T1: Canonical `create_plan` contract and prompt title
- **depends_on**: []
- **location**: `src/mcp/tools/plan.ts`, `src/mcp/prompts/planning.ts`, `src/mcp/server.ts`
- **description**: Extract one shared `create_plan` argument contract/mapping so the tool schema and MCP prompt docs are derived from the same source. Add human-friendly `title` metadata to the `create-plan` prompt entry.
- **validation**: Tool schema and prompt docs stay behaviorally unchanged except for additive title metadata; prompt listing/getting still works.
- **status**: completed (2026-04-10)
- **work_log**: Moved the shared `create-plan` prompt argument metadata into `src/mcp/prompts/planning.ts`, reused it in MCP prompt registration, and sourced the overlapping `create_plan` tool field descriptions from the same contract. Added `title: "Create Plan"` to the MCP prompt definition.
- **files_changed**: `src/mcp/prompts/planning.ts`, `src/mcp/tools/plan.ts`, `src/mcp/server.ts`
- **validation_result**: `npm run build`; `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/tools/plan.test.ts tests/integration/mcpHttpTransport.test.ts --runInBand`

### T2: Add scoped path args to `create_plan`
- **depends_on**: [T1]
- **location**: `src/mcp/tools/plan.ts`, `src/mcp/services/planningService.ts`, `src/mcp/types/planning.ts`, `src/mcp/tooling/validation.ts`
- **description**: Add optional `include_paths` / `exclude_paths` to `create_plan`, normalize them with the existing repo-wide scope helpers, and thread them into planning-context retrieval.
- **validation**: Invalid absolute/traversal globs are rejected; empty arrays behave like no scope; omitted scope preserves current behavior exactly.
- **status**: completed (2026-04-10)
- **work_log**: Added `include_paths` / `exclude_paths` to the `create_plan` tool contract, reused the shared prompt/tool argument definitions for the new fields, validated them with the existing path-scope helpers, and forwarded normalized scope filters into planning context retrieval.
- **files_changed**: `src/mcp/prompts/planning.ts`, `src/mcp/server.ts`, `src/mcp/tools/plan.ts`, `src/mcp/services/planningService.ts`, `src/mcp/types/planning.ts`
- **validation_result**: `npm run build`; `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/tools/plan.test.ts tests/prompts/planning.test.ts tests/services/planningService.test.ts tests/integration/mcpHttpTransport.test.ts --runInBand`

### T3: Preserve planning heuristics under scoped retrieval
- **depends_on**: [T2]
- **location**: `src/mcp/services/planningService.ts`
- **description**: Keep compact/deep profile selection exactly as it is today, but make scoped retrieval affect only the retrieved context. If scoped retrieval returns too little context, stay strict and surface low-confidence / clarification signals rather than silently widening the search.
- **validation**: Compact/deep behavior remains stable; no silent fallback to unscoped retrieval; thin-scope cases produce predictable clarification behavior.
- **status**: completed (2026-04-10)
- **work_log**: Preserved the existing compact/deep prompt-profile selection flow, kept scoped retrieval strict by never widening back to the full workspace, and added thin-scope clarification/confidence adjustments when scoped context returns too little material.
- **files_changed**: `src/mcp/services/planningService.ts`, `tests/services/planningService.test.ts`
- **validation_result**: `npm run build`; `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/services/planningService.test.ts --runInBand`

### T4: Add additive planning diagnostics wrapper
- **depends_on**: [T3]
- **location**: `src/mcp/tools/plan.ts`
- **description**: Add a wrapper-level `planning_context` diagnostics block to `create_plan` responses with prompt profile, whether scope was applied, retrieved context file count, token budget, and whether clarification was raised. Keep this separate from persisted plan JSON.
- **validation**: Diagnostics are additive only; `EnhancedPlanOutput` and persisted/refined/executed plan schema remain unchanged.
- **status**: completed (2026-04-10)
- **work_log**: Added additive `planning_context` diagnostics to `PlanResult` and `create_plan` output formatting, keeping the persisted plan artifact unchanged while exposing prompt profile, scope application, retrieved file count, token budget, and clarification state in the wrapper response.
- **files_changed**: `src/mcp/types/planning.ts`, `src/mcp/services/planningService.ts`, `src/mcp/tools/plan.ts`, `tests/tools/plan.test.ts`, `tests/services/planningService.test.ts`
- **validation_result**: `npm run build`; `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/tools/plan.test.ts tests/services/planningService.test.ts --runInBand`

### T5: Update MCP surface tests
- **depends_on**: [T1, T2]
- **location**: `tests/tools/plan.test.ts`, `tests/prompts/planning.test.ts`, `tests/integration/mcpHttpTransport.test.ts`
- **description**: Cover prompt title metadata, schema parity, prompt list/get behavior, and the new scoped args at the MCP surface.
- **validation**: Prompt/tool shape assertions pass; MCP prompt discovery and retrieval still work.
- **status**: completed (2026-04-10)
- **work_log**: Added prompt contract tests for scoped path arguments, exercised the `Create Plan` title in MCP prompt listings, and verified `create-plan` prompt rendering preserves `include_paths` / `exclude_paths`.
- **files_changed**: `tests/tools/plan.test.ts`, `tests/prompts/planning.test.ts`, `tests/integration/mcpHttpTransport.test.ts`
- **validation_result**: `npm run build`; `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/tools/plan.test.ts tests/prompts/planning.test.ts tests/integration/mcpHttpTransport.test.ts --runInBand`

### T6: Add behavior and regression tests
- **depends_on**: [T2, T3, T4, T5]
- **location**: `tests/tools/plan.test.ts`, `tests/services/planningService.test.ts`, `tests/integration/httpCompatibility.test.ts`
- **description**: Lock in scoped forwarding, invalid glob rejection, thin-scope behavior, compact/deep stability, and the "do not change persisted plan schema" rule.
- **validation**: Targeted Jest suites and the existing compatibility/build gates pass.
- **status**: completed (2026-04-10)
- **work_log**: Added regression coverage for invalid scoped globs, normalized scope forwarding, planning-context diagnostics, prompt-profile stability, and strict thin-scope clarification behavior.
- **files_changed**: `tests/tools/plan.test.ts`, `tests/services/planningService.test.ts`, `tests/prompts/planning.test.ts`, `tests/integration/mcpHttpTransport.test.ts`
- **validation_result**: `npm run build`; `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/tools/plan.test.ts tests/prompts/planning.test.ts tests/services/planningService.test.ts tests/integration/mcpHttpTransport.test.ts --runInBand`

## Parallel Execution Groups
| Wave | Tasks | Can Start When |
|------|-------|----------------|
| 1 | T1 | Immediately |
| 2 | T2 | T1 complete |
| 3 | T3, T5 | T2 complete |
| 4 | T4 | T3 complete |
| 5 | T6 | T2, T3, T4, and T5 complete |

## Testing Strategy
- Unit tests for schema parity, prompt title metadata, and prompt argument rendering.
- Unit tests for scoped arg validation, forwarding, and empty-array no-op behavior.
- Planning service tests for compact/deep stability and thin-scope behavior.
- MCP integration tests for prompt list/get and transport-level compatibility.
- Final readiness gate: `npm run build` plus focused Jest suites covering planning tool, planning service, prompt surface, and HTTP/MCP compatibility.

## Risks & Mitigations
- Scoped retrieval could produce weaker plans without obviously failing. Mitigation: keep scope strict, do not silently widen, and expose low-confidence or clarification signals.
- Tool and prompt definitions could drift. Mitigation: derive both from one shared contract.
- Diagnostics could accidentally leak into persisted plan JSON. Mitigation: keep diagnostics in the wrapper layer only and test schema stability explicitly.
- Prompt metadata changes could break clients if treated as more than additive polish. Mitigation: add `title` only, preserve the existing prompt name and args.

## Rollback
- Revert T2-T4 together if scoped planning regresses.
- Keep T1 prompt metadata if it is safe and independently useful.
- Do not roll back the shared contract unless the prompt/tool surfaces cannot stay aligned.
