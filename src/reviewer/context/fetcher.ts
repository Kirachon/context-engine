import type { ParsedDiff } from '../../mcp/types/codeReview.js';
import type { ContextPlan } from './planner.js';

export interface ContextFetcherOptions {
  contextLines?: number;
  maxCharsPerFile?: number;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function toMaxChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n...';
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = ranges
    .slice()
    .sort((a, b) => a.start - b.start)
    .filter(r => r.start <= r.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (!last || r.start > last.end + 1) {
      merged.push({ start: r.start, end: r.end });
    } else {
      last.end = Math.max(last.end, r.end);
    }
  }
  return merged;
}

function formatSection(filePath: string, start: number, end: number, lines: string[]): string {
  const out: string[] = [];
  out.push(`Path: ${filePath}`);
  out.push(`Lines ${start}-${end}`);
  for (let i = start; i <= end; i++) {
    const line = lines[i - 1] ?? '';
    out.push(`${String(i).padStart(5, ' ')}  ${line}`);
  }
  return out.join('\n');
}

export async function fetchPlannedContext(
  diff: ParsedDiff,
  plan: ContextPlan,
  readFile: (filePath: string) => Promise<string>,
  options: ContextFetcherOptions = {}
): Promise<string> {
  const contextLines = clamp(options.contextLines ?? 20, 0, 200);
  const maxCharsPerFile = clamp(options.maxCharsPerFile ?? 20000, 1000, 200000);

  const blocks: string[] = [];
  for (const allocation of plan.allocations) {
    const file = diff.files.find(f => f.new_path === allocation.file);
    if (!file) continue;

    let content: string;
    try {
      content = await readFile(allocation.file);
    } catch {
      continue;
    }

    const allLines = content.split('\n');
    const changed = Array.from(file.changed_lines.values()).sort((a, b) => a - b);
    if (changed.length === 0) {
      const basic = toMaxChars(content, maxCharsPerFile);
      blocks.push(`Path: ${allocation.file}\nLines 1-${Math.min(allLines.length, 200)}\n${basic}`);
      continue;
    }

    const ranges = changed.map(line => ({
      start: Math.max(1, line - contextLines),
      end: Math.min(allLines.length, line + contextLines),
    }));
    const merged = mergeRanges(ranges);

    const perFileBlocks: string[] = [];
    for (const r of merged) {
      perFileBlocks.push(formatSection(allocation.file, r.start, r.end, allLines));
    }

    blocks.push(toMaxChars(perFileBlocks.join('\n\n'), maxCharsPerFile));
  }

  return blocks.join('\n\n---\n\n');
}

