<update-note>
Archived roadmap draft.

This note is preserved for reference, but it is not the active roadmap anymore.
The current repo direction is summarized in `docs/updates-openai-roadmap-summary.md`.
</update-note>

The current direction is to keep the repo OpenAI-only for reasoning, planning, synthesis, and review, while deferring any Responses API migration to a later modernization pass. The active work is focused on keeping the existing integration fast, cancelable, cache-friendly, and simple to reason about.

Updated direction

Keep:

OpenAI for reasoning, planning, synthesis, and review

Improve:

build/package health
OpenAI adapter quality
cancellation/timeouts
token efficiency
review correctness
job control and observability

Remove from the old plan:

Ollama / vLLM / llama.cpp migration
multi-provider abstraction as a delivery goal
Responses API as the near-term canonical flow

Keep only a thin provider boundary so the code stays clean, but do not spend roadmap time on non-OpenAI providers.

Historical phases below are kept for context only.

Historical Phase 0 — Make the repo shippable

This is still first.

From the audit, the archive is not build-complete as shipped, so no optimization work is trustworthy until this is fixed.

Do now:

restore tsconfig.json
restore or remove dead package.json scripts
add the missing CLI/bin entrypoint
add a smoke test that installs, builds, starts the service, and runs one MCP/HTTP tool
add a packaging gate so releases fail if required runtime files are missing

Success criteria:

clean npm ci
clean npm run build
one end-to-end test passes in CI
release artifact is reproducible
Historical Phase 1 — Replace the current OpenAI execution path with a real OpenAI gateway

Do not replace OpenAI.
Replace the current OpenAI integration style.

The repo should move away from the current session/subprocess-style path and toward one explicit OpenAIProvider / OpenAIGateway built around the Responses API. OpenAI’s docs position Responses as the forward path, support incremental migration, and document structured outputs in Responses under text.format.

Build this gateway with:

responses.create() as the default execution path
support for streaming where interactive latency matters
background: true for long-running review/audit jobs
structured JSON output for plans, findings, and tool synthesis
unified usage capture:
prompt tokens
cached tokens
completion tokens
finish reason
latency
model routing hooks

Success criteria:

all AI calls go through one adapter
no temp-file response capture
no per-call subprocess orchestration for standard model requests
every AI response returns usage telemetry
Historical Phase 2 — Add real deadline propagation and cancellation

This is the biggest correctness fix after packaging.

Right now, timeouts mostly reject the caller while work can continue underneath. That needs to become a real cancellation model.

Implement:

one request deadline object at entry
AbortController propagated through HTTP -> tool -> service -> OpenAI gateway
queue cancellation for waiting tasks
in-flight cancellation for OpenAI requests whenever the caller drops or the deadline expires
background jobs separated from foreground requests instead of “fire-and-forget inside request handlers”

For long-running jobs, use:

OpenAI background responses where they fit
webhook-driven completion handling for async flows
your own job registry for state, heartbeat, retry, cancel

OpenAI documents background responses plus webhook events like response.completed, and recommends quick webhook acknowledgment with non-trivial work offloaded to background workers.

Success criteria:

timed-out requests stop spending work
no orphaned review/index jobs
canceling a request removes it from the queue or marks the job canceled
Historical Phase 3 — Make OpenAI usage token-efficient and cache-friendly

If you are staying with OpenAI, this becomes a major optimization area.

OpenAI prompt caching works automatically on supported recent models, benefits exact prompt-prefix matches, works best when stable content is at the front and variable content is at the end, and exposes cached_tokens in usage. It also supports prompt_cache_key and optional retention settings.

Refactor prompt construction to maximize cache hits:

stable system instructions first
stable tool schema first
stable output schema first
repo-specific context after that
user-specific / diff-specific content last

Also add three prompt modes:

compact
balanced
deep

Specific repo fixes:

stop sending whole formatted plan JSON into refine_plan
send only summary + changed sections + user delta
replace broad file dumps with:
file purpose
touched symbols
changed hunks
1–2 best snippets
set explicit output ceilings per tool
dedupe repeated summaries and repeated snippets

Also use model controls deliberately. The Responses API exposes reasoning controls like reasoning.effort; lower effort can reduce latency and reasoning-token spend where deep reasoning is unnecessary.

Success criteria:

lower prompt tokens per plan/review
measurable cached token usage
fewer timeout overruns from oversized prompts
Historical Phase 4 — Add OpenAI-aware scheduling and rate-limit control

Do not treat scheduling as “one request at a time.”

OpenAI rate limits are defined at the organization/project level, vary by model, and batch uses a separate rate-limit pool from normal per-model traffic.

Build a scheduler with:

per-model concurrency caps
token-budget queueing
RPM/TPM-aware backpressure
priority classes:
interactive
background
bulk/offline
low-priority shedding when near limits

Use:

interactive queue for user-facing synthesis and retrieval answers
background mode for long reviews
Batch API for large offline jobs like repo-wide audits, nightly review passes, and historical rechecks, since Batch has a separate pool.

Success criteria:

fewer 429s
smoother latency under load
big offline jobs no longer starve interactive traffic
Historical Phase 5 — Harden review and auto-review

This is still one of the most important repo-specific improvements.

Recommended review architecture:

review_diff becomes the canonical core
review_auto becomes router/merger only
review_git_diff becomes diff acquisition + chunking wrapper
review_changes becomes compatibility wrapper or gets retired
reactive_review_pr stays, but must use real git diffs only

Review order:

diff parsing
invariants
static analysis
structural OpenAI review
detailed OpenAI review only for risky chunks

For OpenAI outputs here:

use structured outputs for findings
stable finding IDs
confidence, severity, file, symbol, hunk metadata
merge rules for retry/resume dedupe

OpenAI documents structured outputs as a first-class pattern and supports schema-constrained generation in Responses.

Success criteria:

no placeholder diffs in production review
fewer duplicate findings
much lower review-token spend on low-risk changes
Historical Phase 6 — Speed up indexing and retrieval

This part barely changes from the original plan.

Do:

bounded-concurrency directory walking
async FS in hot paths
metadata-first unchanged detection before hashing
precompute symbol/import graph during indexing
cache file synopsis and exported symbols
rank snippets by changed-symbol relevance

This matters even with OpenAI as the brain because every retrieval and review prompt gets cheaper and faster when the non-AI side is more selective.

Success criteria:

faster warm reindex
less repeated disk I/O
smaller prompt payloads downstream
Historical Phase 7 — Tool-by-tool OpenAI-first upgrades

Highest priority tools:

index_workspace, reindex_workspace, index_status

convert to tracked jobs
progress by files/bytes/phase
cancel + retry
no untracked fire-and-forget

semantic_search

lexical-first fast path
AI synthesis optional, not mandatory
adaptive retrieval depth
hard deadlines

codebase_retrieval

return structured retrieval bundles first
separate retrieval from final OpenAI synthesis
compact mode by default

get_context_for_prompt

symbol-aware context assembly
strict budgeter
cache-friendly prompt ordering

create_plan

schema output
staged prompting
compact repo context

refine_plan

diff-only refinement input
no full-plan reserialization

review_diff

canonical review engine
deterministic passes before model
structured findings only

review_auto

router only
choose light vs deep review based on risk

reactive_review_pr

real git diff slices
background execution
resumable job ledger
webhook/job-state integration where useful
Suggested implementation order

Week 1:

packaging/build fixes
smoke tests
create OpenAIGateway skeleton

Week 2:

migrate one critical flow to Responses API
add structured outputs
add usage telemetry

Week 3:

add deadlines/cancellation
replace soft timeout behavior
add job registry

Week 4:

prompt compaction + cache-friendly prompt layout
model routing
queue/rate-limit controls

Week 5:

unify review around review_diff
fix reactive review diff source
add background/batch flows for long reviews

Week 6:

indexing/retrieval optimization
observability dashboards
final cleanup of legacy review/tool paths
Final recommendation

If OpenAI remains the brain, I would aim for this architecture:

OpenAI-only inference
Responses API as the standard
structured outputs everywhere possible
prompt-cache-aware prompt design
rate-limit-aware scheduling
background/batch for long-running jobs
open-source retrieval, parsing, static analysis, and observability around it

That gives you the fastest path to a production-quality system without wasting time on provider migration.
