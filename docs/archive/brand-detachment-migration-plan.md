# Plan: Neutralize Augment/Auggie Branding Safely

**Generated**: 2026-03-24

## Summary
Execute a staged brand-detachment migration so Context Engine no longer looks or feels connected to Augment/Auggie in active code, docs, or runtime artifacts, while preserving existing workspace compatibility until a controlled cleanup window closes.

The migration is intentionally non-destructive:
- new writes move to neutral `context-engine-*` names
- old `.augment-*` workspace files remain readable during the transition
- public-facing text is scrubbed or quarantined
- CI prevents new legacy-brand strings from reappearing

## Key Changes
- Add a repo-wide inventory pass first, then classify every `augment` / `auggie` / `@augmentcode` / `AUGMENT_*` / `augment_legacy` reference by surface and risk.
- Rename runtime artifacts to neutral names for caches, index state, fingerprints, and plan/history storage, while keeping old reads for compatibility only.
- Scrub active docs, help text, examples, logs, snapshots, changelog/release notes, comments, and metadata; quarantine historical legacy docs behind a legacy-only boundary.
- Add strict CI guardrails with a file-scoped, time-bounded compatibility allowlist and explicit lockfile/generated-metadata checks.
- Keep rollback safe: preserve old workspace artifacts, never delete user state automatically, and remove compatibility only after a clean release gate.

## Dependency Graph
```text
T0 ──┬── T1 ──┐
     ├── T2 ──┼── T4 ──> T5
     └── T3 ──┘
```

## Tasks

### T0: Inventory and classify all brand-bearing surfaces
- **depends_on**: []
- **location**: `scripts/ci/`, `docs/`, `src/`, `tests/`, `package-lock.json`
- **description**: Build a repo-wide inventory of every tracked reference to `augment`, `auggie`, `@augmentcode`, `AUGMENT_*`, and `augment_legacy`, grouped into runtime artifacts, public docs/help, archived docs, tests/snapshots, compatibility-only shims, and lockfile/generated metadata.
- **validation**: Inventory report exists and every match is categorized; compatibility-only paths and cleanup candidates are explicitly listed with an owner and removal gate.

### T1: Rename runtime artifacts with dual-read compatibility
- **depends_on**: [T0]
- **location**: `src/mcp/serviceClient.ts`, `src/internal/retrieval/*`, `src/mcp/services/planPersistenceService.ts`, `src/mcp/services/planHistoryService.ts`
- **description**: Move workspace state, caches, and index/backends to neutral `context-engine-*` names for context cache, search cache, index state/fingerprint, plan/history storage, and vector/lexical/chunk artifacts. Keep reads for existing `.augment-*` files, but write only the neutral names going forward. Keep `.augment-ignore` only as a compatibility alias while `.contextignore` becomes the documented default.
- **validation**: Fresh workspaces create only neutral files; existing workspaces still load old files; mixed-format workspaces do not duplicate or orphan state; no destructive in-place rename occurs.

### T2: Scrub public-facing brand references and quarantine historical docs
- **depends_on**: [T0]
- **location**: `README.md`, `docs/**/*.md`, `examples/**/*`, `src/index.ts`, `src/mcp/tools/*`, `tests/**/*snap*`, `package.json`, `package-lock.json`
- **description**: Remove Augment/Auggie references from active docs, setup/help text, examples, logs, error strings, snapshots, changelog/release notes, and package metadata. Rewrite or move legacy-branded historical docs into a quarantined legacy archive path with no links from current docs indexes so they are not presented as current guidance.
- **validation**: Active docs/help/examples/snapshots/metadata scan clean; any remaining legacy strings are confined to explicitly quarantined compatibility or archive paths.

### T3: Add CI guardrails and scoped allowlist
- **depends_on**: [T0]
- **location**: `scripts/ci/*`, `.github/workflows/*`, `config/ci/brand-compat-allowlist.txt`, `package-lock.json`
- **description**: Add a two-tier brand scan that fails on new Augment/Auggie strings in active runtime code and public-facing assets, while allowing only file-scoped compatibility shims and explicitly quarantined legacy archive paths. Every allowlisted path must have an owner and expiry/release gate. Add an explicit lockfile/generated-manifest check so dependency metadata cannot reintroduce `@augmentcode/*`.
- **validation**: CI fails on any new non-allowlisted brand string; allowlist entries are file-scoped and time-bounded; lockfile and generated metadata scans pass cleanly.

### T4: Add migration and leak-prevention tests
- **depends_on**: [T1, T2, T3]
- **location**: `tests/serviceClient.test.ts`, `tests/internal/retrieval/*.test.ts`, `tests/tools/*.test.ts`, `tests/ci/*.test.ts`
- **description**: Add coverage for fresh installs, existing `.augment-*` workspaces, mixed-format workspaces, neutral-name writes, dual-read behavior, no destructive migration, `.contextignore` preferred with `.augment-ignore` as compatibility-only, and brand-scan regressions in docs/examples/snapshots/lockfiles.
- **validation**: Tests prove neutral writes, backward-compatible reads, no duplicate/orphan state, and brand-scan regressions fail as expected.

### T5: Remove legacy compatibility after the release gate is met
- **depends_on**: [T4]
- **location**: same runtime files plus allowlist/CI files
- **description**: After one full release cycle with zero compatibility fallback hits in CI/nightly checks, remove the legacy `.augment-*` read path, delete remaining allowlist entries, and drop `.augment-ignore` alias support if it is no longer needed.
- **validation**: Active runtime only reads/writes neutral names; CI scans remain clean; rollback notes preserve the ability to re-enable dual-read without deleting workspace artifacts.

## Parallel Execution Groups

| Wave | Tasks | Can Start When |
|------|-------|----------------|
| 1 | T0 | Immediately |
| 2 | T1, T2, T3 | T0 complete |
| 3 | T4 | T1, T2, and T3 complete |
| 4 | T5 | T4 complete and release-gate criteria are met |

## Test Plan
- Inventory pass produces a complete categorized reference list.
- Fresh workspace creates only neutral runtime artifacts.
- Existing `.augment-*` workspace still loads without data loss.
- Mixed-format workspace does not duplicate or orphan caches/state.
- Brand-scan CI fails on new legacy strings in active runtime code or public docs/assets.
- Lockfile and generated metadata scans stay clean.
- Cleanup step only runs after a release window with zero fallback hits.

## Assumptions
- Current active runtime is already `local_native`-only; this migration is about naming, public surface area, and compatibility cleanup rather than retrieval-provider refactoring.
- The transition is non-destructive: old workspace artifacts are preserved until the cleanup step.
- Any public historical docs that still carry legacy branding must either be rewritten to neutral language or quarantined behind a legacy-only archive boundary before the migration is considered complete.
- The compatibility allowlist is temporary and must expire on the cleanup gate, not become a permanent exception list.
