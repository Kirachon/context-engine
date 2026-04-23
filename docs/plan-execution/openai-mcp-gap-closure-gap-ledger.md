# OpenAI MCP Gap Closure Gap Ledger

Purpose: freeze the current-state implementation ledger for `openai_mcp_enhancement_plan.md` against the baseline receipts captured in `T0`.

Linked receipts:
- Baseline bundle: [openai-mcp-gap-closure-t0-baseline.md](D:\GitProjects\context-engine\docs\plan-execution\openai-mcp-gap-closure-t0-baseline.md:1)
- Ownership and gate pack: [openai-mcp-gap-closure-ownership-gate-pack.md](D:\GitProjects\context-engine\docs\plan-execution\openai-mcp-gap-closure-ownership-gate-pack.md:1)
- Plan of record: [openai-mcp-gap-closure-swarm-plan.md](D:\GitProjects\context-engine\openai-mcp-gap-closure-swarm-plan.md:1)

## Ledger

| Area from `openai_mcp_enhancement_plan.md` | Status | Current anchors | Notes |
| --- | --- | --- | --- |
| Phase 0: repo stabilization and baseline tests | Mostly done | `package.json`, `tests/**`, `src/http/routes/tools.ts`, `src/reactive/ReactiveReviewService.ts`, `src/mcp/utils/gitUtils.ts` | The repo no longer matches the stale/no-tests description from the original roadmap. Background indexing and real git diff sourcing are already in place. |
| Phase 1: OpenAI as a first-class runtime subsystem | Partial | `src/mcp/openaiTaskRuntime.ts`, `src/internal/handlers/enhancement.ts`, `src/mcp/tools/reviewDiff.ts` | A real runtime seam exists, but the full policy/registry/outcome contract is not yet frozen across all public AI-backed surfaces. |
| Phase 2: persistent code graph | Missing | Current symbol and call logic still anchored in `src/mcp/serviceClient.ts` heuristics | No persistent graph store or graph-native services/tools are shipped yet. |
| Phase 3: graph-aware retrieval | Partial | `src/internal/retrieval/treeSitterChunkParser.ts`, `src/internal/retrieval/sqliteLexicalIndex.ts`, `src/internal/retrieval/lancedbVectorIndex.ts` | Retrieval foundations exist, but graph-aware expansion and explainability are not yet first-class. |
| Phase 4: real diff-native review pipeline | Partial | `src/reviewer/reviewDiff.ts`, `src/mcp/tools/reviewDiff.ts`, `src/reactive/ReactiveReviewService.ts` | Review is much more diff-native than the original roadmap assumed, but architecture modularization and some analyzer/provenance boundaries remain open. |
| Phase 5: split oversized orchestration modules | Partial | `src/mcp/serviceClient.ts`, `src/mcp/server.ts`, `src/http/httpServer.ts` | Core orchestration remains large and tightly coupled. |
| Phase 6: standardize tool ergonomics and contracts | Partial | `src/mcp/tools/manifest.ts`, `src/mcp/tooling/discoverability.ts`, `src/http/httpServer.ts`, `src/http/routes/tools.ts` | Good manifest/discoverability foundations exist, but transport-wide explainability/metadata parity is not fully frozen. |
| Phase 7: observability, evaluation, and benchmarks | Partial | `artifacts/bench/*`, `scripts/ci/*`, `src/metrics/*`, `src/telemetry/requestContext.ts` | Benchmarking and artifact gates exist; full OpenTelemetry/tracing adoption and final evaluation packing remain open. |

## Current Compatibility Constraints

These constraints are frozen by baseline and should be treated as execution anchors until a later wave explicitly re-baselines them:
- Stdio MCP inventory and capability shapes remain anchored to [src/mcp/server.ts](D:\GitProjects\context-engine\src\mcp\server.ts:1), [src/mcp/tools/manifest.ts](D:\GitProjects\context-engine\src\mcp\tools\manifest.ts:1), and [src/mcp/tooling/discoverability.ts](D:\GitProjects\context-engine\src\mcp\tooling\discoverability.ts:1).
- Streamable HTTP MCP remains anchored to [src/http/httpServer.ts](D:\GitProjects\context-engine\src\http\httpServer.ts:1).
- `/api/v1` REST tool parity remains anchored to [src/http/routes/tools.ts](D:\GitProjects\context-engine\src\http\routes\tools.ts:1) and [tests/integration/httpCompatibility.test.ts](D:\GitProjects\context-engine\tests\integration\httpCompatibility.test.ts:1).
- The manifest snapshot remains anchored to [tests/snapshots/phase2/baseline/tool_manifest_basic.baseline.txt](D:\GitProjects\context-engine\tests\snapshots\phase2\baseline\tool_manifest_basic.baseline.txt:1).

## Execution Interpretation

- `T2` exists to formalize and extend the runtime seam that already exists, not to introduce OpenAI runtime work from scratch.
- `T5a/T5b/T7/T8` are the first genuinely net-new product architecture slice because the persistent code graph is still absent.
- `T9` is a refactor-and-hardening task on top of an already substantial review system, not an initial review implementation.
- `T12` and `T13` should be treated as parity and evidence consolidation work on top of existing manifest/CI foundations rather than greenfield tooling.
