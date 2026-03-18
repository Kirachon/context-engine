# Plan: Faster, Smarter, Leaner Context Engine

## Summary
Improve the context engine so it is faster, smarter, and more token-efficient without weakening answer quality or reliability. The repo already has a thin CLI wrapper in `bin/context-engine-mcp.js`, so wrapper work in this plan is audit-only and documentation-only unless we find a real startup or packaging problem.

Success targets:
- Lower latency on the main retrieval and context flows.
- Lower token use in prompt and context assembly.
- Keep or improve retrieval quality.
- Keep `enhance_prompt` and other core tools stable.
- No new public API shape changes are expected.

## Key Changes
- Measure baseline speed, token usage, and quality before changing behavior.
- Improve context selection, not just context size, so the engine is both leaner and smarter.
- Improve retrieval ordering and fallback handling so stronger matches are not lost.
- Keep the existing CLI wrapper thin and simple; do not turn it into a new feature.
- Keep public tool contracts stable.

## Dependency Graph
T1 -> T2, T3, T4 -> T5 -> T6

## Tasks

### T1: Baseline and hotspot inventory
- depends_on: []
- location: `src/internal/handlers/enhancement.ts`, `src/internal/retrieval/retrieve.ts`, `src/mcp/tools/context.ts`, `src/mcp/tools/search.ts`, `bin/context-engine-mcp.js`
- description: Measure current latency, token usage, and quality for the main flows; identify the hottest code paths; confirm the wrapper is already thin.
- validation: Capture pre-change benchmark numbers, token-use snapshots, and a short baseline note for search quality, context-pack size, and `enhance_prompt` reliability.

### T2: Token-efficiency and context intelligence pass
- depends_on: [T1]
- location: `src/internal/handlers/enhancement.ts`, `src/mcp/tools/context.ts`
- description: Reduce duplicated or low-value context, tighten prompt/context shaping, and make file selection more decision-focused so we keep the most useful material without bloating output.
- validation: Compare before/after token counts, verify required sections still appear, and check that sample outputs remain useful and complete.

### T3: Retrieval intelligence and speed pass
- depends_on: [T1]
- location: `src/internal/retrieval/retrieve.ts`, `src/internal/handlers/retrieval.ts`, `src/mcp/tools/search.ts`
- description: Improve ranking order, preserve stronger fallback matches, and keep the quality guard active while lowering unnecessary work.
- validation: Re-run retrieval benchmarks, confirm quality metrics do not regress, and confirm latency improves or stays stable.

### T4: CLI wrapper audit
- depends_on: [T1]
- location: `bin/context-engine-mcp.js`, `docs/MCP_CLIENT_SETUP.md`
- description: Verify the existing wrapper remains a thin launcher, document what it helps with in plain language, and avoid adding extra layers unless there is a real operational gain.
- validation: Confirm startup behavior stays the same, wrapper remains small, and setup docs match the actual launch flow.

### T5: End-to-end verification
- depends_on: [T2, T3, T4]
- location: `tests/*`, `artifacts/bench/*`
- description: Compare before/after quality, speed, and token usage; confirm the core tools still behave correctly.
- validation: Pass targeted tests, compare benchmark deltas, and verify no regressions in retrieval, context assembly, or prompt enhancement.

### T6: Rollout notes and docs
- depends_on: [T5]
- location: `docs/ROLLOUT_RUNBOOK.md`, `docs/RETRIEVAL_IMPACT_MAP.md` or a new rollout note if needed
- description: Record the final recommendation, tradeoffs, and rollback guidance in operator-friendly language.
- validation: Documentation clearly states what improved, what stayed the same, and what to do if a regression appears.

## Test Plan
- Search quality: verify `semantic_search` and `codebase_retrieval` still surface the best results first.
- Context efficiency: verify `get_context_for_prompt` stays compact and useful.
- Prompt enhancement: verify `enhance_prompt` still returns structured output and does not lose required sections.
- Wrapper check: verify the launcher still starts the server cleanly and does not add extra runtime complexity.
- Performance check: compare baseline and candidate latency plus token-use snapshots on the same query set.

## Assumptions
- The existing CLI wrapper is already enough for launch convenience; this plan keeps it audit-only and thin.
- No new public API is required for this pass.
- Success means faster and leaner output with equal or better result quality, not just smaller prompts.
