import { afterEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeWorkspaceRelativePath,
  normalizeWorkspaceRelativePaths,
  resolveWorkspaceRelativePath,
  resolveRealPathInsideWorkspace,
} from '../../src/workspace/pathValidation.js';

describe('workspace path validation', () => {
  it('normalizes safe workspace-relative paths', () => {
    expect(normalizeWorkspaceRelativePath('src\\tools/../tools/a.ts')).toBe('src/tools/a.ts');
    expect(normalizeWorkspaceRelativePaths(['./src/a.ts', 'tests\\b.ts'])).toEqual(['src/a.ts', 'tests/b.ts']);
  });

  it.each(['', '   ', '.', '../secret.txt', 'src/../../secret.txt', '/etc/passwd', 'C:/tmp/x.ts', 'C:tmp/x.ts', '\\\\server\\share\\x.ts', 'a\nb.ts'])(
    'rejects unsafe path %p',
    (unsafePath) => {
      expect(() => normalizeWorkspaceRelativePath(unsafePath)).toThrow(/Invalid/);
    }
  );

  it('rejects option-like paths when requested', () => {
    expect(() => normalizeWorkspaceRelativePath('--config', 'changed_files[0]', { rejectOptionLike: true })).toThrow(
      /option-like/
    );
  });

  it('resolves paths beneath the workspace', () => {
    const resolved = resolveWorkspaceRelativePath(process.cwd(), 'src/index.ts');
    expect(resolved).toContain('src');
    expect(resolved).toContain('index.ts');
  });
});

describe('live real-path containment', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  function fixture() {
    const evidenceRoot = path.join(process.cwd(), '.context-engine-native-realpath-tests');
    fs.mkdirSync(evidenceRoot, { recursive: true });
    const root = fs.mkdtempSync(path.join(evidenceRoot, 'case-'));
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(workspace);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(workspace, 'safe.txt'), 'synthetic safe');
    fs.writeFileSync(path.join(outside, 'outside.txt'), 'synthetic outside');
    return { root, workspace, outside };
  }

  function linkDirectory(target: string, link: string) {
    // Directory junctions exercise the boundary on Windows without requiring
    // file-symlink privileges. A link-creation failure must fail this test.
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  }

  it('resolves ordinary and Unicode paths and rejects an outside path', () => {
    const { workspace, outside } = fixture();
    const unicode = path.join(workspace, 'caf\u00e9.ts');
    fs.writeFileSync(unicode, 'synthetic unicode');
    expect(resolveRealPathInsideWorkspace(workspace, unicode)).toBe(fs.realpathSync(unicode));
    expect(() => resolveRealPathInsideWorkspace(workspace, path.join(outside, 'outside.txt'))).toThrow(/within workspace/);
  });

  it('allows an inside junction and rejects a junction to an outside file', () => {
    const { workspace, outside } = fixture();
    const inside = path.join(workspace, 'inside');
    fs.mkdirSync(inside);
    fs.writeFileSync(path.join(inside, 'safe.txt'), 'synthetic nested');
    linkDirectory(inside, path.join(workspace, 'inside-link'));
    linkDirectory(outside, path.join(workspace, 'outside-link'));
    expect(resolveRealPathInsideWorkspace(workspace, path.join(workspace, 'inside-link/safe.txt'))).toBe(fs.realpathSync(path.join(inside, 'safe.txt')));
    expect(() => resolveRealPathInsideWorkspace(workspace, path.join(workspace, 'outside-link/outside.txt'))).toThrow(/within workspace/);
  });

  it('rechecks a junction target after it changes instead of reusing an allowed path', () => {
    const { workspace, outside } = fixture();
    const inside = path.join(workspace, 'inside');
    fs.mkdirSync(inside);
    fs.writeFileSync(path.join(inside, 'target.txt'), 'synthetic inside');
    fs.writeFileSync(path.join(outside, 'target.txt'), 'synthetic outside');
    const link = path.join(workspace, 'link');
    linkDirectory(inside, link);
    expect(resolveRealPathInsideWorkspace(workspace, path.join(link, 'target.txt'))).toBe(fs.realpathSync(path.join(inside, 'target.txt')));
    fs.renameSync(link, path.join(workspace, 'previous-link'));
    linkDirectory(outside, link);
    expect(() => resolveRealPathInsideWorkspace(workspace, path.join(link, 'target.txt'))).toThrow(/within workspace/);
  });

  it('supports a workspace reached through a junction and resolves a changed root afresh', () => {
    const { root, workspace, outside } = fixture();
    fs.writeFileSync(path.join(outside, 'safe.txt'), 'synthetic replacement workspace');
    const alias = path.join(root, 'workspace-alias');
    linkDirectory(workspace, alias);
    expect(resolveRealPathInsideWorkspace(alias, path.join(alias, 'safe.txt'))).toBe(fs.realpathSync(path.join(workspace, 'safe.txt')));
    fs.renameSync(alias, path.join(root, 'previous-alias'));
    linkDirectory(outside, alias);
    expect(resolveRealPathInsideWorkspace(alias, path.join(alias, 'safe.txt'))).toBe(fs.realpathSync(path.join(outside, 'safe.txt')));
  });

  it('falls back to the existing resolver when native resolution is unavailable', () => {
    const { workspace } = fixture();
    const native = jest.spyOn(fs.realpathSync, 'native').mockImplementation(() => { throw new Error('synthetic native unavailable'); });
    expect(resolveRealPathInsideWorkspace(workspace, path.join(workspace, 'safe.txt'))).toBe(path.join(workspace, 'safe.txt'));
    expect(native).toHaveBeenCalledTimes(2);
  });

  it('continues to reject a missing file', () => {
    const { workspace } = fixture();
    expect(() => resolveRealPathInsideWorkspace(workspace, path.join(workspace, 'missing.txt'))).toThrow();
  });
});
