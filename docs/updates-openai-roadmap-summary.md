# OpenAI-Only Roadmap Summary

> Status: active

This note captures the current repo state after the recent hardening work.
It is the short, practical version of `docs/updates.md`.

## Already in the repo

- OpenAI-only provider path for reasoning, planning, synthesis, and review.
- Local-native retrieval and workspace indexing.
- Review timeout hardening and prompt compaction.
- Fast compact `create_plan` path, with deeper refinement still available when needed.
- Build/package health, rollout gates, and timeout smoke checks.

## Keep

- OpenAI-only reasoning, planning, synthesis, and review.
- Better build/package health.
- Better OpenAI adapter quality.
- Cancellation and deadline handling.
- Token efficiency and prompt stability.
- Review correctness.
- Job control and observability.
- A thin provider boundary for clean code structure.

## Drop

- Ollama migration.
- vLLM migration.
- llama.cpp migration.
- Multi-provider abstraction as a roadmap goal.
- Responses API as the near-term canonical path.

## Build next

1. Keep the fast planning path small, simple, and responsive.
2. Keep deep planning as the slower path for complex requests.
3. Tighten prompt snapshots and operational docs only when regressions appear.
4. Treat any Responses API migration as a later modernization option, not an active priority.

## Notes

- The current repo already has the main review and planning safety work in place.
- The remaining OpenAI work should focus on stability and maintenance, not provider replacement.
