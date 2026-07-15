# OpenAI-Powered, OSS-Enhanced MCP Enhancement Plan

## Executive Summary

This codebase should evolve into an **OpenAI-powered, OSS-enhanced code graph MCP**.

The right direction is to **keep OpenAI as the only model provider** while using **open-source enhancements everywhere else**:

- **tree-sitter** for parsing
- **SQLite / FTS5** for lexical retrieval
- **LanceDB** for vector retrieval
- **OpenTelemetry** for tracing
- **Semgrep / ast-grep / linters** for static analysis
- **git-native diff analysis** for review workflows
- **persistent local code graph** for symbol intelligence

This avoids unnecessary provider complexity while significantly improving the MCP’s quality, reliability, and depth.

---

## Strategic Direction

### Keep
- OpenAI as the single model provider
- Existing retrieval foundations already present in the repo
- Current MCP + HTTP surfaces
- Existing indexing and review concepts

### Do Not Prioritize
- Multi-provider abstraction
- Ollama / llama.cpp / vLLM integration
- Local model backends
- Provider registry expansion beyond OpenAI

### Best Core Idea
Build a **code graph MCP** that uses:
- OpenAI for reasoning, synthesis, review generation, planning, and context explanation
- Open-source systems for indexing, parsing, diff analysis, static findings, retrieval, and observability

---

## Current Issues Observed in the Repo

### 1. Repo surface appears partially stale or incomplete
The archive appears to have drift between code and manifest/config:
- `package.json` references files and scripts that are missing in the uploaded snapshot
- Jest scripts exist, but there are no actual test files in the repo snapshot
- This increases delivery risk and should be fixed first

### 2. OpenAI integration exists, but not as a robust platform subsystem
OpenAI is present, but the provider/runtime path should become more disciplined:
- stronger structured outputs
- better task routing
- caching and retries
- token/cost accounting
- prompt versioning
- explicit contracts per task

### 3. Symbol/code intelligence is still too heuristic
Several code-navigation features rely on line heuristics, regex, or keyword matching rather than a true code graph.

### 4. Reactive review is not fully diff-native yet
The review path should operate on real git diffs and changed hunks throughout.

### 5. Oversized orchestration files are becoming a maintenance bottleneck
Large files like `serviceClient.ts` and `server.ts` should be split before more features are added.

### 6. There are some correctness and hardening gaps
Examples include:
- HTTP background indexing path mismatch
- placeholder diff generation in reactive review
- git subprocess execution using `shell: true`

---

## Updated Roadmap

# Phase 0 — Stabilize the Repository

Before major new capabilities are added, make the codebase safe to evolve.

## Goals
- eliminate stale manifest/config drift
- add baseline tests
- fix obvious correctness gaps
- document architecture and module boundaries

## Work Items

### Cleanup
- audit `package.json` scripts and remove or restore missing script targets
- verify bin/entrypoint references
- add or restore missing CI-related files if expected
- ensure build/test/dev commands reflect reality

### Testing Baseline
Add a real test foundation for:
- MCP tool contracts
- HTTP route behavior
- retrieval services
- review pipeline behavior
- provider/runtime behavior
- indexing smoke tests

### Documentation
Add:
- root architecture overview
- module map
- tool contract documentation
- contribution/development guide

### Immediate Fixes
- fix the HTTP route so background indexing actually calls the background method
- remove placeholder diff generation from reactive review paths
- remove `shell: true` from git command execution
- correct any tool descriptions/state-file mismatches

## Output of Phase 0
A repo that can be safely refactored and benchmarked.

---

# Phase 1 — Make OpenAI a First-Class Runtime Subsystem

Since OpenAI is staying, this should become a strong and explicit subsystem rather than just a single provider call path.

## Goals
- standardize all OpenAI interactions
- enforce structured outputs wherever possible
- add reliability controls
- support task-based model routing
- improve observability of cost and latency

## Design Direction

Create a dedicated runtime layer, for example:
- `OpenAIRuntime`
- `PromptRegistry`
- `TaskRouter`
- `ResponseValidator`
- `LLMCache`
- `CostTelemetry`

## Improvements

### Structured Outputs
Use strict JSON schema or structured output enforcement for:
- review findings
- planning responses
- context selection metadata
- query classification
- decomposition tasks
- tool output summaries

### Task-Based Routing
Use different model classes for different work:
- smaller/faster model for classification, query rewrite, and routing
- stronger model for planning, code review synthesis, and architectural reasoning

### Reliability
Add:
- retries with bounded backoff
- cancellation support
- timeout controls
- request deduplication
- rate-limit handling
- fallback prompt strategies when parsing fails

### Prompt Management
- version prompts
- track prompt usage per feature
- test prompt regressions
- store prompt metadata alongside outputs

### Caching
Add cache layers for:
- query classification
- context selection on repeated queries
- review synthesis for unchanged diffs
- identical prompt+context calls

### Telemetry
Track:
- token usage
- cost by feature
- latency by task type
- parse failure rate
- structured output conformance
- retry frequency

## Output of Phase 1
OpenAI becomes a robust reasoning backend with strict contracts and measurable quality.

---

# Phase 2 — Build a Persistent Code Graph

This is the highest-value product improvement outside the OpenAI runtime.

## Goals
- replace heuristic code understanding with persistent structural intelligence
- support definition/reference/call relationships reliably
- enable impact analysis and graph-aware retrieval

## Core Graph Entities
Store at minimum:
- files
- symbols
- definitions
- references
- imports
- call relationships
- containment relationships
- file-to-symbol mappings
- graph edges tied to language and extraction confidence

## Extraction Strategy
Use:
- **tree-sitter** as the primary parser/extractor
- language-specific enrichers where practical
- SQLite as the graph metadata store

## New Services
Introduce a graph layer such as:
- `GraphIndexService`
- `SymbolGraphRepository`
- `ReferenceResolver`
- `CallGraphService`
- `ImpactAnalysisService`

## Existing Features to Rebuild on the Graph
Move these away from heuristics and onto the graph first, with fallback only when necessary:
- symbol search
- symbol definition lookup
- symbol reference search
- call relationships
- code impact tracing

## New MCP Tools Enabled
- `trace_symbol`
- `find_callers`
- `find_callees`
- `impact_analysis`
- `blast_radius`
- `why_this_context`

## Output of Phase 2
The MCP becomes structurally aware of the codebase instead of depending heavily on regex and keyword heuristics.

---

# Phase 3 — Upgrade Retrieval to Be Graph-Aware

The repo already has a useful retrieval base. The next step is to orchestrate it better.

## Goals
- improve relevance of retrieved context
- better support code-navigation and architecture questions
- explain why specific files/chunks were chosen

## Proposed Retrieval Flow
1. classify query intent
2. retrieve lexical candidates
3. retrieve vector candidates
4. expand candidates using graph neighbors
5. rerank results
6. assemble context with provenance metadata

## Recommended Division of Labor

### OpenAI should handle
- query rewriting
- intent classification
- contextual reasoning
- explanation and final synthesis

### OSS/local systems should handle
- indexing
- chunk storage
- lexical search
- vector retrieval
- graph expansion
- reranking
- provenance tracking

## Enhancements
- support query-type-aware retrieval routing
- weight graph-neighbor expansion differently by task
- add provenance metadata for every selected chunk
- expose “why this was selected” information to tools and outputs

## Output of Phase 3
Higher-quality context assembly for architectural questions, code navigation, and change reasoning.

---

# Phase 4 — Rebuild Review as a Real Diff-Native Pipeline

This should be the second-biggest product improvement after the code graph.

## Goals
- operate on real git diffs consistently
- focus on changed hunks rather than whole files
- combine static analyzers with OpenAI synthesis
- reduce hallucinated review findings

## Pipeline Shape
`git diff -> changed hunks -> static analyzers -> line mapping -> OpenAI synthesis`

## Required Changes
- use real git diff collection everywhere in review flows
- stop generating synthetic or placeholder diffs in reactive review
- map findings to changed lines and nearby context
- only send relevant hunks + supporting context to OpenAI

## OSS Analyzer Stack to Add
- **Semgrep CE**
- **ast-grep**
- **ESLint**
- **Ruff**
- **ShellCheck**
- **Hadolint**
- **Actionlint**
- **golangci-lint**
- **Gitleaks**

## Review Architecture
Add a pluggable analyzer bus, for example:
- `AnalyzerRegistry`
- `DiffContextBuilder`
- `ChangedLineMapper`
- `ReviewSynthesisService`
- `ReviewFindingNormalizer`

## Why This Matters
This shifts OpenAI from “discover everything from scratch” to “synthesize and prioritize grounded findings,” which is both cheaper and more accurate.

## Output of Phase 4
A review system that is more precise, less noisy, and more trustworthy.

---

# Phase 5 — Refactor the Oversized Core Modules

The system should not continue growing around one giant service client and a large hand-maintained server registry.

## Goals
- improve maintainability
- improve testability
- reduce coupling
- make feature development safer

## Recommended Extraction Targets
Split into focused modules such as:
- `OpenAIRuntime`
- `IndexService`
- `RetrievalService`
- `GraphService`
- `ReviewService`
- `ContextComposer`
- `WorkspaceStateService`
- `ToolRegistry`

## Refactor Priorities

### `serviceClient.ts`
Break apart by responsibility:
- indexing
- retrieval
- symbol intelligence
- review orchestration
- OpenAI runtime access
- workspace state

### `server.ts`
Replace hand-maintained registry logic with:
- manifest-driven tool registration
- explicit schema ownership per tool
- shared middleware for validation and telemetry

## Output of Phase 5
A codebase that is modular enough to support future growth without turning brittle.

---

# Phase 6 — Improve MCP Tool Ergonomics and Contracts

The MCP should feel like a coherent platform, not just a collection of individual tools.

## Goals
- standardize tool behavior
- improve explainability
- reduce divergence between HTTP and MCP paths

## Work Items
- standardize tool input/output schemas
- define common metadata fields per tool
- unify behavior across transports
- expose tool reasoning metadata where useful

## Suggested Tool Metadata
- latency class
- cost class
- required indexes
- whether git is required
- whether graph index is required
- provenance/explainability availability

## Explainability Features
Return metadata such as:
- why these files were selected
- why a symbol matched
- why a review finding was emitted
- which analyzers contributed to a conclusion

## Output of Phase 6
A more predictable and transparent MCP developer experience.

---

# Phase 7 — Add Observability, Evaluation, and Benchmarks

The repo should have measurable quality, not just functionality.

## Goals
- observe performance and cost
- prevent regressions
- benchmark retrieval and review quality

## Additions
- **OpenTelemetry** spans and traces
- structured logs
- correlation IDs across request flows
- token/cost dashboards
- retrieval quality fixtures
- review quality fixture suites
- latency benchmarks by repo size

## Benchmark Areas
Create evaluation sets for:
- symbol lookup accuracy
- reference resolution accuracy
- call graph usefulness
- context pack relevance
- review precision on seeded bugs
- latency under different repo sizes and diff sizes

## Output of Phase 7
A system that can be improved using evidence instead of guesswork.

---

## Recommended Execution Order

### Priority 1 — Stabilize the repo
- clean stale scripts and missing entries
- add baseline tests
- fix background indexing mismatch
- remove `shell: true`
- remove placeholder diff usage

### Priority 2 — Harden OpenAI runtime
- structured outputs
- task routing
- caching
- retries
- prompt versioning
- telemetry

### Priority 3 — Build the code graph
- tree-sitter extraction
- persistent graph storage
- graph-backed symbol tools

### Priority 4 — Upgrade retrieval
- graph-aware context assembly
- rerank improvements
- provenance and explainability

### Priority 5 — Rebuild review
- real git diffs
- analyzer plugin bus
- OpenAI synthesis over grounded findings

### Priority 6 — Modularize core orchestration
- split `serviceClient.ts`
- move toward manifest-driven tool registration

### Priority 7 — Add evaluation and tracing
- observability
- regression suites
- performance baselines

---

## Concrete Near-Term Fixes

These should be addressed immediately because they provide quick value and reduce risk:

1. Fix HTTP indexing behavior so background indexing actually runs in the background path.
2. Remove placeholder diff generation from reactive review and use real git diff inputs.
3. Remove `shell: true` from git subprocess execution.
4. Clean up stale manifest/script/bin references.
5. Add a real test baseline before deeper refactors.
6. Stop adding new logic into oversized orchestration files until extraction begins.

---

## Final Recommendation

The best version of this project is:

# **OpenAI-Powered, OSS-Enhanced Code Graph MCP**

### OpenAI should be used for:
- reasoning
- planning
- code review synthesis
- context explanation
- architecture summarization

### Open-source enhancements should be used for:
- parsing
- indexing
- graph construction
- retrieval
- diff analysis
- static analysis
- observability
- benchmarking

This keeps the strongest existing design choice — OpenAI for synthesis and reasoning — while fixing the most important weaknesses:
- heuristic symbol understanding
- weak diff-native review
- oversized orchestration modules
- brittle output handling
- incomplete testing and observability

---

## Proposed Outcome

If implemented well, this MCP would become:
- more accurate on code navigation
- more useful for impact analysis
- more trustworthy in code review
- more maintainable internally
- easier to benchmark and improve over time
- stronger without adding unnecessary provider complexity

