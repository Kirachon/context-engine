import {
  getCommitDiff,
  getGitDiff,
  getGitStatus,
  type GitDiffResult,
  type GitDiffStats,
} from '../utils/gitUtils.js';

export type ReviewDiffScopeEmptyReason = 'no_changes_for_target' | 'path_scope_excluded_all_changes';

export interface ReviewDiffSource {
  diff: string;
  changed_files: string[];
  stats: GitDiffStats;
  command: string;
  target: string;
  base?: string;
  scope_empty_reason?: ReviewDiffScopeEmptyReason;
}

export interface ReviewDiffSourceRequest {
  workspacePath: string;
  target?: string;
  base?: string;
  include_patterns?: string[];
  contextLines?: number;
}

function looksLikeCommitHash(target: string): boolean {
  return /^[a-f0-9]{7,40}$/i.test(target);
}

function normalizePatterns(patterns: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (patterns ?? [])
        .filter((pattern): pattern is string => typeof pattern === 'string')
        .map((pattern) => pattern.trim())
        .filter((pattern) => pattern.length > 0)
    )
  );
}

function normalizeDiffResult(result: GitDiffResult): GitDiffResult {
  return {
    ...result,
    diff: result.diff.replace(/\r\n/g, '\n'),
    files_changed: Array.from(new Set(result.files_changed)).sort((a, b) => a.localeCompare(b)),
  };
}

function countDiffStats(diff: string): GitDiffStats {
  const lines = diff.split('\n');
  let additions = 0;
  let deletions = 0;

  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      additions += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions += 1;
    }
  }

  const filesCount = (diff.match(/^diff --git a\/.+? b\/.+?$/gm) ?? []).length;
  return {
    additions,
    deletions,
    files_count: filesCount,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function convertGitPathPatternToRegex(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/');
  const segments = normalized.split('/').map((segment) => {
    if (segment === '**') {
      return '.*';
    }
    let out = '';
    for (let index = 0; index < segment.length; index += 1) {
      const char = segment[index];
      if (char === '*') {
        out += '[^/]*';
      } else if (char === '?') {
        out += '[^/]';
      } else {
        out += escapeRegex(char);
      }
    }
    return out;
  });

  return new RegExp(`^${segments.join('/')}$`);
}

function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  return patterns.some((pattern) => convertGitPathPatternToRegex(pattern).test(normalizedPath));
}

function filterDiffByPatterns(result: GitDiffResult, patterns: string[]): GitDiffResult {
  if (patterns.length === 0) {
    return result;
  }

  const lines = result.diff.replace(/\r\n/g, '\n').split('\n');
  const keptLines: string[] = [];
  const keptFiles = new Set<string>();
  let currentBlock: string[] = [];
  let currentFile: string | null = null;

  const flushBlock = (): void => {
    if (currentBlock.length === 0 || !currentFile) {
      currentBlock = [];
      currentFile = null;
      return;
    }

    if (matchesAnyPattern(currentFile, patterns)) {
      keptLines.push(...currentBlock);
      keptFiles.add(currentFile);
    }

    currentBlock = [];
    currentFile = null;
  };

  for (const line of lines) {
    const match = /^diff --git a\/(.+?) b\/(.+?)$/.exec(line);
    if (match) {
      flushBlock();
      currentFile = match[2];
      currentBlock = [line];
      continue;
    }

    if (currentBlock.length > 0) {
      currentBlock.push(line);
    }
  }

  flushBlock();

  const diff = keptLines.join('\n').trim();
  return {
    diff: diff ? `${diff}\n` : '',
    files_changed: Array.from(keptFiles),
    stats: countDiffStats(diff),
    command: result.command,
  };
}

export async function getReviewDiffSource(request: ReviewDiffSourceRequest): Promise<ReviewDiffSource> {
  const { workspacePath, target = 'staged', base, include_patterns, contextLines } = request;
  const normalizedPatterns = normalizePatterns(include_patterns);
  const status = await getGitStatus(workspacePath);
  if (!status.is_git_repo) {
    throw new Error('Not a git repository. Please run this tool from within a git repository.');
  }

  const loadDiff = async (pathPatterns?: string[]): Promise<GitDiffResult> => {
    if (!base && looksLikeCommitHash(target)) {
      const commitDiff = await getCommitDiff(workspacePath, target, { contextLines });
      return pathPatterns && pathPatterns.length > 0
        ? filterDiffByPatterns(commitDiff, pathPatterns)
        : commitDiff;
    }

    return getGitDiff(workspacePath, {
      target,
      base,
      pathPatterns,
      contextLines,
    });
  };

  const scoped = normalizeDiffResult(await loadDiff(normalizedPatterns));
  if (scoped.diff.trim().length > 0 && scoped.files_changed.length > 0) {
    return {
      diff: scoped.diff,
      changed_files: scoped.files_changed,
      stats: scoped.stats,
      command: scoped.command,
      target,
      base,
    };
  }

  let scope_empty_reason: ReviewDiffScopeEmptyReason = 'no_changes_for_target';
  if (normalizedPatterns.length > 0) {
    const unscoped = normalizeDiffResult(await loadDiff());
    if (unscoped.diff.trim().length > 0 && unscoped.files_changed.length > 0) {
      scope_empty_reason = 'path_scope_excluded_all_changes';
    }
  }

  return {
    diff: scoped.diff,
    changed_files: scoped.files_changed,
    stats: scoped.stats,
    command: scoped.command,
    target,
    base,
    scope_empty_reason,
  };
}

export function buildEmptyReviewDiffScopeError(source: ReviewDiffSource, toolName: string): Error {
  const detail =
    source.scope_empty_reason === 'path_scope_excluded_all_changes'
      ? 'The requested path scope excluded all matching changes. Adjust include_patterns or choose a broader target.'
      : 'Stage or modify files, or choose a different target (e.g., unstaged, head, branch, or commit).';

  return new Error(
    `No changes found for ${toolName} target "${source.target}". ` +
      `Review scope is empty (${source.scope_empty_reason ?? 'no_changes_for_target'}), so review is blocked. ` +
      detail
  );
}
