# Handoff: Context Engine MCP Roadmap — Verify, Gate, Review, Commit, Push

Use this document when transferring release verification to another AI or teammate.

**Repo:** `D:\GitProjects\context-engine`  
**Branch:** `main`  
**Baseline commit (roadmap implementation):** `fbbe18c` — *Implement MCP sequential upgrade roadmap (S1A-S10B).*

---

## Overview

The sequential MCP upgrade (S1A–S10B) adds structured tool results, policy-enforced resources, context packs, background tasks, optional HTTP auth, MCP roots, audit logging, eval gates, and shared `executeTool` plumbing — while preserving legacy `content[0].text` for old clients.

This handoff covers:

1. Commit hygiene audit (what belongs in git vs not)
2. Release gates (build, tests, MCP smoke, compatibility matrix)
3. Thermo-nuclear code quality review
4. P0 fixes (if needed)
5. Commit and push

---

## Phase 0 — Read context

1. Read `docs/context-engine-mcp-sequential-implementation-plan.md` (all tasks S1A–S10B should be **Completed**).
2. Read `docs/context-engine-mcp-upgrade-plan.md` (Roadmap Completion Summary).
3. Confirm you are on `main` and understand include/exclude rules below.

---

## Phase 1 — Commit hygiene audit (before any new commit)

Run and report results:

```powershell
cd D:\GitProjects\context-engine
git status
git log -3 --oneline
git rev-parse HEAD origin/main
git diff --stat
git diff --stat --cached
git ls-files --others --exclude-standard
```

### Decision rules

| Situation | Action |
|-----------|--------|
| `HEAD` == `origin/main`, only untracked EXCLUDE files | No new commit needed; run Phase 3 gates + Phase 4 review for sign-off |
| Unpushed commits on `main` | Run Phase 3–4, then push (Phase 7) |
| Modified/staged implementation files | Run Phase 2 staging rules, then Phase 3–7 |

### NEVER commit

| Path / pattern | Reason |
|----------------|--------|
| `context-engine.zip` | Binary archive |
| `artifacts/evals/` | Generated runtime eval output |
| `docs/rollout-evidence/2026-03-04/` | Stale rollout logs |
| `peer-context-engine-adoption-plan.md` | Planning only |
| `peer-context-engine-adoption-swarm-plan.md` | Planning only |
| `openai_mcp_enhancement_plan.md` | Planning only |
| `context-engine-mcp-structured-results-swarm-plan.md` | Superseded by sequential plan |
| `docs/context-engine-research-backed-enhancement-goal.md` | Planning only |
| `docs/plan-execution/` | Planning only (unless explicitly requested) |
| `.env`, `*.pem`, `*.key` | Secrets |

### SHOULD already be in `fbbe18c`

- All `src/` implementation (`executeTool`, `security/`, `context/`, `resources/`, `tasks/`, auth, roots, audit, etc.)
- All new `tests/` modules
- `evals/` baselines and fixtures (**not** `artifacts/evals/`)
- `scripts/ci/run-mcp-*.ts`, `config/ci/mcp-compatibility-matrix.json`
- `docs/context-engine-mcp-sequential-implementation-plan.md`
- `docs/context-engine-mcp-upgrade-plan.md`
- `docs/rollout-evidence/2026-05-31/mcp-compatibility-matrix.log`
- `.github/workflows/test.yml`

### Optional `.gitignore` additions

If junk keeps reappearing as untracked:

```gitignore
artifacts/evals/
context-engine.zip
```

---

## Phase 2 — Staging (only if Phase 1 found committable changes)

```powershell
cd D:\GitProjects\context-engine
git add -A
git reset HEAD context-engine.zip
git reset HEAD artifacts/evals/
git reset HEAD docs/rollout-evidence/2026-03-04/
git reset HEAD peer-context-engine-adoption-plan.md peer-context-engine-adoption-swarm-plan.md
git reset HEAD openai_mcp_enhancement_plan.md
git reset HEAD docs/context-engine-research-backed-enhancement-goal.md
git reset HEAD docs/plan-execution/
git reset HEAD context-engine-mcp-structured-results-swarm-plan.md
git status
git diff --cached --stat
```

Review staged diff. Unstage anything from the NEVER commit list. Do not create an empty commit.

---

## Phase 3 — Release gates (must pass before commit/push)

```powershell
cd D:\GitProjects\context-engine
npm run build
```

Focused test batch:

```powershell
npm test -- --runInBand tests/mcp/outputSchemaContract.test.ts tests/integration/mcpTransportParity.test.ts tests/integration/mcpErrorParity.test.ts tests/integration/httpAuthScopes.test.ts tests/mcp/resourceRouter.test.ts tests/mcp/resourcePolicyReads.test.ts tests/mcp/taskManager.test.ts tests/evals/mcpEvalSmoke.test.ts tests/ci/mcpCompatibilityMatrix.test.ts
```

CI-style gates:

```powershell
npm run ci:check:mcp-smoke
npm run ci:check:mcp-compatibility-matrix
```

Optional broader regression check:

```powershell
npm test -- --runInBand tests/ai/contract/privacyBoundary.test.ts tests/observability/otel.test.ts tests/serviceClient.test.ts
```

If any gate fails → fix and re-run. Do not commit or push until gates pass.

---

## Phase 4 — Thermo-nuclear code quality review

Use **Cursor Team Kit** skill: `thermo-nuclear-code-quality-review`

Skill path:

```
C:\Users\preda\.cursor\plugins\cache\cursor-public\cursor-team-kit\683cdbda983ea8be4b766ac3fe94b7b88e7f75ad\skills\thermo-nuclear-code-quality-review\SKILL.md
```

In Cursor, invoke via Task subagent with `subagent_type: thermo-nuclear-code-quality-review`.

**Review scope:** diff since `2fb2d08` (parent of `fbbe18c`), or uncommitted changes if new work exists.

**Focus areas:**

- Files over 1000 lines (`src/mcp/tools/search.ts`, `discoverability.ts`, `convertedToolOutputSchemas.ts`)
- Type safety at tool registry boundary (`toolRegistryBinders.ts` vs scattered casts)
- REST `/api/v1` parity with `executeToolCall` (`httpToolExecutor.ts`)
- Duplicated stdio vs HTTP MCP handler wiring
- Accidental artifacts or secrets in diff

**Approval bar:** Do **not** push if P0 structural regressions remain unfixed.

**Known P1 (non-blocking, note for follow-up PR):**

- Split `search.ts`
- Extract shared symbol-navigation diagnostics helper
- `attachMcpHandlers` to dedupe stdio/HTTP registration

---

## Phase 5 — Fix P0 blockers from review

Fix only what the review marks **P0**. Re-run **Phase 3** after fixes.

---

## Phase 6 — Commit (only if staged changes exist)

```powershell
cd D:\GitProjects\context-engine
git status
git diff --cached --stat

git commit -m "Fix P0 blockers from MCP roadmap release review." -m "Address thermo-nuclear review findings. Re-run MCP smoke and compatibility matrix."

git log -1 --oneline
git status
```

### Git safety rules

- **Never** `git commit --amend` unless HEAD was created in this session and has **not** been pushed.
- **Never** force-push to `main`.
- **Never** skip hooks (`--no-verify`).
- **Never** update git config.

Adjust commit message to match actual changes.

---

## Phase 7 — Push

```powershell
cd D:\GitProjects\context-engine
git push origin main
git status
git rev-parse HEAD origin/main
```

---

## Phase 8 — Final report template

Return to the requester:

1. **Commit hash(es)** and whether push succeeded
2. **Gate results:** build, focused tests, `ci:check:mcp-smoke`, `ci:check:mcp-compatibility-matrix`
3. **Thermo-nuclear verdict:** APPROVED / NOT APPROVED
4. **Files intentionally left uncommitted** (with reasons)
5. **Residual P1/P2** items for a follow-up PR

---

## One-liner prompt for another AI

> In `D:\GitProjects\context-engine` on `main`: follow `docs/handoff-mcp-roadmap-release.md` — audit commit hygiene (exclude zip, artifacts/evals, old logs, peer plans), confirm roadmap commit `fbbe18c` is complete, run build + MCP smoke + compatibility matrix, run thermo-nuclear-code-quality-review on the roadmap diff, fix any P0 findings, commit only if needed, then push. Do not commit junk.

---

## Expected “all good” state (no new work)

If nothing changed since roadmap landing:

| Check | Expected |
|-------|----------|
| `git status` | Clean tracked tree; only untracked EXCLUDE files |
| `HEAD` vs `origin/main` | Same (`fbbe18c` or later handoff commits) |
| New commit needed? | **No** (unless new fixes/docs) |
| Push needed? | **No** |
| Gates | Re-run to confirm still green |
| Thermo-nuclear | Re-run on `2fb2d08..HEAD` for sign-off record |

---

## Key npm scripts reference

| Script | Purpose |
|--------|---------|
| `npm run build` | TypeScript compile |
| `npm run ci:check:mcp-smoke` | HTTP MCP smoke test |
| `npm run ci:check:mcp-compatibility-matrix` | Full compatibility matrix (7 surfaces) |
| `npm run ci:check:mcp-eval-smoke` | Informational eval smoke (use `--strict` to block) |
| `npm run ci:check:mcp-compatibility` | Compatibility eval gate |

---

## Related docs

- `docs/context-engine-mcp-sequential-implementation-plan.md` — task checklist S1A–S10B
- `docs/context-engine-mcp-upgrade-plan.md` — upgrade roadmap and evidence
- `docs/rollout-evidence/2026-05-31/mcp-compatibility-matrix.log` — last matrix run output
