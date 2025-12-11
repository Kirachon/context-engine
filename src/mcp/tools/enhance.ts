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

export interface EnhancePromptArgs {
  /** The raw user prompt to enhance */
  prompt: string;
}

// ============================================================================
// AI-Powered Enhancement (using searchAndAsk)
// ============================================================================

/**
 * Enhancement prompt template following the official Augment SDK example
 * from enhance-handler.ts in the prompt-enhancer-server
 */
function buildAIEnhancementPrompt(originalPrompt: string): string {
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
    "Here is my original instruction:\n\n" +
    originalPrompt
  );
}

/**
 * Parse the enhanced prompt from the AI response
 * Extracts content between <enhanced-prompt> and </enhanced-prompt> tags
 *
 * Following the official SDK's response-parser.ts pattern
 */
function parseEnhancedPrompt(response: string): string | null {
  // Regex for extracting enhanced prompt from AI response
  const ENHANCED_PROMPT_REGEX = /<enhanced-prompt>([\s\S]*?)<\/enhanced-prompt>/;

  const match = response.match(ENHANCED_PROMPT_REGEX);

  if (match?.[1]) {
    return match[1].trim();
  }

  return null;
}

/**
 * Handle AI-powered prompt enhancement using searchAndAsk
 *
 * Uses the official Augment SDK pattern from the prompt-enhancer-server example:
 * 1. Use the original prompt as the search query to find relevant code
 * 2. Send an enhancement prompt to the LLM with the codebase context
 * 3. Parse the enhanced prompt from the response
 */
async function handleAIEnhance(
  prompt: string,
  serviceClient: ContextServiceClient
): Promise<string> {
  console.error(`[AI Enhancement] Enhancing prompt: "${prompt.substring(0, 100)}..."`);

  // Build the enhancement instruction
  const enhancementPrompt = buildAIEnhancementPrompt(prompt);

  try {
    // Use searchAndAsk to get the enhancement with relevant codebase context
    // The original prompt is used as the search query to find relevant code
    const response = await serviceClient.searchAndAsk(prompt, enhancementPrompt);

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
    return enhanced;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[AI Enhancement] Error: ${errorMessage}`);

    // Check for authentication errors
    if (errorMessage.includes('API key') || errorMessage.includes('authentication') || errorMessage.includes('Login')) {
      throw new Error(
        'AI enhancement requires authentication. Please run "auggie login" or set AUGMENT_API_TOKEN environment variable.'
      );
    }

    throw error;
  }
}



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
  return handleAIEnhance(prompt, serviceClient);
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
