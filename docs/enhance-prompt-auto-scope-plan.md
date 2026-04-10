# Plan: Add Safe Auto-Scope to `enhance_prompt`

**Generated**: 2026-04-10

## Overview
Extend `enhance_prompt` with vibe-coder-friendly auto-scope while keeping compatibility risk low. Reuse one shared scope-inference helper across `create_plan` and `enhance_prompt`, keep manual scope authoritative, auto-apply inferred scope only at high confidence, and preserve `enhance_prompt` text mode plus JSON error behavior in v1.

## Scope Lock
- In scope:
  - shared scope-inference helper reused by planning and enhancement
  - `auto_scope?: boolean` on `enhance_prompt` and the MCP `enhance-request` prompt
  - additive JSON success diagnostics for enhancement
  - enhancement cache-key updates for inferred scope
  - regression tests across tool, prompt, MCP surface, and shared-helper parity
- Explicitly out of scope:
  - inferred `exclude_paths`
  - redesigning text-mode output
  - changing the JSON error envelope
  - expanding auto-scope to other retrieval tools
- Files likely to change:
  - `src/mcp/tools/enhance.ts`
  - `src/internal/handlers/enhancement.ts`
  - `src/mcp/server.ts`
  - `src/mcp/prompts/planning.ts`
  - `src/mcp/services/planningService.ts`
  - a new shared helper under `src/mcp/tooling/`
  - `tests/tools/enhance.test.ts`
  - `tests/prompts/planning.test.ts`
  - `tests/integration/mcpHttpTransport.test.ts`
  - planning-service tests covering parity

## Prerequisites
- Existing `create_plan` auto-scope behavior is already present and must remain stable.
- Existing path validation rules for `include_paths` / `exclude_paths` must be reused unchanged.
- No new dependencies are needed.

## Dependency Graph

```text
T1 -> T2 -> T3 -> T4 -> T5 -> T7
T1 -> T2 -> T6 ------^
```

## Tasks

### T1: Freeze the v1 enhancement contract
- **depends_on**: []
- **location**: `src/mcp/tools/enhance.ts`, `src/internal/handlers/enhancement.ts`
- **description**: Lock the v1 behavior before implementation. Text mode must remain a plain enhanced-prompt string. JSON error responses must remain unchanged. JSON success responses may add `scope_source`, `scope_confidence`, `applied_include_paths`, and `candidate_include_paths`, with both `applied_include_paths` and `candidate_include_paths` always present as arrays.
- **validation**: Plan and implementation both preserve text-mode shape and the existing error envelope; success JSON semantics are explicit and testable.
- **status**: Completed
- **log**: Froze the v1 enhancement contract in code: text mode remains plain enhanced prompt output, JSON errors stayed unchanged, and JSON success now always includes `scope_source`, `scope_confidence`, `applied_include_paths`, and `candidate_include_paths`.
- **files edited/created**: `src/mcp/tools/enhance.ts`, `src/internal/handlers/enhancement.ts`

### T2: Extract the shared scope-inference helper and migrate planning to it
- **depends_on**: [T1]
- **location**: `src/mcp/services/planningService.ts`, new shared helper under `src/mcp/tooling/`, any planning types needed for parity
- **description**: Move the root-derivation and confidence logic behind one deterministic helper with return shape `{ source, confidence, appliedIncludePaths, candidateIncludePaths }`. Migrate `create_plan` to use the helper so planning and enhancement follow the same inference rules, and complete this task only when planning-service regression coverage proves the migration preserved current behavior.
- **validation**: Existing `create_plan` behavior remains intact; helper output is deterministic; candidate paths are ordered and capped at 3; planning-service regression coverage proves parity before downstream tasks start.
- **status**: Completed
- **log**: Extracted a shared deterministic auto-scope helper and migrated planning to use it, preserving the existing planning diagnostics and confidence behavior while centralizing the inference rules.
- **files edited/created**: `src/mcp/tooling/autoScope.ts`, `src/mcp/services/planningService.ts`, `tests/services/planningService.test.ts`

### T3: Add `auto_scope` to enhancement tool and MCP prompt surfaces
- **depends_on**: [T2]
- **location**: `src/mcp/tools/enhance.ts`, `src/mcp/prompts/planning.ts`, `src/mcp/server.ts`
- **description**: Add `auto_scope?: boolean` with default `true` to `enhance_prompt` and `enhance-request`. Keep manual `include_paths` / `exclude_paths` authoritative, and ensure prompt/tool docs stay aligned.
- **validation**: Tool schema, prompt arguments, and MCP prompt listing/getting all expose `auto_scope` consistently without changing existing manual-scope behavior.
- **status**: Completed
- **log**: Added `auto_scope` to the enhancement tool schema and the MCP `enhance-request` prompt surface, keeping prompt/tool descriptions aligned through shared prompt-definition helpers.
- **files edited/created**: `src/mcp/tools/enhance.ts`, `src/mcp/prompts/planning.ts`, `src/mcp/server.ts`, `tests/prompts/planning.test.ts`, `tests/integration/mcpHttpTransport.test.ts`

### T4: Wire shared inference into `enhance_prompt`
- **depends_on**: [T1, T3]
- **location**: `src/internal/handlers/enhancement.ts`, `src/mcp/tools/enhance.ts`
- **description**: Run inference only after prompt validation, skip it when manual scope exists or `auto_scope` is `false`, auto-apply inferred include paths only at high confidence, keep enhancement broad at medium/low confidence, and always surface ranked candidates in JSON success. Validation failures must short-circuit before any inference or search call happens.
- **validation**: Manual scope always wins; `auto_scope: false` disables inference; medium/low confidence never auto-narrows; no inferred excludes are added; invalid prompt/path validation fails before any inference/search call happens.
- **status**: Completed
- **log**: Wired the shared helper into `enhance_prompt`, ensuring validation happens before inference, manual scope remains authoritative, high-confidence auto-scope narrows retrieval, and lower-confidence cases stay broad with ranked candidates.
- **files edited/created**: `src/internal/handlers/enhancement.ts`, `src/mcp/tools/enhance.ts`, `tests/tools/enhance.test.ts`

### T5: Update enhancement cache identity and diagnostics
- **depends_on**: [T2, T4]
- **location**: `src/internal/handlers/enhancement.ts`, `src/mcp/tools/enhance.ts`
- **description**: Extend the enhancement cache identity to include `auto_scope`, shared-helper version, applied inferred include paths, and whether inference produced candidates-only vs applied scope. Add the new scope diagnostics to JSON success responses only.
- **validation**: Broad, manual-scope, and auto-scoped enhancement requests do not share stale cached snippets; JSON success includes the frozen fields; JSON errors remain unchanged.
- **status**: Completed
- **log**: Extended the enhancement cache identity with auto-scope state, helper version, and inferred-path diagnostics so broad, manual, and auto-scoped runs stay isolated.
- **files edited/created**: `src/internal/handlers/enhancement.ts`, `tests/tools/enhance.test.ts`

### T6: Update prompt/MCP surface tests
- **depends_on**: [T3]
- **location**: `tests/prompts/planning.test.ts`, `tests/integration/mcpHttpTransport.test.ts`
- **description**: Add coverage for `auto_scope` prompt/tool parity, prompt argument rendering, and MCP prompt discovery/get behavior for the updated `enhance-request` surface.
- **validation**: Prompt surface tests fail if tool/prompt contracts drift on `auto_scope` presence, description intent, or default-true behavior semantics.
- **status**: Completed
- **log**: Added prompt-builder and MCP transport coverage for the updated `enhance-request` surface, including `auto_scope` visibility and rendered request content.
- **files edited/created**: `tests/prompts/planning.test.ts`, `tests/integration/mcpHttpTransport.test.ts`

### T7: Add tool, cache, and parity regression tests
- **depends_on**: [T5, T6]
- **location**: `tests/tools/enhance.test.ts`, planning-service tests that cover shared-helper parity
- **description**: Add tests for manual-scope precedence, `auto_scope: false`, high-confidence auto-apply, medium/low-confidence broad fallback, validation-before-inference, JSON success states, unchanged JSON error envelope, cache-key isolation, and shared-helper parity between `create_plan` and `enhance_prompt`.
- **validation**: Focused Jest suites cover all new behavior and compatibility boundaries.
- **status**: Completed
- **log**: Added regression tests for auto-scope validation, manual precedence, high-confidence auto-apply, broad fallback, unchanged error envelopes, cache isolation, and planning/helper parity.
- **files edited/created**: `tests/tools/enhance.test.ts`, `tests/services/planningService.test.ts`

## Parallel Execution Groups

| Wave | Tasks | Can Start When |
|------|-------|----------------|
| 1 | T1 | Immediately |
| 2 | T2 | T1 complete |
| 3 | T3 | T2 complete |
| 4 | T4, T6 | T4 needs T1 and T3; T6 needs T3 |
| 5 | T5 | T2 and T4 complete |
| 6 | T7 | T5 and T6 complete |

## Testing Strategy
- Run targeted planning-service tests to confirm `create_plan` still behaves the same after moving to the shared helper.
- Run enhancement tool tests for success JSON, unchanged error JSON, inference skip rules, and cache isolation.
- Run prompt and MCP integration tests for `enhance-request` parity and discovery.
- Final readiness gate:
  - `npm run build`
  - `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/tools/enhance.test.ts tests/prompts/planning.test.ts tests/integration/mcpHttpTransport.test.ts tests/services/planningService.test.ts --runInBand`

## Risks & Mitigations
- Shared helper migration could subtly change `create_plan` behavior.
  - Mitigation: freeze parity rules first and add planning-service regression coverage before calling implementation complete.
- Auto-scope could pollute enhancement cache identity.
  - Mitigation: version the helper and include inferred-scope state in the cache key.
- Tool/prompt drift could recur.
  - Mitigation: update both surfaces in the same task and cover them in prompt/MCP tests.
- Compatibility drift could leak scope fields into text mode or JSON errors.
  - Mitigation: freeze those as non-goals for v1 and test explicitly.

## Readiness Gate
- Every task log is updated in this file.
- Build passes.
- Focused Jest suites pass.
- Manual scope, broad fallback, and auto-scoped enhancement all behave deterministically.
- `create_plan` auto-scope behavior remains parity-stable after helper migration.
- Verification completed:
  - `npm run build`
  - `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/tools/enhance.test.ts tests/prompts/planning.test.ts tests/integration/mcpHttpTransport.test.ts tests/services/planningService.test.ts --runInBand`
