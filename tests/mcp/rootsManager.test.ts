import { afterEach, describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ContextServiceClient } from '../../src/mcp/serviceClient.js';
import {
  readPolicyEnforcedFileResource,
} from '../../src/mcp/resources/policyEnforcedReads.js';
import { evaluateContextResourcePolicy } from '../../src/security/contextPolicy.js';
import {
  RootsManager,
  parseFileRootUri,
} from '../../src/mcp/roots/rootsManager.js';

function toFileUri(absolutePath: string): string {
  const normalized = path.resolve(absolutePath).replace(/\\/g, '/');
  return process.platform === 'win32'
    ? `file:///${normalized}`
    : `file://${normalized}`;
}

describe('RootsManager', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function createWorkspace(layout: Record<string, string>): string {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roots-manager-'));
    tempDirs.push(workspaceDir);

    for (const [relativePath, contents] of Object.entries(layout)) {
      const fullPath = path.join(workspaceDir, relativePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, contents, 'utf-8');
    }

    return workspaceDir;
  }

  it('keeps single-workspace compatibility when no roots are negotiated', () => {
    const workspaceDir = createWorkspace({
      'src/allowed.ts': 'export const allowed = true;\n',
      'docs/readme.md': '# readme\n',
    });
    const manager = new RootsManager(workspaceDir);

    expect(manager.isRootsSupported()).toBe(false);
    expect(manager.isEnforcementActive()).toBe(false);
    expect(manager.getIndexingRoots()).toEqual([path.resolve(workspaceDir)]);
    expect(manager.isRelativePathAllowed('src/allowed.ts')).toBe(true);
    expect(manager.isRelativePathAllowed('docs/readme.md')).toBe(true);
  });

  it('ignores roots updates from unsupported clients', () => {
    const workspaceDir = createWorkspace({
      'src/allowed.ts': 'export const allowed = true;\n',
    });
    const manager = new RootsManager(workspaceDir);
    manager.configureFromClientCapabilities({});

    const updateResult = manager.updateRoots([
      { uri: toFileUri(path.join(workspaceDir, 'src')) },
    ]);

    expect(updateResult.accepted).toBe(false);
    expect(updateResult.reason).toBe('unsupported');
    expect(manager.isEnforcementActive()).toBe(false);
    expect(manager.getAllowedRoots()).toEqual([]);
  });

  it('rejects roots outside the workspace boundary', () => {
    const workspaceDir = createWorkspace({
      'src/allowed.ts': 'export const allowed = true;\n',
    });
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roots-outside-'));
    tempDirs.push(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'outside.ts'), 'export const outside = true;\n', 'utf-8');

    const manager = new RootsManager(workspaceDir);
    manager.configureFromClientCapabilities({ roots: { listChanged: true } });

    const updateResult = manager.updateRoots([
      { uri: toFileUri(path.join(workspaceDir, 'src')) },
      { uri: toFileUri(outsideDir) },
    ]);

    expect(updateResult.accepted).toBe(true);
    expect(updateResult.rejectedRoots).toHaveLength(1);
    expect(updateResult.rejectedRoots[0]?.reason).toBe('outside_workspace');
    expect(manager.getAllowedRoots()).toEqual([path.resolve(workspaceDir, 'src')]);
    expect(manager.isRelativePathAllowed('src/allowed.ts')).toBe(true);
    expect(manager.isRelativePathAllowed('../outside/outside.ts')).toBe(false);
  });

  it('allows overlapping roots without dropping nested paths', () => {
    const workspaceDir = createWorkspace({
      'src/nested/deep.ts': 'export const deep = true;\n',
      'src/other.ts': 'export const other = true;\n',
    });
    const manager = new RootsManager(workspaceDir);
    manager.configureFromClientCapabilities({ roots: { listChanged: true } });

    manager.updateRoots([
      { uri: toFileUri(path.join(workspaceDir, 'src')) },
      { uri: toFileUri(path.join(workspaceDir, 'src', 'nested')) },
    ]);

    expect(manager.getAllowedRoots()).toEqual([
      path.resolve(workspaceDir, 'src'),
      path.resolve(workspaceDir, 'src', 'nested'),
    ]);
    expect(manager.isRelativePathAllowed('src/nested/deep.ts')).toBe(true);
    expect(manager.isRelativePathAllowed('src/other.ts')).toBe(true);
  });

  it('blocks symlink escape outside negotiated roots', () => {
    const workspaceDir = createWorkspace({
      'src/allowed.ts': 'export const allowed = true;\n',
    });
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roots-escape-'));
    tempDirs.push(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'secret.ts'), 'export const secret = true;\n', 'utf-8');

    const linkPath = path.join(workspaceDir, 'src', 'escape-link.ts');
    fs.symlinkSync(path.join(outsideDir, 'secret.ts'), linkPath);

    const manager = new RootsManager(workspaceDir);
    manager.configureFromClientCapabilities({ roots: { listChanged: true } });
    manager.updateRoots([{ uri: toFileUri(path.join(workspaceDir, 'src')) }]);

    expect(manager.isRelativePathAllowed('src/allowed.ts')).toBe(true);
    expect(manager.isRelativePathAllowed('src/escape-link.ts')).toBe(false);
  });

  it('enforces roots during indexing and resource policy reads', async () => {
    const workspaceDir = createWorkspace({
      'src/allowed.ts': 'export const allowed = true;\n',
      'docs/blocked.md': '# blocked\n',
    });
    const manager = new RootsManager(workspaceDir);
    manager.configureFromClientCapabilities({ roots: { listChanged: true } });
    manager.updateRoots([{ uri: toFileUri(path.join(workspaceDir, 'src')) }]);

    const serviceClient = new ContextServiceClient(workspaceDir);
    serviceClient.setRootsManager(manager);

    const allowedEvaluation = evaluateContextResourcePolicy({
      workspaceRoot: workspaceDir,
      requestedPath: 'src/allowed.ts',
      allowedRoots: manager.getAllowedRootsForPolicy(),
    });
    const blockedEvaluation = evaluateContextResourcePolicy({
      workspaceRoot: workspaceDir,
      requestedPath: 'docs/blocked.md',
      allowedRoots: manager.getAllowedRootsForPolicy(),
    });

    expect(allowedEvaluation.allowed).toBe(true);
    expect(blockedEvaluation.allowed).toBe(false);
    expect(blockedEvaluation.receipts[0]?.reason).toBe('outside_client_root');

    expect(() =>
      readPolicyEnforcedFileResource(
        `context-engine://files/${encodeURIComponent('docs/blocked.md')}`,
        {
          workspaceRoot: workspaceDir,
          allowedRoots: manager.getAllowedRootsForPolicy(),
        }
      )
    ).toThrow(/blocked by context policy/i);

    const discoverWorkspaceFiles = (serviceClient as unknown as {
      discoverWorkspaceFiles: () => Promise<string[]>;
    }).discoverWorkspaceFiles.bind(serviceClient);
    await expect(discoverWorkspaceFiles()).resolves.toEqual([path.join('src', 'allowed.ts')]);
    expect(manager.filterAllowedRelativePaths(['src/allowed.ts', 'docs/blocked.md'])).toEqual([
      'src/allowed.ts',
    ]);
  });

  it('parses file root URIs for the current platform', () => {
    const absolutePath = path.join(os.tmpdir(), 'project', 'src');
    expect(parseFileRootUri(toFileUri(absolutePath))).toBe(path.normalize(absolutePath));
    expect(parseFileRootUri('https://example.com/not-a-root')).toBeNull();
  });
});
