import { InternalSearchResult } from './types.js';

export interface DedupeOptions {
  overlapThreshold?: number;
}

function parseLineRange(lines?: string): { start: number; end: number } | null {
  if (!lines) {
    return null;
  }
  const match = lines.match(/(\d+)\s*-\s*(\d+)/);
  if (!match) {
    return null;
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return null;
  }
  return { start, end };
}

function overlapRatio(a: { start: number; end: number }, b: { start: number; end: number }): number {
  const intersection = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start) + 1);
  const lenA = a.end - a.start + 1;
  const lenB = b.end - b.start + 1;
  const minLen = Math.min(lenA, lenB);
  if (minLen <= 0) {
    return 0;
  }
  return intersection / minLen;
}

function normalizeContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

export function dedupeResults(
  results: InternalSearchResult[],
  options: DedupeOptions = {}
): InternalSearchResult[] {
  const threshold = options.overlapThreshold ?? 0.6;
  const grouped = new Map<string, InternalSearchResult[]>();

  for (const result of results) {
    const key = result.path || '';
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(result);
  }

  const deduped: InternalSearchResult[] = [];

  for (const [, group] of grouped) {
    const ordered = [...group].sort((a, b) => {
      const scoreA = a.combinedScore ?? a.relevanceScore ?? 0;
      const scoreB = b.combinedScore ?? b.relevanceScore ?? 0;
      return scoreB - scoreA;
    });

    const kept: InternalSearchResult[] = [];

    for (const candidate of ordered) {
      const candidateRange = parseLineRange(candidate.lines);
      const candidateContent = normalizeContent(candidate.content);

      const isDuplicate = kept.some(existing => {
        if (candidate.path !== existing.path) {
          return false;
        }

        const existingRange = parseLineRange(existing.lines);
        if (candidateRange && existingRange) {
          return overlapRatio(candidateRange, existingRange) >= threshold;
        }

        const existingContent = normalizeContent(existing.content);
        return candidateContent === existingContent;
      });

      if (!isDuplicate) {
        kept.push(candidate);
      }
    }

    deduped.push(...kept);
  }

  return deduped;
}
