import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type ExternalSourceType = 'github_url' | 'docs_url';
export type ExternalGroundingWarningCode =
  | 'invalid_source'
  | 'unsupported_content_type'
  | 'fetch_failed'
  | 'extract_failed'
  | 'truncated';
export type ExternalGroundingSourceStatus = 'used' | 'ignored' | 'failed' | 'truncated';
export type GroundingWarning = ExternalGroundingWarning;
export type GroundingSourceStatus = {
  type: ExternalSourceType;
  url: string;
  host: string;
  label?: string;
  status: ExternalGroundingSourceStatus;
  warning_code?: ExternalGroundingWarningCode;
};

export interface ExternalSourceInput {
  type: ExternalSourceType;
  url: string;
  label?: string;
}

export interface ExternalGroundingWarning {
  code: ExternalGroundingWarningCode;
  message: string;
  source_url: string;
  source_index: number;
}

export interface NormalizedExternalSource {
  type: ExternalSourceType;
  url: string;
  label?: string;
  sourceIndex: number;
  host: string;
}

export interface ExternalReferenceSnippet {
  type: ExternalSourceType;
  url: string;
  label?: string;
  host: string;
  title?: string;
  excerpt?: string;
  status: ExternalGroundingSourceStatus;
  warning?: ExternalGroundingWarning;
  fetched_at?: string;
}

export interface ExternalReferenceBundle {
  requestedCount: number;
  usedCount: number;
  applied: boolean;
  truncated: boolean;
  items: ExternalReferenceSnippet[];
  warnings: ExternalGroundingWarning[];
}

export interface FetchExternalGroundingResult {
  requestedCount: number;
  references: ExternalReferenceSnippet[];
  warnings: ExternalGroundingWarning[];
  truncated: boolean;
  applied: boolean;
}

export interface ExternalGroundingFetchOptions {
  signal?: AbortSignal;
  maxResponseBytes?: number;
  maxRedirects?: number;
  perSourceTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxExcerptChars?: number;
  maxTotalExcerptChars?: number;
}

const MAX_EXTERNAL_SOURCES = 3;
const ALLOWED_GITHUB_PREFIXES = ['/blob/', '/tree/'];
const ALLOWED_GITHUB_FILE_NAMES = ['readme', 'readme.md', 'readme.mdx'];
const DOCS_PATH_PATTERN = /(\/docs?(?:\/|$)|\/documentation(?:\/|$)|\/guide(?:\/|$)|\/reference(?:\/|$))/i;
const BLOCKED_GITHUB_SEGMENTS = new Set([
  'issues',
  'pull',
  'commit',
  'commits',
  'releases',
  'discussions',
  'actions',
  'security',
  'wiki',
]);
const MAX_RESPONSE_BYTES = 300 * 1024;
const DEFAULT_PER_SOURCE_TIMEOUT_MS = 5_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 1;
const DEFAULT_MAX_EXCERPT_CHARS = 1_200;
const DEFAULT_MAX_TOTAL_EXCERPT_CHARS = 3_600;
const GROUNDING_PROVIDER_VERSION = '1.0.0';

function normalizeOptionalLabel(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error('label must be a string when provided');
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildWarning(
  code: ExternalGroundingWarningCode,
  message: string,
  source: Pick<NormalizedExternalSource, 'url' | 'sourceIndex'>
): ExternalGroundingWarning {
  return {
    code,
    message,
    source_url: source.url,
    source_index: source.sourceIndex,
  };
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((value) => Number.parseInt(value, 10));
  if (parts.length !== 4 || parts.some((value) => Number.isNaN(value))) {
    return false;
  }
  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

function isBlockedIPv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === '::1' || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd');
}

function assertSafeHostname(hostname: string): void {
  const normalized = hostname.toLowerCase();
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '169.254.169.254' ||
    normalized === 'metadata.google.internal'
  ) {
    throw new Error('host is not allowed');
  }

  const ipFamily = isIP(normalized);
  if ((ipFamily === 4 && isPrivateIpv4(normalized)) || (ipFamily === 6 && isBlockedIPv6(normalized))) {
    throw new Error('host is not allowed');
  }
}

async function assertSafeResolvedTarget(hostname: string): Promise<void> {
  const normalized = hostname.toLowerCase();
  const ipFamily = isIP(normalized);
  if (ipFamily !== 0) {
    assertSafeHostname(normalized);
    return;
  }

  const records = await lookup(normalized, { all: true });
  if (!records || records.length === 0) {
    throw new Error('host could not be resolved');
  }

  for (const record of records) {
    assertSafeHostname(record.address);
  }
}

function canonicalizeUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('url must be a valid absolute URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('url must use https');
  }
  if (parsed.username || parsed.password) {
    throw new Error('url must not include userinfo');
  }
  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol === 'https:' && parsed.port === '443') {
    parsed.port = '';
  }

  if (parsed.pathname !== '/') {
    parsed.pathname = parsed.pathname.replace(/\/+$/u, '') || '/';
  }

  assertSafeHostname(parsed.hostname);
  return parsed;
}

function isAllowedGitHubPath(pathname: string): boolean {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length < 2) {
    return false;
  }
  const third = segments[2]?.toLowerCase();
  if (third && BLOCKED_GITHUB_SEGMENTS.has(third)) {
    return false;
  }
  if (segments.length === 2) {
    return true;
  }
  const normalizedPath = pathname.toLowerCase();
  if (ALLOWED_GITHUB_PREFIXES.some((prefix) => normalizedPath.includes(prefix))) {
    return true;
  }
  const last = segments.at(-1)?.toLowerCase() ?? '';
  if (ALLOWED_GITHUB_FILE_NAMES.includes(last) || DOCS_PATH_PATTERN.test(pathname)) {
    return true;
  }
  return false;
}

function assertSourceTypeAdmission(type: ExternalSourceType, parsedUrl: URL): void {
  if (type === 'github_url') {
    if (parsedUrl.hostname !== 'github.com') {
      throw new Error('github_url must use github.com');
    }
    if (!isAllowedGitHubPath(parsedUrl.pathname)) {
      throw new Error('github_url must target a repo, tree, blob, or docs-like page');
    }
    return;
  }

  if (!parsedUrl.hostname || parsedUrl.hostname === 'github.com') {
    return;
  }
}

export function normalizeExternalSources(value: unknown, fieldName = 'external_sources'): NormalizedExternalSource[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName} parameter: must be an array of source objects`);
  }
  if (value.length === 0) {
    return undefined;
  }
  if (value.length > MAX_EXTERNAL_SOURCES) {
    throw new Error(`Invalid ${fieldName} parameter: maximum ${MAX_EXTERNAL_SOURCES} sources are allowed`);
  }

  const seen = new Set<string>();
  const normalized: NormalizedExternalSource[] = [];

  value.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Invalid ${fieldName} parameter: each source must be an object`);
    }
    const source = entry as Record<string, unknown>;
    if (source.type !== 'github_url' && source.type !== 'docs_url') {
      throw new Error(`Invalid ${fieldName} parameter: unsupported source type`);
    }
    if (typeof source.url !== 'string' || source.url.trim().length === 0) {
      throw new Error(`Invalid ${fieldName} parameter: each source must include a non-empty url`);
    }

    const parsedUrl = canonicalizeUrl(source.url);
    assertSourceTypeAdmission(source.type, parsedUrl);

    const normalizedUrl = parsedUrl.toString();
    const dedupeKey = `${source.type}:${normalizedUrl}`;
    if (seen.has(dedupeKey)) {
      return;
    }
    seen.add(dedupeKey);
    normalized.push({
      type: source.type,
      url: normalizedUrl,
      label: normalizeOptionalLabel(source.label),
      sourceIndex: index,
      host: parsedUrl.hostname,
    });
  });

  return normalized.length > 0 ? normalized : undefined;
}

export const validateAndNormalizeExternalSources = normalizeExternalSources;

export function parseExternalSourcesPromptArgument(raw: string | undefined): NormalizedExternalSource[] | undefined {
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`external_sources must be valid JSON: ${message}`);
  }
  return normalizeExternalSources(parsed, 'external_sources');
}

export function buildExternalSourcesCacheKeyPart(sources: NormalizedExternalSource[] | undefined): string {
  if (!sources || sources.length === 0) {
    return 'external:none';
  }
  return JSON.stringify({
    version: GROUNDING_PROVIDER_VERSION,
    sources: sources.map((source) => ({
      type: source.type,
      url: source.url,
      label: source.label,
      host: source.host,
    })),
  });
}

export const serializeExternalSourcesForCache = buildExternalSourcesCacheKeyPart;

function extractTextFromHtml(html: string): { title?: string; excerpt?: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    title: titleMatch?.[1]?.replace(/\s+/g, ' ').trim(),
    excerpt: withoutScripts || undefined,
  };
}

async function fetchWithTimeout(url: string, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`fetch timed out after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: {
        'accept': 'text/html, text/plain;q=0.9',
        'user-agent': 'context-engine/grounding',
      },
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function fetchSingleExternalSource(
  source: NormalizedExternalSource,
  options: ExternalGroundingFetchOptions,
  sharedState: { remainingChars: number }
): Promise<{ item: ExternalReferenceSnippet; warning?: ExternalGroundingWarning }> {
  try {
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    const perSourceTimeoutMs = options.perSourceTimeoutMs ?? DEFAULT_PER_SOURCE_TIMEOUT_MS;
    const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    const maxExcerptChars = options.maxExcerptChars ?? DEFAULT_MAX_EXCERPT_CHARS;

    let currentUrl = source.url;
    let redirects = 0;
    let response: Response;
    while (true) {
      await assertSafeResolvedTarget(new URL(currentUrl).hostname);
      response = await fetchWithTimeout(currentUrl, perSourceTimeoutMs, options.signal);
      if (response.status >= 300 && response.status < 400) {
        if (redirects >= maxRedirects) {
          const warning = buildWarning('fetch_failed', 'Too many redirects', source);
          return { item: { ...source, status: 'failed', warning }, warning };
        }
        const location = response.headers.get('location');
        if (!location) {
          const warning = buildWarning('fetch_failed', 'Redirect response missing location header', source);
          return { item: { ...source, status: 'failed', warning }, warning };
        }
        const redirected = canonicalizeUrl(new URL(location, currentUrl).toString());
        assertSourceTypeAdmission(source.type, redirected);
        await assertSafeResolvedTarget(redirected.hostname);
        currentUrl = redirected.toString();
        redirects += 1;
        continue;
      }
      break;
    }

    if (!response.ok) {
      const warning = buildWarning('fetch_failed', `Fetch failed with status ${response.status}`, source);
      return { item: { ...source, status: 'failed', warning }, warning };
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      const warning = buildWarning('unsupported_content_type', `Unsupported content type: ${contentType || 'unknown'}`, source);
      return { item: { ...source, status: 'ignored', warning }, warning };
    }

    const rawText = await response.text();
    if (Buffer.byteLength(rawText, 'utf8') > maxResponseBytes) {
      const warning = buildWarning('fetch_failed', `Response exceeded ${maxResponseBytes} bytes`, source);
      return { item: { ...source, status: 'failed', warning }, warning };
    }

    const extracted = contentType.includes('text/html') ? extractTextFromHtml(rawText) : { excerpt: rawText.trim() };
    if (!extracted.excerpt) {
      const warning = buildWarning('extract_failed', 'No readable content could be extracted', source);
      return { item: { ...source, status: 'ignored', warning }, warning };
    }

    const excerptBudget = Math.max(0, Math.min(sharedState.remainingChars, maxExcerptChars));
    if (excerptBudget <= 0) {
      const warning = buildWarning('truncated', 'External grounding budget exhausted', source);
      return {
        item: { ...source, title: extracted.title, status: 'truncated', warning, fetched_at: new Date().toISOString() },
        warning,
      };
    }

    let excerpt = extracted.excerpt.slice(0, excerptBudget);
    let warning: ExternalGroundingWarning | undefined;
    let status: ExternalGroundingSourceStatus = 'used';
    if (extracted.excerpt.length > excerptBudget) {
      excerpt = `${excerpt.trimEnd()}...`;
      warning = buildWarning('truncated', 'External snippet was truncated to fit the grounding budget', source);
      status = 'truncated';
    }
    sharedState.remainingChars -= excerpt.length;
    return {
      item: {
        ...source,
        title: extracted.title,
        excerpt,
        status,
        warning,
        fetched_at: new Date().toISOString(),
      },
      warning,
    };
  } catch (error) {
    const warning = buildWarning(
      'fetch_failed',
      error instanceof Error && error.message.trim().length > 0 ? error.message : 'External fetch failed',
      source
    );
    return { item: { ...source, status: 'failed', warning }, warning };
  }
}

export async function fetchExternalReferences(
  sources: NormalizedExternalSource[] | undefined,
  options: ExternalGroundingFetchOptions = {}
): Promise<ExternalReferenceBundle | undefined> {
  if (!sources || sources.length === 0) {
    return undefined;
  }

  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`external grounding timed out after ${totalTimeoutMs}ms`)), totalTimeoutMs);
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const warnings: ExternalGroundingWarning[] = [];
    const items: ExternalReferenceSnippet[] = [];
    const sharedState = { remainingChars: options.maxTotalExcerptChars ?? DEFAULT_MAX_TOTAL_EXCERPT_CHARS };
    for (const source of sources) {
      const { item, warning } = await fetchSingleExternalSource(source, { ...options, signal: controller.signal }, sharedState);
      items.push(item);
      if (warning) {
        warnings.push(warning);
      }
    }
    const usedCount = items.filter((item) => item.status === 'used' || item.status === 'truncated').length;
    return {
      requestedCount: sources.length,
      usedCount,
      applied: usedCount > 0,
      truncated: items.some((item) => item.status === 'truncated'),
      items,
      warnings,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export async function fetchExternalGrounding(
  sources: NormalizedExternalSource[] | undefined,
  options: ExternalGroundingFetchOptions = {}
): Promise<FetchExternalGroundingResult> {
  const bundle = await fetchExternalReferences(sources, options);
  if (!bundle) {
    return {
      requestedCount: 0,
      references: [],
      warnings: [],
      truncated: false,
      applied: false,
    };
  }
  return {
    requestedCount: bundle.requestedCount,
    references: bundle.items.filter((item) => item.excerpt),
    warnings: bundle.warnings,
    truncated: bundle.truncated,
    applied: bundle.applied,
  };
}

export const EXTERNAL_GROUNDING_PROVIDER_VERSION = GROUNDING_PROVIDER_VERSION;
