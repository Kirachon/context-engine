# Contract Freeze

Purpose: lock rollout behavior, KPI gates, and rollback controls so operators can run safely without policy drift.

Scope (frozen for this rollout):
- Gate thresholds in `docs/BENCHMARKING_GATES.md`.
- Runtime control flags in `docs/FLAG_REGISTRY.md`.
- Rollout and rollback procedure in `docs/ROLLOUT_RUNBOOK.md`.
- Stage order: dark launch -> canary -> controlled ramp -> GA hardening.

Freeze rules:
- Do not change fail thresholds during an active rollout window.
- Do not rename or repurpose `CE_ROLLOUT_KILL_SWITCH`.
- Do not skip stage order unless rollback is active.
- If a gate fails, progression is blocked until remediation evidence is recorded.

Allowed changes during freeze:
- Typos and clarity edits that do not change behavior.
- Additional examples and operator notes.
- Explicit post-incident addenda, marked with date and owner.

Change control (for behavior changes):
1. Open a governance PR that lists old value, new value, and reason.
2. Include benchmark evidence and risk note.
3. Get approval from release owner and on-call operator.
4. Update all affected docs in one PR before execution.

Operator sign-off checklist:
- [x] Gate outputs attached for PR/nightly/release checks.
- [x] Rollout stage and decision recorded.
- [x] Rollback path verified, including kill switch command.
- [x] No unresolved blocker from failed gates.
