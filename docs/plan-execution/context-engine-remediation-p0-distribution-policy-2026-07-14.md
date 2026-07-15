# Context Engine Remediation P0 Distribution-Policy Decision

This decision record resolves `P0 — Distribution-policy decision` from
`context-engine-remediation-plan-2026-07-14.md`. It is a policy artifact only:
it does not publish anything, does not change `package.json`, and does not
authorize any release or deployment action.

The optional machine-readable pointer is
[`config/ci/distribution-policy.json`](../../config/ci/distribution-policy.json),
validated by
[`tests/ci/distributionPolicy.test.ts`](../../tests/ci/distributionPolicy.test.ts).

## Decision

**Supported npm distribution.**

## Owner lane

Release engineering / `F8`.

## Rationale

The package is already structured for installable local/npm use and nothing
in the repository forbids registry-style distribution:

- `package.json` declares a real `bin.context-engine-mcp` entry point
  (`./bin/context-engine-mcp.js`), which only makes sense for an installable
  CLI/package, not an internal-only script.
- License is `MIT` — permissive and compatible with public distribution.
- There is no `"private": true` field anywhere in `package.json`, which is
  the standard npm signal that would forbid `npm publish`.
- `scripts.prepare` runs `npm run build`, the conventional npm lifecycle hook
  that prepares a package for consumption via `npm install`/`npm pack`,
  reinforcing that the package is meant to be installed, not only run from a
  cloned source tree.
- No documentation, config, or CI file in this repository states that
  registry distribution is forbidden; the only prior gap was the missing
  `engines` field and Node-matrix pinning, which K0 already characterized as
  a K0-scope compatibility gap rather than a distribution prohibition.

This satisfies the plan's guidance: choose supported npm distribution when
the package is already structured for installable local/npm use (bin
present, MIT, not private), and reserve unsupported/private distribution for
cases where docs or configs clearly forbid registry distribution — which is
not the case here.

## Supported Node versions

`18.x`, `20.x`, `22.x` — taken directly from the `node-version` matrix in
`.github/workflows/test.yml` (`strategy.matrix.node-version: [18.x, 20.x,
22.x]`), the same matrix K0 already pinned in
`config/ci/compatibility-rollback-envelope.json`.

## Closure branch

**P1a — Supported-distribution local proof** becomes the executable Wave 6
task: add package allowlist/metadata, pack to a temporary directory, inspect
contents, clean-install the tarball, and run CLI help/start smoke on the
supported Node versions above.

**P1b — Unsupported/private distribution closure** becomes
`rejected-by-policy` per this decision's disposition below.

## Explicit non-authorization

This decision authorizes **only** the P1a proof-of-packaging work described
in the plan (pack/inspect/clean-install/smoke on supported Node versions).
It does **not** authorize:

- running `npm publish` or any equivalent registry-publish command;
- tagging or cutting a release;
- any deployment of build artifacts to any environment.

Any future publish or deployment action requires a separate, explicit user
approval and is out of scope for this decision and for P1a.

## Disposition implications

- `P1a — Supported-distribution local proof`: **executable**. It may proceed
  once its stated dependency (`P0=supported`, `Q2`) is satisfied.
- `P1b — Unsupported/private distribution closure`: **`rejected-by-policy`**
  at closeout, per the plan's own acceptance criterion for P0/P1a/P1b ("P1b
  closes as `implemented` after the private-distribution contract is
  recorded; P1a closes as `rejected-by-policy`" — mirrored here in reverse
  because the decision resolved to `supported`).

## Rollback

This decision can only be reversed by a new, approved decision record that
explicitly supersedes it (per the plan card's rollback rule: "Supersede
through a new approved decision record"). Superseding would also require
retroactively re-flipping the P1a/P1b disposition pair above.

## Suggested plan-card update for P0

| Field | Value |
| --- | --- |
| Status | completed |
| Disposition | `implemented` |
| Log | Decision: `supported npm distribution` (Release engineering / F8), grounded in `bin.context-engine-mcp`, MIT license, absence of `"private": true`, and the `prepare`/`build` lifecycle hooks in `package.json`; no doc/config forbids registry distribution. Supported Node versions: `18.x`, `20.x`, `22.x` (from `.github/workflows/test.yml`, matching K0's pinned matrix). Closure branch: **P1a** (executable); **P1b becomes `rejected-by-policy`** at closeout. Publishing/deployment remains unauthorized without separate user approval. Recorded in `docs/plan-execution/context-engine-remediation-p0-distribution-policy-2026-07-14.md` and `config/ci/distribution-policy.json` (validated by `tests/ci/distributionPolicy.test.ts`, passing). |
| Files edited | `docs/plan-execution/context-engine-remediation-p0-distribution-policy-2026-07-14.md`, `config/ci/distribution-policy.json`, `tests/ci/distributionPolicy.test.ts` |

This update is left for the orchestrator to apply to
`context-engine-remediation-plan-2026-07-14.md`, since that file is
governance-owned and out of scope for this task's allowed edits.
