import type { ContextServiceClient } from '../../mcp/serviceClient.js';
import { createHash } from 'crypto';
import { isRetrievalPipelineEnabled, retrieve } from '../retrieval/retrieve.js';
import { internalContextSnippet } from './context.js';
import { incCounter, observeDurationMs } from '../../metrics/metrics.js';

const DEFAULT_ENHANCE_TIMEOUT_MS = 8_000;
const DEFAULT_RETRIEVAL_TIMEOUT_MS = 1_500;
const DEFAULT_ENHANCE_PROMPT_MODE: EnhancePromptMode = 'light';
const DEFAULT_SNIPPET_CACHE_TTL_MS = 10 * 60 * 1000;
const ENHANCE_RETRIEVAL_ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);
const ENHANCE_RETRIEVAL_DISABLED_VALUES = new Set(['0', 'false', 'no', 'off']);
const ENHANCE_PROMPT_MODES = new Set<EnhancePromptMode>(['off', 'light', 'rich']);
const ENHANCED_PROMPT_PLACEHOLDER = 'enhanced prompt goes here';
const DEFAULT_CONTEXT_TOP_K = 3;
const DEFAULT_CONTEXT_MAX_FILES = 3;
const DEFAULT_CONTEXT_MAX_CHARS = 1200;

type EnhancePromptMode = 'off' | 'light' | 'rich';

type BudgetManager = {
  readonly totalBudgetMs: number;
  readonly deadlineMs: number;
  remainingMs: () => number;
  stageBudgetMs: (stage: 'retrieval' | 'enhancement', requestedMs?: number) => number;
};

type ContextSnippetCacheEntry = {
  snippet: string | null;
  expiresAtMs: number;
};

const contextSnippetCache = new Map<string, ContextSnippetCacheEntry>();

function normalizeTimeout(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function readEnhancePromptMode(): EnhancePromptMode {
  const modeRaw = process.env.CE_ENHANCE_PROMPT_MODE?.trim().toLowerCase();
  if (modeRaw && ENHANCE_PROMPT_MODES.has(modeRaw as EnhancePromptMode)) {
    return modeRaw as EnhancePromptMode;
  }

  // Legacy compatibility: explicit legacy flag takes precedence when mode is absent/invalid.
  const legacyRaw = process.env.CE_ENHANCE_PROMPT_USE_RETRIEVAL?.trim().toLowerCase();
  if (legacyRaw) {
    if (ENHANCE_RETRIEVAL_ENABLED_VALUES.has(legacyRaw)) return 'rich';
    if (ENHANCE_RETRIEVAL_DISABLED_VALUES.has(legacyRaw)) return 'off';
  }

  return DEFAULT_ENHANCE_PROMPT_MODE;
}

function normalizePromptCacheTtl(raw: string | undefined): number {
  return normalizeTimeout(raw, DEFAULT_SNIPPET_CACHE_TTL_MS, 0, 24 * 60 * 60 * 1000);
}

function createBudgetManager(totalBudgetMs: number, retrievalBudgetMs: number): BudgetManager {
  const startedAtMs = Date.now();
  const deadlineMs = startedAtMs + totalBudgetMs;
  const normalizedRetrievalBudgetMs = Math.max(0, Math.min(retrievalBudgetMs, totalBudgetMs));

  const remainingMs = () => Math.max(0, deadlineMs - Date.now());

  return {
    totalBudgetMs,
    deadlineMs,
    remainingMs,
    stageBudgetMs: (stage: 'retrieval' | 'enhancement', requestedMs?: number) => {
      const remaining = remainingMs();
      if (remaining <= 0) return 0;

      const stageCap = stage === 'retrieval'
        ? normalizedRetrievalBudgetMs
        : Math.max(1_000, totalBudgetMs - normalizedRetrievalBudgetMs);
      const requested = Number.isFinite(requestedMs) ? Math.max(0, requestedMs as number) : stageCap;
      return Math.max(0, Math.min(remaining, stageCap, requested));
    },
  };
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function getProviderIdIfAvailable(serviceClient: ContextServiceClient): string {
  const candidate = serviceClient as unknown as {
    aiProviderId?: string;
    getActiveAIProviderId?: () => string;
  };

  try {
    if (typeof candidate.getActiveAIProviderId === 'function') {
      const id = candidate.getActiveAIProviderId();
      if (id && id.trim()) return id.trim();
    }
  } catch {
    // Best-effort only.
  }

  return candidate.aiProviderId?.trim() || 'provider:unknown';
}

function getIndexFingerprintOrWorkspaceHash(serviceClient: ContextServiceClient): string {
  const candidate = serviceClient as unknown as {
    getIndexFingerprint?: () => string;
  };

  try {
    if (typeof candidate.getIndexFingerprint === 'function') {
      const fingerprint = candidate.getIndexFingerprint();
      if (fingerprint && fingerprint.trim()) return fingerprint.trim();
    }
  } catch {
    // Best-effort only.
  }

  return `workspace:${hashString(process.cwd())}`;
}

function buildContextCacheKey(
  prompt: string,
  mode: EnhancePromptMode,
  topK: number,
  maxFiles: number,
  maxChars: number,
  providerId: string,
  indexFingerprint: string
): string {
  const promptHash = hashString(prompt.trim());
  return `enhance-context:${promptHash}:${mode}:topK=${topK}:maxFiles=${maxFiles}:maxChars=${maxChars}:${providerId}:${indexFingerprint}`;
}

function getCachedContextSnippet(cacheKey: string): string | null | undefined {
  const cached = contextSnippetCache.get(cacheKey);
  if (!cached) return undefined;
  if (cached.expiresAtMs <= Date.now()) {
    contextSnippetCache.delete(cacheKey);
    return undefined;
  }
  return cached.snippet;
}

function setCachedContextSnippet(cacheKey: string, snippet: string | null): void {
  const ttlMs = normalizePromptCacheTtl(process.env.CE_ENHANCE_PROMPT_CACHE_TTL_MS);
  if (ttlMs <= 0) return;
  contextSnippetCache.set(cacheKey, {
    snippet,
    expiresAtMs: Date.now() + ttlMs,
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorLabel: string): Promise<T> {
  if (timeoutMs <= 0) {
    return Promise.reject(new Error(`${errorLabel} timed out`));
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${errorLabel} timed out`)), timeoutMs);
    promise
      .then((value) => resolve(value))
      .catch((error) => reject(error))
      .finally(() => clearTimeout(timer));
  });
}

function isFallbackEligibleError(errorMessage: string): boolean {
  return /timed out|timeout|SEARCH_QUEUE_FULL|queue\s*full|rate\s*limit|429|temporar(?:y|ily)|unavailable|overload|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN/i.test(
    errorMessage
  );
}

function isAuthOrConfigError(errorMessage: string): boolean {
  return /api key|authentication|unauthorized|forbidden|login|openai session|provider.+(missing|not configured|invalid)|configuration|misconfig|CE_AI_/i.test(
    errorMessage
  );
}

function buildFastFallbackEnhancement(originalPrompt: string): string {
  const normalized = originalPrompt.trim();
  return [
    `Improve and execute this request with clear scope and outputs: ${normalized}`,
    '',
    'Requirements:',
    '1. Define the exact goal and expected outcome.',
    '2. Identify affected files/components before changes.',
    '3. Implement minimal, safe changes first.',
    '4. Validate with concrete checks (tests/build/runtime).',
    '5. Report what changed, risks, and follow-up actions.',
  ].join('\n');
}

/**
 * Enhancement prompt template following the official prompt enhancer example
 * from enhance-handler.ts in the prompt-enhancer-server
 */
export function buildAIEnhancementPrompt(originalPrompt: string, contextBlock?: string): string {
  const contextSection = contextBlock
    ? `\n\nHere is relevant code context that may help:\n\n${contextBlock}\n\n`
    : '\n\n';

  return (
    "Here is an instruction that I'd like to give you, but it needs to be improved. " +
    "Rewrite and enhance this instruction to make it clearer, more specific, " +
    "less ambiguous, and correct any mistakes. " +
    "If there is code in triple backticks (```) consider whether it is a code sample and should remain unchanged. " +
    "Reply with the following format:\n\n" +
    "### BEGIN RESPONSE ###\n" +
    "Here is an enhanced version of the original instruction that is more specific and clear:\n" +
    "<enhanced-prompt>enhanced prompt goes here</enhanced-prompt>\n\n" +
    "### END RESPONSE ###\n\n" +
    contextSection +
    "Here is my original instruction:\n\n" +
    originalPrompt
  );
}

/**
 * Parse the enhanced prompt from the AI response
 * Extracts content between <enhanced-prompt> and </enhanced-prompt> tags
 *
 * Following the response-parser.ts pattern
 */
export function parseEnhancedPrompt(response: string): string | null {
  // Regex for extracting enhanced prompt from AI response
  const ENHANCED_PROMPT_REGEX = /<enhanced-prompt>([\s\S]*?)<\/enhanced-prompt>/;

  const match = response.match(ENHANCED_PROMPT_REGEX);

  if (match?.[1]) {
    const trimmed = match[1].trim();
    if (!trimmed) {
      return null;
    }
    if (trimmed.toLowerCase() === ENHANCED_PROMPT_PLACEHOLDER) {
      return null;
    }
    return trimmed;
  }

  return null;
}

export async function internalPromptEnhancer(
  prompt: string,
  serviceClient: ContextServiceClient
): Promise<string> {
  const totalStartMs = Date.now();
  console.error(`[AI Enhancement] Enhancing prompt: "${prompt.substring(0, 100)}..."`);
  const mode = readEnhancePromptMode();
  incCounter(
    'context_engine_enhance_prompt_total',
    { mode },
    1,
    'Total enhance_prompt attempts by mode.'
  );
  const totalBudgetMs = normalizeTimeout(
    process.env.CE_ENHANCE_PROMPT_TIMEOUT_MS,
    DEFAULT_ENHANCE_TIMEOUT_MS,
    1_000,
    30_000
  );
  const retrievalBudgetMs = normalizeTimeout(
    process.env.CE_ENHANCE_RETRIEVAL_TIMEOUT_MS,
    DEFAULT_RETRIEVAL_TIMEOUT_MS,
    0,
    10_000
  );
  const budget = createBudgetManager(totalBudgetMs, retrievalBudgetMs);

  let enhancementPrompt = buildAIEnhancementPrompt(prompt);
  const retrievalEnabled = mode !== 'off' && (mode === 'light' || isRetrievalPipelineEnabled());

  if (retrievalEnabled) {
    const retrievalStartMs = Date.now();
    const providerId = getProviderIdIfAvailable(serviceClient);
    const indexFingerprint = getIndexFingerprintOrWorkspaceHash(serviceClient);
    const cacheKey = buildContextCacheKey(
      prompt,
      mode,
      DEFAULT_CONTEXT_TOP_K,
      DEFAULT_CONTEXT_MAX_FILES,
      DEFAULT_CONTEXT_MAX_CHARS,
      providerId,
      indexFingerprint
    );
    const cachedContextSnippet = getCachedContextSnippet(cacheKey);
    const hasCachedSnippet = cachedContextSnippet !== undefined;
    const retrievalStageTimeoutMs = budget.stageBudgetMs('retrieval', retrievalBudgetMs);

    try {
      let contextSnippet = hasCachedSnippet ? cachedContextSnippet ?? null : null;

      if (!hasCachedSnippet && retrievalStageTimeoutMs > 0) {
        if (mode === 'light') {
          const localSearch = (serviceClient as unknown as {
            localKeywordSearch?: (query: string, topK: number) => Promise<Array<{
              path: string;
              content: string;
              relevanceScore?: number;
            }>>;
          }).localKeywordSearch;

          if (typeof localSearch === 'function') {
            const localResults = await withTimeout(
              localSearch(prompt, DEFAULT_CONTEXT_TOP_K),
              retrievalStageTimeoutMs,
              'Local keyword retrieval'
            );
            contextSnippet = internalContextSnippet(
              localResults,
              DEFAULT_CONTEXT_MAX_FILES,
              DEFAULT_CONTEXT_MAX_CHARS
            );
          }
        } else if (mode === 'rich') {
          const retrievalResults = await retrieve(prompt, serviceClient, {
            topK: DEFAULT_CONTEXT_TOP_K,
            perQueryTopK: DEFAULT_CONTEXT_TOP_K,
            maxVariants: 1,
            enableExpansion: false,
            timeoutMs: retrievalStageTimeoutMs,
          });
          contextSnippet = internalContextSnippet(
            retrievalResults,
            DEFAULT_CONTEXT_MAX_FILES,
            DEFAULT_CONTEXT_MAX_CHARS
          );
        }

        setCachedContextSnippet(cacheKey, contextSnippet ?? null);
      }

      if (contextSnippet) {
        enhancementPrompt = buildAIEnhancementPrompt(prompt, contextSnippet);
      }
      observeDurationMs(
        'context_engine_enhance_prompt_retrieval_duration_seconds',
        { mode, result: 'success' },
        Date.now() - retrievalStartMs,
        { help: 'Enhance prompt retrieval stage duration in seconds.' }
      );
    } catch (error) {
      console.error('[AI Enhancement] Retrieval context failed, proceeding without it.', error);
      observeDurationMs(
        'context_engine_enhance_prompt_retrieval_duration_seconds',
        { mode, result: 'error' },
        Date.now() - retrievalStartMs,
        { help: 'Enhance prompt retrieval stage duration in seconds.' }
      );
    }
  }

  try {
    const modelStartMs = Date.now();
    // Use searchAndAsk to get the enhancement with relevant codebase context
    // The original prompt is used as the search query to find relevant code
    const response = await serviceClient.searchAndAsk(prompt, enhancementPrompt, {
      timeoutMs: budget.stageBudgetMs('enhancement'),
    });

    // Parse the enhanced prompt from the response
    const enhanced = parseEnhancedPrompt(response);

    if (!enhanced) {
      // If parsing fails, return the raw response with a note
      console.error('[AI Enhancement] Failed to parse enhanced prompt from response, returning raw response');
      console.error(`[AI Enhancement] Response preview: ${response.substring(0, 200)}...`);

      // Try to extract any useful content from the response
      // If the response doesn't contain the expected tags, it might still be useful
      if (response && response.length > 0) {
        return `${response}\n\n---\n_Note: AI enhancement completed but response format was unexpected._`;
      }

      throw new Error('AI enhancement returned empty response');
    }

    console.error(`[AI Enhancement] Successfully enhanced prompt (${enhanced.length} chars)`);
    observeDurationMs(
      'context_engine_enhance_prompt_model_duration_seconds',
      { mode, result: 'success' },
      Date.now() - modelStartMs,
      { help: 'Enhance prompt AI/model stage duration in seconds.' }
    );
    observeDurationMs(
      'context_engine_enhance_prompt_duration_seconds',
      { mode, result: 'success' },
      Date.now() - totalStartMs,
      { help: 'Enhance prompt end-to-end duration in seconds.' }
    );
    return enhanced;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[AI Enhancement] Error: ${errorMessage}`);

    if (isAuthOrConfigError(errorMessage)) {
      incCounter(
        'context_engine_enhance_prompt_auth_failures_total',
        { mode },
        1,
        'Enhance prompt authentication/configuration failures.'
      );
      observeDurationMs(
        'context_engine_enhance_prompt_duration_seconds',
        { mode, result: 'auth_error' },
        Date.now() - totalStartMs,
        { help: 'Enhance prompt end-to-end duration in seconds.' }
      );
      throw new Error(
        'AI enhancement requires authentication and valid provider configuration. Please ensure your OpenAI session is authenticated and configured.'
      );
    }

    if (isFallbackEligibleError(errorMessage)) {
      console.error('[AI Enhancement] Fast fallback used due to timeout/queue pressure');
      incCounter(
        'context_engine_enhance_prompt_fallback_total',
        { mode, reason: 'timeout_or_queue_or_transient' },
        1,
        'Enhance prompt deterministic fallback count by reason.'
      );
      observeDurationMs(
        'context_engine_enhance_prompt_duration_seconds',
        { mode, result: 'fallback' },
        Date.now() - totalStartMs,
        { help: 'Enhance prompt end-to-end duration in seconds.' }
      );
      return buildFastFallbackEnhancement(prompt);
    }

    observeDurationMs(
      'context_engine_enhance_prompt_duration_seconds',
      { mode, result: 'error' },
      Date.now() - totalStartMs,
      { help: 'Enhance prompt end-to-end duration in seconds.' }
    );
    throw error;
  }
}
