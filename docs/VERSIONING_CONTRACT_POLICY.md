# Versioning and Contract Policy

Purpose: define a single canonical release version source and enforce backward-compatible contract changes.

## Canonical version source

- Canonical release version is `package.json` -> `version`.
- Runtime/server metadata must derive from that value.
- Release updates must keep these literals in sync with `package.json`:
  - `src/mcp/tools/manifest.ts` (`MCP_SERVER_VERSION`)
  - `src/reviewer/reviewDiff.ts` (`TOOL_VERSION`)

## Update policy

When preparing a release version bump:

1. Update `package.json` `version` first.
2. Update the required mirrored literals listed above.
3. Run `node --import tsx scripts/ci/check-version-literals.ts`.
4. Update release notes/changelog in the same change set.

## Deprecation path and no-silent-break rule

- No silent contract breaks: externally visible tool output shapes and semantics must not change without explicit notice.
- Any contract-affecting change must use this path:
  1. Document change scope, affected tools, and migration notes in docs.
  2. Keep additive compatibility where possible for at least one release window.
  3. If removal/breaking behavior is required, announce deprecation first, then remove in a later release.
  4. Update compatibility replay notes and changelog with explicit version/date.
- CI/review gates must fail if release version literals are inconsistent with canonical version source.

## Evidence gate

- Deterministic parity gate: `scripts/ci/check-version-literals.ts`.
- Regression test coverage: `tests/ci/checkVersionLiterals.test.ts`.
