/**
 * Layer 3: MCP Interface Layer - Enhance Prompt Tool
 *
 * Transforms simple user prompts into detailed, structured prompts using
 * AI-powered enhancement via Augment's LLM API.
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
 * Note: Always uses AI mode. Requires authentication (auggie login).
 */

import { ContextServiceClient } from '../serviceClient.js';
import { internalPromptEnhancer } from '../../internal/handlers/enhancement.js';

export interface EnhancePromptArgs {
  /** The raw user prompt to enhance */
  prompt: string;
}

// ============================================================================
// AI-Powered Enhancement (using searchAndAsk)
// ============================================================================



/**
 * Handle the enhance_prompt tool call
 *
 * Uses AI-powered enhancement via Augment's LLM API for intelligent prompt rewriting.
 */
export async function handleEnhancePrompt(
  args: EnhancePromptArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const { prompt } = args;

  // Validate inputs
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('Invalid prompt parameter: must be a non-empty string');
  }

  if (prompt.length > 10000) {
    throw new Error('Prompt too long: maximum 10000 characters');
  }

  // Always use AI-powered enhancement
  console.error('[enhance_prompt] Using AI-powered enhancement mode');
  return internalPromptEnhancer(prompt, serviceClient);
}

/**
 * Tool schema definition for MCP registration
 */
export const enhancePromptTool = {
  name: 'enhance_prompt',
  description: `Transform a simple prompt into a detailed, structured prompt with codebase context using AI-powered enhancement.

This tool follows Augment's Prompt Enhancer pattern:
- Uses Augment's LLM API (searchAndAsk) for intelligent prompt rewriting
- Produces natural language enhancement with codebase context
- Requires network access and authentication (auggie login)

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
