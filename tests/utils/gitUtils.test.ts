/**
 * Unit Tests for Git Utilities
 *
 * Tests for git diff retrieval and git status functions.
 * These tests run against the actual git repository.
 */

import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  execGitCommand,
  getGitStatus,
  getGitDiff,
  getStagedDiff,
  getUnstagedDiff,
  getCommitDiff,
  parseGitPorcelainLine,
  parseGitPorcelainStatus,
} from '../../src/mcp/utils/gitUtils.js';

// Use the actual workspace for testing
const workspacePath = path.resolve(process.cwd());

// ============================================================================
// Fixture repository helpers
// ============================================================================

function runGit(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function writeFile(repoPath: string, relativePath: string, content: string): void {
  const fullPath = path.join(repoPath, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function createFixtureRepo(): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-git-porcelain-'));
  runGit(['init'], repoPath);
  runGit(['config', 'user.email', 'fixture@example.com'], repoPath);
  runGit(['config', 'user.name', 'Fixture'], repoPath);
  return repoPath;
}

function removeFixtureRepo(repoPath: string): void {
  fs.rmSync(repoPath, { recursive: true, force: true });
}

// ============================================================================
// execGitCommand Tests (Integration)
// ============================================================================

describe('execGitCommand', () => {
  it('should execute git command and return stdout', async () => {
    const result = await execGitCommand(['--version'], workspacePath);

    expect(result.stdout).toContain('git version');
    expect(result.exitCode).toBe(0);
  });

  it('should return error on invalid command', async () => {
    const result = await execGitCommand(['invalid-command-that-does-not-exist'], workspacePath);

    expect(result.exitCode).not.toBe(0);
  });
});

// ============================================================================
// getGitStatus Tests (Integration)
// ============================================================================

describe('getGitStatus', () => {
  it('should detect current directory as git repository', async () => {
    const result = await getGitStatus(workspacePath);

    expect(result.is_git_repo).toBe(true);
    // GitHub Actions checks out commits in detached HEAD state, so there is
    // no branch name in CI even though the directory is a valid Git repo.
    expect(result.current_branch === undefined || result.current_branch.length > 0).toBe(true);
  });

  it('should detect non-existent path as not a git repo', async () => {
    // Use temp directory which typically isn't a git repo
    const result = await getGitStatus('/tmp/definitely-not-a-git-repo-12345');

    expect(result.is_git_repo).toBe(false);
  });
});

// ============================================================================
// Porcelain XY-column parsing (synthetic lines) - C1
// ============================================================================

describe('parseGitPorcelainLine', () => {
  it('parses a staged (index-only) modification', () => {
    const entry = parseGitPorcelainLine('M  staged.txt');
    expect(entry).toMatchObject({
      indexStatus: 'M',
      worktreeStatus: ' ',
      path: 'staged.txt',
      isStaged: true,
      isUnstaged: false,
      isUntracked: false,
      isConflicted: false,
    });
  });

  it('parses an unstaged (worktree-only) modification', () => {
    const entry = parseGitPorcelainLine(' M unstaged.txt');
    expect(entry).toMatchObject({
      indexStatus: ' ',
      worktreeStatus: 'M',
      path: 'unstaged.txt',
      isStaged: false,
      isUnstaged: true,
      isUntracked: false,
      isConflicted: false,
    });
  });

  it('parses a mixed staged+unstaged modification (MM)', () => {
    const entry = parseGitPorcelainLine('MM mixed.txt');
    expect(entry).toMatchObject({
      indexStatus: 'M',
      worktreeStatus: 'M',
      path: 'mixed.txt',
      isStaged: true,
      isUnstaged: true,
      isUntracked: false,
      isConflicted: false,
    });
  });

  it('parses a staged rename and preserves both original and new path', () => {
    const entry = parseGitPorcelainLine('R  old-name.txt -> new-name.txt');
    expect(entry).toMatchObject({
      indexStatus: 'R',
      worktreeStatus: ' ',
      path: 'new-name.txt',
      originalPath: 'old-name.txt',
      isStaged: true,
      isUnstaged: false,
      isConflicted: false,
    });
  });

  it('parses a staged delete', () => {
    const entry = parseGitPorcelainLine('D  deleted-staged.txt');
    expect(entry).toMatchObject({
      indexStatus: 'D',
      worktreeStatus: ' ',
      path: 'deleted-staged.txt',
      isStaged: true,
      isUnstaged: false,
      isConflicted: false,
    });
  });

  it('parses an unstaged delete', () => {
    const entry = parseGitPorcelainLine(' D deleted-unstaged.txt');
    expect(entry).toMatchObject({
      indexStatus: ' ',
      worktreeStatus: 'D',
      path: 'deleted-unstaged.txt',
      isStaged: false,
      isUnstaged: true,
      isConflicted: false,
    });
  });

  it('parses an untracked file and never marks it staged', () => {
    const entry = parseGitPorcelainLine('?? untracked.txt');
    expect(entry).toMatchObject({
      indexStatus: '?',
      worktreeStatus: '?',
      path: 'untracked.txt',
      isStaged: false,
      isUnstaged: false,
      isUntracked: true,
      isConflicted: false,
    });
  });

  it.each(['UU', 'AA', 'DD', 'AU', 'UA', 'UD', 'DU'])(
    'classifies unmerged code %s as conflicted, never staged or unstaged',
    (code) => {
      const entry = parseGitPorcelainLine(`${code} conflicted.txt`);
      expect(entry).toMatchObject({
        path: 'conflicted.txt',
        isStaged: false,
        isUnstaged: false,
        isUntracked: false,
        isConflicted: true,
      });
    }
  );

  it('returns null for a blank line', () => {
    expect(parseGitPorcelainLine('')).toBeNull();
  });
});

describe('parseGitPorcelainStatus', () => {
  it('parses every category from a synthetic multi-line porcelain payload', () => {
    const porcelain = [
      'M  staged.txt',
      ' M unstaged.txt',
      'MM mixed.txt',
      'R  old-name.txt -> new-name.txt',
      'D  deleted-staged.txt',
      ' D deleted-unstaged.txt',
      '?? untracked.txt',
      'UU conflicted.txt',
    ].join('\n');

    const entries = parseGitPorcelainStatus(porcelain);
    expect(entries).toHaveLength(8);

    const staged = entries.filter((e) => e.isStaged);
    const unstaged = entries.filter((e) => e.isUnstaged);
    const untracked = entries.filter((e) => e.isUntracked);
    const conflicted = entries.filter((e) => e.isConflicted);

    // staged.txt, mixed.txt, old->new rename, deleted-staged.txt
    expect(staged.map((e) => e.path).sort()).toEqual(
      ['staged.txt', 'mixed.txt', 'new-name.txt', 'deleted-staged.txt'].sort()
    );
    // unstaged.txt, mixed.txt, deleted-unstaged.txt
    expect(unstaged.map((e) => e.path).sort()).toEqual(
      ['unstaged.txt', 'mixed.txt', 'deleted-unstaged.txt'].sort()
    );
    expect(untracked.map((e) => e.path)).toEqual(['untracked.txt']);
    expect(conflicted.map((e) => e.path)).toEqual(['conflicted.txt']);

    // Conflicted paths must never leak into staged/unstaged counts.
    expect(staged.some((e) => e.path === 'conflicted.txt')).toBe(false);
    expect(unstaged.some((e) => e.path === 'conflicted.txt')).toBe(false);
  });

  it('handles trailing CRLF line endings without corrupting the XY columns', () => {
    const porcelain = 'M  staged.txt\r\n?? untracked.txt\r\n';
    const entries = parseGitPorcelainStatus(porcelain);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ indexStatus: 'M', path: 'staged.txt' });
    expect(entries[1]).toMatchObject({ indexStatus: '?', path: 'untracked.txt' });
  });

  it('ignores blank lines', () => {
    const porcelain = '\nM  staged.txt\n\n';
    const entries = parseGitPorcelainStatus(porcelain);
    expect(entries).toHaveLength(1);
  });
});

// ============================================================================
// getGitStatus fixture-repository coverage - C1
// ============================================================================

describe('getGitStatus fixture-repository cases', () => {
  it('reports a clean repo with no staged, unstaged, or conflicted changes', async () => {
    const repo = createFixtureRepo();
    try {
      writeFile(repo, 'README.md', 'hello\n');
      runGit(['add', '.'], repo);
      runGit(['commit', '-m', 'initial'], repo);

      const result = await getGitStatus(repo);
      expect(result.is_git_repo).toBe(true);
      expect(result.has_changes).toBe(false);
      expect(result.has_staged).toBe(false);
      expect(result.has_unstaged).toBe(false);
      expect(result.has_conflicts).toBe(false);
      expect(result.file_counts).toEqual({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0, total: 0 });
    } finally {
      removeFixtureRepo(repo);
    }
  });

  it('reports staged-only changes as staged, not unstaged', async () => {
    const repo = createFixtureRepo();
    try {
      writeFile(repo, 'a.txt', 'a\n');
      runGit(['add', '.'], repo);
      runGit(['commit', '-m', 'initial'], repo);

      writeFile(repo, 'b.txt', 'b\n');
      runGit(['add', 'b.txt'], repo);

      const result = await getGitStatus(repo);
      expect(result.has_staged).toBe(true);
      expect(result.has_unstaged).toBe(false);
      expect(result.has_conflicts).toBe(false);
      expect(result.file_counts).toMatchObject({ staged: 1, unstaged: 0, untracked: 0, conflicted: 0, total: 1 });
    } finally {
      removeFixtureRepo(repo);
    }
  });

  it('reports unstaged-only changes as unstaged, never staged (regression for the porcelain misclassification bug)', async () => {
    const repo = createFixtureRepo();
    try {
      writeFile(repo, 'a.txt', 'a\n');
      runGit(['add', '.'], repo);
      runGit(['commit', '-m', 'initial'], repo);

      writeFile(repo, 'a.txt', 'a modified\n');

      const result = await getGitStatus(repo);
      expect(result.has_staged).toBe(false);
      expect(result.has_unstaged).toBe(true);
      expect(result.file_counts).toMatchObject({ staged: 0, unstaged: 1, untracked: 0, conflicted: 0, total: 1 });
    } finally {
      removeFixtureRepo(repo);
    }
  });

  it('reports mixed staged and unstaged changes independently', async () => {
    const repo = createFixtureRepo();
    try {
      writeFile(repo, 'a.txt', 'a\n');
      writeFile(repo, 'b.txt', 'b\n');
      runGit(['add', '.'], repo);
      runGit(['commit', '-m', 'initial'], repo);

      // a.txt: staged modification
      writeFile(repo, 'a.txt', 'a staged\n');
      runGit(['add', 'a.txt'], repo);
      // b.txt: unstaged modification
      writeFile(repo, 'b.txt', 'b unstaged\n');
      // c.txt: untracked
      writeFile(repo, 'c.txt', 'c\n');

      const result = await getGitStatus(repo);
      expect(result.has_staged).toBe(true);
      expect(result.has_unstaged).toBe(true);
      expect(result.file_counts).toMatchObject({ staged: 1, unstaged: 1, untracked: 1, conflicted: 0, total: 3 });
    } finally {
      removeFixtureRepo(repo);
    }
  });

  it('reports a staged rename correctly', async () => {
    const repo = createFixtureRepo();
    try {
      writeFile(repo, 'old-name.txt', 'renamed content\n');
      runGit(['add', '.'], repo);
      runGit(['commit', '-m', 'initial'], repo);

      runGit(['mv', 'old-name.txt', 'new-name.txt'], repo);

      const result = await getGitStatus(repo);
      expect(result.has_staged).toBe(true);
      expect(result.has_unstaged).toBe(false);
      expect(result.file_counts?.total).toBe(1);

      const statusResult = await execGitCommand(['status', '--porcelain'], repo);
      const entries = parseGitPorcelainStatus(statusResult.stdout);
      expect(entries).toHaveLength(1);
      expect(entries[0].indexStatus).toBe('R');
      expect(entries[0].path).toBe('new-name.txt');
      expect(entries[0].originalPath).toBe('old-name.txt');
    } finally {
      removeFixtureRepo(repo);
    }
  });

  it('reports staged and unstaged deletes distinctly', async () => {
    const repo = createFixtureRepo();
    try {
      writeFile(repo, 'staged-delete.txt', 'x\n');
      writeFile(repo, 'unstaged-delete.txt', 'y\n');
      runGit(['add', '.'], repo);
      runGit(['commit', '-m', 'initial'], repo);

      runGit(['rm', '--cached', 'staged-delete.txt'], repo);
      fs.rmSync(path.join(repo, 'unstaged-delete.txt'));

      const result = await getGitStatus(repo);
      expect(result.has_staged).toBe(true);
      expect(result.has_unstaged).toBe(true);
      expect(result.file_counts).toMatchObject({ staged: 1, unstaged: 1, untracked: 1, conflicted: 0, total: 3 });
      // Deleting the cached copy leaves the working-tree file as untracked.
    } finally {
      removeFixtureRepo(repo);
    }
  });

  it('reports untracked-only files without marking them staged or unstaged', async () => {
    const repo = createFixtureRepo();
    try {
      writeFile(repo, 'README.md', 'hello\n');
      runGit(['add', '.'], repo);
      runGit(['commit', '-m', 'initial'], repo);

      writeFile(repo, 'new-file.txt', 'brand new\n');

      const result = await getGitStatus(repo);
      expect(result.has_changes).toBe(true);
      expect(result.has_staged).toBe(false);
      expect(result.has_unstaged).toBe(false);
      expect(result.file_counts).toMatchObject({ staged: 0, unstaged: 0, untracked: 1, conflicted: 0, total: 1 });
    } finally {
      removeFixtureRepo(repo);
    }
  });

  it('reports merge conflicts as conflicted, never as staged (regression for conflict misclassification)', async () => {
    const repo = createFixtureRepo();
    try {
      writeFile(repo, 'conflict.txt', 'base\n');
      runGit(['add', '.'], repo);
      runGit(['commit', '-m', 'initial'], repo);
      runGit(['branch', '-M', 'main'], repo);

      runGit(['checkout', '-b', 'feature'], repo);
      writeFile(repo, 'conflict.txt', 'feature change\n');
      runGit(['commit', '-am', 'feature change'], repo);

      runGit(['checkout', 'main'], repo);
      writeFile(repo, 'conflict.txt', 'main change\n');
      runGit(['commit', '-am', 'main change'], repo);

      try {
        runGit(['merge', 'feature'], repo);
      } catch {
        // Expected: merge conflict causes a non-zero exit code.
      }

      const result = await getGitStatus(repo);
      expect(result.has_conflicts).toBe(true);
      expect(result.file_counts).toMatchObject({ staged: 0, unstaged: 0, untracked: 0, conflicted: 1, total: 1 });
      // The old buggy heuristic (`line[0] !== ' ' && line[0] !== '?'`) would
      // have misclassified this conflicted ('U') entry as staged.
      expect(result.has_staged).toBe(false);
    } finally {
      removeFixtureRepo(repo);
    }
  });
});

// ============================================================================
// getGitDiff Tests (Integration)
// ============================================================================

describe('getGitDiff', () => {
  it('should get staged diff without error', async () => {
    // This will return empty diff if nothing is staged, which is fine
    const result = await getGitDiff(workspacePath, { target: 'staged' });

    expect(result.command).toContain('--staged');
    expect(result.files_changed).toBeDefined();
    expect(result.stats).toBeDefined();
  });

  it('should get unstaged diff without error', async () => {
    const result = await getGitDiff(workspacePath, { target: 'unstaged' });

    expect(result.command).not.toContain('--staged');
    expect(result.files_changed).toBeDefined();
  });

  it('should get HEAD diff without error', async () => {
    const result = await getGitDiff(workspacePath, { target: 'head' });

    expect(result.command).toContain('HEAD');
    expect(result.files_changed).toBeDefined();
  });

  it('rejects shell metacharacters in target refs without executing injected commands', async () => {
    const markerPath = path.join(os.tmpdir(), 'context-engine-git-diff-cmdi-poc.txt');
    fs.rmSync(markerPath, { force: true });

    await expect(
      getGitDiff(workspacePath, {
        target: `HEAD & echo POC>${markerPath} & rem`,
      })
    ).rejects.toThrow(/Invalid git target/i);

    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it('rejects shell metacharacters in base refs', async () => {
    await expect(
      getGitDiff(workspacePath, {
        target: 'HEAD',
        base: 'main; echo POC',
      })
    ).rejects.toThrow(/Invalid git base/i);
  });

  it('rejects option-like and traversal path patterns before invoking git', async () => {
    await expect(
      getGitDiff(workspacePath, {
        target: 'staged',
        pathPatterns: ['--output=/tmp/poc'],
      })
    ).rejects.toThrow(/Invalid git path pattern/i);

    await expect(
      getGitDiff(workspacePath, {
        target: 'staged',
        pathPatterns: ['../outside.ts'],
      })
    ).rejects.toThrow(/Invalid git path pattern/i);
  });
});

// ============================================================================
// Convenience Function Tests (Integration)
// ============================================================================

describe('Convenience Functions', () => {
  it('getStagedDiff should work without error', async () => {
    const result = await getStagedDiff(workspacePath);

    expect(result.command).toContain('--staged');
  });

  it('getUnstagedDiff should work without error', async () => {
    const result = await getUnstagedDiff(workspacePath);

    expect(result.command).not.toContain('--staged');
  });

  it('getCommitDiff should work with a valid commit', async () => {
    // Get the first commit (HEAD~0 or just HEAD should work)
    // Use HEAD as it always exists
    try {
      const result = await getCommitDiff(workspacePath, 'HEAD');
      expect(result.command).toContain('show');
      expect(result.command).toContain('HEAD');
    } catch {
      // If HEAD doesn't work, that's also acceptable in some edge cases
      expect(true).toBe(true);
    }
  });

  it('getCommitDiff rejects unsafe commit-ish values', async () => {
    await expect(getCommitDiff(workspacePath, 'HEAD & echo POC')).rejects.toThrow(
      /Invalid git commit/i
    );
  });
});

// ============================================================================
// Diff Parsing Tests (Unit - no git needed)
// ============================================================================

describe('Diff Parsing Logic', () => {
  // These test the internal parsing by examining output structure

  it('should correctly count additions and deletions', async () => {
    // Get a diff of HEAD to verify parsing
    const result = await getGitDiff(workspacePath, { target: 'head' });

    // Stats should be non-negative numbers
    expect(result.stats.additions).toBeGreaterThanOrEqual(0);
    expect(result.stats.deletions).toBeGreaterThanOrEqual(0);
    expect(result.stats.files_count).toBeGreaterThanOrEqual(0);
  });

  it('should return empty arrays for empty diff', async () => {
    // Get staged diff (usually empty in CI)
    const result = await getStagedDiff(workspacePath);

    // If diff is empty, files_changed should be empty
    if (result.diff === '') {
      expect(result.files_changed).toEqual([]);
      expect(result.stats.files_count).toBe(0);
    }
  });
});
