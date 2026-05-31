import fs from 'node:fs';
import path from 'node:path';
import {
  assertPathInsideWorkspace,
  normalizeWorkspaceRelativePath,
  resolveRealPathInsideWorkspace,
  resolveWorkspaceRelativePath,
} from '../workspace/pathValidation.js';

export type PathSafetyReason =
  | 'path_traversal'
  | 'encoded_traversal'
  | 'outside_root'
  | 'outside_client_root'
  | 'symlink_escape';

export interface PathSafetyAssessment {
  safe: boolean;
  reason?: PathSafetyReason;
  normalizedPath?: string;
  resolvedPath?: string;
  message?: string;
}

const ENCODED_TRAVERSAL_RE = /(?:^|[\\/])%2e%2e(?:%2f|%5c|$)|(?:^|[\\/])%2e%2e(?:[\\/]|$)/i;

function decodePathSegments(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      const next = decodeURIComponent(decoded.replace(/\+/g, ' '));
      if (next === decoded) {
        break;
      }
      decoded = next;
    } catch {
      return value;
    }
  }
  return decoded;
}

export function hasEncodedTraversal(value: string): boolean {
  if (!/%[0-9a-f]{2}/i.test(value)) {
    return false;
  }

  if (ENCODED_TRAVERSAL_RE.test(value)) {
    return true;
  }

  const decoded = decodePathSegments(value);
  const slashNormalized = decoded.replace(/\\/g, '/');
  const normalized = path.posix.normalize(slashNormalized);
  return normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('..');
}

function mapPathValidationError(message: string): PathSafetyReason {
  if (/traversal/i.test(message)) {
    return 'path_traversal';
  }
  return 'outside_root';
}

function isPathInsideAllowedRoots(candidatePath: string, allowedRoots: readonly string[]): boolean {
  const resolvedCandidate = path.resolve(candidatePath);
  return allowedRoots.some((rootPath) => {
    const relative = path.relative(path.resolve(rootPath), resolvedCandidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

export function assessPathSafety(
  workspaceRoot: string,
  requestedPath: string,
  fieldName = 'path',
  allowedRoots?: readonly string[]
): PathSafetyAssessment {
  if (hasEncodedTraversal(requestedPath)) {
    return {
      safe: false,
      reason: 'encoded_traversal',
      message: `Invalid ${fieldName}: encoded path traversal is not allowed.`,
    };
  }

  let normalizedPath: string;
  try {
    normalizedPath = normalizeWorkspaceRelativePath(requestedPath, fieldName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      safe: false,
      reason: mapPathValidationError(message),
      message,
    };
  }

  let resolvedPath: string;
  try {
    resolvedPath = resolveWorkspaceRelativePath(workspaceRoot, normalizedPath, fieldName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      safe: false,
      reason: 'outside_root',
      normalizedPath,
      message,
    };
  }

  if (!fs.existsSync(resolvedPath)) {
    try {
      assertPathInsideWorkspace(path.resolve(workspaceRoot), resolvedPath, fieldName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        safe: false,
        reason: 'outside_root',
        normalizedPath,
        resolvedPath,
        message,
      };
    }

    if (allowedRoots && allowedRoots.length > 0 && !isPathInsideAllowedRoots(resolvedPath, allowedRoots)) {
      return {
        safe: false,
        reason: 'outside_client_root',
        normalizedPath,
        resolvedPath,
        message: `Invalid ${fieldName}: path is outside client-provided roots.`,
      };
    }

    return {
      safe: true,
      normalizedPath,
      resolvedPath,
    };
  }

  try {
    assertPathInsideWorkspace(path.resolve(workspaceRoot), resolvedPath, fieldName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      safe: false,
      reason: 'outside_root',
      normalizedPath,
      resolvedPath,
      message,
    };
  }

  try {
    const safeResolvedPath = resolveRealPathInsideWorkspace(workspaceRoot, resolvedPath, fieldName);
    if (allowedRoots && allowedRoots.length > 0 && !isPathInsideAllowedRoots(safeResolvedPath, allowedRoots)) {
      return {
        safe: false,
        reason: 'outside_client_root',
        normalizedPath,
        resolvedPath: safeResolvedPath,
        message: `Invalid ${fieldName}: path is outside client-provided roots.`,
      };
    }

    return {
      safe: true,
      normalizedPath,
      resolvedPath: safeResolvedPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      safe: false,
      reason: 'symlink_escape',
      normalizedPath,
      resolvedPath,
      message: message.includes('within workspace')
        ? `Invalid ${fieldName}: symlink target escapes workspace root.`
        : message,
    };
  }
}
