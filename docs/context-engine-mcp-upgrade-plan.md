# Context-Engine MCP Upgrade Implementation Plan

## Current Implemented Tranche — Tool Selection Discoverability

Status: implemented and validated for the first bounded tranche of this roadmap.

This pass intentionally implements the smallest useful piece of Phase 4 instead of pretending that the entire multi-phase MCP modernization is complete. The selected tranche improves how MCP clients and coding agents choose tools before deeper structured-result, context-pack, resource, and transport work begins.

### Scope Completed

- Added additive `selection_profile` metadata to every runtime tool in `tool_manifest.discoverability.tools`.
- Kept runtime tool registration unchanged; the new metadata is manifest-only discoverability data.
- Added intent tags, selection signals, preferred-use guidance, avoid-use guidance, and operation-risk labels.
- Added tests that verify selection profiles exist for every registered tool, use only known enums, remain declarative, and flag risky tools with safety hints.
- Added spot assertions for sensitive tool risk labels, including index mutation, destructive cleanup, review, static analysis, secret scrubbing, and reactive review session state.
- Added representative intent fixtures to prove common user intents map to expected tools.
- Preserved rollout evidence logs in Git by allowing `docs/rollout-evidence/**/*.log` through `.gitignore`.
- Added CI coverage for evidence file eligibility so required fixture artifacts are not silently ignored.
- Fixed the GitHub Actions compatibility job to use existing repository scripts: `ci:check:mcp-smoke`, `ci:check:legacy-capability-parity`, and `verify`.

### Files Changed In This Tranche

```txt
.gitignore
.github/workflows/test.yml
docs/context-engine-mcp-upgrade-plan.md
src/mcp/tooling/discoverability.ts
src/mcp/tooling/selectionProfile.ts
tests/ci/generateLegacyCapabilityParityReport.test.ts
tests/fixtures/tool-selection-intents.json
tests/mcp/discoverability.test.ts
docs/rollout-evidence/2026-03-04/*.log
```

### Party-Mode Review Feedback Incorporated

- Keep the roadmap explicit that this is a bounded Phase 4 implementation, not completion of all 13 phases.
- Avoid introducing a new routing tool; make the existing `tool_manifest` easier for clients to interpret.
- Preserve public MCP tool schemas and runtime behavior by adding metadata only to discoverability output.
- Validate both structural metadata quality and practical intent-to-tool selection behavior.
- Ensure CI references real scripts and does not rely on missing compatibility commands.
- Keep selection-profile policy in a focused helper instead of growing the already-large discoverability registry.

### Validation Evidence

```txt
npm test -- --runInBand tests/mcp/discoverability.test.ts tests/ci/generateLegacyCapabilityParityReport.test.ts
npm run build
npm run ci:check:mcp-smoke
npm run ci:check:legacy-capability-parity
```

All commands passed locally on 2026-05-31.

### Remaining Roadmap

The sections below remain the broader upgrade roadmap design reference. Sequential implementation tranches S1A–S10B are complete; see **Roadmap Completion Summary** above for validation evidence.

## Current Implemented Tranche — Structured Results Foundation

Status: implemented and validated for the first bounded Phase 1 tranche.

This pass adds the shared structured-result contract and converts only the lowest-risk read-only tools: `tool_manifest` and `index_status`. Existing text content remains available first for old clients, while MCP clients that understand structured results can read `structuredContent`.

### Scope Completed

- Added shared structured result types and result builders aligned with MCP `CallToolResult` fields.
- Updated stdio MCP, HTTP MCP, and shared runtime wrappers to accept legacy string results or structured result objects.
- Converted `tool_manifest` to return parse-compatible legacy JSON text plus structured manifest content.
- Converted `index_status` to return the existing markdown table/guidance text plus a whitelisted structured payload.
- Added HTTP MCP and client-compatibility tests proving `tools/call` preserves `content[0].text` and `structuredContent`.
- Updated direct-handler old-client fixtures so snapshot and launcher compatibility tests keep consuming legacy text from structured handlers.
- Deferred `why_this_context`, retrieval/search/review tools, `outputSchema`, Context Pack V3, resources, ranking, long-running tasks, and HTTP/auth hardening to later tranches.

### Files Changed In This Tranche

```txt
src/mcp/types/toolResult.ts
src/mcp/utils/resultBuilder.ts
src/mcp/server.ts
src/http/httpServer.ts
src/mcp/tooling/runtime.ts
src/mcp/tools/manifest.ts
src/mcp/tools/status.ts
tests/tooling/runtime.test.ts
tests/tools/status.test.ts
tests/integration/mcpHttpTransport.test.ts
tests/integration/client-compat.test.ts
tests/launcher.test.ts
tests/snapshots/oldClientFixtures.test.ts
tests/snapshots/snapshot-harness.ts
tests/snapshots/phase2/fixtures/old-client-tool-families.json
tests/snapshots/phase2/baseline/tool_manifest_basic.baseline.txt
context-engine-mcp-structured-results-swarm-plan.md
docs/context-engine-mcp-upgrade-plan.md
```

### Validation Evidence

```txt
npm test -- --runInBand tests/tools/status.test.ts tests/tooling/runtime.test.ts tests/integration/mcpHttpTransport.test.ts tests/integration/client-compat.test.ts tests/mcp/discoverability.test.ts tests/launcher.test.ts tests/snapshots/oldClientFixtures.test.ts
npm run build
npm run ci:check:mcp-smoke
node --import tsx -e "...built dist structured result inspection..."
```

All commands passed locally on 2026-05-31. The focused Jest gate passed 7 suites and 63 tests. The built `dist` inspection confirmed `tool_manifest` text parse-equality, `tool_manifest.structuredContent`, `index_status` text markers, and `index_status.structuredContent.schema_version === 1`.

### Review Evidence

`review_auto` selected `review_git_diff` but the AI review pass hit the Codex session usage limit. Per the repo fallback rule, Cursor Team Kit `thermo-nuclear-code-quality-review` was run manually against the structured-results diff. No blocking structural regression was found: the shared result normalizer stays small and canonical, transport adapters remain thin, and structured payload construction stays owned by the converted tools.

## Roadmap Completion Summary — Sequential Tranches S1A–S10B

Status: **completed and release-gated on 2026-05-31**.

This section records evidence for the remaining sequential roadmap tranches after the initial discoverability and structured-results foundation passes.

### Tranche Evidence Matrix

| Tranche | Scope | Primary validation |
|---------|-------|-------------------|
| S1A | Output schema contract utilities | `tests/mcp/outputSchemaContract.test.ts` |
| S1B | `why_this_context` structured output | `tests/tools/whyThisContext.test.ts` |
| S1C | Symbol/navigation tool families | `tests/tools/search.test.ts`, `tests/tools/graphNativeTools.test.ts` |
| S1D | Retrieval tools (`codebase_retrieval`, `semantic_search`, `get_context_for_prompt`) | `tests/tools/codebaseRetrieval.test.ts`, `tests/tools/context.test.ts` |
| S2A | Shared stdio/HTTP execution wrapper + input validation | `tests/integration/mcpTransportParity.test.ts`, `tests/integration/mcpErrorParity.test.ts` |
| S2B–S2C | Context Pack V3 types, assembler, first return path | `tests/context/contextPackAssembler.test.ts`, `tests/tools/context.test.ts` |
| S3A | Context policy engine | `tests/mcp/resourceSafety.test.ts` |
| S4A–S4D | Resource router, templates, policy reads, pack store | `tests/mcp/resource*.test.ts`, `tests/context/contextPackStore.test.ts` |
| S5A–S5C | Eval skeleton, ranking receipts, test discovery/impact | `tests/evals/*`, `tests/context/rankingReceipts.test.ts`, `tests/analysis/testDiscovery.test.ts` |
| S6A–S6B | Task manager + review/static-analysis tasks | `tests/mcp/taskManager.test.ts`, `tests/mcp/reviewTaskIntegration.test.ts` |
| S7A–S7B | HTTP auth scopes (default-off) + audit logging | `tests/integration/httpAuthScopes.test.ts`, `tests/telemetry/auditLog.test.ts` |
| S8A–S8B | Roots + client capability negotiation | `tests/mcp/rootsManager.test.ts`, `tests/mcp/clientCapabilities.test.ts` |
| S9A–S9B | Expanded eval/CI gates + compatibility matrix | `npm run ci:check:mcp-compatibility-matrix` |
| S10A | Behavior-preserving module extraction | Focused module test batch |
| S10B | Final release stabilization | Full release gate (below) |

### S10B Final Release Gate Evidence (2026-05-31)

```txt
npm run build                                              → PASS
npm run ci:check:mcp-smoke                                 → PASS
npm run ci:check:mcp-compatibility-matrix                  → PASS (7/7 surfaces, 8/8 checks)
Focused new-module Jest batch (28 suites)                  → PASS (324/324 tests)
```

Evidence artifacts:

```txt
docs/rollout-evidence/2026-05-31/mcp-compatibility-matrix.log
artifacts/bench/mcp-compatibility-matrix.json
artifacts/evals/mcp-eval-smoke.json
config/ci/mcp-compatibility-matrix.json
```

### S10B Release Blocker Fix

MCP smoke failed because missing required tool arguments and unknown tools returned `isError` tool results instead of JSON-RPC `InvalidParams` errors. Fixed by:

- Adding `src/mcp/utils/validateToolInput.ts` with input-schema validation before handler execution.
- Propagating `McpError` for unknown tools and schema validation failures through `executeToolCall`.
- Updating parity/client-compat tests to match JSON-RPC error semantics for protocol-level invalid calls.

### Residual Risks (Non-Blocking)

- Full `npm test -- --runInBand` suite not required for this roadmap release; unrelated legacy failures remain out of scope per S10B stop criteria.
- Eval gates remain informational/warning-only until baselines stabilize across environments.
- Remote HTTP auth deployment policies are documented but not production-hardened beyond default-off local compatibility.

### Remaining Roadmap

The phase sections below remain as the long-form design reference. All sequential tranches S1A–S10B from `docs/context-engine-mcp-sequential-implementation-plan.md` are complete. Future work should treat the phase docs as architecture guidance for incremental enhancements rather than an open implementation backlog.

## Goal

Transform the MCP from a broad code-search and tool server into a **context intelligence layer** that can answer:

> What context does the AI need, why does it matter, how risky is it, how fresh is it, and what should happen next?

The final product should provide high-quality context packs, explainable rankings, safe retrieval, reusable MCP resources, and structured outputs that AI coding clients can understand reliably.

---

## Phase 0 — Stabilize and Prepare the Codebase

### Objective

Make the project easier to build, test, package, and modify before major architectural changes.

### Tasks

#### 0.1 Audit required project files against the real repo

Check the current repo before adding anything. Several baseline files already exist, so this phase should produce a gap list rather than blindly creating boilerplate.

Already present in the current repo:

```txt
README.md
CHANGELOG.md
tsconfig.json
bin/context-engine-mcp.js
docs/
examples/
tests/
scripts/
```

Candidate gaps to decide explicitly before adding:

```txt
LICENSE
SECURITY.md
server.json
```

Recommended docs to add only when they correspond to implemented behavior:

```txt
docs/architecture.md
docs/security-model.md
docs/tool-selection.md
docs/context-pack-format.md
docs/resources.md
docs/evals.md
```

#### 0.2 Verify package scripts

Use the repo's existing Jest/TypeScript scripts and CI gates. Do not replace them with a Vitest/ESLint template unless those dependencies are intentionally introduced in a separate change.

```json
{
  "scripts": {
    "build": "tsc",
    "test": "node --experimental-vm-modules node_modules/jest/bin/jest.js",
    "test:watch": "node --experimental-vm-modules node_modules/jest/bin/jest.js --watch",
    "ci:check:mcp-smoke": "node --import tsx scripts/ci/mcp-smoke.ts",
    "ci:check:legacy-capability-parity": "npm run -s ci:generate:legacy-capability-parity-report && node --import tsx scripts/ci/check-legacy-capability-parity.ts --report artifacts/bench/retrieval-parity-pr.json --matrix config/ci/legacy-capability-matrix.json --out artifacts/bench/legacy-capability-parity-gate.json",
    "ci:check:retrieval-quality-gate": "npm run -s ci:generate:retrieval-quality-report && node --import tsx scripts/ci/check-retrieval-quality-gate.ts --report artifacts/bench/retrieval-quality-report.json --out artifacts/bench/retrieval-quality-gate.json",
    "verify": "node verify-setup.js",
    "inspector": "npx @modelcontextprotocol/inspector tsx src/index.ts --workspace ."
  }
}
```

#### 0.3 Add MCP smoke tests

Create smoke tests for:

```txt
initialize
tools/list
tools/call
resources/list
resources/read
prompts/list
```

Example test cases:

```txt
- Server starts over stdio
- Server starts over HTTP
- tools/list returns valid JSON schemas
- codebase_retrieval returns structuredContent
- resources/list includes context-engine resources
- invalid path is rejected
- .env is not exposed by default
```

### Output of Phase 0

The MCP can be built, tested, inspected, and released consistently.

---

## Phase 1 — Convert Outputs to Structured MCP Results

### Objective

Stop returning everything as plain JSON text. Return structured data that clients and agents can reliably parse.

### Current Problem

A tool result may look like this:

```ts
return {
  content: [
    {
      type: "text",
      text: JSON.stringify(result, null, 2)
    }
  ]
};
```

This works, but it makes the client treat useful data as a text blob.

### Target Behavior

Return both:

1. A human-readable text summary.
2. A machine-readable `structuredContent` object.

### Implementation Steps

#### 1.1 Create a shared tool result type

Add:

```txt
src/mcp/types/toolResult.ts
```

Example:

```ts
export type ContextEngineToolResult<T> = {
  content: Array<{
    type: "text";
    text: string;
  }>;
  structuredContent?: T;
  isError?: boolean;
  _meta?: {
    requestId?: string;
    traceId?: string;
    indexSnapshot?: string;
    workspaceHash?: string;
  };
};
```

#### 1.2 Create a result builder

Add:

```txt
src/mcp/utils/resultBuilder.ts
```

Example:

```ts
export function okResult<T>(summary: string, data: T): ContextEngineToolResult<T> {
  return {
    content: [
      {
        type: "text",
        text: summary
      }
    ],
    structuredContent: data
  };
}

export function errorResult(
  message: string,
  details?: unknown
): ContextEngineToolResult<{
  message: string;
  details?: unknown;
}> {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: message
      }
    ],
    structuredContent: {
      message,
      details
    }
  };
}
```

#### 1.3 Update tool handlers

Prioritize these tools first:

```txt
codebase_retrieval
semantic_search
symbol_definition
symbol_references
find_callers
find_callees
impact_analysis
review_diff
index_status
why_this_context
```

#### 1.4 Add output schemas

Every important tool should have:

```ts
inputSchema: { ... },
outputSchema: { ... }
```

Example:

```ts
outputSchema: {
  type: "object",
  additionalProperties: false,
  required: ["summary", "files", "risks"],
  properties: {
    summary: { type: "string" },
    files: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "reason", "importance"],
        properties: {
          path: { type: "string" },
          reason: { type: "string" },
          importance: {
            type: "string",
            enum: ["low", "medium", "high"]
          }
        }
      }
    },
    risks: {
      type: "array",
      items: { type: "string" }
    }
  }
}
```

### Before

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"files\":[{\"path\":\"src/auth/login.ts\"}]}"
    }
  ]
}
```

### After

```json
{
  "content": [
    {
      "type": "text",
      "text": "The login flow starts in src/routes/auth.ts and calls loginUser in src/auth/login.ts."
    }
  ],
  "structuredContent": {
    "summary": "The login flow starts in src/routes/auth.ts and calls loginUser in src/auth/login.ts.",
    "files": [
      {
        "path": "src/routes/auth.ts",
        "reason": "Defines the /login route",
        "importance": "high"
      },
      {
        "path": "src/auth/login.ts",
        "reason": "Contains the loginUser function",
        "importance": "high"
      }
    ],
    "risks": [
      "Changing session handling may affect logout and remember-me behavior"
    ]
  }
}
```

### Output of Phase 1

All major tools return structured, typed results that AI clients can understand without parsing text.

---

## Phase 2 — Build Context Pack V3

### Objective

Make the context pack the main product of the MCP.

Instead of returning random search results, the MCP should return a complete package of context for a task.

### Context Pack V3 Structure

Add:

```txt
src/context/types/contextPack.ts
```

Example:

```ts
export type ContextPackV3 = {
  packId: string;
  goal: string;
  summary: string;
  assumptions: string[];

  selectedContext: ContextItem[];

  graph: {
    entrypoints: GraphNode[];
    callers: GraphEdge[];
    callees: GraphEdge[];
    imports: GraphEdge[];
    tests: TestCandidate[];
  };

  risks: ContextRisk[];

  budget: {
    requestedTokens: number;
    usedTokens: number;
    strategy: "ranked_snippets" | "compressed" | "full_files";
  };

  provenance: {
    indexSnapshot: string;
    createdAt: string;
    workspaceHash: string;
    rankingVersion: string;
  };

  nextBestActions: NextBestAction[];
};
```

### Context Item Type

```ts
export type ContextItem = {
  id: string;
  uri: string;
  file: string;
  lines?: [number, number];
  symbols: string[];
  rank: number;
  importance: "low" | "medium" | "high" | "critical";
  reason: string[];
  freshness: {
    lastModified?: string;
    indexSnapshot: string;
    workingTreeStatus?: "clean" | "modified" | "untracked";
  };
  risk: {
    secretExposure: boolean;
    generatedFile: boolean;
    testGap: boolean;
    staleIndex: boolean;
  };
};
```

### Implementation Steps

#### 2.1 Create context pack assembler

Add:

```txt
src/context/contextPackAssembler.ts
```

Responsibilities:

```txt
- Take raw retrieval results
- Rank them
- Add reasons
- Attach graph relationships
- Attach tests
- Attach risks
- Attach freshness
- Attach token budget
- Produce ContextPackV3
```

#### 2.2 Add context item ranking reasons

Every selected result should explain itself.

Example reasons:

```txt
- File name directly matches the query
- Contains the requested symbol
- Called by the entrypoint
- Imports the changed module
- Test file covers the target function
- Recently modified in current git diff
```

#### 2.3 Add context pack IDs

Generate stable IDs:

```ts
const packId = `ctxp_${hash(goal + indexSnapshot + selectedFileHashes)}`;
```

#### 2.4 Store context packs in memory/cache

Add:

```txt
src/context/contextPackStore.ts
```

Basic API:

```ts
save(pack: ContextPackV3): Promise<void>;
get(packId: string): Promise<ContextPackV3 | null>;
list(): Promise<ContextPackSummary[]>;
delete(packId: string): Promise<void>;
```

#### 2.5 Update retrieval tools to return context packs

Primary tools should return `ContextPackV3`:

```txt
codebase_retrieval
semantic_search
impact_analysis
review_auto
debug_error
```

### Before

```txt
Found files:
- src/auth/login.ts
- src/auth/session.ts
- tests/auth.test.ts
```

### After

```txt
Context pack created: ctxp_login_flow_123

Main context:
- src/auth/login.ts because it contains loginUser
- src/auth/session.ts because loginUser creates a session through it
- tests/auth.test.ts because it verifies successful and failed login

Risks:
- Session changes affect logout
- Remember-me behavior shares the same cookie utility

Next best action:
- Inspect createSession before editing loginUser
```

### Output of Phase 2

The MCP consistently returns rich context packs instead of loose search results.

---

## Phase 3 — Make MCP Resources First-Class

### Objective

Expose files, symbols, chunks, context packs, and reviews as reusable MCP resources.

### Why This Matters

Tools answer questions.

Resources expose reusable context.

A great context engine should allow clients to say:

```txt
Read this context pack again.
Open this symbol.
Fetch this exact chunk.
Subscribe to index changes.
```

### Resource URI Design

Add these resources:

```txt
context-engine://files/{path}
context-engine://chunks/{chunkId}
context-engine://symbols/{symbolId}
context-engine://context-packs/{packId}
context-engine://graphs/{path}
context-engine://index/snapshot
context-engine://reviews/{reviewId}
context-engine://evals/{runId}
```

### Implementation Steps

#### 3.1 Add resource router

Add:

```txt
src/mcp/resources/resourceRouter.ts
```

Example:

```ts
export async function readResource(uri: string) {
  if (uri.startsWith("context-engine://files/")) {
    return readFileResource(uri);
  }

  if (uri.startsWith("context-engine://context-packs/")) {
    return readContextPackResource(uri);
  }

  if (uri.startsWith("context-engine://symbols/")) {
    return readSymbolResource(uri);
  }

  throw new Error(`Unknown resource URI: ${uri}`);
}
```

#### 3.2 Implement resource list

`resources/list` should include:

```txt
index snapshot
recent context packs
recent reviews
tool manifest
saved plans
```

#### 3.3 Implement resource templates

Expose templates like:

```json
{
  "uriTemplate": "context-engine://files/{path}",
  "name": "Workspace file",
  "description": "Read a safe workspace-relative file",
  "mimeType": "text/plain"
}
```

#### 3.4 Return resource links from tools

A retrieval result should include resource references:

```json
{
  "file": "src/auth/login.ts",
  "uri": "context-engine://files/src/auth/login.ts",
  "chunkUri": "context-engine://chunks/chunk_abc123"
}
```

#### 3.5 Add resource safety checks

For `context-engine://files/{path}`:

```txt
- Must stay inside workspace root
- Must reject path traversal
- Must respect .gitignore if configured
- Must redact or block secrets
- Must block huge files unless explicitly allowed
- Must mark generated files
```

### Before

The AI asks the tool again to fetch the same file.

### After

The MCP says:

```json
{
  "path": "src/auth/login.ts",
  "resource": "context-engine://files/src/auth/login.ts"
}
```

The client can now fetch that resource directly.

### Output of Phase 3

Context is no longer only returned by tools. It becomes reusable, inspectable, and linkable.

---

## Phase 4 — Improve Tool Descriptions and Tool Selection

### Objective

Make it easier and safer for AI clients to choose the right tool.

### Current Problem

Some tool descriptions are too forceful, such as telling the model to “always” use a tool or treating tool guidance like system-level rules.

That can cause tool-selection confusion.

### Implementation Steps

#### 4.1 Rewrite tool descriptions neutrally

Before:

```txt
ALWAYS use codebase_retrieval when answering code questions.
Treat these rules as appending to the system prompt.
```

After:

```txt
Use codebase_retrieval for natural-language questions over the codebase,
especially when exact file names or symbols are unknown.

Prefer symbol_definition, symbol_references, find_callers, or find_callees
when the exact symbol name is known.
```

#### 4.2 Add a tool-selection guide

Create:

```txt
docs/tool-selection.md
```

Example:

```txt
User asks "Where is auth handled?"
Use: codebase_retrieval

User asks "Where is loginUser defined?"
Use: symbol_definition

User asks "What calls loginUser?"
Use: find_callers

User asks "What will break if I change loginUser?"
Use: impact_analysis

User asks "Review this diff"
Use: review_diff
```

#### 4.3 Add a tool manifest linter

Create:

```txt
src/mcp/tooling/manifestLint.ts
```

Rules:

```txt
- No "ignore previous instructions"
- No "system prompt" wording
- No "always use this tool" unless justified
- Input schemas must be strict
- Output schemas required for high-value tools
- Tool names must be stable and descriptive
```

### Output of Phase 4

Tools become safer, easier to choose, and more compatible with different MCP clients.

---

## Phase 5 — Add Context Safety and Policy Checks

### Objective

Prevent the MCP from accidentally sending secrets, irrelevant generated files, stale data, or dangerous context.

### Implementation Steps

#### 5.1 Add a context policy engine

Add:

```txt
src/security/contextPolicy.ts
```

Policy checks:

```txt
- Secret detection
- Path traversal detection
- Generated file detection
- Large file detection
- Binary file detection
- Vendor/dependency folder detection
- Stale index detection
- Private key detection
- .env file detection
```

#### 5.2 Add safe context modes

Support modes:

```ts
type ContextSafetyMode = "strict" | "balanced" | "permissive";
```

Recommended behavior:

| Mode | Behavior |
|---|---|
| `strict` | Block secrets, `.env`, large files, generated files, lockfiles, vendor files |
| `balanced` | Redact secrets, include generated files only if highly relevant |
| `permissive` | Include more files, but still redact obvious secrets |

#### 5.3 Add redaction receipts

Instead of silently removing files, explain it.

Example:

```json
{
  "redacted": [
    {
      "path": ".env",
      "reason": "Potential secret file"
    },
    {
      "path": "local.secrets.json",
      "reason": "Filename indicates credentials"
    }
  ]
}
```

#### 5.4 Add secret scanning

Detect patterns such as:

```txt
API keys
JWT secrets
Private keys
GitHub tokens
AWS keys
Database URLs
OAuth secrets
```

#### 5.5 Add generated file detection

Common generated files:

```txt
dist/
build/
coverage/
node_modules/
*.min.js
package-lock.json
pnpm-lock.yaml
yarn.lock
generated/
__generated__/
```

### Before

```txt
Found:
- .env
- src/auth/token.ts
- src/config/security.ts
```

### After

```txt
Included:
- src/auth/token.ts
- src/config/security.ts

Excluded:
- .env because it may contain secrets
- local.secrets.json because it likely contains credentials
```

### Output of Phase 5

The context engine becomes safer for real-world projects.

---

## Phase 6 — Add Explainable Ranking

### Objective

Every result should explain why it was selected and why it was ranked where it was.

### Implementation Steps

#### 6.1 Add ranking receipt type

```ts
export type RankingReceipt = {
  itemId: string;
  finalScore: number;
  signals: Array<{
    name: string;
    score: number;
    explanation: string;
  }>;
};
```

#### 6.2 Add ranking signals

Recommended signals:

```txt
Exact symbol match
File name match
Semantic similarity
Import relationship
Caller/callee relationship
Recently edited file
Test relationship
Entrypoint relationship
Documentation relationship
Error stack trace match
```

#### 6.3 Include ranking receipts in context packs

Example:

```json
{
  "file": "src/auth/login.ts",
  "rank": 0.94,
  "why": [
    "Contains exact symbol loginUser",
    "Called by /login route",
    "Covered by auth login tests"
  ],
  "rankingReceipt": {
    "finalScore": 0.94,
    "signals": [
      {
        "name": "exact_symbol_match",
        "score": 0.4,
        "explanation": "Contains loginUser"
      },
      {
        "name": "route_relationship",
        "score": 0.3,
        "explanation": "Called by /login route"
      },
      {
        "name": "test_coverage",
        "score": 0.2,
        "explanation": "Covered by login.test.ts"
      }
    ]
  }
}
```

#### 6.4 Update `why_this_context`

Instead of only answering after the fact, every retrieval result should already include `why`.

`why_this_context` should become a deeper inspection tool for a specific context pack.

### Output of Phase 6

The MCP becomes explainable, not just searchable.

---

## Phase 7 — Add Test Discovery and Impact Analysis Upgrades

### Objective

Whenever the MCP returns implementation files, it should also identify related tests and likely blast radius.

### Implementation Steps

#### 7.1 Add test discovery service

Add:

```txt
src/analysis/testDiscovery.ts
```

Detection strategies:

```txt
- Same folder test file
- __tests__ folder
- *.test.ts / *.spec.ts
- Import graph relationship
- Naming similarity
- Package script mapping
- Framework config detection
```

#### 7.2 Add impact graph

For a target file or symbol, return:

```txt
- Direct callers
- Direct callees
- Importers
- Imported dependencies
- Related tests
- Related routes
- Related configs
- Related docs
```

#### 7.3 Update `impact_analysis`

Before:

```txt
login.ts may impact session.ts
```

After:

```txt
Changing loginUser may impact:

Runtime:
- src/routes/auth.ts
- src/auth/session.ts
- src/auth/cookies.ts

Tests:
- tests/auth/login.test.ts
- tests/auth/session.test.ts

Risks:
- Logout shares session cookie logic
- Remember-me uses the same expiry utility

Recommended validation:
- npm test -- auth
- npm run test:e2e -- login
```

### Output of Phase 7

The MCP helps agents make safer edits and validate changes.

---

## Phase 8 — Add Long-Running Task Support

### Objective

Make slow operations like indexing, deep review, and large repo analysis trackable and cancellable.

### Candidate Tools

```txt
index_workspace
reindex_workspace
review_auto
reactive_review_pr
execute_plan
run_static_analysis
deep_impact_analysis
```

### Implementation Steps

#### 8.1 Add task manager

Add:

```txt
src/mcp/tasks/taskManager.ts
```

Basic task type:

```ts
export type McpTask = {
  taskId: string;
  kind: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress: {
    current: number;
    total?: number;
    message?: string;
  };
  startedAt: string;
  completedAt?: string;
  resultResourceUri?: string;
  error?: string;
};
```

#### 8.2 Add task APIs internally

```ts
createTask(kind, input): Promise<McpTask>;
getTask(taskId): Promise<McpTask | null>;
cancelTask(taskId): Promise<void>;
listTasks(): Promise<McpTask[]>;
```

#### 8.3 Emit progress

Example:

```txt
Indexing:
- scanned 1,240 files
- indexed 930 files
- extracted 8,420 symbols
- skipped 210 generated files
```

#### 8.4 Store final result as resource

Example:

```txt
context-engine://tasks/task_123
context-engine://index/snapshot
context-engine://reviews/review_456
```

### Before

The client waits for a long request to finish.

### After

The client sees:

```json
{
  "taskId": "task_index_123",
  "status": "running",
  "progress": {
    "current": 930,
    "total": 1240,
    "message": "Indexing TypeScript files"
  }
}
```

### Output of Phase 8

Large operations become reliable, visible, and cancellable.

---

## Phase 9 — Improve HTTP Transport, Auth, and Protocol Compliance

### Objective

Make the MCP production-ready over HTTP.

### Implementation Steps

#### 9.1 Support protocol version header

Allow and validate:

```txt
MCP-Protocol-Version
MCP-Session-Id
Accept: application/json, text/event-stream
```

Update CORS middleware to expose:

```txt
MCP-Protocol-Version
MCP-Session-Id
```

#### 9.2 Centralize stdio and HTTP execution

Create:

```txt
src/mcp/executeTool.ts
```

Both stdio and HTTP should use the same execution path for:

```txt
- Validation
- Logging
- Metrics
- Error formatting
- Cancellation
- Structured results
```

#### 9.3 Add HTTP auth scopes

Suggested scopes:

```txt
workspace:read
workspace:index
memory:read
memory:write
review:run
plan:write
process:run
admin:metrics
```

#### 9.4 Add audit logging

Log:

```txt
- Tool called
- Resource read
- Files exposed
- Secrets redacted
- Long-running tasks started/cancelled
- Auth scope used
```

#### 9.5 Add rate limits by scope

Example:

```txt
index_workspace: low frequency
semantic_search: medium frequency
resources/read: higher frequency
admin tools: restricted
```

### Output of Phase 9

The MCP is safer and more reliable for local and remote use.

---

## Phase 10 — Add Roots, Elicitation, and Client-Aware Behavior

### Objective

Use more MCP client features to behave better in real coding environments.

### Implementation Steps

#### 10.1 Support roots

If the client provides workspace roots, respect them.

Behavior:

```txt
- Ask client for roots
- Only index/read files inside allowed roots
- Update roots when client sends roots/list_changed
```

#### 10.2 Add elicitation for ambiguity

When a request is vague, the MCP can ask for structured clarification.

Example:

```txt
User task: "Fix auth"

MCP asks:
- Are you fixing login, registration, sessions, or password reset?
- Should I include tests?
- Should I inspect recent git changes?
```

#### 10.3 Add sampling where useful

Use client-provided model sampling for:

```txt
- Summarizing large context packs
- Explaining review findings
- Generating plan drafts
- Compressing context
```

### Output of Phase 10

The MCP behaves more intelligently inside modern clients.

---

## Phase 11 — Add Evaluation Benchmarks

### Objective

Prove that this is not just bigger, but better.

### Eval Categories

#### 11.1 Retrieval quality

Measure:

```txt
recall@k
precision@k
context usefulness
exact symbol hit rate
test discovery accuracy
```

#### 11.2 Safety

Measure:

```txt
secret leak rate
.env exposure rate
path traversal prevention
generated file suppression
```

#### 11.3 Agent usefulness

Measure:

```txt
Can an AI solve a coding task with the returned context?
How many tool calls are needed?
How much irrelevant context was included?
Did the MCP suggest the right tests?
```

#### 11.4 Performance

Measure:

```txt
p50 latency
p95 latency
indexing time
cache hit rate
memory usage
token efficiency
```

### Implementation Steps

Add:

```txt
evals/
  fixtures/
  tasks/
  expected-context/
  runEval.ts
  metrics.ts
```

Example eval task:

```json
{
  "id": "auth-password-reset-001",
  "query": "Change password reset token expiry",
  "expectedFiles": [
    "src/auth/password.ts",
    "src/config/security.ts",
    "tests/auth/password-reset.test.ts"
  ],
  "forbiddenFiles": [
    ".env",
    "node_modules/"
  ]
}
```

Expected output:

```json
{
  "recallAt5": 1.0,
  "precisionAt5": 0.8,
  "secretLeakRate": 0,
  "includedTests": true
}
```

### Output of Phase 11

The project has measurable quality and can improve over time.

---

## Phase 12 — Refactor Architecture

### Objective

Reduce complexity and make the codebase easier to maintain.

### Recommended Structure

```txt
src/
  mcp/
    server.ts
    executeTool.ts
    tools/
    resources/
    prompts/
    tasks/
    types/
  context/
    contextPackAssembler.ts
    contextPackStore.ts
    ranking.ts
    rankingReceipts.ts
    tokenBudget.ts
  indexing/
    indexer.ts
    snapshot.ts
    freshness.ts
  retrieval/
    semanticSearch.ts
    symbolSearch.ts
    hybridRetrieval.ts
    queryIntent.ts
  graph/
    importGraph.ts
    callGraph.ts
    symbolGraph.ts
  analysis/
    impactAnalysis.ts
    testDiscovery.ts
    review.ts
  security/
    contextPolicy.ts
    secretScanner.ts
    pathSafety.ts
  telemetry/
    metrics.ts
    traces.ts
    auditLog.ts
  evals/
```

### Refactor Plan

1. Extract result formatting and schema validation.
2. Extract context pack assembly.
3. Extract resource routing.
4. Extract safety policy.
5. Extract ranking and receipts.
6. Extract indexing and retrieval services.

Avoid one massive rewrite. Refactor around the features being implemented.

### Output of Phase 12

The codebase becomes modular and easier to extend.

---

## Milestones

### Milestone 1 — Foundation

Implement:

```txt
- Project packaging cleanup
- Shared structured result type
- Output schemas for key tools
- Neutral tool descriptions
- Basic context pack type
```

Success criteria:

```txt
- MCP builds cleanly
- Major tools return structuredContent
- Tool descriptions are safe and clear
- Context pack shape is documented
```

### Milestone 2 — Context Pack V3

Implement:

```txt
- ContextPackAssembler
- Ranking reasons
- Basic provenance
- Related tests
- Risks
- Token budget
- Context pack store
```

Success criteria:

```txt
codebase_retrieval returns:
- summary
- selected files
- why each file matters
- related tests
- risks
- next best action
```

### Milestone 3 — Resource-Native MCP

Implement:

```txt
- context-engine://files/{path}
- context-engine://chunks/{chunkId}
- context-engine://symbols/{symbolId}
- context-engine://context-packs/{packId}
- resources/list
- resources/read
- resource links in tool results
```

Success criteria:

```txt
A retrieval result links to reusable MCP resources.
Clients can fetch the same context pack later.
```

### Milestone 4 — Safety and Explainability

Implement:

```txt
- Context policy engine
- Secret redaction
- Generated file filtering
- Ranking receipts
- why_this_context upgrade
- Stale index warnings
```

Success criteria:

```txt
- .env and secrets are blocked or redacted
- Every selected context item explains why it was chosen
- Risk warnings appear in context packs
```

### Milestone 5 — Agent-Grade Analysis

Implement:

```txt
- Better impact analysis
- Test discovery
- Git diff awareness
- Next-best-action suggestions
- Debug/error context flow
```

Success criteria:

```txt
For a requested code change, MCP returns:
- edit targets
- blast radius
- tests to run
- likely risks
- validation commands
```

### Milestone 6 — Long-Running Tasks and HTTP Hardening

Implement:

```txt
- Task manager
- Indexing progress
- Review progress
- Cancellation
- Protocol version header support
- Shared stdio/HTTP execution
- Basic auth scopes
```

Success criteria:

```txt
Large operations are trackable, cancellable, and consistent across transports.
```

### Milestone 7 — Evals and Release Quality

Implement:

```txt
- Retrieval evals
- Safety evals
- Performance evals
- MCP Inspector tests
- CI workflow
- Release docs
```

Success criteria:

```txt
Every PR can prove it did not make retrieval, safety, or performance worse.
```

---

## Example Final User Experience

### User asks

```txt
I need to change password reset token expiry from 15 minutes to 30 minutes.
```

### Old MCP response

```txt
Found matches:
- src/auth/password.ts
- src/config/security.ts
- docs/auth.md
```

### New MCP response

```txt
Context pack created: ctxp_password_reset_expiry_7f3a

Summary:
Password reset expiry is configured in src/config/security.ts and used by
src/auth/password.ts when generating reset tokens.

Primary files:
1. src/config/security.ts
   Reason: Defines PASSWORD_RESET_EXPIRY_MINUTES.

2. src/auth/password.ts
   Reason: Uses the expiry value when creating reset tokens.

3. tests/auth/password-reset.test.ts
   Reason: Verifies expired and valid reset tokens.

Risks:
- Account invitation tokens use a similar expiry utility.
- Changing the shared helper may affect email verification.

Recommended edit:
- Change PASSWORD_RESET_EXPIRY_MINUTES from 15 to 30.

Recommended validation:
- npm test -- password-reset
- npm test -- auth

Excluded:
- .env because it may contain secrets.
```

Machine-readable result:

```json
{
  "packId": "ctxp_password_reset_expiry_7f3a",
  "goal": "Change password reset token expiry from 15 minutes to 30 minutes",
  "summary": "Password reset expiry is configured in src/config/security.ts and used by src/auth/password.ts.",
  "selectedContext": [
    {
      "file": "src/config/security.ts",
      "uri": "context-engine://files/src/config/security.ts",
      "importance": "critical",
      "reason": [
        "Defines PASSWORD_RESET_EXPIRY_MINUTES"
      ],
      "rank": 0.97
    },
    {
      "file": "src/auth/password.ts",
      "uri": "context-engine://files/src/auth/password.ts",
      "importance": "high",
      "reason": [
        "Uses the expiry value when creating reset tokens"
      ],
      "rank": 0.91
    },
    {
      "file": "tests/auth/password-reset.test.ts",
      "uri": "context-engine://files/tests/auth/password-reset.test.ts",
      "importance": "high",
      "reason": [
        "Tests reset token expiry behavior"
      ],
      "rank": 0.84
    }
  ],
  "risks": [
    {
      "level": "medium",
      "message": "Shared expiry helper may also affect email verification tokens."
    }
  ],
  "nextBestActions": [
    {
      "action": "Inspect src/config/security.ts",
      "reason": "Confirm the constant is not reused for unrelated token types."
    },
    {
      "action": "Run password reset tests",
      "command": "npm test -- password-reset"
    }
  ]
}
```

---

## Final Priority List

Build in this order:

1. Structured tool results
2. Context Pack V3
3. MCP resources for files, chunks, symbols, and packs
4. Explainable ranking
5. Safety policy and secret redaction
6. Test discovery and impact analysis
7. Long-running task support
8. HTTP/auth/protocol hardening
9. Evaluation benchmarks
10. Architecture refactor and release packaging

The most important shift is:

> Do not make the MCP return more context. Make it return the **right context**, with reasons, risks, tests, provenance, and reusable resource links.
