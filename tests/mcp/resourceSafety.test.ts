import { afterEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MAX_FILE_SIZE_BYTES,
  evaluateContextResourcePolicy,
  formatPolicyReceiptForLog,
} from '../../src/security/contextPolicy.js';
import { assessPathSafety, hasEncodedTraversal } from '../../src/security/pathSafety.js';
import { isSecretLikePath, sanitizeForPolicyLog } from '../../src/security/secretScanner.js';

describe('resource safety policy engine', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createWorkspace(): string {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-policy-workspace-'));
    tempDirs.push(workspace);
    return workspace;
  }

  function writeRelativeFile(workspace: string, relativePath: string, content: string | Buffer): string {
    const fullPath = path.join(workspace, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
    return relativePath.replace(/\\/g, '/');
  }

  it('blocks plain path traversal with a receipt', () => {
    const workspace = createWorkspace();
    const evaluation = evaluateContextResourcePolicy({
      workspaceRoot: workspace,
      requestedPath: '../outside.txt',
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.action).toBe('block');
    expect(evaluation.receipts).toEqual([
      expect.objectContaining({
        policyId: 'context-resource-policy',
        action: 'block',
        reason: 'path_traversal',
        path: '../outside.txt',
      }),
    ]);
  });

  it('blocks encoded traversal attempts', () => {
    expect(hasEncodedTraversal('src/%2e%2e/%2fsecret.txt')).toBe(true);

    const workspace = createWorkspace();
    const evaluation = evaluateContextResourcePolicy({
      workspaceRoot: workspace,
      requestedPath: 'src/%2e%2e/%2fsecret.txt',
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.action).toBe('block');
    expect(evaluation.receipts[0]).toEqual(
      expect.objectContaining({
        reason: 'encoded_traversal',
        action: 'block',
      })
    );
  });

  it('blocks absolute outside-root paths', () => {
    const workspace = createWorkspace();
    const outsidePath = process.platform === 'win32' ? 'C:/outside.txt' : '/etc/passwd';
    const evaluation = evaluateContextResourcePolicy({
      workspaceRoot: workspace,
      requestedPath: outsidePath,
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.action).toBe('block');
    expect(evaluation.receipts[0]?.reason).toBe('outside_root');
  });

  it('blocks symlink escapes that leave the workspace root', () => {
    const workspace = createWorkspace();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-policy-outside-'));
    tempDirs.push(outside);
    const outsideFile = path.join(outside, 'secret.txt');
    const linkPath = path.join(workspace, 'escape-link.txt');
    fs.writeFileSync(outsideFile, 'outside secret', 'utf-8');

    try {
      fs.symlinkSync(outsideFile, linkPath, 'file');
    } catch {
      return;
    }

    const pathAssessment = assessPathSafety(workspace, 'escape-link.txt');
    expect(pathAssessment.safe).toBe(false);
    expect(pathAssessment.reason).toBe('symlink_escape');

    const evaluation = evaluateContextResourcePolicy({
      workspaceRoot: workspace,
      requestedPath: 'escape-link.txt',
    });
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.receipts[0]).toEqual(
      expect.objectContaining({
        reason: 'symlink_escape',
        action: 'block',
      })
    );
  });

  it('blocks secret-like filenames in strict mode', () => {
    const workspace = createWorkspace();
    writeRelativeFile(workspace, '.env', 'DATABASE_URL=postgres://user:pass@localhost/db');

    const evaluation = evaluateContextResourcePolicy({
      workspaceRoot: workspace,
      requestedPath: '.env',
      mode: 'strict',
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.action).toBe('block');
    expect(evaluation.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'secret_like_file',
          action: 'block',
          path: '.env',
        }),
      ])
    );
  });

  it('redacts secret-like filenames in balanced mode', () => {
    const workspace = createWorkspace();
    writeRelativeFile(workspace, 'config/.env.local', 'TOKEN=abc');

    const evaluation = evaluateContextResourcePolicy({
      workspaceRoot: workspace,
      requestedPath: 'config/.env.local',
      mode: 'balanced',
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.action).toBe('redact');
    expect(evaluation.receipts[0]).toEqual(
      expect.objectContaining({
        reason: 'secret_like_file',
        action: 'redact',
      })
    );
  });

  it('blocks large files above the safe size limit', () => {
    const workspace = createWorkspace();
    const largeContent = 'x'.repeat(DEFAULT_MAX_FILE_SIZE_BYTES + 1);
    writeRelativeFile(workspace, 'large.txt', largeContent);

    const evaluation = evaluateContextResourcePolicy({
      workspaceRoot: workspace,
      requestedPath: 'large.txt',
      mode: 'balanced',
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.action).toBe('block');
    expect(evaluation.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'large_file',
          action: 'block',
        }),
      ])
    );
  });

  it('blocks binary files', () => {
    const workspace = createWorkspace();
    writeRelativeFile(workspace, 'binary.bin', Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]));

    const evaluation = evaluateContextResourcePolicy({
      workspaceRoot: workspace,
      requestedPath: 'binary.bin',
      mode: 'balanced',
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.action).toBe('block');
    expect(evaluation.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'binary_file',
          action: 'block',
        }),
      ])
    );
  });

  it('blocks generated files in strict mode', () => {
    const workspace = createWorkspace();
    writeRelativeFile(workspace, 'dist/app.min.js', 'console.log("bundle");');

    const evaluation = evaluateContextResourcePolicy({
      workspaceRoot: workspace,
      requestedPath: 'dist/app.min.js',
      mode: 'strict',
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.action).toBe('block');
    expect(evaluation.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'generated_file',
          action: 'block',
        }),
      ])
    );
  });

  it('redacts generated files in balanced mode and allows them in permissive mode', () => {
    const workspace = createWorkspace();
    writeRelativeFile(workspace, 'node_modules/pkg/index.js', 'module.exports = {};');

    const balanced = evaluateContextResourcePolicy({
      workspaceRoot: workspace,
      requestedPath: 'node_modules/pkg/index.js',
      mode: 'balanced',
    });
    expect(balanced.allowed).toBe(false);
    expect(balanced.action).toBe('redact');
    expect(balanced.receipts[0]?.reason).toBe('generated_file');

    const permissive = evaluateContextResourcePolicy({
      workspaceRoot: workspace,
      requestedPath: 'node_modules/pkg/index.js',
      mode: 'permissive',
    });
    expect(permissive.allowed).toBe(true);
    expect(permissive.action).toBe('allow');
    expect(permissive.receipts).toEqual([]);
  });

  it('redacts files whose content contains secret patterns', () => {
    const workspace = createWorkspace();
    writeRelativeFile(
      workspace,
      'src/config.ts',
      'export const token = "sk-proj-' + 'a'.repeat(90) + '";'
    );

    const evaluation = evaluateContextResourcePolicy({
      workspaceRoot: workspace,
      requestedPath: 'src/config.ts',
      mode: 'balanced',
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.action).toBe('redact');
    expect(evaluation.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'content_secret',
          action: 'redact',
        }),
      ])
    );
  });

  it('allows safe workspace files with no receipts', () => {
    const workspace = createWorkspace();
    writeRelativeFile(workspace, 'src/safe.ts', 'export const answer = 42;');

    const evaluation = evaluateContextResourcePolicy({
      workspaceRoot: workspace,
      requestedPath: 'src/safe.ts',
      mode: 'balanced',
    });

    expect(evaluation.allowed).toBe(true);
    expect(evaluation.action).toBe('allow');
    expect(evaluation.receipts).toEqual([]);
    expect(evaluation.normalizedPath).toBe('src/safe.ts');
  });

  it('does not emit auth headers, tokens, or raw .env content in policy logs', () => {
    const rawEnv = 'OPENAI_API_KEY=sk-proj-' + 'z'.repeat(90);
    const receipt = evaluateContextResourcePolicy({
      workspaceRoot: createWorkspace(),
      requestedPath: '.env',
      mode: 'strict',
    }).receipts[0]!;

    const logged = formatPolicyReceiptForLog({
      ...receipt,
      message: `authorization: Bearer ghp_${'a'.repeat(36)} ${rawEnv}`,
    });

    expect(logged).not.toContain('sk-proj-');
    expect(logged).not.toContain('ghp_');
    expect(logged).not.toContain(rawEnv);
    expect(logged).toMatch(/authorization: \[REDACTED\]/i);
    expect(sanitizeForPolicyLog(rawEnv)).not.toContain('sk-proj-');
    expect(isSecretLikePath('.env')).toBe(true);

    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    console.error(formatPolicyReceiptForLog(receipt));
    const emitted = String(stderrSpy.mock.calls[0]?.[0] ?? '');
    expect(emitted).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
    stderrSpy.mockRestore();
  });
});
