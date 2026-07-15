import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compileIgnoreRules } from '../../../src/internal/discovery/ignoreCompiler.js';

describe('compileIgnoreRules', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const next = tempDirs.pop();
      if (next) fs.rmSync(next, { recursive: true, force: true });
    }
  });

  function createTempWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-ignore-compiler-'));
    tempDirs.push(dir);
    return dir;
  }

  it('hard-excludes default directory names and never lets negation override them', () => {
    const workspacePath = createTempWorkspace();
    fs.writeFileSync(path.join(workspacePath, '.gitignore'), '!node_modules\n', 'utf-8');

    const rules = compileIgnoreRules({ workspacePath });

    expect(rules.isDirectoryNameExcluded('node_modules')).toBe(true);
    expect(rules.isDirectoryNameExcluded('src')).toBe(false);
  });

  it('applies gitignore-style negation with last-match-wins semantics', () => {
    const workspacePath = createTempWorkspace();
    fs.writeFileSync(
      path.join(workspacePath, '.gitignore'),
      ['*.log', '!keep.log'].join('\n'),
      'utf-8'
    );

    const rules = compileIgnoreRules({ workspacePath });

    expect(rules.matchesIgnoreRule('debug.log', 'file')).toBe(true);
    expect(rules.matchesIgnoreRule('keep.log', 'file')).toBe(false);
  });

  it('anchors root-prefixed patterns to the workspace root only', () => {
    const workspacePath = createTempWorkspace();
    fs.writeFileSync(path.join(workspacePath, '.gitignore'), '/only-root.txt\n', 'utf-8');

    const rules = compileIgnoreRules({ workspacePath });

    expect(rules.matchesIgnoreRule('only-root.txt', 'file')).toBe(true);
    expect(rules.matchesIgnoreRule('nested/only-root.txt', 'file')).toBe(false);
  });

  it('applies directory-only patterns only to directory entries', () => {
    const workspacePath = createTempWorkspace();
    fs.writeFileSync(path.join(workspacePath, '.gitignore'), 'build/\n', 'utf-8');

    const rules = compileIgnoreRules({ workspacePath });

    expect(rules.matchesIgnoreRule('build', 'directory')).toBe(true);
    expect(rules.matchesIgnoreRule('build', 'file')).toBe(false);
  });

  it('reads custom ignore files provided via extraIgnoreFileNames', () => {
    const workspacePath = createTempWorkspace();
    fs.writeFileSync(path.join(workspacePath, '.customignore'), 'secret-*.ts\n', 'utf-8');

    const withoutCustom = compileIgnoreRules({ workspacePath });
    const withCustom = compileIgnoreRules({ workspacePath, extraIgnoreFileNames: ['.customignore'] });

    expect(withoutCustom.matchesIgnoreRule('secret-key.ts', 'file')).toBe(false);
    expect(withCustom.matchesIgnoreRule('secret-key.ts', 'file')).toBe(true);
  });

  it('excludes hidden entries by default but allows the hidden allowlist', () => {
    const workspacePath = createTempWorkspace();
    const rules = compileIgnoreRules({ workspacePath });

    expect(rules.isHiddenEntryExcluded('.env')).toBe(true);
    expect(rules.isHiddenEntryExcluded('.mysecret')).toBe(true);
    expect(rules.isHiddenEntryExcluded('.gitignore')).toBe(false);
    expect(rules.isHiddenEntryExcluded('.editorconfig')).toBe(false);
    expect(rules.isHiddenEntryExcluded('readme.md')).toBe(false);
  });

  it('supports programmatic hidden-allowlist and excluded-directory overrides', () => {
    const workspacePath = createTempWorkspace();
    const rules = compileIgnoreRules({
      workspacePath,
      additionalHiddenAllowlist: ['.customdotfile'],
      additionalExcludedDirectoryNames: ['my_custom_excluded_dir'],
    });

    expect(rules.isHiddenEntryExcluded('.customdotfile')).toBe(false);
    expect(rules.isDirectoryNameExcluded('my_custom_excluded_dir')).toBe(true);
  });

  it('produces a deterministic rule fingerprint for identical inputs', () => {
    const workspacePath = createTempWorkspace();
    fs.writeFileSync(path.join(workspacePath, '.gitignore'), '*.log\n!keep.log\n', 'utf-8');

    const first = compileIgnoreRules({ workspacePath });
    const second = compileIgnoreRules({ workspacePath });

    expect(first.ruleFingerprint).toBe(second.ruleFingerprint);
    expect(first.ruleFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the rule fingerprint when ignore-file content changes', () => {
    const workspacePath = createTempWorkspace();
    fs.writeFileSync(path.join(workspacePath, '.gitignore'), '*.log\n', 'utf-8');
    const before = compileIgnoreRules({ workspacePath });

    fs.writeFileSync(path.join(workspacePath, '.gitignore'), '*.log\n*.tmp\n', 'utf-8');
    const after = compileIgnoreRules({ workspacePath });

    expect(before.ruleFingerprint).not.toBe(after.ruleFingerprint);
  });

  it('changes the rule fingerprint when additionalPatterns differ', () => {
    const workspacePath = createTempWorkspace();
    const withoutExtra = compileIgnoreRules({ workspacePath });
    const withExtra = compileIgnoreRules({ workspacePath, additionalPatterns: ['*.custom'] });

    expect(withoutExtra.ruleFingerprint).not.toBe(withExtra.ruleFingerprint);
  });
});
