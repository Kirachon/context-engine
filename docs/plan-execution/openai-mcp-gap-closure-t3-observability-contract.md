# OpenAI MCP Gap Closure T3 Observability Contract

Purpose: freeze the implementation contract for observability across runtime and retrieval before `T6` adds OpenTelemetry and correlated tracing.

This document is normative for `T6`, `T9`, and `T12` work that touches `src/metrics/**`, `src/telemetry/**`, `src/http/**`, `src/mcp/server.ts`, or new `src/observability/**` files. If implementation needs behavior outside this contract, execution stops until this document is updated.

Linked execution anchors:
- Baseline bundle: [openai-mcp-gap-closure-t0-baseline.md](D:\GitProjects\context-engine\docs\plan-execution\openai-mcp-gap-closure-t0-baseline.md:1)
- Gap ledger: [openai-mcp-gap-closure-gap-ledger.md](D:\GitProjects\context-engine\docs\plan-execution\openai-mcp-gap-closure-gap-ledger.md:1)
- Ownership and gate pack: [openai-mcp-gap-closure-ownership-gate-pack.md](D:\GitProjects\context-engine\docs\plan-execution\openai-mcp-gap-closure-ownership-gate-pack.md:1)
- Plan of record: [openai-mcp-gap-closure-swarm-plan.md](D:\GitProjects\context-engine\openai-mcp-gap-closure-swarm-plan.md:83)

## Current Repo Anchors

The contract is grounded in the current repo surfaces below.

| Surface | Current anchor | Observed behavior frozen by this contract |
| --- | --- | --- |
| Request context storage | `src/telemetry/requestContext.ts` | One `AsyncLocalStorage<RequestContext>` stores `requestId`, `transport`, optional `method`, `path`, and `sessionId`. |
| HTTP request ID creation | `src/http/middleware/logging.ts` | Every HTTP request gets a server-generated UUID and `x-context-engine-request-id` response header. |
| MCP-over-HTTP session tagging | `src/http/httpServer.ts` | `/mcp` requests add `transport: 'mcp'` and current `mcp-session-id` into request context after ingress. |
| Stdio MCP logging + metrics | `src/mcp/server.ts` | Tool execution logs use `formatRequestLogPrefix()` and current Prometheus metrics record `context_engine_mcp_tool_calls_total` and `context_engine_mcp_tool_call_duration_seconds` with labels `{ tool, result }`. |
| Metrics registry | `src/metrics/metrics.ts` | One in-process registry renders Prometheus text, has a hard `maxSeries` ceiling of `5000`, and increments `context_engine_metrics_dropped_total` when the ceiling is exceeded. |
| HTTP metrics endpoint | `src/http/httpServer.ts` | `/metrics` is optional and Prometheus-text only, behind `metrics` and `http_metrics` feature flags. |
| HTTP redaction boundary | `src/http/routes/status.ts`, `src/http/middleware/errorHandler.ts` | HTTP payloads already sanitize internal downgrade reasons and hide raw 5xx error text. |
| Runtime entrypoint | `package.json` | The current Node entrypoint is `src/index.ts` via `npm start`, so startup-first observability must be anchored there. |

## Contract Summary

1. Prometheus stays the metrics system of record for server/process counters, gauges, and histograms.
2. OpenTelemetry is introduced in `T6` for tracing only, not for metrics export.
3. The existing `AsyncLocalStorage` request context stays authoritative for app-level correlation data and log prefixes.
4. OpenTelemetry context must bridge to, not replace, `src/telemetry/requestContext.ts`.
5. HTTP and MCP behavior stays additive: no telemetry change may alter response bodies, JSON-RPC payloads, route inventory, or required headers.

## Package and File Freeze

### Package additions allowed in `T6`

`package.json` currently has no OpenTelemetry dependencies. `T6` may add only the packages below for the first tracing implementation:
- `@opentelemetry/api`
- `@opentelemetry/sdk-node`
- `@opentelemetry/resources`
- `@opentelemetry/semantic-conventions`
- One trace exporter package:
  - default: `@opentelemetry/exporter-trace-otlp-http`
  - local-only alternative for smoke/debug use is allowed if clearly non-production

Packages explicitly out of scope for the first implementation:
- `@opentelemetry/auto-instrumentations-node`
- any OpenTelemetry metrics exporter
- any OpenTelemetry logs SDK/exporter

Reasoning:
- Current repo already has a Prometheus registry and `/metrics` surface.
- Official OpenTelemetry JS guidance supports `NodeSDK` startup-first initialization and makes metrics/exporters optional; this contract freezes tracing-only coexistence for the first rollout.

### File ownership freeze for implementation

`T6` must keep the implementation split below:
- New bootstrap module: `src/observability/otel.ts`
- Optional shared helpers: `src/observability/tracing.ts`, `src/observability/attributes.ts`
- Existing correlation store remains in `src/telemetry/requestContext.ts`
- HTTP ingress instrumentation lives under `src/http/middleware/`
- stdio MCP ingress instrumentation lives in `src/mcp/server.ts`
- `/mcp` HTTP session enrichment remains in `src/http/httpServer.ts`

No OpenTelemetry initialization may be added directly to:
- `src/http/httpServer.ts`
- `src/mcp/server.ts`
- `src/metrics/metrics.ts`
- leaf runtime/retrieval modules

Those modules may create spans or add attributes, but they may not initialize or shut down the SDK.

## Startup and Shutdown Contract

### Initialization location

OpenTelemetry initialization must be startup-first and centralized:
- `src/index.ts` is the only entrypoint allowed to call `startObservability()`.
- `startObservability()` must run before application/server construction begins.
- The function must be idempotent inside a single process.
- If observability is disabled, `startObservability()` must no-op cleanly and return a disabled handle.

### Shutdown ownership

Shutdown orchestration must stay centralized:
- `src/observability/otel.ts` exports `shutdownObservability()`.
- `src/index.ts` owns process-signal shutdown ordering and calls `shutdownObservability()` alongside existing server shutdown.
- Leaf modules must not register additional `process.on('SIGTERM' | 'SIGINT')` handlers for telemetry.

### Default-off behavior

The first tracing rollout is additive and disabled by default:
- No existing local workflow may require an OTLP collector.
- When tracing is disabled, current logs, metrics, routes, and MCP behavior must remain unchanged.
- When tracing is enabled but exporter setup is invalid, startup may degrade to local no-op tracing; it must not disable MCP or HTTP serving.

## Correlation and Request Identifier Flow

### Source of truth

The repo keeps two correlated but distinct context layers:
- `requestContext` in `src/telemetry/requestContext.ts` is the source of truth for `requestId`, `transport`, `method`, `path`, and `sessionId`.
- OpenTelemetry context is the source of truth for trace/span parentage.

Bridge rule:
- Every root span created by the app must copy the active `requestId` into span attributes as `context_engine.request_id`.
- The app must not derive `requestId` from `traceId`.
- The app must not replace `requestContext` reads with direct OTel context reads in existing logging code.

### HTTP `/api/v1` and `/mcp`

HTTP ingress flow is frozen as:
1. `loggingMiddleware` creates the authoritative `requestId`.
2. The response keeps `x-context-engine-request-id`.
3. A new HTTP observability middleware starts the root server span after request context exists.
4. If the request carries valid W3C `traceparent` or `tracestate`, that context may parent the root span.
5. Client-supplied request IDs are ignored; the server-generated `requestId` remains authoritative.
6. For `/mcp`, `src/http/httpServer.ts` continues to attach `transport: 'mcp'` and `sessionId` to request context after ingress.
7. `mcp-session-id` remains a transport/session header only and is never echoed into HTTP JSON bodies beyond current session-not-found errors.

### Stdio MCP

Current gap:
- `src/mcp/server.ts` logs tool execution with `formatRequestLogPrefix()` but does not create request context for stdio requests.

Frozen fix for `T6`:
- A stdio request context must be created at MCP request-handler entry, before logging or span creation.
- The stdio root context uses `transport: 'stdio'`.
- `requestId` is generated server-side for each MCP request.
- For `CallTool`, the tool name is attached as span data, not as a new `RequestContext` required field.
- For list/read/prompt requests, the MCP method name is tracked on the span and may optionally map to `RequestContext.method`.

### Session identifiers

`sessionId` handling is frozen as:
- Raw `mcp-session-id` may exist only in in-process request context and current transport logic.
- Raw `sessionId` must not become a Prometheus label.
- Raw `sessionId` must not become a default exported OTel attribute.
- If session presence matters for spans, export only bounded fields such as:
  - `context_engine.mcp.session_present=true|false`
  - `context_engine.mcp.session_phase=initialize|reuse|delete`

## Span Ownership and Naming

The first tracing implementation uses manual spans, not blanket auto-instrumentation.

### Root span owners

| Surface | Root span owner | Span name pattern |
| --- | --- | --- |
| HTTP REST | new HTTP observability middleware | `http.request` |
| HTTP MCP initialize/reuse/delete | `src/http/httpServer.ts` request handling path | `mcp.http.request` |
| Stdio MCP | `src/mcp/server.ts` request-handler wrapper | `mcp.stdio.request` |

### Child span owners

| Concern | Owner | Span name pattern |
| --- | --- | --- |
| MCP tool execution | `executeToolCallWithSignal()` path in `src/mcp/server.ts` and shared HTTP MCP tool handler path | `mcp.tool` |
| Retrieval phases | retrieval implementation modules | `retrieval.<stage>` |
| OpenAI/runtime phases | runtime modules added in `T2`/`T6` | `openai.runtime.<stage>` |

Bounded naming rule:
- Use fixed span names plus bounded attributes, not dynamic span names containing tool names, paths, prompt ids, model ids, or filenames.
- Example: use `mcp.tool` with `context_engine.tool=<tool_name>` rather than `mcp.tool.semantic_search`.

## Metrics vs Spans Boundary

### Metrics that remain in `src/metrics/metrics.ts`

The following stay in the existing Prometheus registry:
- process/runtime gauges already rendered by `renderPrometheusMetrics()`
- `context_engine_metrics_dropped_total`
- current MCP tool execution counter and duration histogram in `src/mcp/server.ts`
- future low-cardinality counters, gauges, and histograms needed for CI gates, local `/metrics`, or cheap operational checks

### Telemetry that moves to OpenTelemetry spans

The following belong in spans, not Prometheus labels:
- per-request correlation
- request parentage across HTTP or stdio
- retrieval stage timing within one request
- runtime/OpenAI stage timing within one request
- sanitized exception and retry events tied to one request

### Dual-write rule

Dual-write is allowed only for low-cardinality request or tool summaries:
- keep existing Prometheus metrics for stable counters/histograms
- add spans for per-request tracing detail

Dual-write is not allowed for:
- request IDs
- session IDs
- prompt text
- file paths
- raw errors
- large payload fragments

## Prometheus Label Contract

### Hard ceilings

The current registry hard-stops new series at `5000`. This remains frozen.

Design budgets for new metrics introduced under this contract:
- total designed steady-state series across all new observability metrics must stay under `1000`
- any single metric name must stay under `200` series in steady state
- any label set requiring unbounded IDs is rejected

### Allowed Prometheus label keys

Only the bounded keys below are allowed for new metrics unless this contract is updated:
- `tool`
- `result`
- `transport`
- `route`
- `method`
- `status_class`
- `operation`
- `backend`
- `outcome`
- `degraded`
- `execution_outcome`
- `parse_outcome`
- `consumer_outcome`

Rules for those keys:
- `route` must be a fixed route id such as `/api/v1/context`, `/api/v1/retrieval/status`, `/mcp`, or `stdio`
- `method` must stay in the small enum already implied by transports such as `GET`, `POST`, `DELETE`, or fixed MCP operation ids
- `backend` must be a bounded enum such as `sqlite`, `lancedb`, `tree_sitter`, `hash_embedding`, `transformer_embedding`, or `openai`
- `outcome` and related outcome labels must be stable enums, not free text

Prometheus label keys explicitly forbidden:
- `request_id`
- `trace_id`
- `span_id`
- `session_id`
- `plan_id`
- `user_id`
- `file_path`
- `repo_path`
- `prompt`
- `prompt_version`
- `model`
- `error`
- `error_message`
- `error_stack`

## OpenTelemetry Attribute Contract

### Allowed root-span attributes

These attributes are approved for exported spans:
- `context_engine.request_id`
- `context_engine.transport`
- `context_engine.route`
- `context_engine.tool`
- `context_engine.operation`
- `context_engine.backend`
- `context_engine.outcome`
- `context_engine.execution_outcome`
- `context_engine.parse_outcome`
- `context_engine.consumer_outcome`
- `context_engine.degraded`
- `context_engine.retry_count`
- `http.request.method`
- `http.response.status_code`

Additional rules:
- `context_engine.request_id` is allowed on root spans and directly-related error events only.
- `context_engine.tool` is allowed only where the tool name is from the bounded registered tool inventory.
- `context_engine.route` must use fixed route ids, not raw URLs.

### Forbidden exported attributes

These must not be exported as span attributes or events:
- raw `mcp-session-id`
- raw filesystem paths
- raw diff content
- raw prompt content
- raw model response text
- raw upstream error bodies
- API keys, auth headers, or connection strings
- arbitrary request body fragments

## Transport Propagation Rules

### Inbound propagation

Allowed:
- HTTP may extract W3C `traceparent` and `tracestate` to parent the root span.

Not allowed in the first rollout:
- any requirement that clients send tracing headers
- accepting client-supplied request IDs as authoritative
- any stdio propagation protocol beyond local request-context creation

### Outbound propagation

The first rollout does not add automatic downstream propagation:
- do not add `@opentelemetry/auto-instrumentations-node`
- do not rely on blanket HTTP auto-instrumentation to mutate outgoing requests
- if a later wave wants outbound propagation to OpenAI or other upstreams, it must freeze that separately

## Redaction and Error Boundary Contract

### HTTP response boundary

Existing HTTP redaction behavior remains authoritative:
- `src/http/routes/status.ts` continues to expose stable downgrade/error category codes instead of raw internals
- `src/http/middleware/errorHandler.ts` continues to suppress raw 5xx details from HTTP clients
- no telemetry rollout may add raw trace ids, exception stacks, prompt text, or local path details into HTTP bodies

### Logs vs exported telemetry

Current repo comments already distinguish between sanitized HTTP output and fuller server logs. OpenTelemetry export is stricter than stderr logs:
- exported spans/events must use stable category codes or bounded status strings
- if exceptions are recorded, they must be sanitized first
- full raw exception text and stack traces are not approved for exporter payloads by default

### Retrieval/runtime redaction floor

For retrieval and runtime instrumentation:
- emit category codes such as `runtime_unavailable`, `awaiting_retry`, `validation_failed`, or `provider_error`
- do not emit raw prompt, chunk, query, diff, file, or upstream response content
- do not emit raw model identifiers if they are user- or config-controlled and not already public/stable in the repo contract

## Additive Behavior Constraints on MCP and HTTP

Telemetry work under this contract may:
- add spans
- add internal request-context fields if optional
- add internal helper modules
- add optional exporter/env configuration
- add new stderr log lines only if they remain request-correlated and do not break stdio transport

Telemetry work under this contract may not:
- change `/api/v1` route inventory
- change `/mcp` session semantics
- change JSON-RPC payload shapes
- require new request headers from clients
- add telemetry fields to API or MCP response bodies
- replace or remove the existing Prometheus `/metrics` endpoint
- make tracing a hard startup dependency

## T6 Implementation Checklist

`T6` is conformant only if all of the following are true:
- OpenTelemetry bootstrap lives in `src/observability/otel.ts`.
- `src/index.ts` initializes tracing before app/server construction.
- shutdown is coordinated from `src/index.ts`, not from leaf modules.
- HTTP requests still emit `x-context-engine-request-id`.
- stdio MCP requests no longer log as `[request:unknown]` once inside handled request paths.
- `/metrics` still renders Prometheus text from `src/metrics/metrics.ts`.
- existing MCP tool metrics keep labels `{ tool, result }`.
- no metric label or exported span attribute contains raw session IDs, raw paths, raw prompts, or raw error text.
- HTTP error and status payloads remain sanitized.
- tracing remains default-off and additive.

## Receipt Expectations

The `telemetry_receipt` required by the ownership pack must include at least:
- `wave_id: 2` or later wave id that implements this contract
- `task_ids`
- `owner_lane: F10`
- `anchored_files`
- startup order proof showing observability initialized before app/server construction
- request-id and correlation proof for HTTP and stdio
- `/metrics` compatibility proof
- redaction proof showing sanitized exporter payloads or sanitized tracing fixtures
- explicit note that Prometheus and OTel coexist under this contract

## Decision Table

| Topic | Frozen decision |
| --- | --- |
| OTel bootstrap location | New `src/observability/otel.ts`, called only from `src/index.ts` |
| Startup ordering | Initialize before app/server construction |
| Shutdown ownership | `src/index.ts` orchestrates shutdown; leaf modules do not register signal handlers |
| Existing request context | Keep `AsyncLocalStorage` in `src/telemetry/requestContext.ts` as the app-level source of truth |
| HTTP request ID | Keep server-generated `x-context-engine-request-id`; do not trust client-supplied request ids |
| Stdio request ID | Add generated request context at MCP handler entry in `src/mcp/server.ts` |
| Session ID export | Keep raw session IDs internal only |
| Metrics system | Existing Prometheus registry remains authoritative |
| OTel scope in first rollout | Tracing only, no OTel metrics/logs |
| Instrumentation style | Manual spans, no blanket auto-instrumentation |
| Propagation | Accept inbound W3C headers on HTTP only; no stdio or downstream auto-propagation |
| Redaction boundary | Sanitized HTTP responses and sanitized exported telemetry; no raw prompt/path/error payload export |
