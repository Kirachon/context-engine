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
import { validateMaxLength, validateNonEmptyString } from '../tooling/validation.js';

export interface EnhancePromptArgs {
  /** The raw user prompt to enhance */
  prompt: string;
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
  const { prompt } = args;
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

  // Always use AI-powered enhancement
  console.error('[enhance_prompt] Using AI-powered enhancement mode');
  const responseFormat = process.env.CE_ENHANCE_PROMPT_RESPONSE_FORMAT?.trim().toLowerCase() ?? 'text';
  const normalizedResponseFormat = ENHANCE_RESPONSE_FORMATS.has(responseFormat) ? responseFormat : 'text';

  try {
    const enhancement = await internalPromptEnhancerDetailed(validatedPrompt, serviceClient, signal);
    if (normalizedResponseFormat === 'json') {
      return JSON.stringify(
        {
          schema_version: ENHANCE_RESPONSE_SCHEMA_VERSION,
          template_version: enhancement.templateVersion,
          enhanced_prompt: enhancement.enhancedPrompt,
          source: enhancement.source,
          reason_code: enhancement.reasonCode,
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
        description: 'The simple prompt to enhance (e.g., "fix the login bug")',
      },
    },
    required: ['prompt'],
  },
};
