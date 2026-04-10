# Plan: Swarm Implementation for External Docs Grounding

**Generated**: 2026-04-10

## Overview
Add opt-in `external_sources` grounding to `enhance_prompt` and `get_context_for_prompt` through one shared, typed provider layer. Local codebase context remains primary. External content is additive only, never indexed, never merged into local ranking tables, and never allowed to influence local auto-scope or retrieval ranking.

## Scope Lock
- In scope: `enhance_prompt`, `get_context_for_prompt`, `enhance-request`, REST `/enhance-prompt` and `/context` parity, shared grounding helpers, contract/snapshot/security/cache tests.
- Out of scope: automatic external target inference, new source types beyond `github_url` and `docs_url`, text-mode redesign, JSON error-envelope redesign, indexing external content.
- Public input contract:
  - `external_sources?: Array<{ type: 'github_url' | 'docs_url'; url: string; label?: string }>`
  - max 3 sources
  - HTTPS only
  - strip fragments, preserve query strings, normalize scheme/host/default port, trim trailing slash except root, dedupe by normalized URL, preserve first occurrence order, first label wins
  - `github_url`: allow only repo, tree, blob, README/docs-like pages on `github.com`
  - `docs_url`: allow only caller-supplied `text/html` documentation-like pages
- Warning contract:
  - structured warnings only: `{ code, message, source_url, source_index }`
  - invalid input is a hard validation error
  - runtime fetch/extract failures degrade to warnings
- Budget defaults:
  - fetch concurrency `2`
  - per-source timeout `5000ms`
  - total external fetch budget `10000ms`
  - max response size `300 KB`
  - max excerpt per source `1200 chars`
  - max combined external excerpt budget `3600 chars`

## Prerequisites
- No new external dependency is required; use built-in URL/fetch support plus existing repo validation/cache patterns.
- Existing contract guards in prompt tests, MCP transport tests, snapshot harnesses, and `scripts/ci/check-enhance-prompt-contract.ts` remain part of the readiness gate.

## Dependency Graph
```text
T1 -> T2 -> T3 -> T4 -> T6
T1 -> T2 -> T3 -> T5 ->/
```

## Tasks

### T1: Freeze Contract and Surface Parity
- **depends_on**: []
- **location**: `src/mcp/tooling/validation.ts`, `src/mcp/prompts/planning.ts`, `src/mcp/server.ts`, `src/mcp/tools/enhance.ts`, `src/mcp/tools/context.ts`
- **description**: Lock the `external_sources` schema, normalization rules, source-type admission rules, warning schema, success metadata names, and prompt/tool/server argument parity before any provider code lands. Add `external_sources` to the `enhance-request` prompt contract and parser now so MCP prompt, tool schema, and builder cannot drift.
- **validation**: Prompt/tool/server contract tests pass; invalid JSON prompt args fail early; baseline local-only snapshots are captured for both tools; warnings are explicitly JSON-only for `enhance_prompt` text mode in v1.
- **status**: Completed
- **log**: Added `external_sources` to prompt/tool/server/REST request contracts and locked the JSON-string `enhance-request` parsing path so MCP and HTTP no longer drift.
- **files edited/created**: `src/mcp/prompts/planning.ts`, `src/mcp/server.ts`, `src/mcp/tools/enhance.ts`, `src/mcp/tools/context.ts`, `src/http/routes/tools.ts`, `tests/prompts/planning.test.ts`, `tests/integration/httpCompatibility.test.ts`, `tests/integration/mcpHttpTransport.test.ts`

### T2: Add Shared Types, Normalization, and Cache Identity
- **depends_on**: [T1]
- **location**: `src/mcp/serviceClient.ts`, `src/internal/handlers/context.ts`, `src/internal/handlers/enhancement.ts`, new shared grounding helper under `src/mcp/tooling/` or `src/internal/`
- **description**: Create the shared source/status/warning/reference types, normalize `external_sources` once, add a separate `externalReferences` bundle field for context rendering, and include normalized sources plus provider/extractor version in every relevant cache key. Keep positive caching for successful fetch/extract results and use short-lived or no cross-request caching for transient failures.
- **validation**: Unit tests prove normalization, dedup, first-label-wins, deterministic ordering, cache-key isolation, and no cache bleed between local-only and grounded runs.
- **status**: Completed
- **log**: Added normalized external source types, context-bundle metadata, and cache identity wiring so grounded and local-only runs stay isolated.
- **files edited/created**: `src/mcp/tooling/externalGrounding.ts`, `src/mcp/tooling/validation.ts`, `src/mcp/serviceClient.ts`, `src/internal/handlers/context.ts`, `src/internal/handlers/enhancement.ts`

### T3: Build Typed Provider Registry and Fetch Pipeline
- **depends_on**: [T2]
- **location**: new provider files under `src/mcp/tooling/` or `src/internal/`, plus isolated tests
- **description**: Implement a typed source registry with provider-specific normalizers/extractors for `github_url` and `docs_url`. The pipeline must cover validate/normalize, fetch, extract/clean, truncate/label, abort propagation, redirect checks, MIME checks, size limits, and SSRF blocking for direct and redirected targets.
- **validation**: Isolated provider tests cover blocked GitHub surfaces, redirect-to-http, redirect-to-private/loopback/link-local/metadata, IPv4/IPv6 literal rejection, `userinfo@host`, unsupported MIME types, oversized responses, compressed-response expansion, empty extracts, mixed success/failure, and deterministic final canonical URL handling.
- **status**: Completed
- **log**: Implemented the typed external grounding helper with source admission, URL safety, fetch/extract/truncate handling, and structured warnings.
- **files edited/created**: `src/mcp/tooling/externalGrounding.ts`, `tests/serviceClient.test.ts`

### T4: Integrate `get_context_for_prompt` First
- **depends_on**: [T3]
- **location**: `src/internal/handlers/context.ts`, `src/mcp/tools/context.ts`, `src/mcp/serviceClient.ts`
- **description**: Thread grounded references into the context flow through the separate `externalReferences` payload only, then render a dedicated `## External References` section with a note that the content is user-supplied and not part of the indexed local codebase. Keep external data out of `files`, `hints`, `dependencyMap`, `context_files`, and local ranking/rendering surfaces.
- **validation**: Context markdown tests prove local file tables remain unchanged, external references render in deterministic order, warnings are visible in the external section, and requests with unusable sources still succeed with an explicit local-only outcome.
- **status**: Completed
- **log**: Context bundles now carry additive external references only, and the markdown formatter renders them in a dedicated section without polluting local file ranking tables.
- **files edited/created**: `src/mcp/serviceClient.ts`, `src/internal/handlers/context.ts`, `src/mcp/tools/context.ts`, `tests/tools/context.test.ts`

### T5: Integrate `enhance_prompt` Grounding
- **depends_on**: [T3]
- **location**: `src/internal/handlers/enhancement.ts`, `src/mcp/tools/enhance.ts`
- **description**: Feed usable external snippets into prompt enhancement only after the existing local retrieval flow. Keep local ranking, auto-scope, text mode, and JSON error behavior unchanged. Extend JSON success responses with `grounding_strategy`, `grounding_applied`, `grounding_summary`, counts, per-source status entries, structured warnings, and `grounding_truncated`.
- **validation**: Enhance tests prove local-first behavior, JSON-only warning metadata, `grounding_applied=false` when all sources are ignored/failed, no change to text mode, and no contamination of `context_files` or local scope metadata.
- **status**: Completed
- **log**: Prompt enhancement now accepts additive external grounding, preserves text mode/error envelopes, and returns grounding provenance only in JSON success mode.
- **files edited/created**: `src/internal/handlers/enhancement.ts`, `src/mcp/tools/enhance.ts`, `tests/tools/enhance.test.ts`

### T6: HTTP/MCP Parity and Readiness Gate
- **depends_on**: [T4, T5]
- **location**: `src/http/routes/tools.ts`, `tests/prompts/planning.test.ts`, `tests/integration/mcpHttpTransport.test.ts`, `tests/snapshots/`, `scripts/ci/check-enhance-prompt-contract.ts`
- **description**: Bring REST `/enhance-prompt` and `/context` onto the same validated `external_sources` contract, then update MCP prompt integration tests, contract guards, snapshot fixtures, and CI checks. Finish with the security, cache, and bounded-latency regression suite.
- **validation**: REST and MCP both accept the same normalized `external_sources` contract; snapshot and CI contract checks pass; no-op local-only outputs remain stable; mixed-result and cache-isolation tests pass; bounded-latency checks confirm external grounding stays within declared budgets.
- **status**: Completed
- **log**: Verified the new grounding contract across REST and MCP transport surfaces and passed the focused build/test gate for planning, context, enhancement, and HTTP/MCP compatibility.
- **files edited/created**: `src/http/routes/tools.ts`, `tests/prompts/planning.test.ts`, `tests/integration/httpCompatibility.test.ts`, `tests/integration/mcpHttpTransport.test.ts`, `tests/tools/context.test.ts`, `tests/tools/enhance.test.ts`, `tests/serviceClient.test.ts`

## Parallel Execution Groups
| Wave | Tasks | Can Start When |
|------|-------|----------------|
| 1 | T1 | Immediately |
| 2 | T2 | T1 complete |
| 3 | T3 | T2 complete |
| 4 | T4, T5 | T3 complete |
| 5 | T6 | T4 and T5 complete |

## Testing Strategy
- Contract tests: tool schema, prompt arguments, prompt JSON parsing, MCP prompt listing, REST request validation.
- Provider isolation tests: normalization, dedup, SSRF, redirects, MIME, timeout, abort propagation, truncation, empty extracts, mixed results.
- Consumer tests: separate context rendering and enhancement JSON success metadata, with explicit local-only regression coverage when `external_sources` is omitted.
- Snapshot and CI gates: update snapshot harness inputs only where the new opt-in contract is exercised; keep local-only snapshots stable.
- Final readiness evidence:
  - all task-level validations pass
  - local-only behavior remains stable when `external_sources` is absent
  - external content never appears in local ranking tables, `context_files`, or the semantic index
  - REST and MCP surfaces accept the same grounded contract

## Risks & Mitigations
- Cache contamination between local-only and grounded runs. Mitigation: normalize once, include normalized sources plus provider/extractor version in cache identity, and test reordered-equivalent lists explicitly.
- Contract drift between tool, prompt, server, and REST surfaces. Mitigation: freeze parity in `T1`, then add route/CI/snapshot enforcement in `T6`.
- Unsafe external fetch behavior. Mitigation: typed provider registry, strict SSRF/redirect policies, short budgets, abort propagation, and dedicated security tests.
- Grounding overshadowing local context. Mitigation: keep local-first additive ordering, separate `externalReferences`, and enforce a hard ban on external data entering local ranking structures.
