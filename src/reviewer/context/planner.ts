import type { ParsedDiff, ParsedDiffFile } from '../../mcp/types/codeReview.js';
import type { PreflightResult } from '../checks/preflight.js';

export type ContextStrategy = 'focused' | 'broad';

export interface ContextPlan {
  budget: number;
  strategy: ContextStrategy;
  allocations: ContextAllocation[];
}

export interface ContextAllocation {
  file: string;
  priority: number; // 1-10
  tokenBudget: number;
  reason: string;
}

export interface ContextPlannerOptions {
  tokenBudget?: number;
  maxFiles?: number;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function estimateLinesChanged(file: ParsedDiffFile): number {
  return file.hunks.reduce((sum, h) => sum + h.lines.filter(l => l.type !== 'context').length, 0);
}

function isHotzone(filePath: string, hotspots: string[]): boolean {
  // Map known hotspot ids to rough path prefixes.
  const hotPrefixes: Record<string, RegExp> = {
    'src/mcp': /^src\/mcp\//i,
    'src/reactive': /^src\/reactive\//i,
    'src/internal': /^src\/internal\//i,
    'src/http': /^src\/http\//i,
  };

  return hotspots.some(h => hotPrefixes[h]?.test(filePath));
}

function calculatePriority(file: ParsedDiffFile, preflight: PreflightResult): { priority: number; reason: string } {
  let priority = 5;
  const reasons: string[] = [];

  const linesChanged = estimateLinesChanged(file);
  if (linesChanged > 50) {
    priority += 1;
    reasons.push('large diff chunk');
  }

  if (file.is_new) {
    priority += 2;
    reasons.push('new file');
  }

  if (file.is_deleted) {
    priority -= 1;
    reasons.push('deleted file');
  }

  if (isHotzone(file.new_path, preflight.hotspots)) {
    priority += 2;
    reasons.push('hotzone');
  }

  if (preflight.public_api_changed) {
    // We can't know per-file API impact deterministically; bias upward across changed files.
    priority += 1;
    reasons.push('possible public API change');
  }

  const clamped = clamp(priority, 1, 10);
  return { priority: clamped, reason: reasons.length > 0 ? reasons.join(', ') : 'changed file' };
}

export function createContextPlan(
  diff: ParsedDiff,
  preflight: PreflightResult,
  options: ContextPlannerOptions = {}
): ContextPlan {
  const budget = clamp(options.tokenBudget ?? 8000, 1000, 50000);
  const maxFiles = clamp(options.maxFiles ?? 5, 1, 20);

  const strategy: ContextStrategy =
    diff.files.length <= 3 && diff.lines_added + diff.lines_removed <= 200 ? 'broad' : 'focused';

  const allocations = diff.files
    .filter(f => !f.is_binary)
    .map(f => {
      const { priority, reason } = calculatePriority(f, preflight);
      return { file: f.new_path, priority, reason };
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, maxFiles);

  // Allocate budget proportional to priority.
  const totalPriority = allocations.reduce((sum, a) => sum + a.priority, 0) || 1;
  const planned: ContextAllocation[] = allocations.map(a => {
    const tokenBudget = Math.max(200, Math.floor((budget * a.priority) / totalPriority));
    return { ...a, tokenBudget };
  });

  // Ensure we don't exceed budget due to min clamps.
  const totalTokens = planned.reduce((sum, a) => sum + a.tokenBudget, 0);
  if (totalTokens > budget) {
    const scale = budget / totalTokens;
    for (const a of planned) {
      a.tokenBudget = Math.max(200, Math.floor(a.tokenBudget * scale));
    }
  }

  return { budget, strategy, allocations: planned };
}

