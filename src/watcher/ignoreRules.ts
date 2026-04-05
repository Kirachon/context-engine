export function normalizeIgnoredPatterns(
  workspacePath: string,
  ignorePatterns: string[],
  excludedDirs: string[]
): (string | RegExp)[] {
  const normalizedWorkspacePath = workspacePath.replace(/\\/g, '/');

  return [
    ...excludedDirs.map((dir) => `**/${dir}/**`),
    ...ignorePatterns.map((pattern) => {
      if (pattern.startsWith('/')) {
        return `${normalizedWorkspacePath}${pattern}`;
      }
      if (pattern.endsWith('/')) {
        return `**/${pattern}**`;
      }
      return `**/${pattern}`;
    }),
  ];
}
