#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_BOARD_PATH = 'docs/templates/r6-execution-board.template.json';
const HORIZONS = new Set(['D30', 'D60', 'D90']);
const ITEM_STATES = new Set(['planned', 'ready', 'in_progress', 'blocked', 'done', 'dropped']);
const DEPENDENCY_STATES = new Set(['satisfied', 'waiting', 'waived']);
const OVERRIDE_TYPES = new Set(['wip_cap', 'capacity', 'dependency']);

type Horizon = 'D30' | 'D60' | 'D90';

interface Owner {
  owner_id: string;
  display_name: string;
  capacity_points: Record<Horizon, number>;
}

interface Item {
  item_id: string;
  title: string;
  horizon: Horizon;
  owner_id: string;
  state: string;
  estimate_points: number;
  depends_on: string[];
  dependency_state: string;
}

interface OverrideEntry {
  override_id: string;
  override_type: string;
  target_id: string;
  reason: string;
}

interface Board {
  schema_version: string;
  board_id: string;
  generated_at: string;
  owners: Owner[];
  wip_caps: {
    global_in_progress_max: number;
    per_owner_in_progress_max: number;
    per_horizon_in_progress_max: Record<Horizon, number>;
  };
  items: Item[];
  overrides: OverrideEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasValidOverrideReason(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length >= 15;
}

function resolveBoardPath(argv: string[]): string {
  const candidate = argv[2]?.trim();
  if (!candidate) {
    return path.resolve(DEFAULT_BOARD_PATH);
  }
  return path.resolve(candidate);
}

function parseBoard(content: string): Board | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    return parsed as Board;
  } catch {
    return null;
  }
}

function detectCycle(items: Item[]): string | null {
  const depsById = new Map<string, string[]>();
  for (const item of items) {
    depsById.set(item.item_id, Array.isArray(item.depends_on) ? item.depends_on : []);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const dfs = (id: string): string | null => {
    if (visiting.has(id)) {
      const cycleStart = stack.indexOf(id);
      const cyclePath = [...stack.slice(cycleStart), id];
      return cyclePath.join(' -> ');
    }
    if (visited.has(id)) {
      return null;
    }

    visiting.add(id);
    stack.push(id);
    const deps = depsById.get(id) ?? [];
    for (const dep of deps) {
      if (!depsById.has(dep)) {
        continue;
      }
      const cycle = dfs(dep);
      if (cycle) {
        return cycle;
      }
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };

  for (const item of items) {
    const cycle = dfs(item.item_id);
    if (cycle) {
      return cycle;
    }
  }
  return null;
}

function validateBoard(board: Board): string[] {
  const errors: string[] = [];

  if (board.schema_version !== '1.0.0') {
    errors.push(`schema_version must be "1.0.0", received "${String(board.schema_version)}".`);
  }
  if (!isNonEmptyString(board.board_id)) {
    errors.push('board_id must be a non-empty string.');
  }
  if (!isNonEmptyString(board.generated_at) || Number.isNaN(Date.parse(board.generated_at))) {
    errors.push('generated_at must be a valid RFC3339 timestamp.');
  }

  if (!Array.isArray(board.owners) || board.owners.length === 0) {
    errors.push('owners must be a non-empty array.');
  }
  if (!Array.isArray(board.items) || board.items.length === 0) {
    errors.push('items must be a non-empty array.');
  }
  if (!Array.isArray(board.overrides)) {
    errors.push('overrides must be an array.');
  }

  if (errors.length > 0) {
    return errors;
  }

  const ownerIds = new Set<string>();
  const itemIds = new Set<string>();

  for (const owner of board.owners) {
    if (!isNonEmptyString(owner.owner_id)) {
      errors.push('Owner entry has missing owner_id.');
      continue;
    }
    if (ownerIds.has(owner.owner_id)) {
      errors.push(`Duplicate owner_id: ${owner.owner_id}`);
    }
    ownerIds.add(owner.owner_id);
  }

  for (const item of board.items) {
    if (!isNonEmptyString(item.item_id)) {
      errors.push('Item entry has missing item_id.');
      continue;
    }
    if (itemIds.has(item.item_id)) {
      errors.push(`Duplicate item_id: ${item.item_id}`);
    }
    itemIds.add(item.item_id);

    if (!HORIZONS.has(item.horizon)) {
      errors.push(`Item ${item.item_id} has invalid horizon: ${String(item.horizon)}`);
    }
    if (!ITEM_STATES.has(item.state)) {
      errors.push(`Item ${item.item_id} has invalid state: ${String(item.state)}`);
    }
    if (!DEPENDENCY_STATES.has(item.dependency_state)) {
      errors.push(
        `Item ${item.item_id} has invalid dependency_state: ${String(item.dependency_state)}`
      );
    }
    if (!isNonEmptyString(item.owner_id)) {
      errors.push(`Item ${item.item_id} is missing owner_id.`);
    } else if (!ownerIds.has(item.owner_id)) {
      errors.push(`Item ${item.item_id} references missing owner_id: ${item.owner_id}`);
    }
    if (!Number.isInteger(item.estimate_points) || item.estimate_points < 0) {
      errors.push(`Item ${item.item_id} has invalid estimate_points (must be integer >= 0).`);
    }
    if (!Array.isArray(item.depends_on)) {
      errors.push(`Item ${item.item_id} must define depends_on as an array.`);
      continue;
    }
    if (item.depends_on.includes(item.item_id)) {
      errors.push(`Item ${item.item_id} cannot depend on itself.`);
    }
  }

  for (const item of board.items) {
    if (!Array.isArray(item.depends_on)) {
      continue;
    }
    for (const dep of item.depends_on) {
      if (!itemIds.has(dep)) {
        errors.push(`Item ${item.item_id} has orphan dependency reference: ${dep}`);
      }
    }
  }

  const dependencyOverrideTargets = new Set<string>();
  const wipOverrideTargets = new Set<string>();
  const capacityOverrideTargets = new Set<string>();
  const seenOverrideIds = new Set<string>();

  for (const [index, overrideEntry] of board.overrides.entries()) {
    if (!isRecord(overrideEntry)) {
      errors.push(`overrides[${index}] must be an object.`);
      continue;
    }
    const override = overrideEntry as OverrideEntry & { approved_by?: string; approved_at?: string };
    if (!isNonEmptyString(override.override_id)) {
      errors.push('Override entry has missing override_id.');
      continue;
    }
    if (seenOverrideIds.has(override.override_id)) {
      errors.push(`Duplicate override_id: ${override.override_id}`);
    }
    seenOverrideIds.add(override.override_id);

    if (!OVERRIDE_TYPES.has(override.override_type)) {
      errors.push(`Override ${override.override_id} has invalid override_type: ${String(override.override_type)}`);
    }
    if (!isNonEmptyString(override.target_id)) {
      errors.push(`Override ${override.override_id} is missing target_id.`);
    }
    if (!isNonEmptyString(override.approved_by)) {
      errors.push(`Override ${override.override_id} is missing approved_by.`);
    }
    if (!isNonEmptyString(override.approved_at) || Number.isNaN(Date.parse(override.approved_at))) {
      errors.push(`Override ${override.override_id} has invalid approved_at timestamp.`);
    }

    const reasonValid = hasValidOverrideReason(override.reason);
    if (
      (override.override_type === 'wip_cap' ||
        override.override_type === 'capacity' ||
        override.override_type === 'dependency') &&
      !reasonValid
    ) {
      errors.push(
        `Cap override "${override.override_id}" (${override.override_type}) must include a reason with at least 15 characters.`
      );
    }
    if (override.override_type === 'dependency' && reasonValid) {
      dependencyOverrideTargets.add(override.target_id);
    }
    if (override.override_type === 'wip_cap' && reasonValid) {
      wipOverrideTargets.add(override.target_id);
    }
    if (override.override_type === 'capacity' && reasonValid) {
      capacityOverrideTargets.add(override.target_id);
    }
  }

  const byItemId = new Map(board.items.map((item) => [item.item_id, item]));
  for (const item of board.items) {
    const dependencies = item.depends_on.map((id) => byItemId.get(id)).filter(Boolean) as Item[];
    const hasIncompleteDependency = dependencies.some((dep) => dep.state !== 'done');
    const hasDependencyOverride = dependencyOverrideTargets.has(item.item_id);

    if (item.dependency_state === 'satisfied') {
      if (dependencies.length > 0 && hasIncompleteDependency) {
        errors.push(
          `Item ${item.item_id} has invalid transition: dependency_state=satisfied while dependencies are incomplete.`
        );
      }
    } else if (item.dependency_state === 'waiting') {
      if (dependencies.length === 0 || !hasIncompleteDependency || hasDependencyOverride) {
        errors.push(
          `Item ${item.item_id} has invalid transition: dependency_state=waiting is inconsistent with dependency completion/override state.`
        );
      }
    } else if (item.dependency_state === 'waived') {
      if (dependencies.length === 0 || !hasIncompleteDependency || !hasDependencyOverride) {
        errors.push(
          `Item ${item.item_id} has invalid transition: dependency_state=waived requires incomplete dependencies and a valid dependency override.`
        );
      }
    }
  }

  const cycle = detectCycle(board.items);
  if (cycle) {
    errors.push(`Circular dependency detected: ${cycle}`);
  }

  const inProgressItems = board.items.filter((item) => item.state === 'in_progress');
  const globalCap = board.wip_caps?.global_in_progress_max;
  if (typeof globalCap === 'number' && Number.isInteger(globalCap) && globalCap >= 1) {
    const nonOverridden = inProgressItems.filter((item) => !wipOverrideTargets.has(item.item_id));
    if (nonOverridden.length > globalCap) {
      errors.push(
        `Global in-progress cap exceeded: non-overridden items=${nonOverridden.length}, cap=${globalCap}.`
      );
    }
  } else {
    errors.push('wip_caps.global_in_progress_max must be an integer >= 1.');
  }

  const perOwnerCap = board.wip_caps?.per_owner_in_progress_max;
  if (typeof perOwnerCap === 'number' && Number.isInteger(perOwnerCap) && perOwnerCap >= 1) {
    const ownerInProgress = new Map<string, Item[]>();
    for (const item of inProgressItems) {
      const list = ownerInProgress.get(item.owner_id) ?? [];
      list.push(item);
      ownerInProgress.set(item.owner_id, list);
    }
    for (const [ownerId, items] of ownerInProgress) {
      const nonOverridden = items.filter((item) => !wipOverrideTargets.has(item.item_id));
      if (nonOverridden.length > perOwnerCap) {
        errors.push(
          `Per-owner in-progress cap exceeded for ${ownerId}: non-overridden items=${nonOverridden.length}, cap=${perOwnerCap}.`
        );
      }
    }
  } else {
    errors.push('wip_caps.per_owner_in_progress_max must be an integer >= 1.');
  }

  const perHorizonCap = board.wip_caps?.per_horizon_in_progress_max;
  if (!isRecord(perHorizonCap)) {
    errors.push('wip_caps.per_horizon_in_progress_max must be an object with D30/D60/D90 keys.');
  } else {
    const horizonInProgress = new Map<string, Item[]>();
    for (const item of inProgressItems) {
      const list = horizonInProgress.get(item.horizon) ?? [];
      list.push(item);
      horizonInProgress.set(item.horizon, list);
    }
    for (const horizon of HORIZONS) {
      const cap = perHorizonCap[horizon];
      if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1) {
        errors.push(`wip_caps.per_horizon_in_progress_max.${horizon} must be an integer >= 1.`);
        continue;
      }
      const items = horizonInProgress.get(horizon) ?? [];
      const nonOverridden = items.filter((item) => !wipOverrideTargets.has(item.item_id));
      if (nonOverridden.length > cap) {
        errors.push(
          `${horizon} in-progress cap exceeded: non-overridden items=${nonOverridden.length}, cap=${cap}.`
        );
      }
    }
  }

  for (const owner of board.owners) {
    const ownerCapacity = owner.capacity_points;
    for (const horizon of HORIZONS) {
      const cap = ownerCapacity?.[horizon];
      if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 0) {
        errors.push(`Owner ${owner.owner_id} has invalid capacity_points.${horizon}.`);
        continue;
      }
      const points = board.items
        .filter(
          (item) =>
            item.owner_id === owner.owner_id &&
            item.horizon === horizon &&
            item.state !== 'done' &&
            item.state !== 'dropped'
        )
        .reduce((sum, item) => sum + item.estimate_points, 0);
      if (points > cap && !capacityOverrideTargets.has(owner.owner_id)) {
        errors.push(
          `Owner ${owner.owner_id} exceeds capacity_points.${horizon} without valid capacity override reason.`
        );
      }
    }
  }

  return errors;
}

function main(): void {
  const boardPath = resolveBoardPath(process.argv);
  if (!fs.existsSync(boardPath)) {
    // eslint-disable-next-line no-console
    console.error(`Board file not found: ${boardPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(boardPath, 'utf8');
  const board = parseBoard(content);
  if (!board) {
    // eslint-disable-next-line no-console
    console.error('Invalid JSON payload for R6 execution board.');
    process.exit(1);
  }

  const errors = validateBoard(board);
  // eslint-disable-next-line no-console
  console.log('R6 execution board validation');
  // eslint-disable-next-line no-console
  console.log(`Board: ${boardPath}`);
  // eslint-disable-next-line no-console
  console.log(`Items: ${board.items.length}; Owners: ${board.owners.length}; Overrides: ${board.overrides.length}`);

  if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error('Validation errors:');
    for (const error of errors) {
      // eslint-disable-next-line no-console
      console.error(`- ${error}`);
    }
    // eslint-disable-next-line no-console
    console.error('R6 execution board validation failed.');
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log('R6 execution board validation passed.');
  process.exit(0);
}

main();
