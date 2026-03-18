import type { ContextServiceClient } from '../../mcp/serviceClient.js';
import { createHash } from 'crypto';
import { isRetrievalPipelineEnabled, retrieve } from '../retrieval/retrieve.js';
import {
  createRetrievalFlowContext,
  finalizeRetrievalFlow,
  noteRetrievalStage,
} from '../retrieval/flow.js';
import { internalContextSnippet } from './context.js';
import { incCounter, observeDurationMs } from '../../metrics/metrics.js';
import { isOperationalDocsQuery } from '../../retrieval/providers/queryHeuristics.js';

const DEFAULT_ENHANCE_TIMEOUT_MS = 120_000;
const DEFAULT_RETRIEVAL_TIMEOUT_MS = 1_500;
const DEFAULT_ENHANCE_RETRY_ATTEMPTS = 2;
const DEFAULT_ENHANCE_RETRY_BACKOFF_MS = 750;
const MAX_ENHANCE_RETRY_BACKOFF_MS = 5_000;
const DEFAULT_ENHANCE_PROMPT_MODE: EnhancePromptMode = 'light';
const DEFAULT_SNIPPET_CACHE_TTL_MS = 10 * 60 * 1000;
const CONTEXT_CACHE_KEY_VERSION = 'v2';
const ENHANCE_PROMPT_TOOL_VERSION = '1.0.0';
const ENHANCE_RETRIEVAL_ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);
const ENHANCE_RETRIEVAL_DISABLED_VALUES = new Set(['0', 'false', 'no', 'off']);
const ENHANCE_PROMPT_MODES = new Set<EnhancePromptMode>(['off', 'light', 'rich']);
const ENHANCED_PROMPT_PLACEHOLDER = 'enhanced prompt goes here';
const DEFAULT_CONTEXT_TOP_K = 3;
const DEFAULT_CONTEXT_MAX_FILES = 3;
const DEFAULT_CONTEXT_MAX_CHARS = 1200;
const ENHANCE_PROMPT_TEMPLATE_VERSION = '2.0.0';
const FLOW_DEBUG_ENV = 'CE_FLOW_DEBUG';

const REQUIRED_STRUCTURED_SECTIONS = [
  'Objective',
  'Critical Context',
  'Assumptions',
  'Constraints',
  'Proposed Plan',
  'Validation Checklist',
  'Risks and Mitigations',
  'Open Questions',
  'Done Definition',
] as const;

const CORE_REQUIREMENT_LINES = [
  'Define the exact goal and expected outcome.',
  'Identify affected files/components before changes.',
  'Implement minimal, safe changes first.',
  'Validate with concrete checks (tests/build/runtime).',
  'Report what changed, risks, and follow-up actions.',
] as const;

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

type StructuredValidationResult = {
  valid: boolean;
  reason:
    | 'missing_section'
    | 'section_order'
    | 'empty_section'
    | 'duplicate_section'
    | 'no_structured_headers';
};

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

function normalizeEnhanceRetryAttempts(raw: string | undefined): number {
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_ENHANCE_RETRY_ATTEMPTS;
  return Math.max(0, Math.min(3, Math.floor(parsed)));
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
  const queryHash = hashString(prompt.trim());
  const profile = mode;
  const toolVersion = process.env.CE_ENHANCE_PROMPT_TOOL_VERSION?.trim() || ENHANCE_PROMPT_TOOL_VERSION;
  const identity = JSON.stringify({
    key_version: CONTEXT_CACHE_KEY_VERSION,
    query_hash: queryHash,
    profile,
    provider: providerId,
    index_fingerprint: indexFingerprint,
    tool_version: toolVersion,
    top_k: topK,
    max_files: maxFiles,
    max_chars: maxChars,
  });

  return [
    'enhance-context',
    `key_version=${CONTEXT_CACHE_KEY_VERSION}`,
    `query_hash=${queryHash}`,
    `profile=${profile}`,
    `provider=${providerId}`,
    `index_fingerprint=${indexFingerprint}`,
    `tool_version=${toolVersion}`,
    `identity_hash=${hashString(identity)}`,
  ].join(':');
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
  return /api key|authentication|unauthorized|forbidden|login|openai session|provider.+(missing|not configured|invalid)|configuration|misconfig|CE_AI_|usage limit|quota|more access now|try again at/i.test(
    errorMessage
  );
}

function extractRetryAfterMs(errorMessage: string): number | undefined {
  const match = errorMessage.match(/retry_after_ms\s*=\s*(\d+)/i);
  if (!match?.[1]) return undefined;
  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function computeRetryBackoffMs(attempt: number, errorMessage: string): number {
  const hinted = extractRetryAfterMs(errorMessage);
  if (typeof hinted === 'number') {
    return Math.max(250, Math.min(MAX_ENHANCE_RETRY_BACKOFF_MS, hinted));
  }
  const exponential = DEFAULT_ENHANCE_RETRY_BACKOFF_MS * Math.pow(2, attempt);
  return Math.max(250, Math.min(MAX_ENHANCE_RETRY_BACKOFF_MS, exponential));
}

async function sleepMs(durationMs: number): Promise<void> {
  if (durationMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, durationMs));
}

function parseStructuredHeadersIgnoringCodeFences(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const headers: string[] = [];
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = trimmed.match(/^##\s+(.+?)\s*$/);
    if (match?.[1]) {
      headers.push(match[1].trim());
    }
  }

  return headers;
}

function validateStructuredEnhancedPrompt(content: string): StructuredValidationResult {
  const headers = parseStructuredHeadersIgnoringCodeFences(content);
  if (headers.length === 0) {
    return { valid: false, reason: 'no_structured_headers' };
  }

  const seen = new Set<string>();
  for (const header of headers) {
    if (seen.has(header)) {
      return { valid: false, reason: 'duplicate_section' };
    }
    seen.add(header);
  }

  for (const required of REQUIRED_STRUCTURED_SECTIONS) {
    if (!seen.has(required)) {
      return { valid: false, reason: 'missing_section' };
    }
  }

  const requiredIndexes = REQUIRED_STRUCTURED_SECTIONS.map((section) => headers.indexOf(section));
  for (let i = 1; i < requiredIndexes.length; i++) {
    if (requiredIndexes[i] <= requiredIndexes[i - 1]) {
      return { valid: false, reason: 'section_order' };
    }
  }

  // Required sections must have non-empty bodies.
  for (const section of REQUIRED_STRUCTURED_SECTIONS) {
    const headerRegex = new RegExp(`^##\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
    const headerMatch = content.match(headerRegex);
    if (!headerMatch || headerMatch.index === undefined) {
      return { valid: false, reason: 'missing_section' };
    }
    const start = (headerMatch.index ?? 0) + headerMatch[0].length;
    const remainder = content.slice(start);
    const nextHeaderMatch = remainder.match(/\n##\s+/);
    const body = (nextHeaderMatch ? remainder.slice(0, nextHeaderMatch.index) : remainder).trim();
    if (!body) {
      return { valid: false, reason: 'empty_section' };
    }
  }

  return { valid: true, reason: 'no_structured_headers' };
}

function buildRepairEnhancementPrompt(originalPrompt: string, malformedEnhancedPrompt: string): string {
  return [
    "Reformat the enhanced prompt to strict sectioned markdown.",
    "Do not change core intent. Only fix structure, ordering, and missing/empty sections.",
    "",
    "Return exactly this section order with non-empty bullet content:",
    ...REQUIRED_STRUCTURED_SECTIONS.map((section) => `- ${section}`),
    "",
    "Also ensure these requirement points are explicitly covered in the section content:",
    ...CORE_REQUIREMENT_LINES.map((line, index) => `${index + 1}. ${line}`),
    "",
    "Use this exact output envelope:",
    "### BEGIN RESPONSE ###",
    "Here is an enhanced version of the original instruction that is more specific and clear:",
    "<enhanced-prompt>...</enhanced-prompt>",
    "### END RESPONSE ###",
    "",
    "Original instruction:",
    originalPrompt,
    "",
    "Current malformed enhanced prompt:",
    malformedEnhancedPrompt,
  ].join('\n');
}

function buildStructuredPromptFromText(originalPrompt: string, candidateText: string): string {
  const trimmed = candidateText.trim();
  const objective = trimmed.split(/\r?\n/)[0]?.trim() || originalPrompt.trim();
  const criticalContext = trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed;
  return [
    '## Objective',
    `- ${objective}`,
    '',
    '## Critical Context',
    `- ${criticalContext}`,
    '',
    '## Assumptions',
    '- Existing architecture and dependencies remain unchanged unless explicitly required.',
    '',
    '## Constraints',
    '- Keep changes minimal and safe.',
    '',
    '## Proposed Plan',
    `- ${trimmed || originalPrompt.trim()}`,
    '',
    '## Validation Checklist',
    ...CORE_REQUIREMENT_LINES.map((line) => `- ${line}`),
    '',
    '## Risks and Mitigations',
    '- Risk: hidden regressions. Mitigation: targeted tests and explicit verification.',
    '',
    '## Open Questions',
    '- None identified.',
    '',
    '## Done Definition',
    '- Output is structured, actionable, and validated.',
  ].join('\n');
}

function noteEnhancementFlowStage(flow: ReturnType<typeof createRetrievalFlowContext>, stage: string): void {
  noteRetrievalStage(flow, `enhancement:${stage}`);
}

function logEnhancementFlowSummary(
  flow: ReturnType<typeof createRetrievalFlowContext>,
  outcome: string
): void {
  if (process.env[FLOW_DEBUG_ENV] !== '1') return;
  const summary = finalizeRetrievalFlow(flow, { outcome });
  console.error(
    `[AI Enhancement] Flow ${outcome} (${summary.elapsedMs}ms): ${summary.stages.join(' > ')}`
  );
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
    "The enhanced prompt must be structured markdown with exact section headers in this order:\n" +
    `${REQUIRED_STRUCTURED_SECTIONS.map((section) => `- ${section}`).join('\n')}\n` +
    "Within the section content, explicitly cover these requirement points:\n" +
    `${CORE_REQUIREMENT_LINES.map((line, index) => `${index + 1}. ${line}`).join('\n')}\n` +
    "Each section must have non-empty bullet points. " +
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

export interface PromptEnhancementResult {
  enhancedPrompt: string;
  source: 'ai';
  templateVersion: string;
  reasonCode:
    | 'ai_enhanced'
    | 'ai_enhanced_repaired';
}

export type EnhancePromptErrorCode =
  | 'TRANSIENT_UPSTREAM'
  | 'VALIDATION_FAILED'
  | 'REPAIR_FAILED'
  | 'AUTH'
  | 'QUOTA';

export class EnhancePromptError extends Error {
  constructor(
    public readonly code: EnhancePromptErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = 'EnhancePromptError';
  }
}

export async function internalPromptEnhancer(
  prompt: string,
  serviceClient: ContextServiceClient
): Promise<string> {
  const result = await internalPromptEnhancerDetailed(prompt, serviceClient);
  return result.enhancedPrompt;
}

export async function internalPromptEnhancerDetailed(
  prompt: string,
  serviceClient: ContextServiceClient
): Promise<PromptEnhancementResult> {
  const totalStartMs = Date.now();
  const flow = createRetrievalFlowContext('enhance_prompt', {
    metadata: {
      mode: readEnhancePromptMode(),
      tool: 'enhance_prompt',
    },
  });
  noteEnhancementFlowStage(flow, 'start');
  console.error(`[AI Enhancement] Enhancing prompt: "${prompt.substring(0, 100)}..."`);
  const mode = flow.metadata.mode as EnhancePromptMode;
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
    120_000
  );
  const retrievalBudgetMs = normalizeTimeout(
    process.env.CE_ENHANCE_RETRIEVAL_TIMEOUT_MS,
    DEFAULT_RETRIEVAL_TIMEOUT_MS,
    0,
    10_000
  );
  const budget = createBudgetManager(totalBudgetMs, retrievalBudgetMs);
  const retryAttempts = normalizeEnhanceRetryAttempts(process.env.CE_ENHANCE_PROMPT_RETRY_ATTEMPTS);
  let lastTransientRetryAfterMs: number | undefined;

  const baseEnhancementPrompt = buildAIEnhancementPrompt(prompt);
  let enhancementPrompt = baseEnhancementPrompt;
  const retrievalEnabled = mode !== 'off' && (mode === 'light' || isRetrievalPipelineEnabled());
  noteEnhancementFlowStage(flow, retrievalEnabled ? 'retrieval:enabled' : 'retrieval:disabled');

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
    noteEnhancementFlowStage(flow, hasCachedSnippet ? 'retrieval:cache_hit' : 'retrieval:cache_miss');

    try {
      let contextSnippet = hasCachedSnippet ? cachedContextSnippet ?? null : null;

      if (!hasCachedSnippet && retrievalStageTimeoutMs > 0) {
        const preferLocalDocsSearch = mode === 'light' || isOperationalDocsQuery(prompt);
        if (preferLocalDocsSearch) {
          const localSearch = (serviceClient as unknown as {
            localKeywordSearch?: (query: string, topK: number) => Promise<Array<{
              path: string;
              content: string;
              relevanceScore?: number;
            }>>;
          }).localKeywordSearch;

          if (typeof localSearch === 'function') {
            noteEnhancementFlowStage(flow, 'retrieval:local_docs_search');
            let localResults: Array<{
              path: string;
              content: string;
              relevanceScore?: number;
            }> = [];
            try {
              localResults = await withTimeout(
                localSearch.call(serviceClient, prompt, DEFAULT_CONTEXT_TOP_K),
                retrievalStageTimeoutMs,
                'Local keyword retrieval'
              );
            } catch (localError) {
              if (mode !== 'light') {
                localResults = [];
              } else {
                throw localError;
              }
            }

            contextSnippet = internalContextSnippet(
              localResults,
              DEFAULT_CONTEXT_MAX_FILES,
              DEFAULT_CONTEXT_MAX_CHARS
            );
          }

          if (!contextSnippet && mode !== 'light') {
            noteEnhancementFlowStage(flow, 'retrieval:semantic_search');
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
      noteEnhancementFlowStage(flow, 'retrieval:complete');
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
    // Use searchAndAsk to get the enhancement with relevant codebase context.
    // Retry transient failures (timeouts/queue pressure) before using fallback output.
    let response = '';
    let attemptPrompt = enhancementPrompt;
    let lastTransientError: unknown = null;
    for (let attempt = 0; attempt <= retryAttempts; attempt++) {
      const stageTimeoutMs = budget.stageBudgetMs('enhancement');
      if (stageTimeoutMs <= 0) {
        throw new Error('AI enhancement timed out');
      }

      try {
        noteEnhancementFlowStage(flow, `model:attempt:${attempt + 1}`);
        response = await serviceClient.searchAndAsk(prompt, attemptPrompt, {
          timeoutMs: stageTimeoutMs,
        });
        break;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (isAuthOrConfigError(errorMessage)) {
          throw error;
        }

        const canRetry =
          isFallbackEligibleError(errorMessage) &&
          attempt < retryAttempts &&
          budget.remainingMs() > 250;
        if (!canRetry) {
          throw error;
        }

        // Retry with a lean prompt to reduce model/context pressure.
        noteEnhancementFlowStage(flow, `model:retry:${attempt + 1}`);
        attemptPrompt = baseEnhancementPrompt;
        lastTransientError = error;
        const plannedBackoffMs = computeRetryBackoffMs(attempt, errorMessage);
        const backoffMs = Math.min(plannedBackoffMs, Math.max(0, budget.remainingMs() - 100));
        lastTransientRetryAfterMs = backoffMs > 0 ? backoffMs : extractRetryAfterMs(errorMessage);
        incCounter(
          'context_engine_enhance_prompt_retry_total',
          { mode, reason: 'timeout_or_queue_or_transient' },
          1,
          'Enhance prompt transient retries before fallback.'
        );
        await sleepMs(backoffMs);
      }
    }
    if (!response && lastTransientError) {
      throw lastTransientError;
    }

    const performValidation = (candidate: string): StructuredValidationResult =>
      validateStructuredEnhancedPrompt(candidate);

    // Parse and validate enhanced prompt.
    let enhanced = parseEnhancedPrompt(response);
    if (!enhanced) {
      noteEnhancementFlowStage(flow, 'model:validation_failed:no_tag');
      throw new EnhancePromptError(
        'VALIDATION_FAILED',
        'Enhanced prompt response format is invalid. Please retry.',
        true
      );
    }

    if (parseStructuredHeadersIgnoringCodeFences(enhanced).length === 0) {
      enhanced = buildStructuredPromptFromText(prompt, enhanced);
    }

    let validation = performValidation(enhanced);
    if (!validation.valid) {
      noteEnhancementFlowStage(flow, `model:validation_failed:${validation.reason}`);
      incCounter(
        'context_engine_enhance_prompt_validation_failed_total',
        { mode, reason: validation.reason },
        1,
        'Enhance prompt validation failures before repair.'
      );
      const repairTimeoutMs = Math.max(500, Math.floor(budget.stageBudgetMs('enhancement') * 0.3));
      if (repairTimeoutMs <= 0) {
        throw new EnhancePromptError(
          'REPAIR_FAILED',
          'Enhanced prompt is not in the required structure and repair budget is exhausted. Please retry.',
          true
        );
      }

      incCounter(
        'context_engine_enhance_prompt_repair_attempted_total',
        { mode },
        1,
        'Enhance prompt repair attempts.'
      );
      noteEnhancementFlowStage(flow, 'repair:attempt');

      const repairResponse = await withTimeout(
        serviceClient.searchAndAsk(prompt, buildRepairEnhancementPrompt(prompt, enhanced), {
          timeoutMs: repairTimeoutMs,
        }),
        repairTimeoutMs,
        'Enhancement repair'
      );
      const repaired = parseEnhancedPrompt(repairResponse);
      if (!repaired) {
        noteEnhancementFlowStage(flow, 'repair:parse_failed');
        incCounter(
          'context_engine_enhance_prompt_repair_failed_total',
          { mode, reason: 'parse_failed' },
          1,
          'Enhance prompt repair failures.'
        );
        throw new EnhancePromptError(
          'REPAIR_FAILED',
          'Enhanced prompt repair failed due to invalid format. Please retry.',
          true
        );
      }

      validation = performValidation(repaired);
      if (!validation.valid) {
        noteEnhancementFlowStage(flow, `repair:validation_failed:${validation.reason}`);
        incCounter(
          'context_engine_enhance_prompt_repair_failed_total',
          { mode, reason: validation.reason },
          1,
          'Enhance prompt repair failures.'
        );
        throw new EnhancePromptError(
          'REPAIR_FAILED',
          'Enhanced prompt repair failed to satisfy required sections. Please retry.',
          true
        );
      }

      enhanced = repaired;
      noteEnhancementFlowStage(flow, 'repair:success');
      noteEnhancementFlowStage(flow, 'complete:success');
      incCounter(
        'context_engine_enhance_prompt_repair_succeeded_total',
        { mode },
        1,
        'Enhance prompt repair successes.'
      );
      logEnhancementFlowSummary(flow, 'repaired');
      return {
        enhancedPrompt: enhanced,
        source: 'ai',
        templateVersion: ENHANCE_PROMPT_TEMPLATE_VERSION,
        reasonCode: 'ai_enhanced_repaired',
      };
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
    noteEnhancementFlowStage(flow, 'complete:success');
    logEnhancementFlowSummary(flow, 'success');
    return {
      enhancedPrompt: enhanced,
      source: 'ai',
      templateVersion: ENHANCE_PROMPT_TEMPLATE_VERSION,
      reasonCode: 'ai_enhanced',
    };
  } catch (error) {
    noteEnhancementFlowStage(flow, 'complete:error');
    logEnhancementFlowSummary(flow, 'error');
    if (error instanceof EnhancePromptError) {
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[AI Enhancement] Error: ${errorMessage}`);

    if (/usage limit|quota|more access now|try again at/i.test(errorMessage)) {
      observeDurationMs(
        'context_engine_enhance_prompt_duration_seconds',
        { mode, result: 'quota_error' },
        Date.now() - totalStartMs,
        { help: 'Enhance prompt end-to-end duration in seconds.' }
      );
      throw new EnhancePromptError(
        'QUOTA',
        'AI enhancement is blocked because the Codex session has hit its usage limit. Wait for the quota window to reset, then retry.',
        false
      );
    }

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
      throw new EnhancePromptError(
        'AUTH',
        'AI enhancement requires authentication and valid provider configuration. Please ensure your OpenAI session is authenticated and configured.',
        false
      );
    }

    if (isFallbackEligibleError(errorMessage)) {
      console.error('[AI Enhancement] Returning transient upstream error (no fallback template output)');
      const retryAfterMs = extractRetryAfterMs(errorMessage) ?? lastTransientRetryAfterMs;
      incCounter(
        'context_engine_enhance_prompt_transient_error_total',
        { mode, reason: 'timeout_or_queue_or_transient' },
        1,
        'Enhance prompt transient upstream errors.'
      );
      observeDurationMs(
        'context_engine_enhance_prompt_duration_seconds',
        { mode, result: 'transient_error' },
        Date.now() - totalStartMs,
        { help: 'Enhance prompt end-to-end duration in seconds.' }
      );
      throw new EnhancePromptError(
        'TRANSIENT_UPSTREAM',
        'AI enhancement is temporarily unavailable (timeout, queue pressure, or transient upstream issue). Please retry shortly.',
        true,
        retryAfterMs
      );
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
