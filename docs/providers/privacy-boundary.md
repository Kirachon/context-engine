# Provider Privacy & Network Egress Boundary

> Frozen-contract companion to [`./contract.md`](./contract.md) and
> [`./cancellation.md`](./cancellation.md). This document describes what is
> guaranteed to stay on the operator's machine and what is allowed to leave it.
> No runtime behavior is changed by this document; it captures the boundary as
> it exists today so that future adapters and callers can reason about it.

## 1. Overview

Context Engine is **local-by-default**. The indexing pipeline, lexical/dense
retrieval, symbol navigation, MCP tool dispatch, and the HTTP `/api/v1`
retrieval surface all execute against on-disk artifacts and loopback IPC. The
*only* component that initiates outbound traffic to a third party is the AI
provider adapter, and even there the egress is performed by a spawned
subprocess (the Codex CLI), not by direct in-process HTTP from this codebase.

The single in-process exception is the optional `external_sources` grounding
helper, which fetches operator-supplied URLs. It is documented under
[§5](#5-known-egress-points-allow-listed) and is gated by explicit caller
input.

Use the keywords MUST, SHOULD, and MAY per RFC 2119.

## 2. Local-by-default surfaces

The following surfaces MUST NOT initiate any external network egress:

| Surface | Source paths |
|---|---|
| Workspace indexing (chunking, dense, lexical, fusion, rerank) | `src/internal/retrieval/**`, `src/retrieval/**` |
| Symbol navigation, code search | `src/internal/retrieval/**`, `src/retrieval/**` |
| MCP server, tool dispatch, prompts | `src/mcp/**` (except [§5](#5-known-egress-points-allow-listed)) |
| HTTP API | `src/http/**` |
| Watchers, workers, telemetry sinks | `src/watcher/**`, `src/worker/**`, `src/telemetry/**` |
| Reviewer + reactive guardrails (analysis) | `src/reviewer/**`, `src/reactive/**` |

These modules MUST resolve all data from the local filesystem, in-process
SQLite/LanceDB stores, or from the AI provider via the contract surface — they
MUST NOT call `fetch`, `http.request`, `https.request`, or pull in
third-party HTTP clients (`axios`, `node-fetch`, `undici`, etc.).

The static-analysis test
[`tests/ai/contract/privacyBoundary.test.ts`](../../tests/ai/contract/privacyBoundary.test.ts)
fences this invariant by scanning the source tree and failing on unexpected
egress.

## 3. Provider egress boundary

External traffic that originates from an AI call follows this path:

```
caller -> AIProvider.call() / ProviderContractV1.generate()
       -> CodexSessionProvider (src/ai/providers/codexSessionProvider.ts)
       -> child_process.spawn('codex', ...)            <-- process boundary
              `-> Codex CLI subprocess opens its own TLS session to OpenAI
```

Implications:

- The Context Engine process itself MUST NOT open sockets to OpenAI or any
  hosted model endpoint. All such traffic is owned by the spawned Codex CLI
  binary, which is a separately-installed user tool.
- Operators who need to forbid egress can do so at the OS / network policy
  layer by blocking the `codex` binary, **or** by leaving `CE_AI_PROVIDER`
  unset in an environment where `codex` is not installed (the provider will
  then fail health checks and refuse to serve `searchAndAsk`).
- Setting `CONTEXT_ENGINE_OFFLINE_ONLY=1` rejects `CE_AI_PROVIDER=openai_session`
  outright and disables background indexing-time network access (see
  `src/mcp/serviceClient.ts`).

## 4. Privacy class semantics

Every response from the frozen contract carries a
[`ProviderPrivacyClass`](../../src/ai/providers/capabilities.ts) value. The
enum mirrors `src/ai/providers/capabilities.ts` exactly:

| Value | Meaning | Logging guidance |
|---|---|---|
| `Local` (`local`) | Requests stay on the local machine or loopback boundary. | Telemetry MAY log provider identity and health, but MUST NOT log prompt bodies or auth material. |
| `SelfHosted` (`self-hosted`) | Requests stay on operator-managed infrastructure. | Telemetry/logs MUST treat endpoints, tenant routing, and auth details as sensitive. |
| `Hosted` (`hosted`) | Requests MAY leave the operator-controlled environment. | Telemetry/logs MUST assume external egress and MUST NEVER record raw prompts, completions, or credentials. |
| `Unsupported` (`unsupported`) | Privacy or cancellation guarantees cannot be made. | Adapter MUST be excluded from default configuration until it satisfies the frozen contract. |

A response's `privacyClass` is the canonical signal that downstream
telemetry/log sinks SHOULD branch on. Sinks SHOULD default to the strictest
treatment (`Hosted` rules) when the field is missing.

## 5. Known egress points (allow-listed)

The following in-process egress points are intentional and are explicitly
allow-listed by the static-analysis test:

| File | Egress | Trigger | Notes |
|---|---|---|---|
| `src/mcp/tooling/externalGrounding.ts` | `fetch(url, …)` (line ~352) | Caller passes `external_sources: [{ type: 'github_url' \| 'docs_url', url }]` to `enhance_prompt` / `get_context_for_prompt` / `codebase-retrieval`. | DNS lookup is performed up-front, redirects are followed manually with re-validation, response size and excerpt length are capped. The handler emits `GroundingSourceStatus` so callers can observe what was fetched. |

No other module under `src/` MAY introduce a new egress point without
adding a corresponding allow-list entry to both this section and to
`tests/ai/contract/privacyBoundary.test.ts`.

## 6. Secret-scrubbing entry points

Secrets MUST be redacted before any payload crosses the local boundary
(spawned subprocess stdin, external fetch body, or future hosted transport).
The canonical scrubber lives in
`src/reactive/guardrails/secretScrubber.ts` and is exposed via:

- `scrubSecrets(content)` — used by `src/reviewer/reviewDiff.ts` to scrub
  diff/context/invariants before they are concatenated into a provider
  prompt.
- `ValidationPipeline` (`src/reactive/validation/pipeline.ts`) — defaults
  `scrubSecrets: true` so finding payloads run through the scrubber on the
  outbound path.
- The MCP `scrub_secrets` tool (`src/mcp/tools/reactiveReview.ts`) — exposes
  the scrubber to callers that want to preflight content themselves.

New code paths that compose provider prompts SHOULD route untrusted text
through `scrubSecrets()` before handing it to the provider.

## 7. What is NOT guaranteed

- **User-supplied prompt bodies.** Callers retain responsibility for the
  contents of `prompt` / `searchQuery` they hand to the provider. The
  scrubber covers structured findings and review payloads, but a free-form
  prompt that the caller assembles is forwarded to the Codex CLI as-is.
- **`external_sources` URL contents.** The grounding helper fetches whatever
  URL it is given; redirect targets, DNS rebinding, and response payloads
  are validated for shape but the operator decides what URLs to allow.
- **Codex CLI behavior.** Once data crosses into the spawned `codex`
  subprocess, this codebase no longer controls it. Operators who need a
  hard guarantee MUST sandbox the subprocess (network policy, container,
  separate user) themselves.
- **Telemetry sinks.** The contract advertises `privacyClass`, but it does
  not enforce the destination of any sink the operator wires up.

## 8. Operator controls

| Variable / control | Effect |
|---|---|
| `CE_AI_PROVIDER` | Selects the AI provider. Only `openai_session` (default) is accepted by `src/ai/providers/factory.ts`; any other value throws. Leaving it unset *and* not invoking AI tools keeps the process fully local. |
| `CE_OPENAI_SESSION_CMD` | Overrides the Codex CLI command (default `codex`). Operators can point at a wrapper that adds network policy. |
| `CE_OPENAI_SESSION_ARGS_JSON`, `CE_OPENAI_SESSION_EXEC_ARGS_JSON` | JSON arrays of additional CLI args; allow operators to pin auth profiles or proxy flags. |
| `CE_OPENAI_SESSION_REFRESH_MODE` | Identity refresh mode (`per_call` | `ttl`). |
| `CONTEXT_ENGINE_OFFLINE_ONLY` | When set, rejects `CE_AI_PROVIDER=openai_session` and disables background indexing network access. |
| `CE_RETRIEVAL_PROVIDER` | Retrieval provider preference (`local_native` is the only supported value). |
| OS-level network policy on the `codex` binary | Hard egress gate; recommended for regulated environments. |

## 9. Cross-references

- [`./contract.md`](./contract.md) — frozen v1 provider contract surface.
- [`./cancellation.md`](./cancellation.md) — cancellation invariants for
  spawned-process providers.
- [`../../src/ai/providers/capabilities.ts`](../../src/ai/providers/capabilities.ts)
  — authoritative `ProviderPrivacyClass` enum.
- [`../../tests/ai/contract/privacyBoundary.test.ts`](../../tests/ai/contract/privacyBoundary.test.ts)
  — static-analysis fence for the invariants above.
