import * as fs from 'fs';
import * as path from 'path';

export interface WorkspaceStartupLock {
  acquired: boolean;
  lockPath: string;
  warning?: string;
  staleRecovered?: boolean;
  release: () => void;
}

const LOCK_FILE_NAME = '.context-engine-startup.lock';
const DEFAULT_STALE_LOCK_AGE_MS = 30 * 60 * 1000;

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function buildLockPayload(workspacePath: string): { pid: number; created_at: string; workspace_path: string } {
  return {
    pid: process.pid,
    created_at: new Date().toISOString(),
    workspace_path: path.resolve(workspacePath),
  };
}

export function acquireWorkspaceStartupLock(
  workspacePath: string,
  options?: { staleLockAgeMs?: number }
): WorkspaceStartupLock {
  const lockPath = path.join(workspacePath, LOCK_FILE_NAME);
  const staleLockAgeMs = options?.staleLockAgeMs ?? DEFAULT_STALE_LOCK_AGE_MS;
  const payload = buildLockPayload(workspacePath);

  try {
    if (fs.existsSync(lockPath)) {
      try {
        const raw = fs.readFileSync(lockPath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<{ pid: number; created_at: string; workspace_path: string }>;
        const createdAt = typeof parsed.created_at === 'string' ? Date.parse(parsed.created_at) : NaN;
        const ageMs = Number.isFinite(createdAt) ? Date.now() - createdAt : Number.POSITIVE_INFINITY;
        const pid = typeof parsed.pid === 'number' ? parsed.pid : -1;
        const workspaceMatches =
          typeof parsed.workspace_path === 'string' && path.resolve(parsed.workspace_path) === path.resolve(workspacePath);
        const stale = ageMs > staleLockAgeMs || !workspaceMatches || !isPidAlive(pid);

        if (!stale) {
          return {
            acquired: false,
            lockPath,
            warning: `[startup-lock] Workspace startup lock already held by pid ${pid}; continuing without the guard for ${path.basename(workspacePath) || workspacePath}.`,
            release: () => undefined,
          };
        }

        fs.writeFileSync(lockPath, JSON.stringify(payload, null, 2), 'utf8');
        return {
          acquired: true,
          lockPath,
          staleRecovered: true,
          release: () => {
            try {
              const current = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<{ pid: number }>;
              if (current.pid === process.pid) {
                fs.unlinkSync(lockPath);
              }
            } catch {
              // Best-effort cleanup.
            }
          },
        };
      } catch {
        fs.writeFileSync(lockPath, JSON.stringify(payload, null, 2), 'utf8');
        return {
          acquired: true,
          lockPath,
          staleRecovered: true,
          release: () => {
            try {
              fs.unlinkSync(lockPath);
            } catch {
              // Best-effort cleanup.
            }
          },
        };
      }
    }

    fs.writeFileSync(lockPath, JSON.stringify(payload, null, 2), 'utf8');
    return {
      acquired: true,
      lockPath,
      release: () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Best-effort cleanup.
        }
      },
    };
  } catch {
    return {
      acquired: false,
      lockPath,
      warning: `[startup-lock] Unable to create workspace startup lock at ${lockPath}; continuing without the guard.`,
      release: () => undefined,
    };
  }
}
