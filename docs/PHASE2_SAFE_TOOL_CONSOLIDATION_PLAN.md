# Phase 2 – Safe Tool Consolidation (Implementation Notes)

## Goals
- Reduce internal duplication across MCP tools without changing any external contracts.
- Preserve tool names, schemas, descriptions, outputs, and error messages.
- Establish deterministic snapshot baselines for byte-for-byte regression checks.

## Non‑Negotiables
- Do NOT rename or delete MCP tools.
- Do NOT change tool schemas or descriptions.
- Do NOT change MCP routing/contracts.
- Refactor only internal implementation details.

## What Was Implemented

### 1) Tool Inventory
- Script: `scripts/extract-tool-inventory.ts`
- Output: `docs/PHASE2_TOOL_INVENTORY.md`
- Pulls tool registrations from `src/mcp/server.ts` + tool definitions.

### 2) Snapshot Harness + Baselines
- Harness: `tests/snapshots/snapshot-harness.ts`
- Inputs: `tests/snapshots/test-inputs.ts`
- Baselines: `tests/snapshots/phase2/baseline/*.baseline.txt`

Run baseline creation:
```bash
npx --no-install tsx tests/snapshots/snapshot-harness.ts --update
```

Run verification:
```bash
npx --no-install tsx tests/snapshots/snapshot-harness.ts
```

### 3) Internal Handlers (Layer 2.5)
New shared internal modules (no MCP contract changes):
- `src/internal/handlers/retrieval.ts` – shared retrieval wrapper
- `src/internal/handlers/context.ts` – shared context bundle + snippet helper
- `src/internal/handlers/enhancement.ts` – shared AI prompt enhancement logic
- `src/internal/handlers/utilities.ts` – shared file/index helpers
- `src/internal/handlers/performance.ts` – disabled-by-default hooks (cache/batching/embedding reuse)
- `src/internal/handlers/types.ts` – shared handler types

### 4) Tool Refactors (No Output Changes)
Tools now call shared handlers, preserving exact outputs:
- `codebase_retrieval`
- `semantic_search`
- `get_context_for_prompt`
- `enhance_prompt`

## Validation Checklist
- Snapshot baselines generated before refactor.
- Snapshot verification must pass after any internal changes.
- Manual smoke test if needed:
  - `index_workspace`
  - `codebase_retrieval` / `semantic_search`
  - `enhance_prompt`
  - one planning tool (`visualize_plan` or `create_plan`)
  - `list_memories`

## Rollback Plan
- Keep all Phase 2 changes in a single PR.
- If any snapshot mismatches occur:
  - revert the refactor to the baseline,
  - fix formatting adapters,
  - re-run snapshots.
