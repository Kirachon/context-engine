import type { ParsedDiff, ReviewFinding, ReviewOptions } from '../types/codeReview.js';
import { filterByAllowedValues, filterByThreshold, limitToMax } from '../../reviewer/post/shared.js';

function normalizeFilePath(p: string): string {
  return p.replace(/^[ab]\//, '').replace(/^\.?\//, '');
}

function computeIsOnChangedLine(finding: ReviewFinding, parsedDiff: ParsedDiff): boolean | undefined {
  const filePath = typeof finding.code_location?.file_path === 'string' ? finding.code_location.file_path : '';
  const lineRange = finding.code_location?.line_range as any;
  const start = typeof lineRange?.start === 'number' ? lineRange.start : undefined;
  const end = typeof lineRange?.end === 'number' ? lineRange.end : undefined;
  if (!filePath || start === undefined || end === undefined) return undefined;

  const normalizedFile = normalizeFilePath(filePath);
  const diffFile =
    parsedDiff.files.find(f => normalizeFilePath(f.new_path) === normalizedFile) ??
    parsedDiff.files.find(f => normalizeFilePath(f.old_path) === normalizedFile);
  if (!diffFile) return undefined;

  const lo = Math.max(1, Math.min(start, end));
  const hi = Math.max(1, Math.max(start, end));
  for (let line = lo; line <= hi; line++) {
    if (diffFile.changed_lines.has(line)) return true;
  }
  return false;
}

export function postProcessReviewFindings(args: {
  findings: ReviewFinding[];
  parsedDiff: ParsedDiff;
  opts: Required<ReviewOptions>;
}): ReviewFinding[] {
  // Only backfill `is_on_changed_line` when missing/invalid to avoid changing existing outputs.
  let filtered = args.findings.map(f => {
    if (typeof (f as any).is_on_changed_line === 'boolean') return f;
    const computed = computeIsOnChangedLine(f, args.parsedDiff);
    return { ...f, is_on_changed_line: computed ?? false };
  });

  // Filter by confidence threshold
  filtered = filterByThreshold(filtered, f => f.confidence_score, args.opts.confidence_threshold);

  // Filter by changed lines if enabled
  if (args.opts.changed_lines_only) {
    filtered = filtered.filter(f => {
      // Always include P0 findings
      if (f.priority === 0) return true;
      // Include findings on changed lines
      return f.is_on_changed_line;
    });
  }

  // Filter by categories if specified
  filtered = filterByAllowedValues(filtered, f => f.category, args.opts.categories);

  // Sort by priority (lower is higher priority)
  filtered.sort((a, b) => a.priority - b.priority);

  // Limit to max findings
  filtered = limitToMax(filtered, args.opts.max_findings);

  return filtered;
}
