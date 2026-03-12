# R6 Execution Board Model (30/60/90)

Purpose: define a deterministic, validator-ready contract for a 30/60/90 execution board with dependency state tracking, owner capacity controls, WIP caps, and governed override handling.

## 1) Contract Scope

This model is an input contract for automation (CI/local validator). A payload is valid only if it passes all rules in this document.

- Board horizons are fixed: `D30`, `D60`, `D90`.
- Dependency graph must be resolvable and acyclic.
- Capacity and WIP limits are enforced unless an explicit override exists.
- Overrides are only valid when a non-empty reason is provided.

## 2) Canonical Shape

```json
{
  "schema_version": "1.0.0",
  "board_id": "r6-execution-board",
  "generated_at": "2026-03-12T00:00:00Z",
  "owners": [
    {
      "owner_id": "owner-a",
      "display_name": "Owner A",
      "capacity_points": {
        "D30": 8,
        "D60": 8,
        "D90": 8
      }
    }
  ],
  "wip_caps": {
    "global_in_progress_max": 4,
    "per_owner_in_progress_max": 2,
    "per_horizon_in_progress_max": {
      "D30": 2,
      "D60": 2,
      "D90": 2
    }
  },
  "items": [
    {
      "item_id": "T5",
      "title": "R6 model design",
      "horizon": "D30",
      "owner_id": "owner-a",
      "state": "done",
      "estimate_points": 3,
      "depends_on": [],
      "dependency_state": "satisfied"
    }
  ],
  "overrides": [
    {
      "override_id": "ovr-001",
      "override_type": "wip_cap",
      "target_id": "T6",
      "reason": "Temporary spike due to release-window blocker and approved mitigation plan.",
      "approved_by": "eng-manager",
      "approved_at": "2026-03-12T01:00:00Z"
    }
  ]
}
```

## 3) Field Rules

### 3.1 Top-level required fields

- `schema_version`: string, exact `1.0.0`.
- `board_id`: non-empty string.
- `generated_at`: RFC3339 timestamp.
- `owners`: non-empty array.
- `wip_caps`: object.
- `items`: non-empty array.
- `overrides`: array (can be empty).

### 3.2 Owners

Each owner entry requires:

- `owner_id`: unique, non-empty string.
- `display_name`: non-empty string.
- `capacity_points`: object with integer values for `D30`, `D60`, `D90` where each value is `>= 0`.

### 3.3 WIP caps

- `global_in_progress_max`: integer `>= 1`.
- `per_owner_in_progress_max`: integer `>= 1`.
- `per_horizon_in_progress_max.D30|D60|D90`: integer `>= 1`.

### 3.4 Items

Each item entry requires:

- `item_id`: unique, non-empty string.
- `title`: non-empty string.
- `horizon`: enum `D30|D60|D90`.
- `owner_id`: must reference an existing `owners[].owner_id`.
- `state`: enum `planned|ready|in_progress|blocked|done|dropped`.
- `estimate_points`: integer `>= 0`.
- `depends_on`: array of unique `item_id` references (can be empty).
- `dependency_state`: enum `satisfied|waiting|waived`.

### 3.5 Overrides

Each override entry requires:

- `override_id`: unique, non-empty string.
- `override_type`: enum `wip_cap|capacity|dependency`.
- `target_id`: non-empty string.
- `reason`: non-empty trimmed string, minimum length `15`.
- `approved_by`: non-empty string.
- `approved_at`: RFC3339 timestamp.

## 4) Dependency State Model

`dependency_state` is validated against `depends_on`, dependency item states, and override presence.

- `satisfied`: allowed when `depends_on` is empty, or all referenced dependencies are `done`.
- `waiting`: required when at least one referenced dependency is not `done` and no dependency override applies.
- `waived`: allowed only when a matching `overrides[]` record exists where:
  - `override_type = "dependency"`
  - `target_id = item_id`
  - `reason` is present and valid

## 5) Deterministic Validation Rules (Fail Conditions)

A validator must reject payloads when any of the following are true:

1. Unknown horizon, state, dependency_state, or override_type enum value is present.
2. Duplicate IDs exist (`owner_id`, `item_id`, or `override_id`).
3. Orphan owner reference: an item references a missing `owner_id`.
4. Orphan dependency reference: `depends_on` references a non-existent `item_id`.
5. Self dependency exists (`item_id` appears in its own `depends_on`).
6. Circular dependency exists anywhere in the item dependency graph.
7. `dependency_state` conflicts with dependency completion status and override rules.
8. Any WIP/cap limit is exceeded without a matching override:
   - global `in_progress` count exceeds `global_in_progress_max`
   - per-owner `in_progress` count exceeds `per_owner_in_progress_max`
   - per-horizon `in_progress` count exceeds `per_horizon_in_progress_max[horizon]`
9. Any owner capacity is exceeded without a matching `capacity` override:
   - sum of `estimate_points` for non-`done`/non-`dropped` items owned by that owner in a horizon exceeds `capacity_points[horizon]`
10. An override exists with missing/blank/too-short `reason`.

Matching override requirements:

- WIP cap override: `override_type = "wip_cap"` and `target_id` equals the violating item `item_id`.
- Capacity override: `override_type = "capacity"` and `target_id` equals the violating owner `owner_id`.
- Dependency override: `override_type = "dependency"` and `target_id` equals the item `item_id`.

## 6) Minimal Valid Example

```json
{
  "schema_version": "1.0.0",
  "board_id": "r6-execution-board",
  "generated_at": "2026-03-12T00:00:00Z",
  "owners": [
    {
      "owner_id": "owner-a",
      "display_name": "Owner A",
      "capacity_points": { "D30": 8, "D60": 8, "D90": 8 }
    }
  ],
  "wip_caps": {
    "global_in_progress_max": 2,
    "per_owner_in_progress_max": 2,
    "per_horizon_in_progress_max": { "D30": 1, "D60": 1, "D90": 1 }
  },
  "items": [
    {
      "item_id": "T5",
      "title": "R6 model design",
      "horizon": "D30",
      "owner_id": "owner-a",
      "state": "done",
      "estimate_points": 3,
      "depends_on": [],
      "dependency_state": "satisfied"
    },
    {
      "item_id": "T6",
      "title": "R6 validator",
      "horizon": "D60",
      "owner_id": "owner-a",
      "state": "in_progress",
      "estimate_points": 3,
      "depends_on": ["T5"],
      "dependency_state": "satisfied"
    }
  ],
  "overrides": []
}
```

## 7) Invalid Examples

### 7.1 Invalid: circular dependency

```json
{
  "items": [
    { "item_id": "A", "depends_on": ["B"] },
    { "item_id": "B", "depends_on": ["A"] }
  ]
}
```

Reject reason: cycle `A -> B -> A`.

### 7.2 Invalid: orphan dependency reference

```json
{
  "items": [
    { "item_id": "A", "depends_on": ["MISSING"] }
  ]
}
```

Reject reason: `depends_on` contains unknown item `MISSING`.

### 7.3 Invalid: override missing reason

```json
{
  "items": [
    {
      "item_id": "T6",
      "owner_id": "owner-a",
      "horizon": "D30",
      "state": "in_progress",
      "estimate_points": 3,
      "depends_on": [],
      "dependency_state": "satisfied"
    }
  ],
  "overrides": [
    {
      "override_id": "ovr-001",
      "override_type": "wip_cap",
      "target_id": "T6",
      "reason": "   ",
      "approved_by": "eng-manager",
      "approved_at": "2026-03-12T01:00:00Z"
    }
  ]
}
```

Reject reason: override reason is blank/invalid.
