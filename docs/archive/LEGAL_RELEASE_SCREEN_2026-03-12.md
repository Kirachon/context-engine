# Legal Release Screen (2026-03-12)

This is a practical risk screen for legacy-provider naming/content in the repository.

## Scope

- Repo-wide text scan for: `auggie`, `augmentcode`, `@augmentcode/auggie`, `AUGMENT_API_TOKEN`, `augment_legacy`, `Auggie`, `Augment`
- Runtime-path spot check over: `src/`, `package.json`, `.github/workflows/`, `scripts/` (excluding checker scripts)

## Evidence Summary

- Files matched in full repo scan: **60** (after cleanup wave)
- Runtime-path matches for legacy provider identifiers: **0**
- Dependency check for `@augmentcode/auggie` / `@augmentcode/auggie-sdk` in `package.json`: **none**
- No-legacy checker status: **pass** (`npm run -s ci:check:no-legacy-provider`)

## What Still Mentions Legacy Names

These are mostly non-runtime materials:

- Historical architecture and plan docs:
  - `ARCHITECTURE.md`
  - `docs\archive\ARCHITECTURE_ENHANCEMENT_BLUEPRINT.md`
  - `docs\archive\IMPLEMENTATION_PLAN.md`
  - `docs\archive\plan.md`
  - `docs\archive\CODEBASE_RETRIEVAL_PLAN.md`
- Historical release/report docs:
  - `CHANGELOG.md`
  - `docs\archive\PROJECT_STATUS_REPORT.md`
  - `docs\archive\RELEASE_NOTES_v1.4.1.md`
  - `docs\archive\RELEASE_NOTES_v1.5.0.md`
  - `docs\archive\DISCOVERY_SUMMARY.md`
  - `docs\archive\IMPLEMENTATION_STATUS_ASSESSMENT.md`
- Setup templates/snippets not in active runtime:
  - `examples/mcp-clients/gemini_settings_READY_TO_USE.json`
  - `examples/mcp-clients/gemini_settings_MINIMAL.json`
  - `docs\archive\GEMINI_CLI_QUICK_SETUP.txt`
  - `.gemini/settings.json`
- Test/guardrail references (intentional for boundary checks):
  - `tests/ci/checkLegacyProviderReferences.test.ts`
  - `tests/ci/checkRetrievalProviderBoundary.test.ts`
  - `tests/retrieval/providers/*.test.ts`
  - `scripts/ci/check-legacy-provider-references.ts`
  - `scripts/ci/check-retrieval-provider-boundary.ts`
- Historical artifacts:
  - `artifacts/bench/auggie-*`
  - `artifacts/bench/archive/*`
  - `artifacts/governance/*`

## Risk Readout (Practical)

- **Active runtime risk:** low (no live import/dependency or runtime path usage found).
- **Documentation/reputation risk:** medium (many historical docs still include legacy branding/claims).
- **Release hygiene risk:** medium (historical artifacts contain old names; may confuse external reviewers).

## Recommended Next Cleanup Wave

1. Keep test and CI boundary references (they enforce no-legacy behavior).
2. Rewrite or archive historical docs that still present old architecture as current.
3. Move old artifacts to a clearly marked archive folder, or exclude from release bundles.
4. Normalize setup templates to `codex login` and local-native defaults only.

## Cleanup Executed in This Wave

- Updated active setup/troubleshooting/testing docs to remove old login/token guidance.
- Updated Gemini setup templates to remove `AUGMENT_API_TOKEN`/`AUGMENT_API_URL` dependency.
- Reworded core architecture docs so local-native runtime is explicitly current.
- Preserved intentional legacy references in tests/CI guardrails for boundary enforcement.

## Note

This is an engineering risk screen, not legal advice.
