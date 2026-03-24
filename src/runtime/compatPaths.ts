import * as fs from 'fs';
import * as path from 'path';

export type CompatiblePathSpec = {
  preferred: string;
  legacy?: string;
};

export function getPreferredWorkspacePath(workspaceRoot: string, spec: CompatiblePathSpec): string {
  return path.join(workspaceRoot, spec.preferred);
}

export function getReadableWorkspacePath(workspaceRoot: string, spec: CompatiblePathSpec): string {
  const preferredPath = getPreferredWorkspacePath(workspaceRoot, spec);
  if (fs.existsSync(preferredPath)) {
    return preferredPath;
  }

  if (spec.legacy) {
    const legacyPath = path.join(workspaceRoot, spec.legacy);
    if (fs.existsSync(legacyPath)) {
      return legacyPath;
    }
  }

  return preferredPath;
}

export function getPreferredWorkspaceDirectory(workspaceRoot: string, spec: CompatiblePathSpec): string {
  return getPreferredWorkspacePath(workspaceRoot, spec);
}

export function getReadableWorkspaceDirectory(workspaceRoot: string, spec: CompatiblePathSpec): string {
  return getReadableWorkspacePath(workspaceRoot, spec);
}
