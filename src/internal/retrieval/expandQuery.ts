import { ExpandedQuery, RetrievalProfile, RetrievalRewriteMode } from './types.js';
import {
  selectPrimaryIdentifierCandidate,
  splitIdentifierParts,
} from './searchHeuristics.js';

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'to',
  'for',
  'of',
  'in',
  'on',
  'with',
  'by',
  'is',
  'are',
  'be',
  'from',
  'at',
  'as',
  'it',
  'this',
  'that',
  'these',
  'those',
  'how',
  'what',
  'where',
  'when',
  'why',
]);

const SYNONYMS: Record<string, string[]> = {
  auth: ['authentication', 'authorization'],
  login: ['sign-in', 'signin'],
  log: ['logging'],
  config: ['configuration'],
  cfg: ['configuration'],
  db: ['database'],
  repo: ['repository'],
  svc: ['service'],
  util: ['utility'],
  api: ['endpoint'],
  err: ['error'],
  msg: ['message'],
};

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9_./\\-]+/g)
    .map(token => token.trim())
    .filter(Boolean);
}

type ExpandQueryOptions = {
  mode?: RetrievalRewriteMode;
  profile?: RetrievalProfile;
};

const PROFILE_VARIANT_CAP: Record<RetrievalProfile, number> = {
  fast: 2,
  balanced: 4,
  rich: 6,
};

const EXPAND_QUERY_CACHE_VERSION = 'v1';
const MAX_EXPAND_QUERY_CACHE_ENTRIES = 256;
const expandQueryCache = new Map<string, ExpandedQuery[]>();

function isLikelyCodeLike(input: string): boolean {
  if (/[`{}()[\];<>]/.test(input)) {
    return true;
  }
  const slashOrPathHits = (input.match(/[\\/]/g) ?? []).length;
  const camelHits = (input.match(/[a-z][A-Z]/g) ?? []).length;
  return slashOrPathHits >= 2 || camelHits >= 2;
}

function isLikelySymbolToken(token: string): boolean {
  return token.includes('_')
    || token.includes('-')
    || token.includes('/')
    || token.includes('\\')
    || token.includes('.')
    || /[a-z][A-Z]/.test(token)
    || /\d/.test(token);
}

function cloneExpandedQueries(queries: ExpandedQuery[]): ExpandedQuery[] {
  return queries.map((query) => ({ ...query }));
}

function readExpandQueryCache(key: string): ExpandedQuery[] | null {
  const cached = expandQueryCache.get(key);
  if (!cached) {
    return null;
  }

  expandQueryCache.delete(key);
  expandQueryCache.set(key, cached);
  return cloneExpandedQueries(cached);
}

function writeExpandQueryCache(key: string, queries: ExpandedQuery[]): ExpandedQuery[] {
  expandQueryCache.set(key, cloneExpandedQueries(queries));
  while (expandQueryCache.size > MAX_EXPAND_QUERY_CACHE_ENTRIES) {
    const oldestKey = expandQueryCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    expandQueryCache.delete(oldestKey);
  }
  return cloneExpandedQueries(queries);
}

export function clearExpandQueryCacheForTests(): void {
  expandQueryCache.clear();
}

export function getExpandQueryCacheSizeForTests(): number {
  return expandQueryCache.size;
}

export function expandQuery(
  query: string,
  maxVariants: number = 4,
  options: ExpandQueryOptions = {}
): ExpandedQuery[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const mode: RetrievalRewriteMode = options.mode ?? 'v1';
  const profile: RetrievalProfile = options.profile ?? 'balanced';
  const effectiveMaxVariants = mode === 'v2'
    ? Math.max(1, Math.min(maxVariants, PROFILE_VARIANT_CAP[profile]))
    : maxVariants;
  const cacheKey = `${EXPAND_QUERY_CACHE_VERSION}:${mode}:${profile}:${effectiveMaxVariants}:${trimmed}`;
  const cached = readExpandQueryCache(cacheKey);
  if (cached) {
    return cached;
  }

  const variants = new Map<string, ExpandedQuery>();
  const addVariant = (value: string, source: ExpandedQuery['source'], weight: number) => {
    const normalized = value.trim();
    if (!normalized) {
      return;
    }
    const key = normalized.toLowerCase();
    if (variants.has(key)) {
      return;
    }
    variants.set(key, {
      query: normalized,
      source,
      weight,
      index: variants.size,
    });
  };
  const finalize = () => writeExpandQueryCache(
    cacheKey,
    Array.from(variants.values()).slice(0, effectiveMaxVariants)
  );

  addVariant(trimmed, 'original', 1);

  if (effectiveMaxVariants <= 1) {
    return finalize();
  }

  if (/[`]/.test(trimmed) || trimmed.length > 200) {
    return finalize();
  }

  if (mode === 'v2' && isLikelyCodeLike(trimmed)) {
    return finalize();
  }

  const primaryIdentifier = selectPrimaryIdentifierCandidate(trimmed);
  const normalizedPrimaryIdentifier = primaryIdentifier?.trim().toLowerCase() ?? null;
  const tokens = tokenize(trimmed);
  const coreTokens = tokens.filter(token => !STOPWORDS.has(token));
  if (primaryIdentifier) {
    addVariant(primaryIdentifier, 'expanded', 0.82);

    const identifierFocusedTokens = [
      ...splitIdentifierParts(primaryIdentifier),
      ...coreTokens
        .filter((token) => token !== normalizedPrimaryIdentifier)
        .flatMap((token) => splitIdentifierParts(token)),
    ];
    if (identifierFocusedTokens.length > 0) {
      addVariant(identifierFocusedTokens.join(' '), 'expanded', 0.74);
    }
  }

  if (tokens.length < 2) {
    return finalize();
  }

  if (coreTokens.length < 2) {
    return finalize();
  }

  if (!primaryIdentifier && (mode === 'v1' || coreTokens.every(token => !isLikelySymbolToken(token)))) {
    addVariant(`where ${coreTokens.join(' ')} is handled`, 'expanded', 0.7);
    addVariant(`implementation of ${coreTokens.join(' ')}`, 'expanded', 0.7);
  }

  const maxSynonymExpansions = mode === 'v2'
    ? Math.max(1, Math.min(3, Math.floor(effectiveMaxVariants / 2)))
    : Number.MAX_SAFE_INTEGER;
  let synonymExpansions = 0;
  for (let i = 0; i < coreTokens.length; i += 1) {
    const token = coreTokens[i];
    if (normalizedPrimaryIdentifier && token === normalizedPrimaryIdentifier) {
      continue;
    }
    if (mode === 'v2' && isLikelySymbolToken(token)) {
      continue;
    }
    const replacements = SYNONYMS[token];
    if (!replacements) {
      continue;
    }
    for (const replacement of replacements) {
      const clone = [...coreTokens];
      clone[i] = replacement;
      addVariant(clone.join(' '), 'expanded', 0.6);
      synonymExpansions += 1;
      if (mode === 'v2' && synonymExpansions >= maxSynonymExpansions) {
        return finalize();
      }
      if (variants.size >= effectiveMaxVariants) {
        return finalize();
      }
    }
  }

  return finalize();
}
