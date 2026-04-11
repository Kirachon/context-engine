# Vibe-Coder Memory Review Contract

This document defines the user-facing review workflow for draft memory suggestions in the
vibe-coder memory mode. It is a contract for future implementation work, not authorization to
ship runtime behavior by itself.

## Purpose

The review flow must help a low-ceremony user keep useful long-term memory without turning
memory capture into a chore. The default posture is quiet, bounded, and reversible before
promotion.

## Core Review Rules

### Quiet Mode by Default

- The reviewer stays in quiet mode by default.
- The system must not interrupt an active edit, debug, or command loop with a modal prompt.
- Pending draft suggestions may be indicated passively, but they must not force immediate review.

### Checkpoint Policy

Draft suggestions may only surface at closure or idle checkpoints:

- end of task
- end of review
- end of plan
- end of session
- explicit user-opened review panel during an otherwise idle moment

The system must not surface a batch in the middle of an active implementation loop.

### Batch Cap

- A surfaced batch must contain at least `1` and at most `5` suggestions.
- The product target is a practical range of `3-5` suggestions, but `5` is the hard cap.
- Overflow suggestions stay queued for a later checkpoint rather than expanding the current batch.

### Explainability Line

Every surfaced suggestion must include a one-line explanation of why it was suggested.

Minimum explainability fields:

- short summary of the suggested memory
- why it was detected
- source or evidence reference

The explanation must be visible before promotion so the user can judge whether the suggestion is
stable and worth keeping.

## Review Actions

The review surface must support the following actions:

- `save`
- `dismiss`
- `inspect`
- `snooze`
- `save all high-confidence`
- `dismiss all`
- `never suggest like this`
- `undo last batch`

### Action Semantics

#### Save

- Approves the current draft for promotion through the existing durable memory path.
- A saved suggestion is not durable until promotion succeeds.

#### Dismiss

- Rejects the current draft without creating durable memory.
- A dismissed suggestion may still inform aggregate quality metrics, but it must not enter default
  retrieval.

#### Inspect

- Opens the suggestion for richer review before promotion.
- Inspect mode is where edit, conflict resolution, and evidence review occur.

#### Snooze

- Defers the draft to a later checkpoint without dismissing it.
- Snoozed drafts remain non-durable and out of default retrieval.

#### Save All High-Confidence

- Bulk-promotes only the visible high-confidence suggestions that also pass the same safety and
  contradiction checks as single-item save.
- Bulk save must not bypass per-item safety rules.

#### Dismiss All

- Rejects all visible drafts in the surfaced batch.
- This action does not create durable suppression rules by itself.

#### Never Suggest Like This

- Creates a durable suppression rule so the same normalized pattern is not suggested again.
- Suppression rules must survive later sessions.
- Suppression applies to future suggestions, not to already approved durable memories.

#### Undo Last Batch

- In Phase 1, `undo last batch` is pre-promotion only.
- It may reverse the review decisions for the most recent surfaced batch only while no durable
  promotion has happened yet.
- It must not imply rollback of already promoted durable memories.

## Suppression Contract

Durable suppression exists to reduce repeated nuisance suggestions without deleting approved memory.

Required behavior:

- suppression is created only through `never suggest like this`
- suppression persists across sessions
- suppression targets normalized repeat patterns rather than exact text only
- suppression prevents future suggestions from resurfacing the same pattern
- suppression does not silently delete or rewrite existing approved memories

## Non-Goals for This Contract

- This contract does not define auto-save behavior.
- This contract does not authorize draft retrieval in default context assembly.
- This contract does not create a second durable memory write path.
- This contract does not define storage format or feature flags; those belong to separate tasks.
