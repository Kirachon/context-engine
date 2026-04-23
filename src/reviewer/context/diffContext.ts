import type { ParsedDiff } from '../../mcp/types/codeReview.js';
import { runDeterministicPreflight, type PreflightResult } from '../checks/preflight.js';
import { classifyChange } from '../diff/classify.js';
import { parseUnifiedDiff } from '../diff/parse.js';
import type { ChangeType } from '../types.js';

export interface ChangedLineMap {
  files: string[];
  getChangedLines(filePath: string): number[];
  hasLine(filePath: string, line: number): boolean;
  hasRange(filePath: string, startLine: number, endLine?: number): boolean;
}

export interface ReviewDiffContext {
  parsedDiff: ParsedDiff;
  classification: ChangeType;
  preflight: PreflightResult;
  changedLineMap: ChangedLineMap;
}

function normalizeFileKey(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

export function buildChangedLineMap(parsedDiff: ParsedDiff): ChangedLineMap {
  const linesByFile = new Map<string, Set<number>>();

  for (const file of parsedDiff.files) {
    const keys = new Set<string>([normalizeFileKey(file.new_path)]);
    if (file.old_path && file.old_path !== file.new_path) {
      keys.add(normalizeFileKey(file.old_path));
    }

    for (const key of keys) {
      const existing = linesByFile.get(key) ?? new Set<number>();
      for (const line of file.changed_lines) {
        existing.add(line);
      }
      linesByFile.set(key, existing);
    }
  }

  return {
    files: Array.from(linesByFile.keys()).sort(),
    getChangedLines(filePath: string): number[] {
      return Array.from(linesByFile.get(normalizeFileKey(filePath)) ?? []).sort((a, b) => a - b);
    },
    hasLine(filePath: string, line: number): boolean {
      if (!Number.isFinite(line)) {
        return false;
      }
      return (linesByFile.get(normalizeFileKey(filePath)) ?? new Set<number>()).has(line);
    },
    hasRange(filePath: string, startLine: number, endLine?: number): boolean {
      if (!Number.isFinite(startLine)) {
        return false;
      }
      const changedLines = linesByFile.get(normalizeFileKey(filePath));
      if (!changedLines || changedLines.size === 0) {
        return false;
      }
      const upperBound = Number.isFinite(endLine) ? Math.max(startLine, endLine as number) : startLine;
      for (let line = startLine; line <= upperBound; line++) {
        if (changedLines.has(line)) {
          return true;
        }
      }
      return false;
    },
  };
}

export function createReviewDiffContext(diff: string, providedChangedFiles?: string[]): ReviewDiffContext {
  const parsedDiff = parseUnifiedDiff(diff);
  const classification = classifyChange(parsedDiff);
  const preflight = runDeterministicPreflight(parsedDiff, providedChangedFiles);
  const changedLineMap = buildChangedLineMap(parsedDiff);

  return {
    parsedDiff,
    classification,
    preflight,
    changedLineMap,
  };
}
