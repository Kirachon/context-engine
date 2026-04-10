/**
 * Layer 3: MCP Interface Layer - Enhance Prompt Tool
 *
 * Transforms simple user prompts into detailed, structured prompts using
 * AI-powered enhancement via the searchAndAsk pipeline.
 *
 * Key Behavior:
 * - Takes a simple prompt like "fix the login bug"
 * - Uses searchAndAsk() to find relevant codebase context
 * - AI intelligently rewrites the prompt with:
 *   - Specific file references from the codebase
 *   - Actionable details and context
 *   - Clear, unambiguous instructions
 *
 * Example:
 * Input:  "fix the login bug"
 * Output: "Debug and fix the user authentication issue in the login flow.
 *          Specifically, investigate the login function in src/auth/login.ts
 *          which handles JWT token validation and session management..."
 *
 * Note: Always uses AI mode. Requires an authenticated OpenAI session.
 */

import { ContextServiceClient } from '../serviceClient.js';
import { internalPromptEnhancerDetailed } from '../../internal/handlers/enhancement.js';
import { EnhancePromptError } from '../../internal/handlers/enhancement.js';
import { getEnhanceRequestToolFieldDescription } from '../prompts/planning.js';
import { validateBoolean, validateExternalSources, validateMaxLength, validateNonEmptyString, validatePathScopeGlobs } from '../tooling/validation.js';

export interface EnhancePromptArgs {
  /** The raw user prompt to enhance */
  prompt: string;
  /** Automatically infer likely include paths when no explicit scope is provided (default: true) */
  auto_scope?: boolean;
  include_paths?: string[];
  exclude_paths?: string[];
  external_sources?: Array<{ type: 'github_url' | 'docs_url'; url: string; label?: string }>;
}

const MAX_PROMPT_LENGTH = 10000;
const ENHANCE_RESPONSE_FORMATS = new Set(['text', 'json']);
const ENHANCE_RESPONSE_SCHEMA_VERSION = '2.0.0';

// ============================================================================
// AI-Powered Enhancement (using searchAndAsk)
// ============================================================================



/**
 * Handle the enhance_prompt tool call
 *
 * Uses AI-powered enhancement via searchAndAsk for intelligent prompt rewriting.
 */
export async function handleEnhancePrompt(
  args: EnhancePromptArgs,
  serviceClient: ContextServiceClient,
  signal?: AbortSignal
): Promise<string> {
  const { prompt, auto_scope = true, include_paths, exclude_paths, external_sources } = args;
  const normalizedPrompt = typeof prompt === 'string' ? prompt.trim() : prompt;

  // Validate inputs (preserve existing external error messages)
  const validatedPrompt = validateNonEmptyString(
    normalizedPrompt,
    'Invalid prompt parameter: must be a non-empty string'
  );
  validateMaxLength(
    validatedPrompt,
    MAX_PROMPT_LENGTH,
    `Prompt too long: maximum ${MAX_PROMPT_LENGTH} characters`
  );
  validateBoolean(auto_scope, 'auto_scope must be a boolean when provided');
  const normalizedIncludePaths = validatePathScopeGlobs(include_paths, 'include_paths');
  const normalizedExcludePaths = validatePathScopeGlobs(exclude_paths, 'exclude_paths');
  const normalizedExternalSources = validateExternalSources(external_sources, 'external_sources');

  // Always use AI-powered enhancement
  console.error('[enhance_prompt] Using AI-powered enhancement mode');
  const responseFormat = process.env.CE_ENHANCE_PROMPT_RESPONSE_FORMAT?.trim().toLowerCase() ?? 'text';
  const normalizedResponseFormat = ENHANCE_RESPONSE_FORMATS.has(responseFormat) ? responseFormat : 'text';

  try {
    const enhancement = await internalPromptEnhancerDetailed(validatedPrompt, serviceClient, signal, {
      autoScope: auto_scope,
      includePaths: normalizedIncludePaths,
      excludePaths: normalizedExcludePaths,
      externalSources: normalizedExternalSources,
    });
    if (normalizedResponseFormat === 'json') {
      return JSON.stringify(
        {
          schema_version: ENHANCE_RESPONSE_SCHEMA_VERSION,
          template_version: enhancement.templateVersion,
          enhanced_prompt: enhancement.enhancedPrompt,
          source: enhancement.source,
          reason_code: enhancement.reasonCode,
          context_files: enhancement.contextFiles,
          mode: enhancement.mode,
          scope_applied: enhancement.scopeApplied,
          scope_source: enhancement.scopeSource,
          scope_confidence: enhancement.scopeConfidence,
          applied_include_paths: enhancement.appliedIncludePaths,
          candidate_include_paths: enhancement.candidateIncludePaths,
          grounding_strategy: enhancement.groundingStrategy,
          grounding_applied: enhancement.groundingApplied,
          grounding_summary: enhancement.groundingSummary,
          grounding_sources_requested: enhancement.groundingSourcesRequested,
          grounding_sources_used: enhancement.groundingSourcesUsed,
          grounding_source_statuses: enhancement.groundingSourceStatuses,
          grounding_warnings: enhancement.groundingWarnings,
          grounding_truncated: enhancement.groundingTruncated,
          ...(enhancement.includePaths ? { include_paths: enhancement.includePaths } : {}),
          ...(enhancement.excludePaths ? { exclude_paths: enhancement.excludePaths } : {}),
        },
        null,
        2
      );
    }

    return enhancement.enhancedPrompt;
  } catch (error) {
    if (error instanceof EnhancePromptError) {
      if (normalizedResponseFormat === 'json') {
        return JSON.stringify(
          {
            schema_version: ENHANCE_RESPONSE_SCHEMA_VERSION,
            error_code: error.code,
            message: error.message,
            retryable: error.retryable,
            ...(typeof error.retryAfterMs === 'number' ? { retry_after_ms: error.retryAfterMs } : {}),
          },
          null,
          2
        );
      }

      const retryHint = error.retryable ? ' Retry after a short delay.' : '';
      throw new Error(`[${error.code}] ${error.message}${retryHint}`);
    }

    throw error;
  }
}

/**
 * Tool schema definition for MCP registration
 */
export const enhancePromptTool = {
  name: 'enhance_prompt',
  description: `Transform a simple prompt into a detailed, structured prompt with codebase context using AI-powered enhancement.

This tool follows the Prompt Enhancer pattern:
- Uses the searchAndAsk AI pipeline for intelligent prompt rewriting
- Produces structured markdown enhancement with codebase context
- Requires network access and an authenticated OpenAI session
- Returns explicit typed errors on transient/auth/quota failures (no fallback template output path)

Example:
  Input:  { prompt: "fix the login bug" }
  Output: "Debug and fix the user authentication issue in the login flow.
           Specifically, investigate the login function in src/auth/login.ts
           which handles JWT token validation and session management..."

The tool automatically searches for relevant code context and uses AI to rewrite your prompt with specific file references and actionable details.`, 
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: getEnhanceRequestToolFieldDescription('prompt'),
      },
      auto_scope: {
        type: 'boolean',
        description: getEnhanceRequestToolFieldDescription('auto_scope'),
      },
      include_paths: {
        type: 'array',
        items: { type: 'string' },
        description: getEnhanceRequestToolFieldDescription('include_paths'),
      },
      exclude_paths: {
        type: 'array',
        items: { type: 'string' },
        description: getEnhanceRequestToolFieldDescription('exclude_paths'),
      },
      external_sources: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['github_url', 'docs_url'] },
            url: { type: 'string' },
            label: { type: 'string' },
          },
          required: ['type', 'url'],
        },
        description: getEnhanceRequestToolFieldDescription('external_sources'),
      },
    },
    required: ['prompt'],
  },
};
