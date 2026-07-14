# Goal: Research-Backed Context Engine Enhancement

**Date:** 2026-05-19  
**Workspace:** `D:\GitProjects\context-engine`  
**Status:** Goal artifact, ready for implementation planning

## Goal

Enhance Context Engine into a safer, more discoverable, and more measurable MCP codebase-retrieval server by adding an additive, manifest-only `selection_profile` layer over the existing manifest, graph-aware retrieval, and security guardrails.

The first implementation must not replace existing MCP tool schemas, alter retrieval ranking, or introduce a new routing tool. It should use current `tool_manifest` discoverability metadata, `shared_contract` fields, graph navigation, and path-validation primitives to help agents choose the right tool and avoid unsafe workspace access.

## Expected Outcome

Context Engine should become easier for MCP clients and coding agents to use correctly:

- Agents can choose between `semantic_search`, `codebase_retrieval`, `get_context_for_prompt`, symbol tools, review tools, and file tools with less token-heavy guesswork.
- Retrieval responses expose enough quality and provenance evidence to decide whether to trust the result, broaden the query, or reindex.
- Security posture remains explicit: no absolute paths, no path traversal, no secret leakage, no unbounded external context, and no destructive behavior hidden behind discovery features.
- Improvements are measurable through existing retrieval-quality, discoverability, client-compatibility, and MCP smoke gates.

## Party-Mode Review Outcome

Three read-only reviewers refined this goal before implementation:

- Architecture feedback: keep the first increment metadata-only, nested under one `selection_profile` field, and avoid duplicating the existing `shared_contract`.
- Evaluation feedback: add a deterministic tool-selection fixture so the change proves intent-to-tool usefulness, not just metadata coverage.
- Security feedback: treat tool metadata as a security surface, use closed risk enums, require safety hints for risky tools, and add metadata-poisoning checks.

The final first increment incorporates that feedback.

## Research Findings

### MCP Standards

The current MCP specification centers server capability around tools, resources, prompts, and client-visible metadata. Context Engine already aligns with this direction through `tool_manifest`, resource exposure, prompt definitions, and shared transport/discoverability metadata.

Relevant sources:

- MCP specification: https://modelcontextprotocol.io/specification/2025-11-25
- MCP security best practices: https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices
- MCP changelog for metadata evolution: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/changelog.mdx

### Retrieval and RAG Best Practices

Modern RAG guidance favors hybrid retrieval, good chunk boundaries, metadata filtering, reranking, freshness checks, and evaluation rather than vector search alone. For code retrieval, the strongest pattern is to combine lexical precision, semantic recall, symbol/AST structure, graph relationships, and explicit confidence diagnostics.

Relevant sources:

- Microsoft RAG techniques: https://www.microsoft.com/en-us/microsoft-cloud/blog/2025/02/04/common-retrieval-augmented-generation-rag-techniques-explained/
- Repository-level retrieval-augmented code generation survey: https://arxiv.org/abs/2510.04905
- Fine-grained retrieval for code repair: https://arxiv.org/abs/2509.02330

### Semantic Tool Discovery

Recent MCP/tool research argues that exposing every tool directly to the model is inefficient and less accurate at scale. Semantic tool discovery indexes tool descriptions and dynamically selects the best few tools for a user intent. A practical Context Engine version should start as an additive internal or documented routing layer, not a breaking replacement for the existing manifest.

Relevant sources:

- Semantic tool discovery paper: https://arxiv.org/abs/2603.20313
- Tool discovery discussion: https://mcpproxy.app/blog/2026-03-15-beyond-bm25-tool-discovery/

### MCP Security Risks

MCP servers increase the blast radius of tool misuse if tools expose filesystem, shell, network, auth, or memory surfaces without strict validation. Current public security discussion emphasizes prompt injection, tool poisoning, unsafe process execution, overbroad permissions, and data exfiltration. Context Engine should treat discovery and retrieval output as security-sensitive because agents can chain retrieved instructions into later tool calls.

Relevant sources:

- MCP security best practices: https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices
- MCP prompt-injection/security analysis: https://arxiv.org/abs/2601.17549
- MCP threat modeling and tool poisoning: https://arxiv.org/abs/2603.22489

### Comparable Servers

Comparable codebase-retrieval MCP servers are converging around:

- AST-aware chunking.
- Hybrid vector plus BM25 retrieval.
- Symbol search and call/reference navigation.
- Local/offline indexing options.
- Reranking or graph-aware ranking.
- Smaller tool surfaces with higher-quality results.

Examples:

- DeepContext: https://github.com/Wildcard-Official/deepcontext-mcp
- DeepContext marketplace summary: https://mcpmarket.com/server/deepcontext
- Rust multi-repo codesearch MCP: https://github.com/flupkede/codesearch
- Semcode summary: https://mcpservers.org/servers/goodbyeplanet/semcode

## Repo Observations

Current Context Engine already has much of the foundation needed for this goal:

- `src/mcp/tooling/discoverability.ts` defines tool metadata, safety hints, related surfaces, and shared contracts.
- `src/mcp/tools/manifest.ts` exposes capabilities, tool ids, discoverability data, symbol-navigation features, context explainability, and transport parity metadata.
- `src/mcp/server.ts` owns runtime tool registration and should remain aligned with the manifest.
- `src/mcp/tools/search.ts` and `src/mcp/tools/codebaseRetrieval.ts` expose retrieval diagnostics, quality-guard state, fallback state, and ranking diagnostics.
- `src/workspace/pathValidation.ts` rejects absolute paths, drive-qualified paths, UNC paths, control characters, traversal, and option-like paths where requested.
- `tests/mcp/discoverability.test.ts`, `tests/integration/client-compat.test.ts`, and `scripts/ci/mcp-smoke.ts` already cover manifest, runtime registration, compatibility, and smoke behavior.
- Existing CI scripts include retrieval-quality gates and telemetry generation, especially `ci:check:retrieval-quality-gate`, `ci:generate:retrieval-quality-report`, and `ci:check:retrieval-shadow-canary-gate`.

## Recommended First Increment

Add a non-breaking `selection_profile` layer to the manifest/discoverability system.

The smallest useful slice:

1. Extend `src/mcp/tooling/discoverability.ts` with one additive nested `selection_profile` object:
   - `schema_version`
   - `intent_tags`
   - `preferred_when`
   - `avoid_when`
   - `selection_signals`
   - `operation_risk`
2. Surface that metadata through `tool_manifest` without renaming or removing existing fields.
3. Reuse existing `shared_contract` metadata for index, graph, git, provenance, and explainability signals instead of duplicating those contracts.
4. Add tests in `tests/mcp/discoverability.test.ts` proving:
   - every runtime tool has selection metadata;
   - related tools remain aligned;
   - closed enum values are enforced;
   - high-risk tools include safety hints;
   - metadata stays declarative and does not contain prompt-injection style instructions;
   - representative user intents map to the expected tool family.
5. Add a deterministic fixture at `tests/fixtures/tool-selection-intents.json`.

This keeps the first implementation local, testable, and compatible with current clients. A later increment can add an actual `recommend_tool` or `tool_selection` tool only if the metadata and fixture prove useful.

## Threat Model

Assets:

- Workspace source files, local index/cache state, saved plans, memories, git state, and retrieved context sent to model-facing tools.

Trust boundaries:

- User prompts, retrieved code/docs, external sources, diffs, memories, and generated plans are untrusted data.
- Tool metadata is advisory and must remain declarative; clients must not treat it as a privileged instruction channel.

Primary risks:

- Prompt injection from retrieved files, external docs, memories, or diffs.
- Path traversal, UNC paths, drive-qualified paths, symlink escapes, or option-like paths.
- Secret leakage from `.env`, keys, PEMs, tokens, or private memory internals.
- Destructive or state-writing tool calls being selected when a read-only tool is sufficient.
- Local analyzer/process execution through static-analysis surfaces.

Security acceptance:

- Risk metadata uses closed enums.
- Risky tools have explicit safety hints.
- Metadata tests reject common tool-poisoning text.
- Existing path-validation and hardening tests remain part of the validation plan.

## Likely Implementation Areas

- `src/mcp/tooling/discoverability.ts`: additive selection metadata model and manifest serialization.
- `src/mcp/tools/manifest.ts`: capability/feature wording if the new metadata needs to be advertised.
- `src/mcp/server.ts`: out of scope unless runtime registration needs additional annotations.
- `tests/mcp/discoverability.test.ts`: primary regression coverage.
- `tests/fixtures/tool-selection-intents.json`: deterministic tool-selection eval fixture.
- `tests/integration/client-compat.test.ts`: compatibility check if manifest shape snapshots are affected.
- `tests/snapshots/phase2/baseline/tool_manifest_basic.baseline.txt`: update only if snapshot workflow requires it.
- `docs/MCP_CLIENT_SETUP.md` or a new docs file: guidance for clients and agents.

## Success Criteria

The goal is successful when:

- `tool_manifest` includes additive tool-selection metadata for core tools without breaking existing clients.
- Every runtime tool has `selection_profile` metadata.
- `selection_profile.intent_tags` and `selection_profile.operation_risk` use closed enum values.
- Retrieval tools reuse `shared_contract` for index requirements, confidence/provenance signals, freshness signals, and fallback behavior.
- File, state-writing, destructive, git, external-source, LLM-facing, and local-process tools carry explicit operation-risk metadata.
- Metadata-poisoning checks reject hidden/control characters and common instruction-injection phrases.
- Agent-facing guidance clearly distinguishes:
  - search by concept;
  - retrieval for broader context;
  - symbol lookup;
  - direct file read;
  - review/static-analysis flows.
- A deterministic intent fixture proves at least 85 percent top-1 tool-family selection and 100 percent top-3 expected-tool coverage.
- Existing manifest/runtime/client compatibility remains green.
- Retrieval quality gates are unchanged or improved.

## Validation Plan

Run these after implementation:

```powershell
npm test -- tests/mcp/discoverability.test.ts
npm test -- tests/integration/client-compat.test.ts
npm test -- tests/workspace/pathValidation.test.ts
npm test -- tests/integration/httpHardening.test.ts
npm run -s ci:check:mcp-smoke
npm run -s ci:check:retrieval-quality-gate
npm run build
```

If retrieval behavior changes, also run:

```powershell
npm run -s ci:generate:retrieval-quality-report
npm run -s ci:check:retrieval-shadow-canary-gate
```

If source changes affect the running MCP server, rebuild and restart the MCP server before trusting runtime behavior.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Tool metadata grows but agents still choose poorly. | Start with measurable manifest metadata and examples; only add a routing tool after evidence. |
| New metadata breaks client expectations. | Keep changes additive and preserve existing `tool_manifest` fields. |
| Semantic discovery hides high-risk tools too well or exposes them too freely. | Include explicit risk metadata and safety hints for every high-risk tool. |
| Retrieval quality regresses while improving discoverability. | Use existing retrieval-quality and shadow-canary gates. |
| Security guidance becomes documentation-only. | Tie risk metadata to tests that fail when safety hints are missing. |
| Tool metadata becomes a prompt-injection surface. | Keep metadata declarative and test against common injection phrases. |

## Open Questions

- Should the first user-facing surface be metadata-only, docs, or a new `recommend_tool` MCP tool?
- Which MCP clients should define the compatibility floor: Codex CLI, Claude Code, Cursor, Claude Desktop, or all current documented clients?
- Should tool-selection metadata be hand-authored or generated from existing usage hints, safety hints, and shared contracts?
- What query set should measure whether tool selection improves real agent behavior?
- Should security risk levels become a formal enum used by review and policy tools?

## Done Definition

This goal is ready to close when the repo has an additive, tested `selection_profile` metadata layer, a deterministic tool-selection intent fixture, updated goal guidance, passing manifest/client compatibility checks, and retrieval-quality evidence showing no regression.
