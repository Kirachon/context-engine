# Plan: Context Engine MCP Sequential Swarm Implementation

**Generated**: 2026-05-31
**Estimated Complexity**: High
**Review Mode**: swarm-planner with subagent party-mode refinement

## Overview

This plan converts `docs/context-engine-mcp-upgrade-plan.md` into dependency-aware, sequential tranches that can be executed by agents without turning the roadmap into one giant risky patch.

Already completed:
- Tool Selection Discoverability bounded tranche.
- Structured Results Foundation for `tool_manifest` and `index_status`.
- Sequential roadmap tranches S1A through S10B (structured outputs, context packs, resources, policy, ranking, tasks, auth, roots, evals, release stabilization).

The next work must preserve public MCP compatibility while adding richer structured outputs, context packs, safety, resources, ranking, tasks, HTTP hardening, client-aware behavior, evals, and finally architecture cleanup.

## Scope Lock

In scope:
- Execute the remaining roadmap as independently reviewable tranches.
- Keep MCP tool names stable unless a tranche explicitly migrates them.
- Preserve old-client text output as the first content item for every converted tool.
- Add structured outputs, output schemas, resources, policies, rankings, tasks, auth, roots, evals, and refactors only behind explicit validation gates.
- Update `docs/context-engine-mcp-upgrade-plan.md` after each completed tranche with evidence.

Out of scope:
- A single all-in-one implementation PR.
- Breaking existing local unauthenticated MCP use without a compatibility mode.
- Moving business logic into `src/mcp/server.ts` or `src/http/httpServer.ts`.
- Broad architecture refactors before behavior is protected by tests.
- Treating unrelated full-suite failures as part of a feature tranche unless the tranche is explicitly a release stabilization gate.

Architecture boundaries:
- MCP and HTTP layers remain protocol adapters.
- Context-pack assembly, policy, ranking, test discovery, and impact logic live in domain modules.
- Result-shape changes must not also change ranking, retrieval ordering, or auth policy unless explicitly stated.

## Non-Negotiable Release Gates

Any public MCP result-shape change must prove:
- Identical public tool names and additive schemas only.
- `content[0].type === "text"` and non-empty old-client text remains usable.
- `structuredContent` validates against `outputSchema` where an output schema exists.
- Stdio MCP and streamable HTTP MCP expose equivalent `tools/list`, `tools/call`, and error behavior.
- Snapshot diffs include an intentional migration note.
- Built `dist` behavior is inspected or MCP smoke is run after source changes.

Any resource or file-content exposure must prove:
- Path traversal, encoded traversal, absolute outside-root paths, symlink escapes, large files, binaries, generated files, and secret-like files are blocked or redacted with receipts.
- Stdio and HTTP resource errors use compatible MCP semantics.
- Existing resources, including `context-engine://tool-manifest` and plan resources, still work.

Review path:
- Prefer `review_auto`.
- If it fails, times out, or is rate-limited, run deterministic `review_diff` or `review_git_diff` on the scoped diff when available.
- Use Cursor Team Kit `thermo-nuclear-code-quality-review` when Context Engine review tooling is unavailable, rate-limited, or maintainability is the main risk.

Artifact hygiene:
- Retrieval and eval gates may generate benchmark/cache churn. Inspect generated artifacts after those gates and keep only intentional evidence.

## Dependency Graph

```txt
S1A -> S1B -> S1C -> S1D
S1A -> S2A -> S2B -> S2C
S1A -> S3A -> S4A -> S4B -> S4C -> S4D
S2B -> S2C
S4B -> S4C
S2C + S4C -> S5A
S5A -> S5C
S5B -> S5C
S3A -> S6A -> S6B
S6A -> S7A -> S7B
S4C -> S7A
S2B -> S8A -> S8B
S7B + S8B -> S9A -> S9B
S1D + S5C + S9B -> S10A -> S10B
```

## Tasks

### S1A: Output Schema Contract Utilities
- **depends_on**: []
- **location**: `src/mcp/types/`, `src/mcp/utils/`, tool definitions, `tests/mcp/outputSchemaContract.test.ts`
- **file-surface lock**: schema/result utilities and tests only
- **committed scope**: reusable output schema helpers and contract tests
- **stretch scope**: none
- **description**: Add utilities for converted tools to advertise additive `outputSchema` entries and validate emitted `structuredContent`.
- **validation**: `npm run build`; output schema contract tests prove converted tools advertise schemas and unconverted tools do not gain misleading schemas.
- **stop criteria**: stop if schema support requires changing unconverted tool contracts.
- **status**: Completed
- **log**: 2026-05-31 — Added output schema types, lightweight JSON schema validator, converted-tool registry, and contract tests. Gates: `npm run build`; `tests/mcp/outputSchemaContract.test.ts`.
- **files edited/created**: `src/mcp/types/outputSchema.ts`, `src/mcp/utils/jsonSchemaValidator.ts`, `src/mcp/utils/outputSchemaContract.ts`, `src/mcp/schemas/convertedToolOutputSchemas.ts`, `tests/mcp/outputSchemaContract.test.ts`

### S1B: Convert `why_this_context`
- **depends_on**: [S1A]
- **location**: `src/mcp/tools/whyThisContext.ts`, `tests/integration/mcpHttpTransport.test.ts`, `tests/integration/oldClientTextCompatibility.test.ts`, `tests/snapshots/`
- **file-surface lock**: `why_this_context` handler, schema, and focused tests
- **committed scope**: structured result plus preserved legacy text
- **stretch scope**: richer ranking explanations beyond currently available provenance
- **description**: Convert `why_this_context` to return text plus structured explanation payload with query, selected items, reasons, degraded-mode receipts, and provenance where available.
- **validation**: direct handler test; stdio-like execution test; HTTP `/mcp` `tools/call` test; old-client text fixture; `npm run build`; MCP smoke or built `dist` inspection.
- **stop criteria**: stop if old-client text snapshots change without an intentional migration note.
- **status**: Completed
- **log**: 2026-05-31 — Converted `why_this_context` to structured results with preserved legacy text and output schema. Gates: `tests/tools/whyThisContext.test.ts`; transport parity suites.
- **files edited/created**: `src/mcp/tools/whyThisContext.ts`, `tests/tools/whyThisContext.test.ts`, `tests/snapshots/phase2/baseline/*`, `tests/snapshots/oldClientFixtures.test.ts`

### S1C: Convert Symbol Navigation In Small Families
- **depends_on**: [S1A]
- **location**: `src/mcp/tools/search.ts`, `src/mcp/tools/findCallers.ts`, `src/mcp/tools/findCallees.ts`, `src/mcp/tools/traceSymbol.ts`, tests and snapshots
- **file-surface lock**: symbol/navigation handlers and focused compatibility tests
- **committed scope**: `symbol_search`, `symbol_definition`, `symbol_references`, then `call_relationships`, then `find_callers`/`find_callees`
- **stretch scope**: `trace_symbol`; defer final `impact_analysis` richness to S5C
- **description**: Convert symbol/navigation tool families incrementally so each family has its own schema, fixture set, and rollback boundary.
- **validation**: family-specific direct handler tests; HTTP `tools/call`; old-client snapshot harness; `tests/snapshots/oldClientFixtures.test.ts`; build; MCP smoke.
- **stop criteria**: stop if fallback receipts, limits, filters, or result ordering change accidentally.
- **status**: Completed
- **log**: 2026-05-31 — Converted symbol/navigation families with output schemas and old-client text preservation. Gates: `tests/tools/search.test.ts`, `tests/tools/graphNativeTools.test.ts`.
- **files edited/created**: `src/mcp/tools/search.ts`, `src/mcp/tools/findCallers.ts`, `src/mcp/tools/findCallees.ts`, `src/mcp/tools/traceSymbol.ts`, `tests/tools/graphNativeTools.test.ts`, `tests/tools/search.test.ts`

### S1D: Convert Retrieval Tools Last
- **depends_on**: [S1C]
- **location**: `src/mcp/tools/codebaseRetrieval.ts`, `src/mcp/tools/search.ts`, `src/mcp/tools/context.ts`, retrieval tests, snapshots, benchmark artifacts
- **file-surface lock**: one retrieval tool per patch plus its tests
- **committed scope**: one retrieval tool at a time with ranking parity
- **stretch scope**: converting all retrieval tools in one tranche is not allowed
- **description**: Convert `codebase_retrieval`, `semantic_search`, and `get_context_for_prompt` only after symbol/navigation structured outputs are stable.
- **validation**: retrieval tests; old-client text fixtures; snapshot harness; ranking parity gate; `npm run ci:check:retrieval-quality-gate`; build; MCP smoke.
- **stop criteria**: stop on ranking, ordering, limit, filter, fallback-state, or retrieval-quality regression.
- **status**: Completed
- **log**: 2026-05-31 — Converted retrieval tools with structured payloads and ranking parity preserved. Gates: `tests/tools/codebaseRetrieval.test.ts`, `tests/tools/context.test.ts`, `tests/tools/search.test.ts`.
- **files edited/created**: `src/mcp/tools/codebaseRetrieval.ts`, `src/mcp/tools/search.ts`, `src/mcp/tools/context.ts`, `tests/tools/codebaseRetrieval.test.ts`, `tests/tools/context.test.ts`

### S2A: Shared Stdio/HTTP Execution Wrapper
- **depends_on**: [S1A]
- **location**: `src/mcp/executeTool.ts`, `src/mcp/server.ts`, `src/http/httpServer.ts`, `src/mcp/tooling/runtime.ts`, `tests/integration/mcpTransportParity.test.ts`, `tests/integration/mcpErrorParity.test.ts`
- **file-surface lock**: transport execution path only
- **committed scope**: centralize validation, result normalization, metrics/logging hooks, errors, and cancellation plumbing where already supported
- **stretch scope**: auth, tasks, resources
- **description**: Extract shared execution behavior early so future structured/resource/task paths do not duplicate stdio and HTTP semantics.
- **validation**: stdio/HTTP parity tests for known tool, unknown tool, invalid params, handler throw, structured success, and structured error; build; MCP smoke.
- **stop criteria**: stop if local MCP startup markers or current HTTP session behavior change unexpectedly.
- **status**: Completed
- **log**: 2026-05-31 — Centralized tool execution in `executeTool.ts` with input-schema validation and JSON-RPC error propagation. Gates: transport/error parity tests; `npm run ci:check:mcp-smoke`.
- **files edited/created**: `src/mcp/executeTool.ts`, `src/mcp/utils/validateToolInput.ts`, `src/mcp/server.ts`, `src/http/httpServer.ts`, `src/mcp/tooling/runtime.ts`, `tests/integration/mcpTransportParity.test.ts`, `tests/integration/mcpErrorParity.test.ts`, `tests/tooling/runtime.test.ts`

### S2B: Context Pack V3 Types And Ephemeral Assembler
- **depends_on**: [S1A]
- **location**: `src/context/types/contextPack.ts`, `src/context/contextPackAssembler.ts`, `tests/context/`
- **file-surface lock**: context pack domain modules and deterministic fixtures
- **committed scope**: pure types, deterministic IDs, token budget accounting, ephemeral assembler
- **stretch scope**: persistence/store
- **description**: Add Context Pack V3 shape and an assembler that can build an ephemeral pack from existing retrieval results without storage.
- **validation**: type/build tests; assembler fixture tests; stable pack ID tests; context pack size gate.
- **stop criteria**: stop if equivalent inputs produce unstable pack IDs or unbounded payloads.
- **status**: Completed
- **log**: 2026-05-31 — Added Context Pack V3 types and deterministic assembler with token budget accounting. Gates: `tests/context/contextPackAssembler.test.ts`.
- **files edited/created**: `src/context/types/contextPack.ts`, `src/context/contextPackAssembler.ts`, `tests/context/contextPackAssembler.test.ts`

### S2C: First Context Pack Return Path
- **depends_on**: [S2B, S1D]
- **location**: `src/mcp/tools/context.ts` or `src/mcp/tools/codebaseRetrieval.ts`, context pack tests
- **file-surface lock**: one retrieval/context tool plus tests
- **committed scope**: optional structured context pack return for one tool
- **stretch scope**: store-backed saved packs
- **description**: Return an ephemeral Context Pack V3 from one tool while preserving legacy text and retrieval ordering.
- **validation**: HTTP `tools/call`; old-client text compatibility; context pack size and deterministic ID checks; retrieval quality gate.
- **stop criteria**: stop if context pack output changes retrieval ranking or bloats responses beyond budget.
- **status**: Completed
- **log**: 2026-05-31 — Added optional context pack return from `get_context_for_prompt` while preserving legacy text. Gates: `tests/tools/context.test.ts`.
- **files edited/created**: `src/mcp/tools/context.ts`, `tests/tools/context.test.ts`

### S3A: Minimal Context Policy Engine
- **depends_on**: [S1A]
- **location**: `src/security/contextPolicy.ts`, `src/security/secretScanner.ts`, `src/security/pathSafety.ts`, `tests/mcp/resourceSafety.test.ts`
- **file-surface lock**: policy/security modules and fixtures
- **committed scope**: path traversal, encoded traversal, outside-root, symlink escape, secret-like file, large file, binary, generated file checks
- **stretch scope**: advanced secret detectors
- **description**: Add policy checks before broad resource exposure.
- **validation**: resource safety fixtures; no auth headers/tokens/raw `.env` in logs; build.
- **stop criteria**: stop if policy cannot produce clear block/redaction receipts.
- **status**: Completed
- **log**: 2026-05-31 — Added context policy engine with path/secret/generated-file checks and redaction receipts. Gates: `tests/mcp/resourceSafety.test.ts`.
- **files edited/created**: `src/security/contextPolicy.ts`, `src/security/secretScanner.ts`, `src/security/pathSafety.ts`, `tests/mcp/resourceSafety.test.ts`

### S4A: Extract Existing Resource Handling
- **depends_on**: [S3A, S2A]
- **location**: `src/mcp/resources/resourceRouter.ts`, `src/mcp/server.ts`, `src/http/httpServer.ts`, resource tests
- **file-surface lock**: resource adapter/router only
- **committed scope**: preserve existing `context-engine://tool-manifest`, plan, and plan-history resource behavior
- **stretch scope**: broad file/chunk/symbol reads
- **description**: Move existing resource handling into a router without expanding the resource surface yet.
- **validation**: existing resource URI migration tests; stdio/HTTP `resources/list` and `resources/read` parity; not-found/error parity.
- **stop criteria**: stop if any existing resource URI changes.
- **status**: Completed
- **log**: 2026-05-31 — Extracted resource routing while preserving existing plan/manifest URIs. Gates: `tests/mcp/resourceRouter.test.ts`; MCP smoke resource checks.
- **files edited/created**: `src/mcp/resources/resourceRouter.ts`, `src/mcp/server.ts`, `src/http/httpServer.ts`, `tests/mcp/resourceRouter.test.ts`

### S4B: Add Resource Templates Or Document Absence
- **depends_on**: [S4A]
- **location**: `src/mcp/resources/`, MCP capability tests
- **file-surface lock**: resource template metadata and tests
- **committed scope**: templates if supported by installed SDK; otherwise explicit documented non-support with concrete resource list coverage
- **stretch scope**: dynamic template expansion
- **description**: Add or explicitly defer resource templates for files, chunks, symbols, context packs, reviews, and index snapshots.
- **validation**: `resources/list`/template tests prove stdio and HTTP expose the same names, URIs, MIME types, and descriptions.
- **stop criteria**: stop if SDK support is unclear; document the supported concrete-resource behavior instead.
- **status**: Completed
- **log**: 2026-05-31 — Added resource template metadata for files, chunks, symbols, context packs, and index snapshots. Gates: `tests/mcp/resourceTemplates.test.ts`.
- **files edited/created**: `src/mcp/resources/resourceTemplates.ts`, `tests/mcp/resourceTemplates.test.ts`

### S4C: Policy-Enforced File/Chunk/Symbol Resources
- **depends_on**: [S4B, S3A]
- **location**: `src/mcp/resources/`, `src/security/`, resource safety tests
- **file-surface lock**: resources and policy integration only
- **committed scope**: safe workspace file/resource reads behind policy receipts
- **stretch scope**: broad chunk/symbol resource expansion
- **description**: Add file/chunk/symbol resource reads only after policy enforcement is available.
- **validation**: traversal, encoded traversal, outside-root, symlink, MIME, huge/binary/generated/secret tests; stdio/HTTP parity.
- **stop criteria**: stop if blocked/redacted resources lack receipts.
- **status**: Completed
- **log**: 2026-05-31 — Added policy-enforced file/chunk/symbol resource reads with block receipts. Gates: `tests/mcp/resourcePolicyReads.test.ts`, `tests/mcp/resourceSafety.test.ts`.
- **files edited/created**: `src/mcp/resources/policyEnforcedReads.ts`, `tests/mcp/resourcePolicyReads.test.ts`, `tests/mcp/resourceSafety.test.ts`

### S4D: Saved Context Pack Store And Resources
- **depends_on**: [S2C, S4C]
- **location**: `src/context/contextPackStore.ts`, `src/mcp/resources/`, tests
- **file-surface lock**: context pack store/resources only
- **committed scope**: save/get/list/delete recent packs safely
- **stretch scope**: retention policy UI or external persistence
- **description**: Add saved-pack persistence only after ephemeral context packs and policy-enforced resources are stable.
- **validation**: store lifecycle tests; path safety tests; saved-pack resource tests; cleanup behavior tests.
- **stop criteria**: stop if cache lifecycle can orphan or expose stale unsafe data.
- **status**: Completed
- **log**: 2026-05-31 — Added in-memory context pack store with save/get/list/delete lifecycle. Gates: `tests/context/contextPackStore.test.ts`.
- **files edited/created**: `src/context/contextPackStore.ts`, `tests/context/contextPackStore.test.ts`

### S5A: Lightweight Eval Harness Skeleton
- **depends_on**: [S2C, S4C]
- **location**: `evals/`, `scripts/ci/`, package scripts
- **file-surface lock**: eval harness and fixtures only
- **committed scope**: informational eval smoke runner with retrieval/context-pack fixtures
- **stretch scope**: blocking CI quality gates
- **description**: Introduce evals early as shadow gates before ranking and context-pack tuning become release-blocking.
- **validation**: eval smoke passes; sprint records whether evals are informational, warning-only, or blocking.
- **stop criteria**: stop if eval artifacts are nondeterministic without normalization.
- **status**: Completed
- **log**: 2026-05-31 — Added eval harness skeleton with normalized smoke output. Gates: `npm run ci:check:mcp-eval-smoke`; `tests/evals/mcpEvalSmoke.test.ts`.
- **files edited/created**: `evals/`, `scripts/ci/run-mcp-eval-smoke.ts`, `tests/evals/mcpEvalSmoke.test.ts`, `package.json`

### S5B: Ranking Receipts
- **depends_on**: [S2B]
- **location**: `src/context/ranking.ts`, `src/context/rankingReceipts.ts`, ranking tests
- **file-surface lock**: ranking receipt model and tests only
- **committed scope**: explain current ranking signals without changing ranking behavior
- **stretch scope**: new ranking algorithm
- **description**: Add receipts for exact symbol, file name, semantic, graph, git, test, and entrypoint signals.
- **validation**: deterministic ranking receipt tests; retrieval-quality shadow gate.
- **stop criteria**: stop if retrieval ordering changes.
- **status**: Completed
- **log**: 2026-05-31 — Added ranking receipt model explaining current signals without changing ordering. Gates: `tests/context/rankingReceipts.test.ts`.
- **files edited/created**: `src/context/ranking.ts`, `src/context/rankingReceipts.ts`, `tests/context/rankingReceipts.test.ts`

### S5C: Test Discovery And Impact Upgrade
- **depends_on**: [S5B, S1C]
- **location**: `src/analysis/testDiscovery.ts`, `src/mcp/tools/impactAnalysis.ts`, tests
- **file-surface lock**: test discovery and impact analysis only
- **committed scope**: test candidates, runtime impact, risks, recommended validation
- **stretch scope**: deep repo-wide impact graph
- **description**: Add test discovery and upgrade `impact_analysis` after ranking receipts and symbol navigation contracts are stable.
- **validation**: test discovery fixtures; impact analysis tests; old-client text compatibility; retrieval-quality gate.
- **stop criteria**: stop on retrieval-quality regression or over-broad blast radius.
- **status**: Completed
- **log**: 2026-05-31 — Added test discovery service and upgraded `impact_analysis` structured output. Gates: `tests/analysis/testDiscovery.test.ts`, `tests/tools/graphNativeTools.test.ts`.
- **files edited/created**: `src/analysis/testDiscovery.ts`, `src/mcp/tools/impactAnalysis.ts`, `tests/analysis/testDiscovery.test.ts`

### S6A: Task Manager And Indexing Task Path
- **depends_on**: [S2A]
- **location**: `src/mcp/tasks/taskManager.ts`, lifecycle/index tools, tests
- **file-surface lock**: task manager and indexing/reindexing task path only
- **committed scope**: queued/running/completed/failed/cancelled task records and indexing progress
- **stretch scope**: review/analysis task migration
- **description**: Make slow indexing/reindexing visible and cancellable before applying task behavior broadly.
- **validation**: task manager tests; lifecycle tests; cancellation/error parity; MCP smoke.
- **stop criteria**: stop if existing synchronous local indexing behavior is broken without compatibility mode.
- **status**: Completed
- **log**: 2026-05-31 — Added task manager with indexing/reindexing progress and cancellation. Gates: `tests/mcp/taskManager.test.ts`.
- **files edited/created**: `src/mcp/tasks/taskManager.ts`, `src/mcp/tools/lifecycle.ts`, `tests/mcp/taskManager.test.ts`

### S6B: Task-Aware Review And Static Analysis
- **depends_on**: [S6A]
- **location**: review/static-analysis tools, task resources, tests
- **file-surface lock**: review/static-analysis task integration only
- **committed scope**: task IDs/progress for long-running review/static analysis
- **stretch scope**: reactive review redesign
- **description**: Extend task manager to review/static-analysis tools after indexing task behavior is proven.
- **validation**: task response tests; cancellation tests; error parity; old-client text compatibility.
- **stop criteria**: stop if review result contracts drift.
- **status**: Completed
- **log**: 2026-05-31 — Wired review/static-analysis tools to task manager progress surfaces. Gates: `tests/mcp/reviewTaskIntegration.test.ts`.
- **files edited/created**: `src/mcp/tools/reviewAuto.ts`, `src/mcp/tools/reviewDiff.ts`, `src/mcp/tools/staticAnalysis.ts`, `tests/mcp/reviewTaskIntegration.test.ts`

### S7A: HTTP Auth Scopes Default-Off
- **depends_on**: [S6A, S4C]
- **location**: HTTP middleware, auth config, `tests/integration/httpAuthScopes.test.ts`
- **file-surface lock**: HTTP auth/scope middleware and tests only
- **committed scope**: default-off or localhost-compatible scopes for tools/resources/tasks
- **stretch scope**: remote deployment policy
- **description**: Add scoped auth checks without breaking current local no-auth clients by default.
- **validation**: no-auth local compatibility; missing/invalid auth; insufficient scope; resource read scope; task cancel scope.
- **stop criteria**: stop if existing local MCP clients fail without explicit opt-in auth.
- **status**: Completed
- **log**: 2026-05-31 — Added default-off HTTP auth scopes for tools/resources/tasks. Gates: `tests/integration/httpAuthScopes.test.ts`.
- **files edited/created**: `src/http/authScopes.ts`, `src/http/middleware/httpAuth.ts`, `src/http/middleware/index.ts`, `tests/integration/httpAuthScopes.test.ts`

### S7B: Audit Logging With Secret Hygiene
- **depends_on**: [S7A]
- **location**: telemetry/audit modules, HTTP/resource/task paths, tests
- **file-surface lock**: audit logging and tests only
- **committed scope**: logs for tool calls, resource reads, redactions, tasks, and scope decisions
- **stretch scope**: external log sinks
- **description**: Add audit logs that never include auth headers, tokens, raw `.env` content, request bodies with secrets, or full file contents.
- **validation**: audit tests with secret fixtures; log scrubber checks.
- **stop criteria**: stop if audit logs expose sensitive content.
- **status**: Completed
- **log**: 2026-05-31 — Added structured audit logging for tool/resource/task events with secret hygiene. Gates: `tests/telemetry/auditLog.test.ts`.
- **files edited/created**: `src/telemetry/auditLog.ts`, `tests/telemetry/auditLog.test.ts`

### S8A: Roots Support Behind Capability Gates
- **depends_on**: [S2A, S3A]
- **location**: `src/mcp/server.ts`, indexing/resource services, roots tests
- **file-surface lock**: roots capability handling and path enforcement only
- **committed scope**: single-workspace compatibility plus optional client roots
- **stretch scope**: multi-root ranking changes
- **description**: Respect client roots while keeping earlier single-workspace behavior compatible.
- **validation**: no roots; unsupported clients; root outside workspace; overlapping roots; symlink escape; indexing/resource root enforcement.
- **stop criteria**: stop if roots change current workspace behavior without opt-in/capability negotiation.
- **status**: Completed
- **log**: 2026-05-31 — Added roots manager with capability-gated path enforcement. Gates: `tests/mcp/rootsManager.test.ts`.
- **files edited/created**: `src/mcp/roots/rootsManager.ts`, `tests/mcp/rootsManager.test.ts`

### S8B: Elicitation And Sampling As Capability-Gated Features
- **depends_on**: [S8A]
- **location**: prompt/planning/context summarization paths, capability tests
- **file-surface lock**: capability-gated prompt/sampling paths only
- **committed scope**: elicitation for ambiguous tasks where client supports it
- **stretch scope**: sampling unless a target client is named and tested
- **description**: Add clarification and client sampling behavior only when capability negotiation proves support.
- **validation**: unsupported clients receive explicit text/structured fallback; supported-client mocks prove capability behavior.
- **stop criteria**: stop if unsupported clients get hidden partial behavior.
- **status**: Completed
- **log**: 2026-05-31 — Added client capability negotiation with explicit fallback when elicitation/sampling unsupported. Gates: `tests/mcp/clientCapabilities.test.ts`.
- **files edited/created**: `src/mcp/capabilities/clientCapabilities.ts`, `tests/mcp/clientCapabilities.test.ts`, `tests/mcp/serverCapabilities.test.ts`

### S9A: Expanded Eval And CI Quality Gates
- **depends_on**: [S7B, S8B, S5A]
- **location**: `evals/`, scripts/ci, package scripts, CI workflow
- **file-surface lock**: evals and CI scripts only
- **committed scope**: retrieval, safety, usefulness, and performance evals; warning-only before blocking
- **stretch scope**: release-blocking gates after baselines stabilize
- **description**: Expand the shadow eval harness into reproducible quality gates.
- **validation**: eval runner; metrics report; CI script such as `ci:check:mcp-compatibility`.
- **stop criteria**: stop if evals are flaky or environment-sensitive.
- **status**: Completed
- **log**: 2026-05-31 — Expanded eval harness and CI scripts for compatibility/smoke gates. Gates: `npm run ci:check:mcp-compatibility`; `npm run ci:check:mcp-eval-smoke`; `.github/workflows/test.yml`.
- **files edited/created**: `evals/`, `scripts/ci/run-mcp-compatibility.ts`, `scripts/ci/run-mcp-eval-smoke.ts`, `tests/evals/mcpCompatibilityGate.test.ts`, `.github/workflows/test.yml`, `package.json`

### S9B: Compatibility Release Gate
- **depends_on**: [S9A]
- **location**: repo-wide test scripts and evidence docs
- **file-surface lock**: tests/evidence only unless fixing release blockers
- **committed scope**: run and record compatibility matrix across structured outputs, resources, policy, tasks, auth, roots, and evals
- **stretch scope**: fixing unrelated pre-existing full-suite failures
- **description**: Establish release readiness evidence without expanding feature scope.
- **validation**: focused compatibility matrix; build; MCP smoke; eval gates; `npm test -- --runInBand` only if full-suite stabilization is in scope.
- **stop criteria**: stop if failures are unrelated and require separate triage.
- **status**: Completed
- **log**: 2026-05-31 — Added compatibility matrix runner with real execution evidence. Gates: `npm run ci:check:mcp-compatibility-matrix` → PASS 7/7 surfaces; log at `docs/rollout-evidence/2026-05-31/mcp-compatibility-matrix.log`.
- **files edited/created**: `config/ci/mcp-compatibility-matrix.json`, `scripts/ci/run-mcp-compatibility-matrix.ts`, `tests/ci/mcpCompatibilityMatrix.test.ts`, `docs/rollout-evidence/2026-05-31/mcp-compatibility-matrix.log`, `artifacts/bench/mcp-compatibility-matrix.json`

### S10A: Behavior-Preserving Module Extraction
- **depends_on**: [S1D, S5C, S9B]
- **location**: `src/mcp/`, `src/context/`, `src/retrieval/`, `src/graph/`, `src/analysis/`, tests
- **file-surface lock**: import/module ownership changes only
- **committed scope**: extract execution/result formatting, context, retrieval, graph, policy, ranking, and analysis modules around proven seams
- **stretch scope**: no new behavior
- **description**: Refactor architecture only after tests protect the implemented behavior.
- **validation**: build; focused MCP/retrieval/resource/policy tests; diff review confirms no behavior-bearing changes.
- **stop criteria**: stop if refactor changes behavior or grows files past healthy boundaries.
- **status**: Completed
- **log**: 2026-05-31 — Extracted tool registry, prompt registry, server capabilities, and domain modules without behavior changes. Gates: focused module test batch; compatibility matrix.
- **files edited/created**: `src/mcp/toolRegistry.ts`, `src/mcp/prompts/promptRegistry.ts`, `src/mcp/serverCapabilities.ts`, `src/context/`, `src/analysis/`, `src/security/`

### S10B: Final Release Stabilization
- **depends_on**: [S10A]
- **location**: repo-wide
- **file-surface lock**: release blockers only
- **committed scope**: final release audit and documented residual risks
- **stretch scope**: unrelated cleanup
- **description**: Run the full release gate and fix only blockers that are required for this roadmap release.
- **validation**: `npm run build`; MCP smoke; compatibility gate; eval gate; full `npm test -- --runInBand` if the release target requires it.
- **stop criteria**: stop and split out unrelated failures that are not caused by the roadmap implementation.
- **status**: Completed
- **log**: 2026-05-31 — Ran full release gate; fixed MCP smoke blocker (input-schema validation + JSON-RPC errors for missing required params/unknown tools). Final gates: build PASS; mcp-smoke PASS; compatibility-matrix PASS 7/7; focused new-module tests 324/324 PASS.
- **files edited/created**: `src/mcp/executeTool.ts`, `src/mcp/utils/validateToolInput.ts`, `docs/context-engine-mcp-sequential-implementation-plan.md`, `docs/context-engine-mcp-upgrade-plan.md`, `docs/rollout-evidence/2026-05-31/mcp-compatibility-matrix.log`, `tests/integration/mcpErrorParity.test.ts`, `tests/integration/client-compat.test.ts`, `tests/tooling/runtime.test.ts`
## Parallel Execution Groups

| Wave | Tasks | Can Start When |
|------|-------|----------------|
| 1 | S1A, S3A | Immediately |
| 2 | S1B, S1C, S2A, S2B | S1A complete; S3A independent |
| 3 | S1D, S4A, S5A | S1C/S2A/S3A as applicable |
| 4 | S2C, S4B, S5B, S6A | S2B/S4A/S2A complete |
| 5 | S4C, S5C, S6B | S4B/S3A/S5B/S6A complete |
| 6 | S4D, S7A, S8A | Resource/policy/task prerequisites complete |
| 7 | S7B, S8B | S7A/S8A complete |
| 8 | S9A, S9B | Feature tranches complete |
| 9 | S10A, S10B | Release gates and behavior coverage complete |

## Compatibility Matrix

Each tranche that touches MCP behavior must record:

| Surface | Required Checks |
|---------|-----------------|
| Stdio MCP | `tools/list`, `tools/call`, errors, resources where applicable |
| Streamable HTTP MCP | initialize/session reuse, `tools/list`, `tools/call`, resources, errors |
| REST parity | only where an existing REST route exposes the same behavior |
| Old clients | `content[0].text` usable without `structuredContent` |
| Output schemas | only converted tools advertise schemas; schemas match emitted structured content |
| Resources | list/read parity, URI safety, MIME, not-found/error semantics |
| Tasks | create/status/cancel/progress/error behavior |
| Auth | default local compatibility, enabled-mode scope enforcement |

## Testing Strategy

- Every tranche gets focused Jest tests, `npm run build`, MCP smoke or built `dist` inspection, and review.
- Structured-output tranches must include direct handler, stdio-like execution, HTTP `/mcp`, output schema, old-client text, and snapshot coverage.
- Resource tranches must include traversal, encoded traversal, outside-root, symlink, MIME, huge/binary/generated/secret fixtures.
- Transport/auth/task tranches must include stdio/HTTP error parity.
- Retrieval/ranking/context-pack tranches must include retrieval quality gates and artifact hygiene review.
- Eval gates start as informational, then warning-only, then release-blocking after baselines stabilize.

## Risks & Mitigations

- Risk: broad resource exposure before policy. Mitigation: S3A policy precedes S4C broad resources.
- Risk: Sprint 1 becomes a giant public-contract patch. Mitigation: split `why_this_context`, symbol families, and retrieval tools into separate tasks.
- Risk: duplicated stdio/HTTP behavior. Mitigation: S2A moves shared execution earlier.
- Risk: context packs become too large. Mitigation: size gate, token budget, and resource-link fallback.
- Risk: auth hardening breaks local clients. Mitigation: default-off or localhost-compatible behavior until explicitly enabled.
- Risk: evals become flaky. Mitigation: shadow gates first, normalize artifacts before review.
- Risk: refactor hides behavior change. Mitigation: refactor last and require behavior-preserving diff review.

## Rollback Plan

- Each task is independently revertible.
- Do not mix result-shape changes with ranking changes.
- Do not mix resource expansion with auth policy.
- Do not mix context-pack persistence with retrieval ranking.
- Do not mix architecture refactor with feature behavior.
- If a tranche fails validation, revert that tranche only and preserve earlier completed tranches.

## Party-Mode Review Feedback Incorporated

- Split oversized sprints into smaller swarm-ready task IDs with `depends_on`.
- Moved safety policy before broad resource exposure.
- Moved shared stdio/HTTP execution wrapper earlier.
- Split structured output migration into `why_this_context`, symbol/navigation families, and retrieval tools.
- Made Context Pack Store independent from the first ephemeral context-pack return path.
- Added compatibility matrix, output schema gate, old-client text contract, and stale-build/runtime validation.
- Added artifact hygiene for retrieval/eval outputs.
- Reframed existing resource work as extraction/preservation before expansion.
- Made roots and auth compatibility-gated rather than breaking defaults.
- Converted full-suite stabilization into a release gate instead of normal feature scope.
