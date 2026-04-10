# Plan: Low-Risk MCP Modernization, First-Class Resources/Prompts, and Scoped Retrieval

**Generated**: 2026-04-10

> Status: Reference-only after consolidation
>
> This roadmap captures an earlier implementation wave and remains useful as scoped reference.
> `context-engine-improvement-swarm-plan.md` is the active delivery plan.
> `ARCHITECTURE.md` remains the architecture reference.

## Overview
This plan modernizes the repo's MCP surface in a low-risk sequence optimized for parallel execution. It first freezes protocol and compatibility contracts, then upgrades the MCP SDK and adds a dedicated `/mcp` transport adapter without disturbing the current stdio or REST behavior, then layers in first-class MCP resources/prompts plus scoped retrieval and `enhance_prompt` provenance.

## Scope Lock
- In scope:
  - Pin and adopt `@modelcontextprotocol/sdk@1.29.0`.
  - Add a dedicated MCP HTTP endpoint at `POST /mcp`.
  - Preserve current stdio and REST `/api/v1/*` behavior while adding MCP-native HTTP support.
  - Expose first-class MCP resources for tool manifest, saved plans, and plan history.
  - Expose first-class MCP prompts for plan creation/refinement, diff review, and request enhancement.
  - Add optional `include_paths` / `exclude_paths` scoping to retrieval/context/enhance tools.
  - Add additive provenance fields to `enhance_prompt` JSON mode only.
- Explicitly out of scope:
  - Relation-aware retrieval or graph-aware ranking.
  - Server-initiated sampling or elicitation flows.
  - Remote GitHub research tools or any new external data-source integrations.
  - Removal or renaming of existing tools or REST routes.
- File surfaces likely to change:
  - MCP transport and registration: `src/mcp/server.ts`, `src/index.ts`, `src/http/httpServer.ts`
  - Existing REST compatibility layer: `src/http/routes/tools.ts`
  - Tool and prompt/resource metadata: `src/mcp/tools/*.ts`, `src/mcp/prompts/*.ts`
  - Retrieval/context/enhancement flow: `src/internal/handlers/*.ts`, `src/internal/retrieval/*.ts`, `src/mcp/serviceClient.ts`
  - Tests and snapshots under `tests/`

## Prerequisites
- Official MCP TypeScript SDK transport/capability guidance from Context7 has been reviewed for:
  - Streamable HTTP server transport
  - resources and resource templates
  - prompts
  - tool annotations
- Current repo assumptions confirmed:
  - `@modelcontextprotocol/sdk` is currently `^1.0.4` in `package.json`
  - the pinned upgrade target for this roadmap is `1.29.0`
  - stdio MCP is implemented in `src/mcp/server.ts`
  - REST HTTP server is implemented separately in `src/http/httpServer.ts`
  - plan persistence already exists in `.context-engine-plans` via existing services

## Dependency Graph

```text
T1 -> T3 -> T6 -> T7 -> T10
T2 -> T4 -> T8 -> T10
T2 -> T9 -> T10
T5 -> T7
T3 -> T8
T6 -> T8
T6 -> T9
```

## Tasks

### T1: Freeze MCP Upgrade Target and Capability Contract
- **depends_on**: []
- **location**: `package.json`, `src/mcp/server.ts`, `src/http/httpServer.ts`, `docs/mcp-modernization-resources-prompts-scoped-retrieval-plan.md`
- **description**: Pin the intended SDK target to a stable `v1.x` release and document the protocol contract the implementation must preserve. Lock the additive `/mcp` endpoint, resources/prompts capability rollout, and stdio/REST compatibility requirements before code changes begin.
- **validation**: Plan notes and implementation checklist explicitly state:
  - exact SDK target version: `@modelcontextprotocol/sdk@1.29.0`
  - `stdio` remains default
  - `/api/v1/*` remains byte-for-byte compatible
  - `/mcp` is additive only
  - no removals of existing tool surfaces
- **status**: Completed
- **log**: Pinned the roadmap target to `@modelcontextprotocol/sdk@1.29.0` using a read-only `npm view` check and locked the compatibility contract (`stdio` default, `/api/v1/*` byte-for-byte compatibility, additive `/mcp`, no removals of existing tool surfaces).
- **files edited/created**: `docs/mcp-modernization-resources-prompts-scoped-retrieval-plan.md`

### T2: Freeze Path Scoping Contract
- **depends_on**: []
- **location**: `src/mcp/tools/search.ts`, `src/mcp/tools/codebaseRetrieval.ts`, `src/mcp/tools/context.ts`, `src/mcp/tools/enhance.ts`, `src/internal/handlers/retrieval.ts`, `src/mcp/serviceClient.ts`, `docs/mcp-modernization-resources-prompts-scoped-retrieval-plan.md`
- **description**: Define the scoped retrieval semantics up front so implementation work does not diverge across tools. Lock the shared input shape, precedence, allowed patterns, validation rules, and cache-key behavior.
- **validation**: The contract explicitly states:
  - fields are `include_paths?: string[]` and `exclude_paths?: string[]`
  - values are workspace-relative `minimatch` globs only
  - absolute paths and traversal-like patterns are rejected
  - include filtering runs before exclude filtering
  - omitted or empty arrays preserve current behavior
  - normalized sorted scope arrays are part of cache keys
  - duplicate patterns are deduplicated after normalization
  - `./` prefixes are stripped before matching and caching
  - trailing slash variants normalize to the same descendant pattern
  - path separators normalize to `/` before validation, matching, and caching
  - case sensitivity follows platform semantics: case-insensitive on Windows workspaces, case-sensitive elsewhere
- **status**: Completed
- **log**: Locked the shared scoping contract for all four public tools, including precedence, platform-aware case behavior, separator normalization, duplicate elimination, and cache-key normalization requirements across retrieval and context caches.
- **files edited/created**: `docs/mcp-modernization-resources-prompts-scoped-retrieval-plan.md`

### T3: Prepare MCP Registration Layer for New Capabilities
- **depends_on**: [T1]
- **location**: `src/mcp/server.ts`, `src/mcp/tools/manifest.ts`
- **description**: Refactor the MCP registration surface so tools remain stable while the server can later advertise resources and prompts cleanly. Keep the existing execution handlers intact and prepare capability discovery to grow additively.
- **validation**: Existing tool listing still works, current tool names remain unchanged, and manifest/capability code can add resources/prompts without altering current tool behavior.
- **status**: Completed
- **log**: Extracted reusable MCP server capability and tool-registry builders in `src/mcp/server.ts` so future resources/prompts can attach to a cleaner registration seam without changing the current live tool surface. Verified with `npm run build`.
- **files edited/created**: `src/mcp/server.ts`, `docs/mcp-modernization-resources-prompts-scoped-retrieval-plan.md`

### T4: Define Stable Resource URIs and Prompt Schemas
- **depends_on**: [T1, T2]
- **location**: `src/mcp/tools/planManagement.ts`, `src/mcp/tools/manifest.ts`, `src/mcp/prompts/planning.ts`, `src/mcp/tools/enhance.ts`
- **description**: Freeze the public names and argument shapes for the initial resource and prompt families so later implementation and tests share one contract.
- **validation**: The following public shapes are fixed and documented:
  - resources:
    - `context-engine://tool-manifest`
    - `context-engine://plans/{planId}`
    - `context-engine://plan-history/{planId}`
  - prompts:
    - `create-plan(task, mvp_only?, max_context_files?, context_token_budget?)`
    - `refine-plan(current_plan, feedback?, clarifications?)`
    - `review-diff(diff, categories?, custom_instructions?)`
    - `enhance-request(prompt, include_paths?, exclude_paths?)`
  - malformed or unknown `planId` reads resolve to a documented not-found path instead of silent omission or ad hoc fallback
- **status**: Completed
- **log**: Locked the initial resource URI families, prompt names, argument shapes, and not-found handling in the plan artifact itself so later implementation work can treat them as frozen public contracts instead of open design questions.
- **files edited/created**: `docs/mcp-modernization-resources-prompts-scoped-retrieval-plan.md`

### T5: Build Compatibility Regression Harness
- **depends_on**: []
- **location**: `tests/`, existing snapshot baselines, transport/manifest test files
- **description**: Add or tighten regression coverage that proves current stdio and `/api/v1/*` behavior stays unchanged across the rollout. This is the safety net for all later work.
- **validation**: A test suite exists that can fail on:
  - changed stdio startup/tool listing behavior
  - changed REST route shapes or status codes
  - unexpected tool inventory drift
  - broken manifest parity
- **status**: Completed
- **log**: Added a stronger compatibility harness covering stdio startup and `tools/list` parity, manifest/runtime tool inventory parity, and representative `/api/v1/*` regression checks for status, index, search, codebase retrieval, context, file, and 400-envelope behavior. Verified with `npm test -- tests/launcher.test.ts tests/snapshots/oldClientFixtures.test.ts tests/integration/httpCompatibility.test.ts`.
- **files edited/created**: `tests/launcher.test.ts`, `tests/snapshots/oldClientFixtures.test.ts`, `tests/integration/httpCompatibility.test.ts`

### T6: Upgrade the MCP SDK Without Surface Changes
- **depends_on**: [T1, T3]
- **location**: `package.json`, `src/mcp/server.ts`, any MCP registration/type imports affected by the SDK bump
- **description**: Upgrade to the pinned stable SDK target while intentionally preserving current observable behavior. Limit this task to compatibility work and obviously correct tool annotations; do not add `/mcp`, resources, or prompts yet.
- **validation**: Build passes, stdio still works, current tools still list and execute, REST compatibility tests still pass, and any added annotations are additive metadata only.
- **status**: Completed
- **log**: Upgraded `@modelcontextprotocol/sdk` from `^1.0.4` to the pinned `1.29.0` target without changing the public surface. Validation covered install/build plus targeted stdio and REST compatibility checks with `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/launcher.test.ts tests/integration/httpCompatibility.test.ts --runInBand`.
- **files edited/created**: `package.json`

### T7: Add Dedicated MCP HTTP Transport Adapter at `/mcp`
- **depends_on**: [T3, T5, T6]
- **location**: `src/http/httpServer.ts`, `src/index.ts`, `src/http/index.ts`, potentially new MCP HTTP adapter module(s)
- **description**: Introduce MCP-native HTTP handling through a dedicated transport adapter mounted at `POST /mcp`. Reuse the existing `ContextServiceClient`, but do not reuse REST route plumbing from `src/http/routes/tools.ts`.
- **validation**: MCP initialize and tool listing succeed on `/mcp`, stdio remains the default transport, `/api/v1/*` regression tests still pass unchanged, and the Express process serves `/mcp` additively rather than replacing REST.
- **status**: Completed
- **log**: Added a dedicated Streamable HTTP MCP adapter at `POST /mcp` inside the existing Express process without routing through the REST tool handlers. The transport now supports session reuse, initialize, tools, resources, and prompts while preserving stdio as the default path and leaving `/api/v1/*` behavior unchanged. Verified with `npm run build` and `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/integration/httpCompatibility.test.ts tests/integration/mcpHttpTransport.test.ts tests/launcher.test.ts --runInBand`.
- **files edited/created**: `src/http/httpServer.ts`, `tests/integration/mcpHttpTransport.test.ts`

### T8: Implement First-Class MCP Resources and Prompts
- **depends_on**: [T3, T4, T6]
- **location**: `src/mcp/server.ts`, `src/mcp/tools/manifest.ts`, `src/mcp/tools/planManagement.ts`, `src/mcp/services/planPersistenceService.ts`, `src/mcp/services/planHistoryService.ts`, `src/mcp/prompts/planning.ts`, `src/mcp/tools/enhance.ts`
- **description**: Add first-class read-only resources and prompt registrations using the frozen URIs and schemas. Source plan and history data from existing services and keep prompt text derived from the repo’s existing prompt builders/templates.
- **validation**: The server advertises resources/prompts capabilities, list/read and list/get flows work, only known plan IDs are enumerable, and no server-initiated sampling or elicitation is introduced.
- **status**: Completed
- **log**: Registered first-class MCP resources and prompts on the shared server registration layer, exposed the frozen prompt families, and wired read-only plan/history/manifest resources through the existing plan services. HTTP MCP now reuses the same registration helpers so stdio and `/mcp` advertise the same resources/prompts surface. Verified with `npm run build` and `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/integration/mcpHttpTransport.test.ts tests/launcher.test.ts --runInBand`.
- **files edited/created**: `src/mcp/server.ts`, `src/mcp/prompts/planning.ts`, `src/mcp/tools/manifest.ts`, `src/mcp/tools/planManagement.ts`, `src/http/httpServer.ts`, `tests/integration/mcpHttpTransport.test.ts`

### T9: Implement Shared Path Scoping Across Retrieval, Context, and Enhancement
- **depends_on**: [T2, T6]
- **location**: `src/internal/handlers/retrieval.ts`, `src/internal/handlers/context.ts`, `src/internal/handlers/enhancement.ts`, `src/internal/retrieval/retrieve.ts`, `src/mcp/serviceClient.ts`, `src/mcp/tools/search.ts`, `src/mcp/tools/codebaseRetrieval.ts`, `src/mcp/tools/context.ts`, `src/mcp/tools/enhance.ts`
- **description**: Thread the shared scoping contract through semantic retrieval, fallback retrieval, context assembly, and the enhancement pipeline so all four public tools behave consistently and cache safely. Scope normalization must happen before every cache lookup and cache write, including the internal context cache, so equivalent scopes cannot diverge by formatting.
- **validation**: Scoped and unscoped requests produce the expected result sets, fallback retrieval respects the same filtering rules, and cache-key behavior changes when normalized scope inputs change. Normalization explicitly covers duplicate patterns, `./` prefixes, trailing slash variants, Windows separators, and the repo's chosen case-sensitivity behavior.
- **status**: Completed
- **log**: Threaded normalized `include_paths` / `exclude_paths` through semantic retrieval, lexical fallback, context assembly, and the enhancement pipeline, and normalized scope before internal and persistent cache lookups so equivalent globs share cache entries. Added the remaining cache normalization fix in the internal context handler and removed a duplicate helper module that would have drifted from the main scope implementation. Verified with `npm run build` and `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/serviceClient.test.ts tests/tools/search.test.ts tests/tools/context.test.ts tests/tools/codebaseRetrieval.test.ts tests/tools/enhance.test.ts --runInBand`.
- **files edited/created**: `src/mcp/tooling/pathScope.ts`, `src/mcp/tooling/validation.ts`, `src/internal/handlers/context.ts`, `src/internal/handlers/enhancement.ts`, `src/internal/handlers/retrieval.ts`, `src/internal/retrieval/retrieve.ts`, `src/internal/retrieval/types.ts`, `src/mcp/serviceClient.ts`, `src/mcp/tools/search.ts`, `src/mcp/tools/codebaseRetrieval.ts`, `src/mcp/tools/context.ts`, `src/mcp/tools/enhance.ts`, `tests/tools/search.test.ts`, `tests/tools/context.test.ts`, `tests/tools/codebaseRetrieval.test.ts`, `tests/tools/enhance.test.ts`

### T10: Add `enhance_prompt` Provenance and Final Readiness Gate
- **depends_on**: [T7, T8, T9]
- **location**: `src/mcp/tools/enhance.ts`, `src/internal/handlers/enhancement.ts`, relevant tests and snapshots
- **description**: Add additive JSON-only provenance fields to `enhance_prompt`, then run the full readiness gate across transport, capability, compatibility, scoping, and provenance behavior.
- **validation**: JSON mode includes:
  - `context_files: string[]`
  - `mode: 'off' | 'light' | 'rich'`
  - `scope_applied: boolean`
  - `include_paths?: string[]`
  - `exclude_paths?: string[]`
  Text mode remains unchanged, success/error envelopes stay valid, and the full test matrix passes.
- **status**: Completed
- **log**: Added additive JSON-mode provenance fields to `enhance_prompt` (`context_files`, `mode`, `scope_applied`, `include_paths`, `exclude_paths`) while leaving text mode unchanged, then ran the final readiness gate across build, launcher/compatibility, MCP HTTP transport, scoped retrieval, and enhancement behavior. The final evidence run was `npm run build` plus `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/integration/httpCompatibility.test.ts tests/integration/mcpHttpTransport.test.ts tests/launcher.test.ts tests/serviceClient.test.ts tests/tools/search.test.ts tests/tools/context.test.ts tests/tools/codebaseRetrieval.test.ts tests/tools/enhance.test.ts --runInBand`.
- **files edited/created**: `src/internal/handlers/enhancement.ts`, `src/mcp/tools/enhance.ts`, `tests/tools/enhance.test.ts`, `tests/integration/mcpHttpTransport.test.ts`

## Parallel Execution Groups

| Wave | Tasks | Can Start When |
|------|-------|----------------|
| 1 | T1, T2, T5 | Immediately |
| 2 | T3 | T1 complete |
| 2 | T4 | T1 and T2 complete |
| 3 | T6 | T1 and T3 complete |
| 4 | T7 | T3, T5, and T6 complete |
| 4 | T8 | T2, T3, T4, and T6 complete |
| 4 | T9 | T2 and T6 complete |
| 5 | T10 | T7, T8, and T9 complete |

## Testing Strategy
- Baseline compatibility checks before and after each implementation slice:
  - `npm run build`
  - targeted suites for search, context, enhance, plan management, and status
- SDK upgrade checks:
  - stdio tool listing unchanged
  - current tool execution paths still work
  - REST `/api/v1/*` behavior unchanged
  - manifest parity only changes if additive metadata requires it
- MCP HTTP checks:
  - `/mcp` initialize succeeds
  - `/mcp` tool listing succeeds
  - `/api/v1/*` regression suite still passes
  - stdio remains default behavior
- Resource/prompt checks:
  - resource list/read for manifest, plan, and plan history
  - prompt list/get for all four prompt families
  - unknown plan IDs are not exposed
  - malformed resource URIs and unknown `planId` reads return the documented not-found path consistently
- Scoped retrieval/provenance checks:
  - include-only and exclude-only cases
  - combined include/exclude precedence
  - cache-key separation across normalized scopes
  - normalization coverage for duplicates, `./`, trailing slash variants, Windows separators, and case behavior
  - fallback retrieval obeys scope
  - `enhance_prompt` JSON success and error envelope coverage
- Final evidence-oriented readiness gate:
  - full required build/test suite passes
  - `/mcp` is additive and working
  - `/api/v1/*` compatibility is preserved
  - stdio default behavior is preserved
  - new resource/prompt capabilities are discoverable and stable
  - scoped retrieval and provenance behave exactly as frozen in T2/T4

## Risks & Mitigations
- SDK upgrade drift changes transport or registration APIs unexpectedly.
  - Mitigation: T1 pins the exact target version and T6 is isolated from feature rollout.
- `/mcp` accidentally reuses REST semantics and breaks protocol handling.
  - Mitigation: T7 requires a dedicated transport adapter and separate MCP request handling.
- Scoped retrieval returns stale or mixed results.
  - Mitigation: T2 freezes cache-key and precedence rules before implementation; T9 applies the same contract across semantic and fallback paths.
- Resource/prompt exposure drifts from existing plan/prompt sources.
  - Mitigation: T4 freezes names/schemas and T8 reuses existing services/prompt builders.
- Compatibility regressions slip in during multi-wave rollout.
  - Mitigation: T5 establishes the regression harness before risky work begins, and T10 enforces the final readiness gate.
- Stop/replan triggers:
  - MCP SDK target lacks required stable HTTP/resource/prompt APIs
  - `/api/v1/*` cannot remain compatible without larger refactors
  - scoped retrieval cannot be made cache-safe with the current shared retrieval architecture
