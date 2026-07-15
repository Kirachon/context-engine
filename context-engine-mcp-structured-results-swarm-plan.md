# Plan: Context Engine MCP Structured Results Tranche

**Generated**: 2026-05-31

## Overview

This plan implements the next safe tranche of `docs/context-engine-mcp-upgrade-plan.md`: structured MCP results for low-risk tools while preserving existing text output and public tool names. It follows the recommendation to avoid a full-roadmap rewrite and instead deliver dependency-ordered, reviewable slices.

The first implemented tranche already completed additive tool-selection discoverability. This tranche starts Phase 1 by adding a shared result contract and applying it only to `tool_manifest` and `index_status`, because both are read-only and already have stable tests.

## Scope Lock

In scope:
- Add a shared MCP tool result type and result builder.
- Teach server tool execution to accept either legacy string results or structured tool results.
- Teach both stdio MCP and HTTP MCP wrappers to preserve structured result fields.
- Convert `tool_manifest` to return text plus `structuredContent`.
- Convert `index_status` to return text plus `structuredContent`.
- Add focused tests proving backward-compatible text output and additive structured output.
- Update `docs/context-engine-mcp-upgrade-plan.md` with this tranche status.

Out of scope for this tranche:
- Changing `codebase_retrieval`, `semantic_search`, `get_context_for_prompt`, or review tool result shapes.
- Context Pack V3.
- First-class MCP resource expansion.
- Retrieval ranking changes.
- HTTP/auth/protocol hardening beyond preserving existing tool-call wrapping.
- Fixing unrelated full-suite failures not caused by this tranche.

Stop conditions:
- Any change requires modifying retrieval ranking, indexing behavior, MCP tool names, input schemas, or REST routes.
- Any converted tool loses the existing human-readable text content.
- Structured output requires breaking old-client text-only expectations.
- HTTP MCP drops `structuredContent`, `_meta`, or `isError`.

## Prerequisites

- Existing tool-selection tranche remains in place.
- Existing `npm run build` and focused Jest tests are available.
- Context Engine MCP retrieval has been used for codebase discovery before edits.

## Dependency Graph

```txt
T1 -> T3 -> T4 -> T6 -> T5
T2 --------^
```

## Tasks

### T1: Add Shared Structured Result Contract
- **depends_on**: []
- **location**: `src/mcp/types/toolResult.ts`, `src/mcp/utils/resultBuilder.ts`
- **description**: Define a compatibility-preserving `ContextEngineToolResult<T extends Record<string, unknown>>` shape aligned with the MCP SDK `CallToolResult` fields: `content`, `structuredContent`, `_meta`, and `isError`. Helpers must keep text content first and make `structuredContent` optional. This tranche intentionally does not add tool `outputSchema`; that remains deferred until more result schemas are stable.
- **validation**: TypeScript build passes; focused tests compile.
- **status**: Completed
- **log**: Added shared structured result types aligned with MCP `CallToolResult` fields and builders/normalizer for legacy string or structured handler results.
- **files edited/created**: `src/mcp/types/toolResult.ts`, `src/mcp/utils/resultBuilder.ts`

### T2: Add Status Structured Payload Model
- **depends_on**: []
- **location**: `src/mcp/tools/status.ts`, `tests/tools/status.test.ts`
- **description**: Extract the existing index status markdown formatting into pure helpers: `formatIndexStatusText(status)` and `buildIndexStatusStructuredContent(status)`. The structured payload must whitelist public fields with normalized nullable values: `schema_version`, `status`, `freshness`, `guidance`, and selected embedding runtime fields. Do not spread internal `IndexStatus`.
- **validation**: `tests/tools/status.test.ts` verifies legacy markdown still contains existing markers and structured payload covers healthy, unindexed, stale, error, uninitialized embedding, and degraded embedding cases.
- **status**: Completed
- **log**: Added pure text/structured helpers for index status with whitelisted public structured fields and edge-case test coverage.
- **files edited/created**: `src/mcp/tools/status.ts`, `tests/tools/status.test.ts`

### T3: Teach Server Wrapper To Preserve Structured Results
- **depends_on**: [T1]
- **location**: `src/mcp/server.ts`, `src/http/httpServer.ts`, `src/mcp/tooling/runtime.ts`, `tests/tooling/runtime.test.ts`, `tests/integration/mcpHttpTransport.test.ts`
- **description**: Update all string-only handler contracts and wrappers so string handlers still wrap as text-only, while structured results pass through `content`, `structuredContent`, `_meta`, and `isError` unchanged. This must cover stdio server execution, HTTP MCP execution, and the shared runtime helper.
- **validation**: Runtime tests prove mixed string/structured handler support and thrown errors still produce the existing error envelope. HTTP MCP tests prove `tools/call` preserves text plus structured fields.
- **status**: Completed
- **log**: Updated stdio, HTTP MCP, and shared runtime wrappers to preserve structured result fields while keeping legacy string wrapping and thrown-error envelopes.
- **files edited/created**: `src/mcp/server.ts`, `src/http/httpServer.ts`, `src/mcp/tooling/runtime.ts`, `tests/tooling/runtime.test.ts`, `tests/integration/mcpHttpTransport.test.ts`

### T4: Convert Low-Risk Tool Handlers
- **depends_on**: [T2, T3]
- **location**: `src/mcp/tools/manifest.ts`, `src/mcp/tools/status.ts`, `tests/tools/status.test.ts`, `tests/mcp/discoverability.test.ts`, `tests/integration/mcpHttpTransport.test.ts`, `tests/integration/client-compat.test.ts`
- **description**: Convert `handleToolManifest` and `handleIndexStatus` to return structured results with unchanged text. `tool_manifest` text must remain parse-equal to `JSON.stringify(getToolManifest(), null, 2)` and structured content must deep-equal the manifest object. `index_status` text must keep existing table/guidance markers and structured content must use the whitelisted payload from T2.
- **validation**: Tool-specific tests assert both text content and `structuredContent`; HTTP MCP and client compatibility tests prove old clients can ignore `structuredContent` while new clients can consume it.
- **status**: Completed
- **log**: Converted `tool_manifest` and `index_status` to return text plus structured content and added HTTP/client compatibility assertions.
- **files edited/created**: `src/mcp/tools/manifest.ts`, `src/mcp/tools/status.ts`, `tests/tools/status.test.ts`, `tests/integration/mcpHttpTransport.test.ts`, `tests/integration/client-compat.test.ts`

### T5: Update Plan And Compatibility Evidence
- **depends_on**: [T6]
- **location**: `docs/context-engine-mcp-upgrade-plan.md`, this plan file
- **description**: After validation and review, mark the structured-results tranche as implemented, record files changed, validation commands, review path, and explicitly keep remaining Phase 1 tool conversions deferred.
- **validation**: Plan text matches actual implemented files and commands after the gates have run.
- **status**: Completed
- **log**: Main upgrade plan updated after validation with structured-results tranche status, files, evidence, and deferred follow-up boundaries.
- **files edited/created**: `docs/context-engine-mcp-upgrade-plan.md`, `context-engine-mcp-structured-results-swarm-plan.md`

### T6: Final Validation And Review
- **depends_on**: [T4]
- **location**: repository root, changed files
- **description**: Run focused tests, build, MCP smoke, built-artifact inspection, and review the diff. Prefer `review_auto`; if it fails, try deterministic `review_diff`/`review_git_diff` where available, then run Cursor Team Kit `thermo-nuclear-code-quality-review` and incorporate high-confidence maintainability feedback.
- **validation**:
  - `npm test -- --runInBand tests/tools/status.test.ts tests/tooling/runtime.test.ts tests/integration/mcpHttpTransport.test.ts tests/integration/client-compat.test.ts tests/mcp/discoverability.test.ts tests/launcher.test.ts tests/snapshots/oldClientFixtures.test.ts`
  - `npm run build`
  - built `dist` manifest/status smoke showing structured fields are present
  - `npm run ci:check:mcp-smoke`
  - `review_auto` attempted; Cursor Team Kit `thermo-nuclear-code-quality-review` fallback completed after usage-limit failure
- **status**: Completed
- **log**: Focused tests passed with 7 suites and 63 tests. Build, MCP smoke, built `dist` structured-result inspection, and Cursor Team Kit thermo-nuclear fallback review were run/recorded. Old-client direct handler fixtures were updated to preserve text compatibility after `tool_manifest` and `index_status` became structured results.
- **files edited/created**: none beyond implementation/test/doc files

## Parallel Execution Groups

| Wave | Tasks | Can Start When |
|------|-------|----------------|
| 1 | T1, T2 | Immediately |
| 2 | T3 | T1 complete |
| 3 | T4 | T2 and T3 complete |
| 4 | T6 | T4 complete |
| 5 | T5 | T6 complete |

## Testing Strategy

- Keep old text outputs as primary compatibility proof; exact parse-equality for `tool_manifest`, existing table/guidance markers for `index_status`.
- Add assertions for `structuredContent` on converted tools only.
- Add HTTP MCP `tools/call` assertions for `tool_manifest` and `index_status`.
- Build from source and verify MCP smoke still passes.
- Do not rely on full `npm test` as the only signal because current repo has unrelated full-suite failures documented from the previous audit.

## Risks & Mitigations

- Risk: MCP SDK type mismatch for `structuredContent`.
  - Mitigation: Preserve the internal response shape as additive and validate with `npm run build`.
- Risk: old clients expect text only.
  - Mitigation: Keep `content[0].text` unchanged enough for current tests and snapshots.
- Risk: tranche grows into broader output migration.
  - Mitigation: stop if any retrieval/search/review tool conversion becomes necessary.

## Deferred Roadmap After This Tranche

- Convert `why_this_context` after status/manifest prove the shared result contract.
- Convert retrieval tools only with old-client and retrieval-quality gates.
- Build Context Pack V3 after structured results and minimum safety policy are stable.
- Expand resources, ranking, test discovery, long-running tasks, HTTP/auth hardening, and evals as separate swarm plans.
