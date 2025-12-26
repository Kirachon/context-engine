import type { ParsedDiff } from '../../mcp/types/codeReview.js';
import type { ChangeType } from '../types.js';

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.txt']);

function isDocsPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (lower.startsWith('docs/')) return true;
  if (lower === 'readme.md' || lower.endsWith('/readme.md')) return true;
  return Array.from(DOC_EXTENSIONS).some(ext => lower.endsWith(ext));
}

function isInfraPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (lower.startsWith('.github/')) return true;
  if (lower.startsWith('scripts/')) return true;
  if (lower.startsWith('infra/')) return true;
  if (lower === 'package.json' || lower === 'package-lock.json') return true;
  if (lower === 'tsconfig.json' || lower === 'tsconfig.test.json') return true;
  if (lower === 'dockerfile' || lower.startsWith('docker/')) return true;
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return true;
  return false;
}

function isTestPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.startsWith('tests/') ||
    lower.includes('/__tests__/') ||
    lower.endsWith('.test.ts') ||
    lower.endsWith('.spec.ts') ||
    lower.endsWith('.test.js') ||
    lower.endsWith('.spec.js')
  );
}

export function classifyChange(parsedDiff: ParsedDiff): ChangeType {
  const paths = parsedDiff.files.map(f => f.new_path);
  if (paths.length === 0) return 'refactor';

  const docsCount = paths.filter(isDocsPath).length;
  if (docsCount === paths.length) return 'docs';

  const infraCount = paths.filter(isInfraPath).length;
  if (infraCount > 0 && infraCount >= Math.ceil(paths.length / 2)) return 'infra';

  const hasNewNonDocsFile = parsedDiff.files.some(f => f.is_new && !isDocsPath(f.new_path));
  if (hasNewNonDocsFile) return 'feature';

  const addedLines = parsedDiff.files
    .flatMap(f => f.hunks.flatMap(h => h.lines))
    .filter(l => l.type === 'add')
    .map(l => l.content)
    .join('\n');

  const looksLikeBugfix = /\b(fix|bug|error|null|undefined|regression|crash|leak)\b/i.test(addedLines);
  if (looksLikeBugfix) return 'bugfix';

  const onlyTests = paths.every(isTestPath);
  if (onlyTests) return 'refactor';

  const churnRatio =
    Math.min(parsedDiff.lines_added, parsedDiff.lines_removed) /
    Math.max(1, Math.max(parsedDiff.lines_added, parsedDiff.lines_removed));
  const moderateChurn = parsedDiff.lines_added + parsedDiff.lines_removed >= 20;
  if (moderateChurn && churnRatio >= 0.6) return 'refactor';

  return 'feature';
}

