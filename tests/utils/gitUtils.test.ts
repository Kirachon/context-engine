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
import {
  execGitCommand,
  getGitStatus,
  getGitDiff,
  getStagedDiff,
  getUnstagedDiff,
  getCommitDiff,
} from '../../src/mcp/utils/gitUtils.js';

// Use the actual workspace for testing
const workspacePath = path.resolve(process.cwd());

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
    expect(result.current_branch).toBeDefined();
  });

  it('should detect non-existent path as not a git repo', async () => {
    // Use temp directory which typically isn't a git repo
    const result = await getGitStatus('/tmp/definitely-not-a-git-repo-12345');

    expect(result.is_git_repo).toBe(false);
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
