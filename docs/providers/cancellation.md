# Provider Cancellation & Timeout Contract

This document captures the cancellation, deadline, subprocess-lifecycle and
health semantics that every Context Engine AI provider adapter MUST honor. It
is the regression fence for the OpenAI/Codex hardening shipped in commit
`393c9ba`.

For the broader provider contract (capabilities, identity, response shape) see
[`./contract.md`](./contract.md). For privacy/payload boundaries see
[`./privacy-boundary.md`](./privacy-boundary.md).

The keywords MUST, SHOULD, and MAY are used per RFC 2119.

## Overview

Every provider call is bounded along two independent axes:

1. **User cancellation** — an `AbortSignal` the caller MAY pass via
   `ProviderOperationOptions.signal` (contract v1) or `AIProviderRequest.signal`
   (legacy `openai_session` shape).
2. **SLO deadline** — a wall-clock cutoff the caller MAY pass via
   `deadlineMs` (epoch ms). When omitted, callers fall back to the per-request
   `timeoutMs`.

Providers MUST observe both, MUST surface failure as a typed
`AIProviderError`, and MUST NOT leak subprocesses, file handles, or
intermediate temp directories on either failure path.

## AbortSignal contract

- Callers MAY pass `signal` on every operation (`generate`, `embed`,
  `rerank`, `health`, `readiness`, `call`).
- Providers MUST observe an already-aborted signal at entry and reject
  before doing any work.
- Providers MUST observe an abort that fires mid-flight and reject with a
  `ProviderAbortedError` (i.e. an `AIProviderError` whose `code === 'provider_aborted'`).
- The rejection error SHOULD set `retryable = false`. A user-initiated cancel
  is not a transient infrastructure fault and SHOULD NOT be auto-retried.
- A provider MUST NOT translate an abort into `provider_timeout`,
  `provider_unavailable`, or any other code; the cause must remain
  attributable to the caller.

## deadlineMs contract

- `deadlineMs` is an **end-to-end** budget. It includes queue wait,
  readiness/auth probes, subprocess spawn, stdin pump, and stdout drain.
- Providers MUST compute the remaining budget as
  `deadlineMs - Date.now()` immediately before each subprocess invocation
  and pass that remainder as the subprocess time budget. They MUST NOT pass
  the original per-request `timeoutMs` after time has already elapsed in a
  queue or readiness phase.
- If the remaining budget is `<= 0` (or non-finite) before work starts,
  providers MUST reject with a `ProviderTimeoutError`
  (`code === 'provider_timeout'`) without spawning a subprocess.
- If the budget expires during execution, providers MUST terminate the
  subprocess and reject with a `ProviderTimeoutError`. The error SHOULD set
  `retryable = true` because deadline expiry is typically caller-tunable
  rather than a hard provider failure.
- When both `deadlineMs` and `timeoutMs` are supplied, `deadlineMs` wins for
  any phase that runs after the request enters the provider; `timeoutMs`
  serves as the fallback when `deadlineMs` is absent.

## Subprocess lifecycle

- Any spawned subprocess (e.g. `codex login status`, `codex exec`, npx
  shims, Windows `cmd /d /s /c <wrapper>.cmd` invocations) MUST be terminated
  on abort or deadline expiry.
- On Windows the provider MUST use `taskkill /PID <pid> /T /F` (or
  equivalent process-tree termination) so detached child processes spawned
  by `cmd.exe` wrappers do not become orphans.
- Providers MUST NOT leave temp directories behind after a failed call; the
  `finally` cleanup path MUST run on success, error, abort, and timeout
  alike.
- Providers MUST tolerate Windows process trees that survive a kill: after a
  bounded grace period the call MUST settle with an error rather than hang
  indefinitely.

## Health vs cancellation

- `health()` (and `readiness()` when implemented) MUST NOT throw. It MUST
  always resolve with `{ ok: boolean, reason?: string }`.
- An unreachable CLI, missing executable, auth failure, or readiness timeout
  MUST be reported as `{ ok: false, reason: '<human-readable>' }`, not a
  rejection.
- `health()` MAY accept `signal` / `deadlineMs`. If the caller cancels or
  the deadline expires, `health()` SHOULD still resolve with
  `ok: false` and a reason explaining the cancellation, rather than
  reject.

## Caller guidance

- Pass **both** `signal` (for explicit user cancellation, e.g. an MCP
  client closing the request) and `deadlineMs` (for SLO/budget enforcement).
  They compose: whichever fires first wins.
- Set `deadlineMs = Date.now() + budgetMs` once at the top of a multi-phase
  pipeline so that downstream phases inherit the same wall-clock budget.
- Treat `provider_aborted` as terminal for the affected request; do not
  auto-retry. Treat `provider_timeout` as retryable only with a fresh, larger
  budget.
- Do not confuse `provider_circuit_open` (provider self-protection) with
  `provider_aborted` (caller-initiated) or `provider_timeout` (budget
  exhausted) — each has distinct caller semantics.

## Error code reference

| Class                      | `code` value         | Retryable default |
|----------------------------|----------------------|-------------------|
| `ProviderAbortedError`     | `provider_aborted`   | `false`           |
| `ProviderTimeoutError`     | `provider_timeout`   | `true`            |
| `ProviderCircuitOpenError` | `provider_circuit_open` | `true`         |
| `ProviderAuthError`        | `provider_auth`      | `false`           |
| `ProviderCapabilityError`  | `provider_capability` | `false`          |

Source of truth: `src/ai/providers/errors.ts`.
