import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createGitMetadataConnector } from '../../../src/internal/connectors/gitMetadata.js';

function runGit(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', shell: true });
}

describe('git metadata connector', () => {
  it('returns a local read-only git snapshot when the workspace is a git repo', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-git-connector-'));
    try {
      runGit(['init'], tempDir);
      fs.writeFileSync(path.join(tempDir, 'README.md'), 'hello world\n', 'utf8');

      const connector = createGitMetadataConnector();
      const signal = await connector.collect(tempDir);

      expect(signal).not.toBeNull();
      expect(signal).toMatchObject({
        id: 'git_metadata',
        label: 'Git metadata',
        status: 'available',
      });
      expect(signal?.fingerprint).toContain('git:');
      expect(signal?.summary).toContain('changed file');
      expect(signal?.details).toEqual(expect.arrayContaining([
        expect.stringContaining('current_branch='),
        expect.stringContaining('has_changes='),
      ]));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns null for non-git workspaces', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-not-git-'));
    try {
      fs.writeFileSync(path.join(tempDir, 'README.md'), 'hello world\n', 'utf8');

      const connector = createGitMetadataConnector();
      const signal = await connector.collect(tempDir);

      expect(signal).toBeNull();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reports the exact total changed-file count even when the display list is truncated (C1 regression)', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-git-connector-totals-'));
    try {
      runGit(['init'], tempDir);
      runGit(['config', 'user.email', 'fixture@example.com'], tempDir);
      runGit(['config', 'user.name', 'Fixture'], tempDir);
      fs.writeFileSync(path.join(tempDir, 'README.md'), 'hello world\n', 'utf8');
      runGit(['add', '.'], tempDir);
      runGit(['commit', '-m', 'initial'], tempDir);

      // Create 7 untracked files so the total exceeds the internal display
      // truncation limit (5). Before the fix, the summary/detail counts were
      // capped to the display limit instead of reflecting the true total.
      const fileCount = 7;
      for (let i = 0; i < fileCount; i++) {
        fs.writeFileSync(path.join(tempDir, `untracked-${i}.txt`), `content ${i}\n`, 'utf8');
      }

      const connector = createGitMetadataConnector();
      const signal = await connector.collect(tempDir);

      expect(signal).not.toBeNull();
      expect(signal?.summary).toContain(`${fileCount} changed file(s)`);
      expect(signal?.details).toEqual(
        expect.arrayContaining([`total_changed_files=${fileCount}`])
      );
      // The displayed list is still truncated for readability, but must be
      // distinguishable from the true total via the "+N more" suffix.
      const changedFilesDetail = signal?.details.find((d) => d.startsWith('changed_files='));
      expect(changedFilesDetail).toContain('+2 more');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('never reports has_staged=true for an unstaged-only modification (XY column regression)', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-git-connector-unstaged-'));
    try {
      runGit(['init'], tempDir);
      runGit(['config', 'user.email', 'fixture@example.com'], tempDir);
      runGit(['config', 'user.name', 'Fixture'], tempDir);
      fs.writeFileSync(path.join(tempDir, 'tracked.txt'), 'original\n', 'utf8');
      runGit(['add', '.'], tempDir);
      runGit(['commit', '-m', 'initial'], tempDir);

      // Modify a tracked file without staging it: unstaged-only change.
      fs.writeFileSync(path.join(tempDir, 'tracked.txt'), 'modified\n', 'utf8');

      const connector = createGitMetadataConnector();
      const signal = await connector.collect(tempDir);

      expect(signal).not.toBeNull();
      expect(signal?.details).toEqual(expect.arrayContaining(['has_staged=false']));
      expect(signal?.summary).toContain('no staged changes');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
