# Memory Operations Runbook

Purpose: keep Codex memory useful, clean, and safe over time.

Primary memory path (Windows):
- `C:\Users\preda\.codex\memories`

Use this runbook to avoid memory bloat, stale notes, and repeated mistakes.

Quick start:
1. Use `docs/templates/memory-entry.template.md` for new durable notes.
2. Use `docs/templates/memory-health-check.template.md` monthly and before release.
3. Keep entry tags consistent (`critical`, `helpful`, `archive`).

## 1) Memory Quality Checklist

Save to memory only if it is durable and reusable.

Save:
- Decisions that affect future work (why we chose option A over B).
- Stable commands/workflows that repeatedly unblock delivery.
- Known failure patterns and proven fixes.
- User/team preferences that affect output style or rollout process.

Do not save:
- Temporary logs, one-off errors, or noisy debug output.
- Secrets, tokens, passwords, connection strings, private keys.
- Personal/sensitive data.
- Information that is likely to expire quickly unless you mark it as time-bound.

Required fields for each memory entry:
- `What`: short statement of the fact/decision.
- `Why`: reason this matters.
- `When`: date added or updated.
- `Evidence`: file/command/source reference.
- `Owner`: who should maintain it.

Optional structured metadata (recommended):
- `subtype`: finer label such as `review_finding`, `failed_attempt`, `incident`, `plan_note`.
- `priority`: `critical`, `helpful`, or `archive`.
- `tags`: short retrieval tags.
- `linked_files`, `linked_plans`, `source`: references used by ranking and traceability.

Recommended optional metadata in `add_memory`:
- `priority`: `critical`, `helpful`, or `archive`.
- `subtype`: finer category like `review_finding`, `failed_attempt`, `incident`, `plan_note`.
- `tags`: short labels for grouping.
- `linked_files` and `linked_plans`: traceability references.
- `source`: where the memory came from.

## 2) Priority Tags

Use tags to make retrieval and cleanup easier.

- `critical`: must be accurate for release safety or production decisions.
- `helpful`: useful accelerators for normal delivery.
- `archive`: old context kept for history, not for default guidance.

Tagging rules:
- Every new memory entry gets exactly one priority tag.
- If a `critical` entry is stale, update or demote it in the same cycle.
- Move inactive items to `archive` instead of deleting immediately.
- Keep critical decisions concise because startup memory packs prioritize these entries.

## 3) Monthly Cleanup Routine

Run once per month (or before major release).

Checklist:
- Review `critical` entries first.
- Remove duplicates and merge overlapping entries.
- Update stale paths, commands, or versions.
- Move low-value old notes to `archive`.
- Delete entries that are no longer true and have no historical value.

Success criteria:
- No stale `critical` items.
- No duplicate entries for the same decision.
- Memory remains short enough to scan quickly.

## 4) Release Memory Health Check

Run this before release sign-off.

Checklist:
- Confirm all rollout-critical memories are still correct.
- Verify references in memory still map to existing files/commands.
- Ensure no sensitive data exists in memory content.
- Confirm recent major decisions are captured.
- Record a short pass/fail note in release evidence.

Pass template:
- `Memory health: PASS`
- `Critical checked: <count>`
- `Stale fixed: <count>`
- `Archived: <count>`
- `Removed: <count>`
- `Reviewer: <name/date>`

Fail conditions:
- Any stale `critical` memory unresolved.
- Any secret/sensitive data found in memory.
- Missing memory for a release-blocking decision.

## 5) Suggested Lightweight Workflow

For each major task:
1. Read relevant memory.
2. Implement and validate work.
3. Update memory with new durable findings.
4. Mark stale entries corrected or archived.

This keeps memory reliable without adding heavy process overhead.
