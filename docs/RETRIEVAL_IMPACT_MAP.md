# Retrieval Impact Map

This document tracks the exact high-impact touchpoints for the user-visible retrieval upgrade.

## Core Components and Hot Paths

| Component | Purpose | Risk Level | Hot Path Notes |
| --- | --- | --- | --- |
| `src/internal/retrieval/retrieve.ts` | Query fan-out, candidate gathering, fusion + rerank orchestration | High | Every semantic search request passes here; latency-sensitive. |
| `src/internal/retrieval/rerank.ts` | Ranking signal application and deterministic ordering | High | Relevance quality shifts here can quickly affect user trust. |
| `src/internal/retrieval/fusion.ts` | Cross-source score merge (semantic/keyword/dense) | High | Weighting mistakes can over-promote weak matches. |
| `src/mcp/serviceClient.ts#getContextForPrompt` | Context-pack assembly and dependency hints | Medium | Over-verbose packs can reduce prompt clarity and speed. |
| `src/mcp/tools/search.ts` | User-facing semantic_search output and diagnostics | Medium | Output contract is widely consumed by users/agents. |
| `src/mcp/tools/codebaseRetrieval.ts` | Programmatic retrieval payload and metadata | Medium | JSON metadata changes must remain additive only. |
| `src/config/features.ts` | Rollout guard and feature-flag gates | High | Incorrect defaults can accidentally expose unfinished behavior. |

## Rollout Safety Contract

- All new behavior is gated by default-off flags.
- Existing contracts remain backward compatible.
- Additive metadata only; no required field removals.

## Risk to Mitigation Mapping

| Risk | Trigger Signal | Mitigation | Rollback Action |
| --- | --- | --- | --- |
| Relevance drops for top results | `nDCG@10`, `MRR@10`, `Recall@50` gate failure | Keep v2 as baseline and use staged exposure | Disable `CE_RETRIEVAL_RANKING_V3` |
| Latency increase at scale | p95 regression vs baseline gate | Bound fan-out and rerank costs; monitor canary first | Disable `CE_RETRIEVAL_HYBRID_V1` |
| Context output becomes noisy | Context-pack quality review or prompt-regression checks | Keep context-pack v2 optional behind flag | Disable `CE_CONTEXT_PACKS_V2` |
| Runtime instability | Error-rate increase or readiness failure | Keep quality guard and gate enforcement active | Set `CE_ROLLOUT_KILL_SWITCH=true` |

## Operator Notes

- Move stages only after readiness + benchmark gates pass.
- For severe instability, use runtime-first rollback order in `docs/ROLLOUT_RUNBOOK.md`.
- Record all trigger evidence in `docs/ROLLOUT_EVIDENCE_LOG.md`.
