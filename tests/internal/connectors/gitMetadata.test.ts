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
});
