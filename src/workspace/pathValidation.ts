import fs from 'node:fs';
import path from 'node:path';

const WINDOWS_DRIVE_PATH_RE = /^[A-Za-z]:/;
const UNC_PATH_RE = /^[\\/]{2}/;

export interface WorkspacePathValidationOptions {
  allowRoot?: boolean;
  rejectOptionLike?: boolean;
}

function hasControlCharacters(value: string): boolean {
  return /[\0\r\n]/.test(value);
}

export function normalizeWorkspaceRelativePath(
  value: string,
  fieldName = 'path',
  options: WorkspacePathValidationOptions = {}
): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${fieldName}: expected a string path relative to the workspace.`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Invalid ${fieldName}: path must not be empty.`);
  }
  if (hasControlCharacters(trimmed)) {
    throw new Error(`Invalid ${fieldName}: path contains control characters.`);
  }
  if (WINDOWS_DRIVE_PATH_RE.test(trimmed) || UNC_PATH_RE.test(trimmed) || path.isAbsolute(trimmed)) {
    throw new Error(
      `Invalid ${fieldName}: absolute or drive-qualified paths are not allowed. Use paths relative to the workspace.`
    );
  }

  const slashNormalized = trimmed.replace(/\\/g, '/');
  const normalized = path.posix.normalize(slashNormalized);
  if (normalized === '.' && !options.allowRoot) {
    throw new Error(`Invalid ${fieldName}: path must reference a file or nested workspace path.`);
  }
  if (normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('..')) {
    throw new Error(`Invalid ${fieldName}: path traversal is not allowed.`);
  }
  if (options.rejectOptionLike && normalized.startsWith('-')) {
    throw new Error(`Invalid ${fieldName}: option-like paths are not allowed.`);
  }

  return normalized;
}

export function normalizeWorkspaceRelativePaths(
  values: readonly string[] | undefined,
  fieldName = 'paths',
  options: WorkspacePathValidationOptions = {}
): string[] {
  return (values ?? []).map((value, index) =>
    normalizeWorkspaceRelativePath(value, `${fieldName}[${index}]`, options)
  );
}

export function resolveWorkspaceRelativePath(
  workspacePath: string,
  value: string,
  fieldName = 'path',
  options: WorkspacePathValidationOptions = {}
): string {
  const normalized = normalizeWorkspaceRelativePath(value, fieldName, options);
  const workspaceRoot = path.resolve(workspacePath);
  const resolved = path.resolve(workspaceRoot, normalized);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Invalid ${fieldName}: path must be within workspace.`);
  }
  return resolved;
}

export function assertPathInsideWorkspace(workspaceRoot: string, candidatePath: string, fieldName = 'path'): void {
  const relative = path.relative(workspaceRoot, candidatePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Invalid ${fieldName}: path must be within workspace.`);
  }
}

export function resolveRealPathInsideWorkspace(
  workspacePath: string,
  candidatePath: string,
  fieldName = 'path'
): string {
  const workspaceRealPath = fs.realpathSync(workspacePath);
  const candidateRealPath = fs.realpathSync(candidatePath);
  assertPathInsideWorkspace(workspaceRealPath, candidateRealPath, fieldName);
  return candidateRealPath;
}
