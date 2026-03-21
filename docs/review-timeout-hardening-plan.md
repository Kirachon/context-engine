# Plan: Review Timeout Hardening and Prompt Compaction

**Generated**: 2026-03-22

## Overview

The review timeout issue is mostly a wiring and coverage gap, not a provider-migration problem.

Already in place:
- `review_auto` forwards `llm_timeout_ms` on the git-diff path.
- `review_diff` already computes and passes a timeout to the underlying review call.
- `serviceClient.searchAndAsk()` already supports timeout and queue-cancellation behavior.
- A dedicated timeout smoke already exists for the git-diff path.

Implemented during this pass:
- Direct `review_diff` timeout override support was added and validated.
- `review_auto` timeout threading was verified on both routes; no code change was required there.
- Review prompts were compacted and stabilized for better reuse and lower timeout risk.
- Direct `review_auto -> review_diff` smoke coverage was added alongside the existing git-diff smoke.
- Targeted review regression and build validation passed.

Out of scope for this plan:
- Responses API migration
- provider replacement or multi-provider abstraction
- scheduler redesign for interactive vs background jobs
- review architecture rewrite beyond timeout/cancel plumbing and prompt compaction

## Prerequisites

- Current OpenAI-only provider policy remains unchanged.
- `review_diff` stays the core review engine.
- `review_auto` stays the router/wrapper.
- Existing timeout and rollout smoke artifacts remain available for regression checks.

## Dependency Graph

```text
T1 ──┬── T2 ──┬── T4
     │        └── T5
     └── T3 ───────┘
```

## Tasks

### T1: Add direct timeout support to `review_diff`
- **depends_on**: []
- **location**: `src/mcp/tools/reviewDiff.ts`, `src/reviewer/reviewDiff.ts`
- **description**: Add a per-call timeout/deadline path to the direct diff review flow so it can accept the same caller budget as the git-diff route.
- **validation**: Unit test proves the direct diff route honors a supplied timeout value and still returns the same review shape.
- **status**: Completed

### T2: Thread timeout behavior through `review_auto`
- **depends_on**: [T1]
- **location**: `src/mcp/tools/reviewAuto.ts`, `src/mcp/tools/gitReview.ts`, `src/mcp/services/codeReviewService.ts`
- **description**: Ensure `review_auto` passes the same timeout/deadline behavior through both the direct diff route and the git-diff route.
- **validation**: Tests prove both `review_auto -> review_diff` and `review_auto -> review_git_diff` pass the same timeout budget to the underlying review call.
- **status**: Completed (verified existing behavior; no code change required)

### T3: Compact the review prompt builders
- **depends_on**: []
- **location**: `src/mcp/prompts/codeReview.ts`, `src/reviewer/prompts/enterprise.ts`, `src/reviewer/reviewDiff.ts`, `src/mcp/services/codeReviewService.ts`
- **description**: Remove repeated prompt text, trim oversized context blocks, and keep prompts stable and more cache-friendly while preserving review quality.
- **validation**: Prompt unit tests show shorter or more stable output and retain required review instructions and schema constraints.
- **status**: Completed

### T4: Add direct timeout smoke coverage for `review_auto -> review_diff`
- **depends_on**: [T1, T2]
- **location**: `tests/tools/reviewAuto.test.ts`, `scripts/ci/review-auto-timeout-smoke.ts`
- **description**: Add a smoke/regression check for the direct diff route so timeout behavior is verified on both entry paths, not just git-diff.
- **validation**: The smoke/test suite confirms the direct diff path propagates the requested timeout and still produces valid review output.
- **status**: Completed

### T5: Re-run timeout and build regression coverage
- **depends_on**: [T1, T2, T3, T4]
- **location**: `tests/tools/reviewAuto.test.ts`, `tests/tools/reviewDiff.test.ts`, `tests/services/codeReviewService.test.ts`, `tests/integration/timeoutResilience.test.ts`
- **description**: Revalidate the timeout/cancellation and prompt compaction changes against the existing regression and resilience suites.
- **validation**: Targeted tests and build pass; no review schema or tool contract regressions.
- **status**: Completed

## Parallel Execution Groups

| Wave | Tasks | Can Start When |
|---|---|---|
| 1 | T1, T3 | Immediately |
| 2 | T2 | T1 complete |
| 3 | T4 | T1 + T2 complete |
| 4 | T5 | T1 + T2 + T3 + T4 complete |

## Testing Strategy

- Verify the direct diff review still honors timeout input.
- Verify both `review_auto` routes pass the same timeout budget to the underlying review call.
- Verify prompt builders still emit valid review instructions while reducing repeated context.
- Re-run the existing timeout-resilience and review regression tests.
- Confirm no public tool schema or review-result shape changes.

## Risks & Mitigations

- Timeout behavior still diverges between routes.
  - Mitigation: keep the direct diff smoke and the git-diff smoke both in CI.
- Cancellation stops the caller but not the underlying work.
  - Mitigation: thread the smallest useful cancellation seam through the review path and verify it in tests.
- Prompt compaction removes useful context.
  - Mitigation: keep schema, instructions, and review-critical context stable; only cut duplication and oversized context blocks.
- Scope drifts into a Responses migration or scheduler redesign.
  - Mitigation: keep those items explicitly out of this plan and defer them to a separate roadmap.

## Final Status

This plan is complete. The timeout seam, prompt compaction, direct-route smoke coverage, and regression validation are all in place, and the direct diff route verification confirmed the existing auto-router passthrough behavior did not need a code change.
