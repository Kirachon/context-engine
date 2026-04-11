const STOPWORDS = new Set([
  'and',
  'the',
  'for',
  'with',
  'from',
  'that',
  'this',
  'where',
  'what',
  'when',
  'why',
  'how',
  'is',
  'are',
  'of',
  'to',
  'in',
  'on',
  'at',
  'by',
]);

const TEST_HINT_TOKENS = new Set([
  'test',
  'tests',
  'spec',
  'specs',
]);

const CODE_PATH_PATTERN = /\.(?:c|cc|cpp|cs|dart|go|h|hpp|java|js|jsx|kt|m|mjs|cjs|php|ps1|py|rb|rs|scala|sh|sql|swift|ts|tsx)$/i;

export function normalizeSearchText(input: string): string {
  return input.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function tokenizeSearchInput(input: string): string[] {
  return Array.from(
    new Set(
      normalizeSearchText(input)
        .split(/[^a-z0-9_./-]+/g)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && !STOPWORDS.has(token))
    )
  );
}

export function splitIdentifierParts(input: string): string[] {
  return Array.from(
    new Set(
      input
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/g)
        .map((token) => token.trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

export function extractSymbolTokens(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(/[^A-Za-z0-9_./-]+/g)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && (/[A-Z_]/.test(token) || token.length >= 12))
        .map((token) => token.toLowerCase())
    )
  );
}

export function isIdentifierLikeQuery(input: string): boolean {
  return input
    .split(/[^A-Za-z0-9_./-]+/g)
    .map((token) => token.trim())
    .filter(Boolean)
    .some((token) => /[A-Z_]/.test(token) || token.length >= 12);
}

export function extractIdentifierCandidates(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(/[^A-Za-z0-9_./\\-]+/g)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3)
        .filter((token) => (
          /[A-Z]/.test(token)
          || token.includes('_')
          || token.includes('-')
          || token.includes('/')
          || token.includes('\\')
          || token.includes('.')
        ))
    )
  );
}

function stripIdentifierDecorators(input: string): string {
  const normalizedPath = input.replace(/\\/g, '/').trim();
  const basename = normalizedPath.split('/').pop() ?? normalizedPath;
  let value = basename;
  while (/\.[A-Za-z0-9]+$/.test(value)) {
    value = value.replace(/\.[A-Za-z0-9]+$/, '');
  }
  return value.replace(/\.(test|spec)$/i, '');
}

function normalizeIdentifier(input: string): string {
  return splitIdentifierParts(input)
    .filter((token) => !TEST_HINT_TOKENS.has(token))
    .join(' ');
}

export function selectPrimaryIdentifierCandidate(input: string): string | null {
  const candidates = extractIdentifierCandidates(input);
  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => {
    const leftNormalized = normalizeIdentifier(stripIdentifierDecorators(left));
    const rightNormalized = normalizeIdentifier(stripIdentifierDecorators(right));
    const leftPartCount = leftNormalized ? leftNormalized.split(' ').length : 0;
    const rightPartCount = rightNormalized ? rightNormalized.split(' ').length : 0;
    if (rightPartCount !== leftPartCount) {
      return rightPartCount - leftPartCount;
    }
    return right.length - left.length;
  });

  return candidates[0] ?? null;
}

export interface IdentifierPathSignals {
  isIdentifierQuery: boolean;
  exactBasenameMatch: boolean;
  pathTokenCoverage: number;
  isTestPath: boolean;
  queryMentionsTest: boolean;
  isArtifactPath: boolean;
  isConfigPath: boolean;
  isJsonPath: boolean;
  isCodePath: boolean;
  isScriptPath: boolean;
}

export function buildIdentifierPathSignals(query: string, path: string): IdentifierPathSignals {
  const primaryIdentifier = selectPrimaryIdentifierCandidate(query);
  const normalizedIdentifier = primaryIdentifier
    ? normalizeIdentifier(stripIdentifierDecorators(primaryIdentifier))
    : '';
  const identifierParts = normalizedIdentifier.split(' ').filter(Boolean);
  const pathParts = new Set(splitIdentifierParts(path));
  let matchedParts = 0;
  for (const part of identifierParts) {
    if (pathParts.has(part)) {
      matchedParts += 1;
    }
  }

  const normalizedPath = path.replace(/\\/g, '/').toLowerCase();
  const normalizedBasename = normalizeIdentifier(stripIdentifierDecorators(path));
  const isArtifactPath = normalizedPath.startsWith('artifacts/');
  const isConfigPath = normalizedPath.startsWith('config/');
  const isJsonPath = normalizedPath.endsWith('.json') || normalizedPath.endsWith('.jsonc');
  const isScriptPath = normalizedPath.startsWith('scripts/')
    || normalizedPath.endsWith('.sh')
    || normalizedPath.endsWith('.ps1');
  const isCodePath = CODE_PATH_PATTERN.test(normalizedPath) || normalizedPath.startsWith('src/') || isScriptPath;

  return {
    isIdentifierQuery: identifierParts.length > 0,
    exactBasenameMatch: identifierParts.length > 0 && normalizedBasename === normalizedIdentifier,
    pathTokenCoverage: identifierParts.length > 0 ? matchedParts / identifierParts.length : 0,
    isTestPath: normalizedPath.includes('/__tests__/')
      || normalizedPath.includes('/tests/')
      || normalizedPath.includes('/test/')
      || /\.test\./.test(normalizedPath)
      || /\.spec\./.test(normalizedPath),
    queryMentionsTest: splitIdentifierParts(query).some((token) => TEST_HINT_TOKENS.has(token)),
    isArtifactPath,
    isConfigPath,
    isJsonPath,
    isCodePath,
    isScriptPath,
  };
}

export function computeExactMatchBoost(params: {
  query: string;
  path: string;
  content: string;
  lines?: string;
  chunkId?: string;
}): number {
  const normalizedQuery = normalizeSearchText(params.query);
  if (!normalizedQuery) {
    return 0;
  }

  const haystack = normalizeSearchText([
    params.path,
    params.chunkId ?? '',
    params.lines ?? '',
    params.content,
  ].join('\n'));

  let score = 0;
  if (haystack.includes(normalizedQuery)) {
    score += 8;
  }

  const queryTokens = tokenizeSearchInput(params.query);
  const symbolTokens = extractSymbolTokens(params.query);

  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      score += 1.5;
    }
  }

  for (const symbol of symbolTokens) {
    if (haystack.includes(symbol)) {
      score += 3.5;
    }
  }

  if (isIdentifierLikeQuery(params.query)) {
    if (haystack.includes(params.path.toLowerCase())) {
      score += 1.25;
    }
    if (params.chunkId && haystack.includes(params.chunkId.toLowerCase())) {
      score += 1;
    }
  }

  return score;
}
