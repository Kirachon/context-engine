# Provider contract freeze (v1)

This directory now carries two layers:

- `AIProvider` in `types.ts`: legacy compatibility shim for the current `openai_session` path.
- `ProviderContractV1` in `contract.ts`: frozen contract for future adapters.

## Frozen v1 requirements

- Declarative `ProviderCapabilities` with cancellation, streaming, embeddings, rerank, concurrency, context-window, privacy, request-isolation, pool-limit, and circuit-breaker metadata.
- `signal?: AbortSignal` and `deadlineMs?: number` live in per-call `ProviderOperationOptions`.
- `health()` is required; `readiness()` remains available for model-specific checks.
- Typed provider errors live in `errors.ts`.

## Privacy classes

- `local`: loopback/local-machine execution only.
- `self-hosted`: operator-managed remote/self-hosted infrastructure.
- `hosted`: vendor-managed hosted service.
- `unsupported`: cannot meet the frozen privacy/cancellation guarantees and must stay out of default config.

## Migration note

The current Codex-backed `openai_session` implementation still uses the legacy `AIProvider` shim. New adapters should implement `ProviderContractV1` directly, and existing adapters must not claim cancellation unless they can propagate kill-on-abort and kill-on-shutdown end-to-end.
