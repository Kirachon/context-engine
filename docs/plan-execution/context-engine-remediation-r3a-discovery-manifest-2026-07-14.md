# Context Engine Remediation R3a Canonical Discovery Manifest Receipt

This receipt documents `R3a — Canonical discovery manifest production` from
`context-engine-remediation-plan-2026-07-14.md`. It is additive, standalone
production only: no existing discovery consumer (the service-client
`discoverFiles`/`discoverWorkspaceFiles` path, `FileWatcher`/`ignoreRules`,
chunk/vector stores, or `persistentGraphStore`'s `collectSourceFiles`/
`listWorkspaceFiles`) was read from, written to, or migrated. That migration
is tracked separately as R3b1 (watcher), R3b2 (chunk/vector), and R3b3
(graph), per the plan's dependency chain `C2a -> R3a -> R3b1 -> R3b2 -> R3b3`.
R3a's declared dependencies, C2a and C3, were read-only inputs (fingerprint
and versioned-artifact conventions) and were not edited.

## Task receipt

| Field | Value |
| --- | --- |
| Task / wave | `R3a` / `wave-2` |
| Owner / lock | Core orchestration / `F5` |
| Depends on | `C2a`, `C3` (both completed) |
| Disposition | `implemented` |
| Files added | `src/internal/discovery/ignoreCompiler.ts`, `src/internal/discovery/eligibleFileTypes.ts`, `src/internal/discovery/discoveryManifest.ts`, `src/internal/discovery/discoveryManifestStore.ts`, `tests/internal/discovery/ignoreCompiler.test.ts`, `tests/internal/discovery/discoveryManifest.test.ts`, `tests/internal/discovery/discoveryManifestStore.test.ts` |
| Files edited | `docs/FLAG_REGISTRY.md` (additive rollback-flag entry only), this receipt |

## What R3a built

Four new, standalone modules under `src/internal/discovery/`, none of them
imported by any existing consumer:

1. **`ignoreCompiler.ts`** — compiles default excluded-directory names,
   default excluded file patterns, `.gitignore`, `.contextignore`/
   `.augment-ignore` (plus caller-supplied extra ignore-file names and
   literal patterns) into one ordered rule set with **correct
   gitignore-style negation** ("last match wins"), proper root-anchored
   (`/pattern`) and directory-only (`pattern/`) handling, and a separate
   non-negatable hard gate for default-excluded directory names and hidden
   (dot-prefixed) entries. This intentionally fixes a latent defect in the
   legacy `shouldIgnorePath` (`src/mcp/serviceClient.ts`), which parses `!`
   negation lines but then unconditionally `continue`s past them, so
   negation silently does nothing today. `compileIgnoreRules(...)` also
   returns a deterministic `ruleFingerprint` (sha256 over every rule input:
   engine version, excluded-dir/hidden-allowlist sets, default patterns,
   and every ignore file's raw lines).
2. **`eligibleFileTypes.ts`** — a standalone canonical copy of the
   indexable name/extension allowlist (same effective coverage as
   `INDEXABLE_FILES_BY_NAME`/`INDEXABLE_EXTENSIONS` in `serviceClient.ts`,
   plus a fix so multi-part suffixes like `.env.example` are actually
   reachable — `path.extname()` only returns the last segment, so the
   legacy list's `.env.example`/`.env.template`/`.env.sample` entries can
   never match via `extname()` lookup; this version checks those via
   `endsWith`).
3. **`discoveryManifest.ts`** — full and incremental discovery over the
   shared ignore/eligibility predicates, plus the versioned manifest
   builder. `runFullDiscovery`/`produceDiscoveryManifest` walk the
   workspace (or explicit subroots) using `fs.Dirent`/`lstat`-based
   symlink detection (never follows or indexes a symlinked file or
   directory), per-entry hidden/ignore/eligibility checks, and a sha256
   content hash per eligible file. `checkPathEligibility` exposes the
   *exact same* ancestor-aware predicate for single-path evaluation, and
   `applyIncrementalDiscovery(previousManifest, workspacePath, {added,
   removed, mutated})` uses it to update a prior manifest without
   re-walking the tree — by construction, full and incremental discovery
   can never disagree on a given path.
4. **`discoveryManifestStore.ts`** — atomic tmp-file+rename persistence for
   the manifest (mirrors `JsonIndexStateStore`/`persistentGraphStore`'s
   pattern), structural + schema-version validation on load (unsupported
   future schema versions load as `null` rather than being trusted), and
   `produceAndPersistDiscoveryManifest`, the top-level "run discovery and
   persist" entry point gated by the `CE_DISCOVERY_MANIFEST_DISABLED`
   rollback lever.

### The four fingerprints

Every `DiscoveryManifest` carries:

- `workspace_fingerprint` — `buildIndexStateWorkspaceFingerprint(workspacePath)`
  (reused verbatim from `src/mcp/indexStateStore.ts`, the same convention
  C2a's graph-store fingerprints use). Identifies *which* workspace.
- `schema_fingerprint` — sha256 over `{manifest schema version, ignore-rule
  engine version, eligible-file-types engine version}`. Changes only when
  the manifest shape or matching *semantics* change in code, independent of
  any workspace's ignore-file contents or files.
- `source_fingerprint` — sha256 over `{ignoreRules.ruleFingerprint, sorted
  roots}`. Identifies the *rules and scope* used to decide inclusion,
  without walking the filesystem — two workspaces with byte-identical
  ignore configuration and root scope share this fingerprint regardless of
  which files currently exist.
- `generation_fingerprint` — sha256 over the sorted `{path, hash}` file
  list for this specific run. Changes on any add/delete/mutate, and stays
  identical across repeated runs against an unchanged workspace.

## Validation matrix (fixture -> test)

| Fixture | Test |
| --- | --- |
| Negation | `ignoreCompiler.test.ts` "applies gitignore-style negation..."; `discoveryManifest.test.ts` "honors negation to re-include a file..." |
| Rooted | `ignoreCompiler.test.ts` "anchors root-prefixed patterns..."; `discoveryManifest.test.ts` "anchors rooted patterns to the workspace root only" |
| Directory-only | `ignoreCompiler.test.ts` "applies directory-only patterns..."; `discoveryManifest.test.ts` "excludes an entire directory subtree..." |
| Custom-ignore | `ignoreCompiler.test.ts` "reads custom ignore files..."; `discoveryManifest.test.ts` "reads a custom ignore file when requested" |
| Hidden | `ignoreCompiler.test.ts` "excludes hidden entries by default..."; `discoveryManifest.test.ts` "excludes hidden files/directories by default..." |
| Symlink | `discoveryManifest.test.ts` "never follows or indexes symlinked files or directories" (both a symlinked file and a symlinked directory) |
| Subroot | `discoveryManifest.test.ts` "scopes discovery to explicit subroots while keeping workspace-relative paths" |
| Add/delete/mutate | `discoveryManifest.test.ts` `applyIncrementalDiscovery` describe block: matches a full re-discovery after each of add/delete/mutate, plus a case where an added-but-ineligible path is dropped rather than included |
| Determinism | `discoveryManifest.test.ts` "produces deterministic fingerprints for an unchanged workspace" and "changes the generation fingerprint (but not schema/source) when file content mutates"; `ignoreCompiler.test.ts` fingerprint-stability/-sensitivity pair |
| Persistence / rollback | `discoveryManifestStore.test.ts`: save/load round trip, corrupt file, unsupported future schema version, default production, and the `CE_DISCOVERY_MANIFEST_DISABLED` lever leaving a prior artifact byte-for-byte untouched |

## Acceptance

- **Manifest path set and fingerprint are deterministic**: verified by the
  "unchanged workspace" repeat-run test (full struct equality, `generated_at`
  excluded) and by every `applyIncrementalDiscovery` case asserting exact
  equality (including all four fingerprints) against an independent full
  `produceDiscoveryManifest` run over the same on-disk state.

## Rollback

`CE_DISCOVERY_MANIFEST_DISABLED=true` makes
`produceAndPersistDiscoveryManifest` return `{ disabled: true, manifest:
null }` immediately, without reading or writing the artifact file at all
(verified: the on-disk manifest's bytes are unchanged after a disabled run
that follows a real save). Since no consumer reads this manifest yet, the
graph and every other subsystem remain in whatever state R1a-R2/C2a left
them in ("explicitly degraded" where applicable) regardless of this flag.

## Test commands and results

```
npm test -- --runInBand tests/internal/discovery
```

Result: **3 test suites, 30 tests, all passed**.

```
npm test -- --runInBand tests/mcp/indexStateStore.test.ts tests/internal/graph/persistentGraphStore.test.ts tests/watcher
```

Result (regression check on the read-only inputs and adjacent discovery
surfaces): **4 test suites, 21 tests, all passed** (unchanged).

```
npx tsc --noEmit -p tsconfig.test.json
```

Result: no diagnostics in `src/internal/discovery/**` or
`tests/internal/discovery/**` (one pre-existing, unrelated diagnostic in
`src/mcp/serviceClient.ts:4354`, confirmed present before this task's
changes via `git stash`, out of scope for R3a and not touched).

## Suggested plan-card update for R3a

| Field | Value |
| --- | --- |
| Status | completed |
| Disposition | `implemented` |
| Log | Added standalone `src/internal/discovery/{ignoreCompiler,eligibleFileTypes,discoveryManifest,discoveryManifestStore}.ts` producing one versioned canonical eligible-file manifest with workspace/schema/source/generation sha256 fingerprints, correct gitignore negation/rooted/directory-only semantics, symlink-safe walking, subroot scoping, and shared full/incremental discovery predicates so `applyIncrementalDiscovery` always agrees with a full re-walk. Rollback via `CE_DISCOVERY_MANIFEST_DISABLED` (preserves any existing artifact untouched). No consumer migrated (R3b1-3 remain). Focused suite 30/30 passed; adjacent index-state/graph/watcher suites 21/21 unchanged. |
| Files edited | `src/internal/discovery/ignoreCompiler.ts`, `src/internal/discovery/eligibleFileTypes.ts`, `src/internal/discovery/discoveryManifest.ts`, `src/internal/discovery/discoveryManifestStore.ts`, `tests/internal/discovery/ignoreCompiler.test.ts`, `tests/internal/discovery/discoveryManifest.test.ts`, `tests/internal/discovery/discoveryManifestStore.test.ts`, `docs/FLAG_REGISTRY.md` |

This update is left for the orchestrator to apply to
`context-engine-remediation-plan-2026-07-14.md`, since that file is
governance-owned and out of scope for this task's allowed edits.
