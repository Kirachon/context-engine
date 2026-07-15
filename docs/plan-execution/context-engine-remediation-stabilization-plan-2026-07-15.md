# Context Engine Remediation Stabilization Plan

Date: 2026-07-15

Branch: `remediation/2026-07-15-stabilize`
Status: `CONDITIONAL_GO`

## Intent and guardrails

This execution preserves the existing remediation worktree and evidence. The original B0 and Z0 receipts are unchanged. The five B0 protected foreign paths that already differed from their B0 fingerprints are retained as-is and are not implementation inputs. Validation commands that regenerate timestamped receipts were followed by narrow content restoration so those protected files remain unchanged.

The checkpoint commit is `222c63aa10c878ca062b099b0e360f8253284bd0` (`chore: checkpoint context-engine remediation worktree`), with rollback parent `06ff69f72c5aee12768e713d42b217d8f62dcb16`.

## Executed remediation lanes

### K0/P1a compatibility envelope

- `config/ci/compatibility-rollback-envelope.json` now declares `node >=18`, matching `package.json`.
- The existing package allowlist and `publish_authorized: false` policy remain unchanged.
- The P1a package proof passed clean install and CLI-help checks.
- The additive package metadata delta is recorded in the stabilization receipt; the K0 intentional-delta ledger remains empty because its validator requires that contract.

### R3/R4 cross-platform paths

- `ContextServiceClient.discoverWorkspaceFiles()` again returns native platform separators.
- Canonical discovery, graph, retrieval, fingerprint, and cache boundaries retain separator normalization.
- Roots-manager coverage now exercises native service-client paths and canonical forward-slash paths, including path-set parity.

### R1c cancellation

- Production behavior remains response-close cancellation gated by `!res.writableEnded`.
- The legacy helper test now supplies a mock response and emits response-close.
- Coverage explicitly proves request-body close does not cancel normal work.

### External-grounding deterministic test lane

- DNS resolution is injectable through `ExternalGroundingFetchOptions.dnsLookup`.
- Production defaults still use DNS resolution and retain SSRF/private-target validation.
- The unsupported-content test uses a deterministic safe public address without weakening hostname safety checks.

## Validation record

- `npm run build`: passed.
- Targeted remediation suites: 5 suites, 39 tests passed.
- `npm test -- --runInBand`: 221/222 suites passed; 2,130 passed, 5 skipped, 1 todo, 1 failed. The single failure was the existing reranker metadata test under process RSS memory-pressure guardrails; the reranker suite passes standalone with 16/16 tests.
- `npm run ci:check:gate-tier-contract`: passed.
- `npm run ci:check:frozen-corpus-contract`: passed.
- `npm run ci:check:docs-version-reconciliation`: passed.
- `npm run ci:check:evidence-date-contract`: passed.
- `npm run ci:check:mcp-compatibility`: passed, 6/6 checks and eval smoke pass.
- `npm run ci:check:supported-distribution-pack-proof`: passed.
- `npm run test:coverage`: 221/222 suites passed, but the command exited nonzero on the unrelated Windows `tests/launcher.test.ts` temporary-directory cleanup `EPERM`.
- `git diff --check`: passed.
- Context Engine deterministic invariant review: passed, 6 invariants and no findings. The AI review wrapper timed out and was replaced by deterministic review as required by the repository workflow.

## Deferred dispositions

- Q3d: deferred pending three consecutive non-waived GitHub Actions receipts, at least two commits, identical corpus/config identity, complete provenance, and verified branch-protection evidence.
- T1 transport migration: deferred until Q3d is implemented.
- A* facade decomposition: deferred until Q3d is implemented.
- M1-M3: `not-verified`; no treatment harness or evidence-backed implementation claim was created.
- Release status remains `CONDITIONAL_GO`; no publish, deployment, branch-protection mutation, or external GitHub mutation was performed.
