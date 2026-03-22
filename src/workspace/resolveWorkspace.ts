import * as fs from 'fs';
import * as path from 'path';

export type WorkspaceResolutionSource =
  | 'explicit'
  | 'cwd'
  | 'git-root-fallback'
  | 'cwd-fallback';

export interface WorkspaceResolutionResult {
  workspacePath: string;
  source: WorkspaceResolutionSource;
  warning?: string;
}

export interface ResolveWorkspaceOptions {
  explicitWorkspace?: string | null;
  cwd?: string;
  findGitRoot?: (startDir: string) => Promise<string | null>;
  logWarning?: (message: string) => void;
}

export async function resolveWorkspacePath(
  options: ResolveWorkspaceOptions = {}
): Promise<WorkspaceResolutionResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const explicitWorkspace = options.explicitWorkspace?.trim();

  if (explicitWorkspace) {
    return {
      workspacePath: path.resolve(explicitWorkspace),
      source: 'explicit',
    };
  }

  const gitRoot = await (options.findGitRoot ?? findNearestGitRoot)(cwd);
  if (gitRoot) {
    const resolvedGitRoot = path.resolve(gitRoot);
    if (pathsEqual(resolvedGitRoot, cwd)) {
      return {
        workspacePath: cwd,
        source: 'cwd',
      };
    }

    return {
      workspacePath: resolvedGitRoot,
      source: 'git-root-fallback',
    };
  }

  const warning = `[context-engine] Warning: No git root found for ${cwd}; using current directory as workspace.`;
  options.logWarning?.(warning);

  return {
    workspacePath: cwd,
    source: 'cwd-fallback',
    warning,
  };
}

export async function findNearestGitRoot(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);

  while (true) {
    if (await hasGitMarker(current)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function hasGitMarker(dirPath: string): Promise<boolean> {
  const gitPath = path.join(dirPath, '.git');

  try {
    const stat = await fs.promises.stat(gitPath);
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

function pathsEqual(left: string, right: string): boolean {
  const normalizedLeft = normalizeComparablePath(left);
  const normalizedRight = normalizeComparablePath(right);
  return normalizedLeft === normalizedRight;
}

function normalizeComparablePath(value: string): string {
  const normalized = path.normalize(path.resolve(value)).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
