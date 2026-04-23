# OpenAI MCP Gap Closure T0 Baseline Bundle

Purpose: capture a replayable baseline for `T0` before implementation waves advance.

## Baseline Receipt

| Field | Value |
| --- | --- |
| `baseline_snapshot_id` | `openai-mcp-gap-closure-baseline-2026-04-23T00-00-00Z` |
| `timestamp_utc` | `2026-04-23T00:00:00Z` |
| `commit_sha` | `7d31294858f07b5e8936445cd52f43250f572ba1` |
| `branch_or_tag` | `main` |
| `workspace_root` | `D:\GitProjects\context-engine` |
| `json_artifact` | [artifacts/plan/openai-mcp-gap-closure-baseline.json](D:\GitProjects\context-engine\artifacts\plan\openai-mcp-gap-closure-baseline.json:1) |

## Dirty Tree Receipt

The workspace is dirty at baseline capture time. This is acceptable for this program only because the receipt records it explicitly.

Modified paths at capture:
- `artifacts/bench/retrieval-holdout-check.json`
- `artifacts/bench/retrieval-quality-gate.json`
- `artifacts/bench/retrieval-quality-report.json`
- `artifacts/bench/retrieval-quality-telemetry.json`
- `artifacts/bench/retrieval-shadow-canary-gate.json`
- `artifacts/review_auto_timeout_smoke.json`
- `scripts/ci/check-tool-manifest-parity.ts`
- `src/http/routes/tools.ts`
- `src/internal/handlers/enhancement.ts`
- `src/mcp/tooling/discoverability.ts`
- `src/mcp/tools/context.ts`
- `src/mcp/tools/gitReview.ts`
- `src/mcp/tools/planManagement.ts`
- `src/mcp/tools/reviewAuto.ts`
- `src/mcp/tools/reviewDiff.ts`
- `src/mcp/utils/gitUtils.ts`
- `src/reactive/ReactiveReviewService.ts`
- `src/reviewer/llm/twoPass.ts`
- `src/reviewer/llm/types.ts`
- `tests/ci/slowOpenAiToolHardening.test.ts`
- `tests/integration/httpCompatibility.test.ts`
- `tests/services/reactiveReviewService.test.ts`
- `tests/snapshots/oldClientFixtures.test.ts`
- `tests/snapshots/phase2/baseline/tool_manifest_basic.baseline.txt`
- `tests/tools/codebaseRetrieval.test.ts`
- `tests/tools/context.test.ts`
- `tests/tools/reviewAuto.test.ts`
- `tests/tools/reviewDiff.test.ts`
- `tests/tools/reviewGitDiff.test.ts`
- `tests/tools/status.test.ts`

Untracked paths at capture:
- `.agent/workflows/implementation-testing.md`
- `.claude/`
- `.github/workflows/test.yml`
- `artifacts/bench/retrieval-routing-receipts.json`
- `docs/plan-execution/openai-mcp-gap-closure-ownership-gate-pack.md`
- `latest`
- `openai-mcp-gap-closure-swarm-plan.md`
- `openai_mcp_enhancement_plan.md`
- `peer-context-engine-adoption-plan.md`
- `peer-context-engine-adoption-swarm-plan.md`
- `src/internal/cache/`
- `src/internal/logging.ts`
- `src/mcp/handoff/`
- `src/mcp/openaiTaskRuntime.ts`
- `src/mcp/tooling/reviewDiffSource.ts`
- `tests/fixtures/diffs/`
- `tests/fixtures/invariants/`
- `tests/integration/client-compat.test.ts`
- `tests/mcp/activePlanHandoff.test.ts`
- `tests/mcp/handoffCore.test.ts`
- `tests/mcp/openaiTaskRuntime.test.ts`

## Feature Flag Snapshot

Environment capture result:
- No `CE_*` environment variables were present at capture time.

Interpretation:
- The baseline is rooted in checked-in defaults plus current codepaths, not local feature-flag overrides.

## Frozen Snapshot and Artifact Hashes

### Manifest and discoverability snapshot

| Artifact | SHA-256 |
| --- | --- |
| `tests/snapshots/phase2/baseline/tool_manifest_basic.baseline.txt` | `b8d054c03c16b05454076ac0dab7639fcd11edf1a904b66046228f62011c0a5c` |

### Retrieval artifacts

| Artifact | SHA-256 |
| --- | --- |
| `artifacts/bench/retrieval-holdout-check.json` | `0da80709b4474acb52e5190a5e3784d098ea278106c6a3af120e77d1e92de4df` |
| `artifacts/bench/retrieval-quality-report.json` | `e5f1125ddd5b0cc233208ab7c067d139717bf198ad4d21003d337e46b6ab19bb` |
| `artifacts/bench/retrieval-quality-telemetry.json` | `61e9abb6b802b58654bb684fb52420d75800dfc66731ad1e59ca869c66ad36d0` |
| `artifacts/bench/retrieval-shadow-canary-gate.json` | `b57d349cf2bae61788073d384d8fa39b9fdbdb7335daff919c5e944585d217cb` |

### Review artifacts

| Artifact | SHA-256 |
| --- | --- |
| `artifacts/review_auto_timeout_smoke.json` | `3846eda7284243307e09165da4b6bb3de98e53e5ac17ea47456c5b026fc695a4` |

## Compatibility Surface Anchors

| Surface | Anchors |
| --- | --- |
| `stdio_mcp` | `src/mcp/server.ts`, `src/mcp/tools/manifest.ts`, `src/mcp/tooling/discoverability.ts` |
| `streamable_http_mcp` | `src/http/httpServer.ts` |
| `api_v1_rest` | `src/http/routes/tools.ts`, `tests/integration/httpCompatibility.test.ts` |

## T0 Status

This baseline bundle is complete when read together with [openai-mcp-gap-closure-ownership-gate-pack.md](D:\GitProjects\context-engine\docs\plan-execution\openai-mcp-gap-closure-ownership-gate-pack.md:1).
