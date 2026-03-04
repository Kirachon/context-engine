# Rollout Runbook

Operator-first rollout flow for governance-controlled release.

Prerequisites:
- KPI gates defined in `docs/BENCHMARKING_GATES.md`.
- Flags configured per `docs/FLAG_REGISTRY.md`.
- Freeze rules accepted in `docs/CONTRACT_FREEZE.md`.
- Evidence tracking prepared in `docs/ROLLOUT_EVIDENCE_LOG.md`.
- WS20 go/no-go thresholds config is present at `config/rollout-go-no-go-thresholds.json`.
- WS21 rollback drill runbook artifact is prepared at `docs/WS21_ROLLBACK_DRILL_TEMPLATE.md`.

## Readiness check (required before stage changes)

Run this command from repo root:

```bash
node --import tsx scripts/ci/check-rollout-readiness.ts
```

With optional artifact paths (examples):

```bash
node --import tsx scripts/ci/check-rollout-readiness.ts artifacts/pr-gates.json artifacts/nightly-gates.json artifacts/rollback-drill.log
```

Readiness quality signals for optional artifacts:
- Artifact must include a `PASS` marker.
- Artifact must not include a `FAIL` marker.
- If artifact is JSON, it must include `status` and at least one of `checks`, `results`, `metrics`, or `summary`.

Tool inventory parity check (recommended before release):

```bash
node --import tsx scripts/ci/check-tool-manifest-parity.ts
```

Rollback drill evidence format check (required before freeze lift):

```bash
node --import tsx scripts/ci/check-ws21-rollback-drill.ts docs/WS21_ROLLBACK_DRILL_TEMPLATE.md docs/WS21_ROLLBACK_DRILL_SAMPLE.md
```

Progression rule:
- Do not move to the next stage unless readiness check is passing and evidence is recorded in `docs/ROLLOUT_EVIDENCE_LOG.md`.

## Stage 1: Dark launch

Goal:
- Enable new path in shadow mode with no user-visible impact.

Checklist:
- Set `CE_ROLLOUT_STAGE=dark_launch`.
- Keep `CE_ROLLOUT_CANARY_PERCENT=0` unless shadow reads require sampling.
- Run PR and nightly gates; record baseline deltas.
- Record gate outputs and rollback drill proof in `docs/ROLLOUT_EVIDENCE_LOG.md` (Dark Launch section).

Exit criteria:
- No gate failures.
- No unexpected runtime error trend.

## Stage 2: Canary

Goal:
- Expose behavior to a small controlled traffic slice.

Checklist:
- Set `CE_ROLLOUT_STAGE=canary`.
- Start with `CE_ROLLOUT_CANARY_PERCENT=1` (expand up to 5 only if explicitly approved).
- Monitor p95, deterministic `review_diff` latency, error rate, overlap, and `unique_files@k`.
- Record gate outputs and rollback drill proof in `docs/ROLLOUT_EVIDENCE_LOG.md` (Canary section).

Exit criteria:
- PR and nightly gates pass.
- No incident requiring kill switch.

## Stage 3: Controlled ramp

Goal:
- Increase traffic in steps while enforcing gates.

Checklist:
- Set `CE_ROLLOUT_STAGE=controlled_ramp`.
- Execute ramp checkpoints required by `config/rollout-go-no-go-thresholds.json` (10 -> 25 -> 50).
- Treat cutover milestones as `1 -> 10 -> 50 -> 100` in rollout evidence and sign-off notes.
- Hold progression immediately on first fail signal.
- Record each ramp step result, gate outputs, and rollback drill proof in `docs/ROLLOUT_EVIDENCE_LOG.md` (Controlled Ramp section).

Exit criteria:
- Stable passes at target traffic.
- No persistent nightly failures.

## Stage 4: GA hardening

Goal:
- Full traffic with validation of release stability.

Checklist:
- Set `CE_ROLLOUT_STAGE=ga_hardening`.
- Keep gate enforcement active.
- Cut over to full traffic (`100%`) only after controlled ramp evidence is complete and passing.
- Confirm release-level criteria: no persistent nightly failures and no unstable variance.
- Record final gate outputs, rollback drill proof, and freeze-lift sign-off in `docs/ROLLOUT_EVIDENCE_LOG.md` (GA Hardening section).

Exit criteria:
- Release gate passes.
- Freeze can be lifted with documented sign-off.

## Runtime-first rollback order

Execute in this order:
1. Set `CE_ROLLOUT_KILL_SWITCH=true` (immediate runtime containment).
2. Reduce exposure: set `CE_ROLLOUT_CANARY_PERCENT=0`.
3. Move stage to safe baseline: `CE_ROLLOUT_STAGE=dark_launch`.
4. Keep `CE_ROLLOUT_ENFORCE_GATES=true` to block accidental progression.
5. Re-run validation and publish incident summary before re-entry.

Rollback trigger conditions:
- Any PR gate fail threshold breach.
- Any nightly gate fail threshold breach.
- Release fail condition (persistent nightly failures and unstable variance).

## Freeze/Rollback Trigger Evidence Format

Store stage trigger evidence under `docs/rollout-evidence/<YYYY-MM-DD>/` and include:
- `freeze-rollback-triggers.json` with `status`, `checks`, and `summary` fields (PASS/FAIL markers required).
- `ws21-rollback-drill-log.md` formatted for `scripts/ci/check-ws21-rollback-drill.ts`.
- Stage gate command outputs (`ws20-stage*-gate-output.log`) and readiness output (`readiness-check-output.log`).
