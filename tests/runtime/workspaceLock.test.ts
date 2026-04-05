import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { acquireWorkspaceStartupLock } from '../../src/runtime/workspaceLock.js';

describe('acquireWorkspaceStartupLock', () => {
  it('recovers stale locks for the same workspace', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-workspace-lock-'));
    const lockPath = path.join(workspace, '.context-engine-startup.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 999999,
        created_at: '2020-01-01T00:00:00.000Z',
        workspace_path: workspace,
      }, null, 2),
      'utf8'
    );

    const lock = acquireWorkspaceStartupLock(workspace, { staleLockAgeMs: 1 });
    expect(lock.acquired).toBe(true);
    expect(lock.staleRecovered).toBe(true);
    expect(fs.existsSync(lock.lockPath)).toBe(true);

    lock.release();
    expect(fs.existsSync(lock.lockPath)).toBe(false);
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('warns and continues when the workspace lock is already held', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-workspace-lock-held-'));
    const lockPath = path.join(workspace, '.context-engine-startup.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        created_at: new Date().toISOString(),
        workspace_path: workspace,
      }, null, 2),
      'utf8'
    );

    const lock = acquireWorkspaceStartupLock(workspace);
    expect(lock.acquired).toBe(false);
    expect(lock.warning).toContain('continuing without the guard');
    lock.release();

    fs.rmSync(workspace, { recursive: true, force: true });
  });
});
