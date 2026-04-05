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
