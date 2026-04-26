import { describe, expect, it } from '@jest/globals';
import {
  normalizeWorkspaceRelativePath,
  normalizeWorkspaceRelativePaths,
  resolveWorkspaceRelativePath,
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
