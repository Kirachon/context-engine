import { ExpandedQuery, RetrievalProfile, RetrievalRewriteMode } from './types.js';

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
    .split(/[^a-z0-9_]+/g)
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

function isLikelyCodeLike(input: string): boolean {
  if (/[`{}()[\];<>]/.test(input)) {
    return true;
  }
  const slashOrPathHits = (input.match(/[\\/]/g) ?? []).length;
  const camelHits = (input.match(/[a-z][A-Z]/g) ?? []).length;
  return slashOrPathHits >= 2 || camelHits >= 2;
}

function isLikelySymbolToken(token: string): boolean {
  return token.includes('_') || /[a-z][A-Z]/.test(token) || /\d/.test(token);
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

  addVariant(trimmed, 'original', 1);

  if (effectiveMaxVariants <= 1) {
    return Array.from(variants.values());
  }

  if (/[`]/.test(trimmed) || trimmed.length > 200) {
    return Array.from(variants.values());
  }

  if (mode === 'v2' && isLikelyCodeLike(trimmed)) {
    return Array.from(variants.values());
  }

  const tokens = tokenize(trimmed);
  if (tokens.length < 2) {
    return Array.from(variants.values());
  }

  const coreTokens = tokens.filter(token => !STOPWORDS.has(token));
  if (coreTokens.length < 2) {
    return Array.from(variants.values());
  }

  if (mode === 'v1' || coreTokens.every(token => !isLikelySymbolToken(token))) {
    addVariant(`where ${coreTokens.join(' ')} is handled`, 'expanded', 0.7);
    addVariant(`implementation of ${coreTokens.join(' ')}`, 'expanded', 0.7);
  }

  const maxSynonymExpansions = mode === 'v2'
    ? Math.max(1, Math.min(3, Math.floor(effectiveMaxVariants / 2)))
    : Number.MAX_SAFE_INTEGER;
  let synonymExpansions = 0;
  for (let i = 0; i < coreTokens.length; i += 1) {
    const token = coreTokens[i];
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
        return Array.from(variants.values()).slice(0, effectiveMaxVariants);
      }
      if (variants.size >= effectiveMaxVariants) {
        return Array.from(variants.values()).slice(0, effectiveMaxVariants);
      }
    }
  }

  return Array.from(variants.values()).slice(0, effectiveMaxVariants);
}
