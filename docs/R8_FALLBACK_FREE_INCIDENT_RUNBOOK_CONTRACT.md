# R8 Fallback-Free Incident Runbook Contract

Purpose: define a deterministic, fallback-free incident classification and drill evidence contract for enhancement-related incidents.

Scope:
- Incident classes covered by this contract: `TRANSIENT_UPSTREAM`, `AUTH`, `QUOTA`, `CONFIG`.
- Applies to enhancement incident triage, tabletop drills, and readiness-gate evidence checks.
- This contract is normative for T11 design and intended to be consumed by a future T12 readiness checker.

## 1. Contract Metadata

```yaml
contract_id: R8_FALLBACK_FREE_INCIDENT_RUNBOOK_CONTRACT
contract_version: 1.0.0
status: active
owner_role: Support/DevEx
effective_date_utc: 2026-03-12
depends_on:
  - T0
related_recommendation: R8
```

## 2. Fallback-Free Operating Principle

- Incident handling must not degrade into generic fallback templates once typed classification signals are available.
- Every incident record must resolve to exactly one primary class in this contract.
- If signals are incomplete, classify as `TRANSIENT_UPSTREAM` only when retryable behavior is explicitly justified in evidence.
- Generic "unknown" buckets are not valid final states for readiness evidence.

## 3. Incident Taxonomy

| class_id | primary meaning | canonical signal examples | retry policy | required operator action | required evidence |
|---|---|---|---|---|---|
| `TRANSIENT_UPSTREAM` | upstream/runtime transient failure likely recoverable | `EnhancePromptError.code=TRANSIENT_UPSTREAM`, provider timeout/unavailable/exec/parse errors with retryable context | bounded retry allowed | stabilize runtime, rerun targeted check, confirm recovery | retry trace, recovery command output, elapsed time |
| `AUTH` | authentication/session identity invalid or expired | `EnhancePromptError.code=AUTH`, provider auth/login-required signals | no blind retries before auth remediation | re-authenticate, verify identity health, rerun check | auth remediation step, health check output, post-fix pass evidence |
| `QUOTA` | usage/rate/limit exhaustion | `EnhancePromptError.code=QUOTA`, usage-limit indicators with retry-after guidance | retry only after wait window and budget check | record retry-after window, defer or rate-limit workload, rerun after window | quota signal, retry-after value, deferred/resumed execution evidence |
| `CONFIG` | invalid or unsupported environment/policy configuration | invalid provider or env configuration (for example `provider_config_invalid`, unsupported provider policy violations) | no retries until config fix applied | correct config, capture before/after values (redacted as needed), rerun validation | config diff summary, validation command output, resolved status |

## 4. Deterministic Decision Path

The primary class must be selected using this precedence order:

1. `AUTH` if auth/session-invalid signals are present.
2. `QUOTA` if usage-limit/retry-after signals are present.
3. `CONFIG` if configuration/policy-invalid signals are present.
4. `TRANSIENT_UPSTREAM` if failure is retryable and no higher-precedence class matched.
5. Contract violation if none of the above can be proven with evidence.

Decision invariants:
- Exactly one primary class per incident.
- Optional `secondary_signals` may be recorded but cannot override primary-class precedence.
- Missing timestamps, missing owner, or missing command evidence invalidates classification for readiness.

## 5. Drill Artifact Schema (Required)

A drill run must produce one structured artifact with the following schema:

```yaml
schema_id: r8_fallback_free_incident_drill
schema_version: 1.0.0
required_fields:
  - drill_id
  - contract_version
  - executed_at_utc
  - owner
  - scenario_name
  - incident_class
  - decision_path_trace
  - evidence
  - outcome
  - duration_minutes
  - follow_up_actions
```

Field contract:
- `drill_id`: stable ID (`R8-YYYYMMDD-###`).
- `contract_version`: must match this contract version.
- `executed_at_utc`: ISO-8601 UTC timestamp.
- `owner`: accountable operator or team alias.
- `scenario_name`: deterministic scenario label.
- `incident_class`: one of `TRANSIENT_UPSTREAM|AUTH|QUOTA|CONFIG`.
- `decision_path_trace`: ordered array of evaluated rules and matched rule.
- `evidence`: object containing required evidence fields in Section 6.
- `outcome`: `PASS` or `FAIL`.
- `duration_minutes`: numeric drill duration.
- `follow_up_actions`: array (can be empty only when `outcome=PASS` and no findings).

## 6. Required Evidence Fields

Each drill artifact must include:

- `evidence.command_path`: full command sequence used during triage/remediation.
- `evidence.error_signal_excerpt`: sanitized excerpt showing classification signal.
- `evidence.classification_justification`: plain-language explanation for selected class.
- `evidence.validation_command`: command used to confirm recovered or expected state.
- `evidence.validation_result`: explicit `PASS` or `FAIL`.
- `evidence.artifact_refs`: array of file paths/logs used as proof.
- `evidence.started_at_utc`: ISO-8601 UTC.
- `evidence.ended_at_utc`: ISO-8601 UTC.
- `evidence.blocker_status`: `none` or explicit blocker code/name.
- `evidence.blocker_resolution`: required when blocker is not `none`.

Class-specific evidence additions:
- `AUTH`: include `auth_recovery_step` and post-auth health evidence.
- `QUOTA`: include `retry_after_ms` (or documented wait policy) and deferred-resume evidence.
- `CONFIG`: include `config_correction_summary` with redacted before/after values.
- `TRANSIENT_UPSTREAM`: include retry attempt count and recovery/no-recovery outcome.

## 7. Expected Drill Outputs

A compliant drill produces all of the following outputs:

1. Structured drill artifact (YAML/JSON/Markdown with schema fields above).
2. Human-readable summary containing scenario, class decision, and final outcome.
3. Evidence pointers to logs/artifacts proving command execution and validation result.
4. Follow-up action list with owner and due date for every `FAIL` or unresolved blocker.

Expected minimum output quality:
- Timestamps are exact UTC.
- No placeholder-only values (`TBD`, `n/a`) in required fields unless explicitly allowed by this contract.
- Evidence paths resolve to real artifacts at review time.

## 8. Readiness Gate Consumption Rules (For T12 Integration)

Future readiness gate logic should enforce:

1. Contract file exists and declares `contract_version`.
2. Drill artifact contains all required fields in Section 5.
3. `incident_class` is one of the allowed classes and matches decision-path precedence.
4. Evidence object contains all required fields in Section 6.
5. Any missing required field, invalid enum, or unresolved blocker without resolution evidence => gate `FAIL`.
6. Drill `outcome=FAIL` without follow-up actions (owner + due date) => gate `FAIL`.

Recommended gate output envelope:

```yaml
status: PASS|FAIL
contract_id: R8_FALLBACK_FREE_INCIDENT_RUNBOOK_CONTRACT
contract_version: 1.0.0
checks:
  - id: r8_contract_present
  - id: r8_required_fields_complete
  - id: r8_incident_class_valid
  - id: r8_decision_path_precedence
  - id: r8_evidence_complete
summary:
  incident_class: <class>
  outcome: PASS|FAIL
  blockers: []
```

## 9. Non-Compliance Handling

- If classification or evidence is incomplete, incident state is `NOT_READY_FOR_RELEASE_GATE`.
- A non-compliant drill cannot be used as R8 readiness proof.
- Remediation requires rerunning the drill with complete evidence and deterministic class selection.
