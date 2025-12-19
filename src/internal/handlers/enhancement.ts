import type { ContextServiceClient } from '../../mcp/serviceClient.js';
import { isRetrievalPipelineEnabled, retrieve } from '../retrieval/retrieve.js';
import { internalContextSnippet } from './context.js';

/**
 * Enhancement prompt template following the official Augment SDK example
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
 * Following the official SDK's response-parser.ts pattern
 */
export function parseEnhancedPrompt(response: string): string | null {
  // Regex for extracting enhanced prompt from AI response
  const ENHANCED_PROMPT_REGEX = /<enhanced-prompt>([\s\S]*?)<\/enhanced-prompt>/;

  const match = response.match(ENHANCED_PROMPT_REGEX);

  if (match?.[1]) {
    return match[1].trim();
  }

  return null;
}

export async function internalPromptEnhancer(
  prompt: string,
  serviceClient: ContextServiceClient
): Promise<string> {
  console.error(`[AI Enhancement] Enhancing prompt: "${prompt.substring(0, 100)}..."`);

  let enhancementPrompt = buildAIEnhancementPrompt(prompt);

  if (isRetrievalPipelineEnabled()) {
    try {
      const retrievalResults = await retrieve(prompt, serviceClient, {
        topK: 5,
        perQueryTopK: 5,
        maxVariants: 4,
      });

      const contextSnippet = internalContextSnippet(retrievalResults, 3, 1200);
      if (contextSnippet) {
        enhancementPrompt = buildAIEnhancementPrompt(prompt, contextSnippet);
      }
    } catch (error) {
      console.error('[AI Enhancement] Retrieval context failed, proceeding without it.', error);
    }
  }

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
        'AI enhancement requires authentication. Please run \"auggie login\" or set AUGMENT_API_TOKEN environment variable.'
      );
    }

    throw error;
  }
}
