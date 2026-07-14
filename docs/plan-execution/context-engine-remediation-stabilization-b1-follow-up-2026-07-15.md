# Context Engine Remediation B1 Stabilization Follow-up Receipt

This append-only receipt records the live worktree immediately before the stabilization checkpoint. It preserves the B0 and Z0 receipts and documents pre-existing drift found in B0-protected foreign paths.

| Field | Value |
| --- | --- |
| Task / wave | `B1` / `stabilization` |
| Branch / commit | `remediation/2026-07-15-stabilize` / `06ff69f72c5aee12768e713d42b217d8f62dcb16` |
| Timestamp UTC | `2026-07-14T23:54:31.728Z` |
| Source plan SHA-256 | `235fb74fa1b31f0e5afc81f57672725785b6769b1200202dd6565dc94ed854b4` |
| Dirty entries | `169` (`85` tracked, `84` untracked) |
| Runtime | Node `v24.5.0`; npm `11.5.1`; TypeScript `Version 5.9.3` |
| Context Engine | server `1.9.0`; `52` tools; index `idle_not_stale_from_initial_retrieval`; `904` files |
| Machine receipt | `artifacts/plan/context-engine-remediation-stabilization-b1-follow-up-2026-07-15.json` |

## Baseline exception

Five protected foreign paths differed from their frozen B0 SHA-256 values before stabilization work began. Their current contents are preserved verbatim and are now protected by this receipt. No stabilization edit may touch them.

| Path | B0 SHA-256 | B1 current SHA-256 |
| --- | --- | --- |
| `artifacts/bench/mcp-compatibility-matrix.json` | `93050882a218b0488eb76211e4f8cce60d4c407b71490d2b2cda2b86e42679b3` | `b857f6014c822b4d06f43027161ac5e513d13c5494a7324b8f2834b5411011dd` |
| `docs/rollout-evidence/2026-05-31/mcp-compatibility-matrix.log` | `fbed157bb73240ca62d79a66a48d9ef031941af446a85ac0e269718ad822c0a5` | `04c85a9fc7703dfda1cbabd5d51807cb9b2fa79b477edaea7148725d4afd7bef` |
| `artifacts/evals/mcp-compatibility.json` | `f664c628eeef88b1ac25eae952b949178a58a1478a2fd092478819a7ff447cb1` | `8c1aff09c7b31f9b451709d36c3419866dc2dc086cc0cb13fb662fdfcbbde65b` |
| `artifacts/evals/mcp-compatibility.normalized.json` | `9f5a0a561ac1a7330202b7ad431670b1317cdaf0224e7dcb00d0d8c70ca4d556` | `1a45317e23fd306fd8c4cab324372ac0928417420223750de68c8a69887a2c07` |
| `artifacts/evals/mcp-eval-smoke.json` | `7e60243eb65daca6f9492dc6b2d00db27fe1a5210e2ca3c23d8a8361342e10ec` | `25d4dfd9b87ce5d4df8e07832888fb6486bd2180d7318e986ed218de7e01421a` |

The remaining B0-protected foreign paths matched their B0 hashes. This is a pre-existing drift exception, not a B0 rewrite or a claim that the B0 paths are unchanged.

## Evidence immutability

- B0 human receipt SHA-256: `5359cc4437965b02670d58cc9bf4662e608250aa8d39b48369f882747c74bf3f`
- B0 machine receipt SHA-256: `fe008fda3ac11041b463719e6aa099d7e6528ab668a1e848c8f3a92586401b6d`
- Z0 human receipt SHA-256: `93387f1bdf128a5af0f7267a2dca6cba49bc19d4913aaf3d394856e61888ba5d`
- B0 and Z0 remain immutable.
- The stabilization checkpoint is `chore: checkpoint context-engine remediation worktree`.
- Rollback references commit `06ff69f72c5aee12768e713d42b217d8f62dcb16`; protected foreign paths must not be restored or deleted without explicit approval.

## Scope

This receipt fingerprints all current tracked and untracked status entries in the machine-readable companion. It is additive evidence only; it does not change application code, publish, deploy, alter branch protection, or claim Q3d/T1*/A*/M1-M3 completion.

