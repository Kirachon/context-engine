import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findNearestGitRoot, resolveWorkspacePath } from '../../src/workspace/resolveWorkspace.js';

describe('resolveWorkspacePath', () => {
  it('prefers explicit workspace over inferred paths', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-workspace-explicit-'));
    const repoRoot = path.join(tempDir, 'repo');
    const nested = path.join(repoRoot, 'nested', 'child');
    const explicit = path.join(tempDir, 'manual-workspace');
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(explicit, { recursive: true });

    try {
      const result = await resolveWorkspacePath({
        explicitWorkspace: explicit,
        cwd: nested,
      });

      expect(result.workspacePath).toBe(path.resolve(explicit));
      expect(result.source).toBe('explicit');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps cwd when launched from the repo root', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-workspace-root-'));
    fs.mkdirSync(path.join(tempDir, '.git'), { recursive: true });

    try {
      const result = await resolveWorkspacePath({ cwd: tempDir });

      expect(result.workspacePath).toBe(path.resolve(tempDir));
      expect(result.source).toBe('cwd');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('falls back to the nearest git root for nested subdirectories', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-workspace-git-root-'));
    const repoRoot = path.join(tempDir, 'repo');
    const nested = path.join(repoRoot, 'apps', 'api');
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });

    try {
      const result = await resolveWorkspacePath({ cwd: nested });

      expect(result.workspacePath).toBe(path.resolve(repoRoot));
      expect(result.source).toBe('git-root-fallback');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps cwd and warns clearly when no git root exists', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-workspace-non-git-'));
    const warnings: string[] = [];

    try {
      const result = await resolveWorkspacePath({
        cwd: tempDir,
        logWarning: (message) => warnings.push(message),
      });

      expect(result.workspacePath).toBe(path.resolve(tempDir));
      expect(result.source).toBe('cwd-fallback');
      expect(result.warning).toContain('No git root found');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(path.resolve(tempDir));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('normalizes mixed separators while resolving git-root fallback', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-workspace-normalize-'));
    const repoRoot = path.join(tempDir, 'repo');
    const nested = path.join(repoRoot, 'nested', 'child');
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });

    try {
      const mixedPath = nested.replace(/\\/g, '/');
      const result = await resolveWorkspacePath({ cwd: mixedPath });

      expect(result.workspacePath).toBe(path.resolve(repoRoot));
      expect(result.source).toBe('git-root-fallback');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('findNearestGitRoot', () => {
  it('recognizes .git files as repo markers', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-workspace-git-file-'));
    const repoRoot = path.join(tempDir, 'repo');
    const nested = path.join(repoRoot, 'packages', 'web');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, '.git'), 'gitdir: ../.git/modules/repo\n', 'utf-8');

    try {
      const result = await findNearestGitRoot(nested);
      expect(result).toBe(path.resolve(repoRoot));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
