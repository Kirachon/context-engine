import { ExpandedQuery } from './types.js';

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

export function expandQuery(query: string, maxVariants: number = 4): ExpandedQuery[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
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

  addVariant(trimmed, 'original', 1);

  if (maxVariants <= 1) {
    return Array.from(variants.values());
  }

  if (/[`]/.test(trimmed) || trimmed.length > 200) {
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

  addVariant(`where ${coreTokens.join(' ')} is handled`, 'expanded', 0.7);
  addVariant(`implementation of ${coreTokens.join(' ')}`, 'expanded', 0.7);

  for (let i = 0; i < coreTokens.length; i += 1) {
    const token = coreTokens[i];
    const replacements = SYNONYMS[token];
    if (!replacements) {
      continue;
    }
    for (const replacement of replacements) {
      const clone = [...coreTokens];
      clone[i] = replacement;
      addVariant(clone.join(' '), 'expanded', 0.6);
      if (variants.size >= maxVariants) {
        return Array.from(variants.values()).slice(0, maxVariants);
      }
    }
  }

  return Array.from(variants.values()).slice(0, maxVariants);
}
