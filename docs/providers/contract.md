# Provider Contract v1 (Frozen)

> Status: **Frozen** for Phase 2.5. This document captures the existing
> OpenAI/Codex provider contract before multi-provider rollout. It introduces
> no runtime behavior changes; it only fences the surface area that downstream
> adapters MUST conform to.
>
> Key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY are to be interpreted as
> defined in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## 1. Overview

The provider contract defines the boundary between Context Engine's AI
orchestration code and any concrete model backend (Codex CLI, hosted OpenAI,
self-hosted inference servers, etc.). Freezing the contract before adding new
adapters ensures that:

- The orchestrator can swap providers without bespoke knowledge of each.
- Operators get consistent error semantics, health checks, and privacy
  classifications across providers.
- New adapters can be reviewed against an objective conformance checklist.

The canonical types live in `src/ai/providers/`:

- `contract.ts` &mdash; `ProviderContractV1` and request/response shapes.
- `types.ts` &mdash; the legacy `AIProvider` shim and `AIProviderId`.
- `capabilities.ts` &mdash; `ProviderCapabilities` and `ProviderPrivacyClass`.
- `errors.ts` &mdash; `AIProviderError` and `AIProviderErrorCode`.

## 2. Identity & Versioning

Every v1 provider MUST expose:

- `contractVersion: 'v1'` &mdash; literal string, used for negotiation.
- `identity: ProviderIdentity` containing:
  - `providerId: string` &mdash; stable machine identifier (e.g. `openai_session`).
  - `backendFamily: string` &mdash; logical family (e.g. `codex`, `openai`, `ollama`).
  - `model: string` &mdash; the default model label served by this instance.
  - `transport: string` &mdash; how requests reach the backend (`subprocess`, `https`, `ipc`, ...).

Provider IDs MUST be lowercase, ASCII, and stable across restarts. Operators
rely on `providerId` for telemetry, routing, and policy gates.

## 3. Required Capabilities Matrix

A v1 provider MUST populate every required field of `ProviderCapabilities`.
Optional fields MAY be omitted when the provider has no opinion.

| Field                      | Required | Notes |
| -------------------------- | :------: | ----- |
| `supportsCancellation`     |   MUST   | `true` only when queued and in-flight work can be aborted end-to-end. Subprocess-backed providers that cannot guarantee kill-on-abort MUST set this to `false` and `privacyClass = Unsupported`. |
| `supportsStreaming`        |   MUST   | Reserved for v2; v1 providers MUST set `false`. |
| `supportsEmbeddings`       |   MUST   | Drives whether `embed()` is callable. |
| `supportsRerank`           |   MUST   | Drives whether `rerank()` is callable. |
| `maxInFlight`              |   MUST   | Upper bound the orchestrator MUST respect. |
| `maxContextTokens`         |   MUST   | Best-effort token ceiling per request. |
| `privacyClass`             |   MUST   | See section 7. |
| `requestIsolation`         |   MUST   | All three sub-flags MUST be set explicitly. |
| `connectionPool`           |    MAY   | Required when `transport` reuses sockets. |
| `circuitBreaker`           |    MAY   | Required when the orchestrator should observe breaker semantics. |
| `backpressure`             |    MAY   | One of `queue`, `reject`, `caller_managed`. Defaults to caller-managed. |

Providers MUST NOT mutate their `capabilities` object after construction.

## 4. Required Flows

| Method        | Requirement | Behavior |
| ------------- | :---------: | -------- |
| `generate()`  | MUST        | Primary text/JSON/tool-call generation. MUST honor `ProviderOperationOptions` (see section 8). MUST return a `ProviderGenerateResponse` whose `privacyClass` matches `capabilities.privacyClass`. |
| `embed()`     | MAY         | Required when `supportsEmbeddings = true`; otherwise MUST throw `ProviderCapabilityError`. |
| `rerank()`    | MAY         | Required when `supportsRerank = true`; otherwise MUST throw `ProviderCapabilityError`. |
| `health()`    | MUST        | Cheap liveness probe. MUST NOT throw; returns `{ ok, reason? }`. |
| `readiness()` | MAY         | Stricter than `health()` &mdash; verifies auth, model availability, etc. Same non-throwing contract. |
| `dispose()`   | MAY         | Releases sockets, subprocesses, file handles. MUST be idempotent. |

The legacy `AIProvider.call()` shim (see section 9) remains supported during
migration and maps onto `generate()` semantics.

## 5. Structured Error Taxonomy

All operational failures MUST be raised as `AIProviderError` (or a subclass)
with an `AIProviderErrorCode`. Callers branch on `code`, never on `message`.
The `retryable` flag is the recommended caller default and MAY be overridden
by adapters when they have stronger evidence.

| Code                      | When raised                                                             | Default retryable | Recommended caller behavior |
| ------------------------- | ----------------------------------------------------------------------- | :---------------: | --------------------------- |
| `provider_auth`           | Authentication missing, expired, or rejected by the backend.            | `false`           | Surface to operator; do not retry without re-auth. |
| `provider_timeout`        | Operation exceeded the request deadline or backend timeout.             | `true`            | Retry with backoff if budget remains; otherwise fail. |
| `provider_unavailable`    | Backend binary/endpoint not reachable or not installed.                 | `true`            | Retry with backoff; surface install/config hint after N attempts. |
| `provider_exec_error`     | Backend executed but returned a non-success exit/status.                | `true`            | Retry once; escalate with stderr summary on repeat. |
| `provider_parse_error`    | Backend response could not be parsed into the expected shape.           | `false`           | Do not retry; treat as a contract bug and surface raw output for diagnosis. |
| `provider_aborted`        | Caller aborted via `AbortSignal` or process shutdown.                   | `false`           | Propagate cancellation; do not retry. |
| `provider_capability`     | Caller invoked a method the provider does not support.                  | `false`           | Fix the call site or pick a different provider. |
| `provider_circuit_open`   | Adapter circuit breaker is open and rejecting new work.                 | `true`            | Retry after `cooldownMs`; route to fallback if available. |

Concrete subclasses are exported for ergonomics: `ProviderAuthError`,
`ProviderTimeoutError`, `ProviderAbortedError`, `ProviderCapabilityError`,
`ProviderCircuitOpenError`. Adapters MAY introduce new subclasses but MUST
reuse one of the existing `code` values.

## 6. Health & Readiness Semantics

- `health()` and `readiness()` MUST NOT throw. Failures are reported as
  `{ ok: false, reason }` so callers can poll on a fixed interval.
- `health()` SHOULD complete within ~1s and MUST be safe to call concurrently
  with in-flight `generate()`/`embed()`/`rerank()` calls.
- `readiness()` MAY perform stricter checks (auth probes, model warmup) and
  is the recommended gate for "is this provider serving traffic?" decisions.
- Neither method may consume from the user's request budget; adapters MUST
  use independent timeouts.

## 7. Privacy Class Declaration

Every successful response MUST carry a `privacyClass` field drawn from
`ProviderPrivacyClass`:

- `Local` (`'local'`) &mdash; loopback / on-device. Telemetry MAY log identity
  and health, but MUST NOT log prompts or auth material.
- `SelfHosted` (`'self-hosted'`) &mdash; operator-managed infrastructure.
  Endpoints and tenant routing MUST be treated as sensitive.
- `Hosted` (`'hosted'`) &mdash; third-party hosted service. Telemetry MUST
  assume external egress; raw prompts/completions/credentials MUST NOT be
  recorded.
- `Unsupported` (`'unsupported'`) &mdash; the adapter cannot make a privacy or
  cancellation guarantee. Such providers MUST be excluded from default
  configuration.

The `privacyClass` on each response MUST match `capabilities.privacyClass`.
Adapters MUST NOT downgrade the declared class on a per-response basis.

See `docs/providers/privacy-boundary.md` for the operational telemetry
boundary that flows from these declarations.

## 8. Operation Options

`ProviderOperationOptions` is the standard option bag for every contract
method. Adapters MUST honor each populated field:

- `signal?: AbortSignal` &mdash; cancellation source. When fired, adapters
  MUST stop work and reject with `provider_aborted`. See
  `docs/providers/cancellation.md` for the cross-provider cancellation
  contract.
- `deadlineMs?: number` &mdash; absolute wall-clock deadline (epoch ms).
  Adapters MUST treat the smaller of `deadlineMs - now()` and any
  internal/configured timeout as the effective budget.
- `requestId?: string` &mdash; opaque correlation id. Adapters SHOULD include
  it in logs and error messages.
- `tenantId?: string` &mdash; multi-tenant routing key. Adapters MUST scope
  any per-tenant state by this id and MUST NOT leak it across tenants.
- `authHeaders?: Readonly<Record<string, string>>` &mdash; per-request auth
  material. Adapters MUST NOT persist these headers beyond the request and
  MUST NOT log their values.

## 9. Backward-Compatibility Shim

The legacy `AIProvider` interface (in `src/ai/providers/types.ts`) remains
supported during migration. It exposes a smaller surface:

- `id: AIProviderId` (currently the literal `'openai_session'`)
- `modelLabel: string`
- `capabilities?: ProviderCapabilities`
- `call(request: AIProviderRequest): Promise<AIProviderResponse>`
- `health?(): Promise<ProviderHealthStatus>`

`createAIProvider({ providerId: 'openai_session', ... })` returns an
`AIProvider`. New adapters SHOULD implement `ProviderContractV1` directly;
the orchestrator will adapt them to the legacy shim where call sites still
require it. The shim is scheduled for removal once all call sites consume
`ProviderContractV1` directly.

## 10. Out of Scope for v1

The following are explicitly **not** part of the v1 contract and MUST NOT be
relied upon by callers:

- Streaming responses (token streaming, server-sent events, websockets).
- Multi-modal inputs/outputs (images, audio, video).
- Fine-tuning, training, or model management APIs.
- Provider-side caching or memoization guarantees.
- Cost reporting beyond the optional `ProviderUsage` token counts.
- Function/tool routing across multiple providers in a single call.

These are candidates for a future v2 contract and will be negotiated via
`contractVersion`.
