import { minimatch } from 'minimatch';

export interface PathScopeInput {
  includePaths?: string[];
  excludePaths?: string[];
}

export interface NormalizedPathScope {
  includePaths?: string[];
  excludePaths?: string[];
}

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
const UNC_ABSOLUTE_PATH = /^\\\\/;
const PATH_TRAVERSAL_SEGMENT = /(^|\/)\.\.(\/|$)/;
const IS_WINDOWS_WORKSPACE = process.platform === 'win32';

function normalizeScopePattern(rawPattern: string, fieldName: 'include_paths' | 'exclude_paths'): string {
  const trimmed = rawPattern.trim();
  if (!trimmed) {
    throw new Error(`Invalid ${fieldName} entry: patterns must be non-empty strings`);
  }

  let normalized = trimmed.replace(/\\/g, '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  normalized = normalized.replace(/\/{2,}/g, '/');

  if (!normalized) {
    throw new Error(`Invalid ${fieldName} entry: patterns must be workspace-relative globs`);
  }
  if (normalized.startsWith('/') || WINDOWS_ABSOLUTE_PATH.test(normalized) || UNC_ABSOLUTE_PATH.test(trimmed)) {
    throw new Error(`Invalid ${fieldName} entry "${rawPattern}": absolute paths are not allowed`);
  }
  if (PATH_TRAVERSAL_SEGMENT.test(normalized)) {
    throw new Error(`Invalid ${fieldName} entry "${rawPattern}": path traversal is not allowed`);
  }

  if (normalized.endsWith('/')) {
    normalized = `${normalized.slice(0, -1)}/**`;
  }

  return normalized;
}

function normalizeScopeList(
  values: string[] | undefined,
  fieldName: 'include_paths' | 'exclude_paths'
): string[] | undefined {
  if (values === undefined) {
    return undefined;
  }
  if (!Array.isArray(values)) {
    throw new Error(`Invalid ${fieldName} parameter: must be an array of workspace-relative glob strings`);
  }

  const normalized = Array.from(
    new Set(
      values.map((value) => {
        if (typeof value !== 'string') {
          throw new Error(`Invalid ${fieldName} entry: patterns must be strings`);
        }
        return normalizeScopePattern(value, fieldName);
      })
    )
  ).sort((left, right) => left.localeCompare(right));

  return normalized.length > 0 ? normalized : undefined;
}

export function normalizePathScopeInput(scope?: PathScopeInput): NormalizedPathScope {
  if (!scope) {
    return {};
  }

  return {
    includePaths: normalizeScopeList(scope.includePaths, 'include_paths'),
    excludePaths: normalizeScopeList(scope.excludePaths, 'exclude_paths'),
  };
}

export function scopeApplied(scope?: PathScopeInput | NormalizedPathScope): boolean {
  return (scope?.includePaths?.length ?? 0) > 0 || (scope?.excludePaths?.length ?? 0) > 0;
}

export function serializeNormalizedPathScope(scope?: PathScopeInput | NormalizedPathScope): string {
  const normalized = normalizePathScopeInput(scope);
  return JSON.stringify({
    includePaths: normalized.includePaths ?? [],
    excludePaths: normalized.excludePaths ?? [],
  });
}

export function normalizeWorkspaceRelativePathForScope(filePath: string): string {
  let normalized = filePath.replace(/\\/g, '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) =>
    minimatch(filePath, pattern, {
      dot: true,
      nocase: IS_WINDOWS_WORKSPACE,
      matchBase: !pattern.includes('/'),
    })
  );
}

export function matchesNormalizedPathScope(
  filePath: string,
  scope?: PathScopeInput | NormalizedPathScope
): boolean {
  const normalizedScope = normalizePathScopeInput(scope);
  if (!scopeApplied(normalizedScope)) {
    return true;
  }

  const normalizedPath = normalizeWorkspaceRelativePathForScope(filePath);
  const includePaths = normalizedScope.includePaths ?? [];
  const excludePaths = normalizedScope.excludePaths ?? [];

  if (includePaths.length > 0 && !matchesAnyPattern(normalizedPath, includePaths)) {
    return false;
  }
  if (excludePaths.length > 0 && matchesAnyPattern(normalizedPath, excludePaths)) {
    return false;
  }

  return true;
}

export function filterEntriesByPathScope<T extends { path: string }>(
  entries: T[],
  scope?: PathScopeInput | NormalizedPathScope
): T[] {
  if (!scopeApplied(scope)) {
    return entries;
  }
  const normalizedScope = normalizePathScopeInput(scope);
  return entries.filter((entry) => matchesNormalizedPathScope(entry.path, normalizedScope));
}
