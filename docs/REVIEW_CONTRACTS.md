# Review Contracts (CI + MCP)

This document defines the **behavioral contracts** we must preserve while refactoring the review system.

Last updated: December 26, 2025

---

## 1) CI contract: `review_diff` workflow

**Workflow**: `.github/workflows/review_diff.yml`  
**Entrypoint**: `scripts/ci/review-diff.ts`

### Inputs (environment)

The CI job relies on these environment variables:

- `BASE_SHA` (required): base commit for `git diff`
- `HEAD_SHA` (required): head commit for `git diff`
- `CE_REVIEW_ENABLE_LLM` (default `false`): enable LLM passes inside `src/reviewer/reviewDiff.ts`
- `CE_REVIEW_INCLUDE_SARIF` (default `true`): write `artifacts/review_diff.sarif` when enabled
- `CE_REVIEW_INCLUDE_MARKDOWN` (default `true`): write `artifacts/review_diff.md` when enabled
- `CE_REVIEW_FAIL_ON_SEVERITY` (default `CRITICAL`): CI gate threshold (`CRITICAL|HIGH|MEDIUM|LOW|INFO`)

### Outputs (artifacts)

The CI script creates the `artifacts/` directory and writes:

- `artifacts/review_diff_result.json` (always)
- `artifacts/review_diff.sarif` (only if `result.sarif` is present)
- `artifacts/review_diff.md` (only if `result.markdown` is present)

### Gate semantics

`scripts/ci/review-diff.ts` sets `process.exitCode = 1` if `result.should_fail` is truthy, otherwise `0`.

**Important**: the “fail” signal is data-driven (`should_fail` + `fail_reasons`); the review engine should not rely on throwing exceptions to block CI.

### LLM runtime behavior

When `CE_REVIEW_ENABLE_LLM=true`, the CI script constructs a `ContextServiceClient` and passes it into `reviewDiff()` as:

- `runtime.readFile`: file reads (path-validated)
- `runtime.llm.call`: `serviceClient.searchAndAsk(searchQuery, prompt)`

When `CE_REVIEW_ENABLE_LLM=false`, the LLM runtime is omitted and the review remains deterministic.

---

## 2) Enterprise review result contract (`review_diff`)

`review_diff` returns an `EnterpriseReviewResult` (`src/reviewer/types.ts`), including:

- `run_id`, `risk_score`, `classification`, `hotspots`, `summary`
- `findings: EnterpriseFinding[]` (with stable IDs like `SEC001`, `TSC123`, `F001`, etc.)
- `should_fail?: boolean` and `fail_reasons?: string[]` for gating
- `sarif?: unknown` when requested (`include_sarif=true`)
- `markdown?: string` when requested (`include_markdown=true`)

**Contract expectations** (refactoring must preserve):

- Finding IDs remain stable and are safe for allowlisting (`allowlist_finding_ids`) and forced-fail (`fail_on_invariant_ids`).
- `should_fail` computation is consistent with `fail_on_severity` and `fail_on_invariant_ids`.
- SARIF output remains compatible with GitHub code scanning upload.
- Markdown output remains suitable for PR comments and GitHub step summary.

---

## 3) MCP tool surface (review-related)

Tool registration is authoritative in `src/mcp/server.ts`.

### Review tools

- `review_diff`: enterprise diff-first review (deterministic preflight + optional invariants/analyzers/LLM + optional SARIF/Markdown)
- `review_changes`: structured LLM review of a unified diff (different schema from `review_diff`)
- `review_git_diff`: obtains a git diff, then runs `review_changes`
- `check_invariants`: deterministic YAML invariants against a diff (`.review-invariants.yml`)
- `run_static_analysis`: run `tsc` and/or `semgrep` and return findings

### Reactive review tools

- `reactive_review_pr`: start/continue a reactive review session
- `get_review_status`: progress + status for a session
- `pause_review`, `resume_review`: session control
- `get_review_telemetry`: detailed telemetry for a session
- `scrub_secrets`, `validate_content`: safety/validation utilities (used by reactive flows and generally useful)

