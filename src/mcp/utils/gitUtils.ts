/**
 * Git Utilities
 *
 * Utility functions for interacting with git repositories.
 * Used by the code review tools to retrieve diffs automatically.
 */

import { spawn } from 'child_process';

// ============================================================================
// Types
// ============================================================================

export interface GitDiffOptions {
  /** Target to diff against (branch, commit, or 'staged' for staged changes) */
  target?: string;
  /** Base reference for comparison (default: depends on target) */
  base?: string;
  /** Include only specific file patterns */
  pathPatterns?: string[];
  /** Number of context lines (default: 3) */
  contextLines?: number;
}

export interface GitDiffResult {
  /** The unified diff content */
  diff: string;
  /** Files changed in the diff */
  files_changed: string[];
  /** Statistics about the diff */
  stats: {
    additions: number;
    deletions: number;
    files_count: number;
  };
  /** Git command that was executed */
  command: string;
}

export type GitDiffStats = GitDiffResult['stats'];

export interface GitStatusResult {
  /** Whether the directory is a git repository */
  is_git_repo: boolean;
  /** Current branch name */
  current_branch?: string;
  /** Whether there are uncommitted changes */
  has_changes: boolean;
  /** Whether there are staged (index) changes, excluding unmerged/conflicted paths */
  has_staged: boolean;
  /** Whether there are unstaged (worktree) changes, excluding unmerged/conflicted paths */
  has_unstaged?: boolean;
  /** Whether there are unresolved merge conflicts */
  has_conflicts?: boolean;
  /** Exact file counts derived from every porcelain line; never truncated for display */
  file_counts?: GitStatusFileCounts;
}

/**
 * Exact counts of changed files by category. These are always derived from
 * every parsed porcelain line and must never be limited by any display
 * truncation applied to a rendered list of file names.
 */
export interface GitStatusFileCounts {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  /** Total number of distinct porcelain entries (one per changed path) */
  total: number;
}

/**
 * A single parsed `git status --porcelain` (v1) entry.
 *
 * The porcelain v1 format is `XY PATH` (or `XY ORIG_PATH -> PATH` for
 * renames/copies), where:
 * - `X` (indexStatus) describes the state of the index (staged/HEAD diff)
 * - `Y` (worktreeStatus) describes the state of the worktree (index diff)
 *
 * Unmerged/conflicted paths use a fixed set of XY combinations (e.g. `UU`,
 * `AA`, `DD`, `AU`, `UA`, `UD`, `DU`) that are distinct from ordinary
 * staged/unstaged states and must not be counted as "staged".
 */
export interface ParsedGitStatusEntry {
  /** Raw index-column status character (X) */
  indexStatus: string;
  /** Raw worktree-column status character (Y) */
  worktreeStatus: string;
  /** Current path (destination path for renames/copies) */
  path: string;
  /** Original path, present only for renames/copies */
  originalPath?: string;
  isStaged: boolean;
  isUnstaged: boolean;
  isUntracked: boolean;
  isConflicted: boolean;
}

const UNMERGED_XY_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const RENAME_ARROW = ' -> ';

/**
 * Parse a single `git status --porcelain` (v1) line, preserving the
 * distinction between the index (X) and worktree (Y) status columns.
 *
 * Returns `null` for blank/malformed lines that cannot contain a valid
 * `XY PATH` entry.
 */
export function parseGitPorcelainLine(line: string): ParsedGitStatusEntry | null {
  if (line.length < 3 || line[2] !== ' ') {
    return null;
  }

  const indexStatus = line[0];
  const worktreeStatus = line[1];
  const rest = line.slice(3);
  const xy = `${indexStatus}${worktreeStatus}`;

  const isUntracked = xy === '??';
  const isConflicted = !isUntracked && UNMERGED_XY_CODES.has(xy);

  let path = rest;
  let originalPath: string | undefined;
  if ((indexStatus === 'R' || worktreeStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'C')) {
    const arrowIndex = rest.indexOf(RENAME_ARROW);
    if (arrowIndex !== -1) {
      originalPath = rest.slice(0, arrowIndex);
      path = rest.slice(arrowIndex + RENAME_ARROW.length);
    }
  }

  if (path.length === 0) {
    return null;
  }

  return {
    indexStatus,
    worktreeStatus,
    path,
    originalPath,
    isStaged: !isUntracked && !isConflicted && indexStatus !== ' ',
    isUnstaged: !isUntracked && !isConflicted && worktreeStatus !== ' ',
    isUntracked,
    isConflicted,
  };
}

/**
 * Parse the full output of `git status --porcelain` into per-file entries.
 * Every non-blank line becomes exactly one entry; totals derived from this
 * list must never be reduced by a downstream display limit.
 */
export function parseGitPorcelainStatus(statusOutput: string): ParsedGitStatusEntry[] {
  return statusOutput
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0)
    .map(parseGitPorcelainLine)
    .filter((entry): entry is ParsedGitStatusEntry => entry !== null);
}

function countGitStatusEntries(entries: ParsedGitStatusEntry[]): GitStatusFileCounts {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicted = 0;

  for (const entry of entries) {
    if (entry.isStaged) staged++;
    if (entry.isUnstaged) unstaged++;
    if (entry.isUntracked) untracked++;
    if (entry.isConflicted) conflicted++;
  }

  return { staged, unstaged, untracked, conflicted, total: entries.length };
}

const GIT_REF_MAX_LENGTH = 1024;
const GIT_PATH_PATTERN_MAX_LENGTH = 4096;
const SAFE_GIT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@-]*$/;

function validateSafeGitRef(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid git ${fieldName}: must be a safe branch name or commit hash`);
  }

  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > GIT_REF_MAX_LENGTH ||
    trimmed !== value ||
    !SAFE_GIT_REF_PATTERN.test(trimmed) ||
    trimmed.startsWith('-') ||
    trimmed.endsWith('.') ||
    trimmed.endsWith('/') ||
    trimmed.includes('..') ||
    trimmed.includes('@{') ||
    trimmed.includes('//') ||
    trimmed.split('/').some((segment) => segment.length === 0 || segment.endsWith('.lock'))
  ) {
    throw new Error(`Invalid git ${fieldName}: must be a safe branch name or commit hash`);
  }

  return trimmed;
}

function validateContextLines(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 1000) {
    throw new Error('Invalid git contextLines: must be an integer between 0 and 1000');
  }
  return value;
}

function validateGitPathPatterns(patterns: unknown): string[] {
  if (!Array.isArray(patterns)) {
    throw new Error('Invalid git path pattern: must be a safe workspace-relative path or glob');
  }

  return patterns.map((pattern) => {
    if (typeof pattern !== 'string') {
      throw new Error('Invalid git path pattern: must be a string');
    }

    let normalized = pattern.trim().replace(/\\/g, '/');
    while (normalized.startsWith('./')) {
      normalized = normalized.slice(2);
    }
    normalized = normalized.replace(/\/{2,}/g, '/');

    if (
      normalized.length === 0 ||
      normalized.length > GIT_PATH_PATTERN_MAX_LENGTH ||
      normalized.startsWith('-') ||
      /^(?:\/|[A-Za-z]:\/|\/\/)/.test(normalized) ||
      /[\0\r\n]/.test(normalized) ||
      normalized.split('/').some((segment) => segment === '..')
    ) {
      throw new Error('Invalid git path pattern: must be a safe workspace-relative path or glob');
    }

    return normalized;
  });
}

// ============================================================================
// Git Command Execution
// ============================================================================

/**
 * Execute a git command and return the output
 */
export function execGitCommand(
  args: string[],
  workspacePath: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, {
      cwd: workspacePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });

    proc.on('error', (error) => {
      resolve({ stdout, stderr: error.message, exitCode: -1 });
    });
  });
}

// ============================================================================
// Git Operations
// ============================================================================

/**
 * Check git status of a directory
 */
export async function getGitStatus(workspacePath: string): Promise<GitStatusResult> {
  // Check if it's a git repo
  const revParse = await execGitCommand(['rev-parse', '--is-inside-work-tree'], workspacePath);
  
  if (revParse.exitCode !== 0) {
    return {
      is_git_repo: false,
      has_changes: false,
      has_staged: false,
    };
  }

  // Get current branch
  const branchResult = await execGitCommand(['branch', '--show-current'], workspacePath);
  const current_branch = branchResult.stdout.trim() || undefined;

  // Check for uncommitted changes, parsing the XY index/worktree columns
  // explicitly so conflicted (unmerged) paths are never counted as staged.
  const statusResult = await execGitCommand(['status', '--porcelain'], workspacePath);
  const entries = parseGitPorcelainStatus(statusResult.stdout);
  const file_counts = countGitStatusEntries(entries);

  return {
    is_git_repo: true,
    current_branch,
    has_changes: file_counts.total > 0,
    has_staged: file_counts.staged > 0,
    has_unstaged: file_counts.unstaged > 0,
    has_conflicts: file_counts.conflicted > 0,
    file_counts,
  };
}

/**
 * Get a git diff based on the specified options
 */
export async function getGitDiff(
  workspacePath: string,
  options: GitDiffOptions = {}
): Promise<GitDiffResult> {
  const { target = 'staged', base, pathPatterns = [], contextLines = 3 } = options;
  const safeContextLines = validateContextLines(contextLines);
  const safePathPatterns = validateGitPathPatterns(pathPatterns);

  // Build the git diff command
  const args: string[] = ['diff', `--unified=${safeContextLines}`];

  // Handle different target types
  if (target === 'staged') {
    args.push('--staged');
  } else if (target === 'unstaged') {
    // Default diff (unstaged changes)
  } else if (target === 'head') {
    args.push('HEAD');
  } else if (base) {
    const safeBase = validateSafeGitRef(base, 'base');
    const safeTarget = validateSafeGitRef(target, 'target');
    // Compare base...target
    args.push(`${safeBase}...${safeTarget}`);
  } else {
    const safeTarget = validateSafeGitRef(target, 'target');
    // Compare against target directly (e.g., branch name or commit)
    args.push(safeTarget);
  }

  // Add path patterns if specified
  if (safePathPatterns.length > 0) {
    args.push('--');
    args.push(...safePathPatterns);
  }

  const command = `git ${args.join(' ')}`;
  const result = await execGitCommand(args, workspacePath);

  if (result.exitCode !== 0) {
    throw new Error(`Git diff failed: ${result.stderr}`);
  }

  const diff = result.stdout;

  // Parse the diff to extract file information
  const files_changed = extractFilesFromDiff(diff);
  const stats = extractStatsFromDiff(diff);

  return {
    diff,
    files_changed,
    stats,
    command,
  };
}

/**
 * Extract file paths from a unified diff
 */
function extractFilesFromDiff(diff: string): string[] {
  const files: string[] = [];
  const fileRegex = /^diff --git a\/(.+?) b\/(.+?)$/gm;

  let match;
  while ((match = fileRegex.exec(diff)) !== null) {
    // Use the 'b' path (new path) as the primary file path
    files.push(match[2]);
  }

  return files;
}

/**
 * Extract statistics from a unified diff
 */
function extractStatsFromDiff(diff: string): { additions: number; deletions: number; files_count: number } {
  const lines = diff.split('\n');
  let additions = 0;
  let deletions = 0;

  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      additions++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions++;
    }
  }

  const files_count = extractFilesFromDiff(diff).length;

  return { additions, deletions, files_count };
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Get staged changes diff
 */
export async function getStagedDiff(workspacePath: string): Promise<GitDiffResult> {
  return getGitDiff(workspacePath, { target: 'staged' });
}

/**
 * Get unstaged changes diff
 */
export async function getUnstagedDiff(workspacePath: string): Promise<GitDiffResult> {
  return getGitDiff(workspacePath, { target: 'unstaged' });
}

/**
 * Get diff between current branch and another branch
 */
export async function getBranchDiff(
  workspacePath: string,
  targetBranch: string,
  baseBranch?: string
): Promise<GitDiffResult> {
  return getGitDiff(workspacePath, { target: targetBranch, base: baseBranch });
}

/**
 * Get diff for a specific commit
 */
export async function getCommitDiff(
  workspacePath: string,
  commitHash: string,
  options: Pick<GitDiffOptions, 'pathPatterns' | 'contextLines'> = {}
): Promise<GitDiffResult> {
  const { pathPatterns = [], contextLines = 3 } = options;
  const safeCommitHash = validateSafeGitRef(commitHash, 'commit');
  const safeContextLines = validateContextLines(contextLines);
  const safePathPatterns = validateGitPathPatterns(pathPatterns);
  const args = ['show', safeCommitHash, '--format=', `--unified=${safeContextLines}`];
  if (safePathPatterns.length > 0) {
    args.push('--');
    args.push(...safePathPatterns);
  }
  const command = `git ${args.join(' ')}`;
  const result = await execGitCommand(args, workspacePath);

  if (result.exitCode !== 0) {
    throw new Error(`Git show failed: ${result.stderr}`);
  }

  const diff = result.stdout;
  const files_changed = extractFilesFromDiff(diff);
  const stats = extractStatsFromDiff(diff);

  return {
    diff,
    files_changed,
    stats,
    command,
  };
}
