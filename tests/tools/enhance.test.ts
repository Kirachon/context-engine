/**
 * Unit tests for enhance_prompt tool
 *
 * Tests the AI-powered Prompt Enhancer that transforms simple prompts
 * into detailed, structured prompts using Augment's LLM API
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { handleEnhancePrompt, EnhancePromptArgs, enhancePromptTool } from '../../src/mcp/tools/enhance.js';
import { ContextServiceClient } from '../../src/mcp/serviceClient.js';

describe('enhance_prompt Tool (AI Mode Only)', () => {
  let mockServiceClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockServiceClient = {
      searchAndAsk: jest.fn(),
    };
  });

  describe('Input Validation', () => {
    it('should reject empty prompt', async () => {
      await expect(handleEnhancePrompt({ prompt: '' }, mockServiceClient as any))
        .rejects.toThrow(/invalid prompt/i);
    });

    it('should reject null prompt', async () => {
      await expect(handleEnhancePrompt({ prompt: null as any }, mockServiceClient as any))
        .rejects.toThrow(/invalid prompt/i);
    });

    it('should reject undefined prompt', async () => {
      await expect(handleEnhancePrompt({ prompt: undefined as any }, mockServiceClient as any))
        .rejects.toThrow(/invalid prompt/i);
    });

    it('should reject prompt over 10000 characters', async () => {
      const longPrompt = 'a'.repeat(10001);
      await expect(handleEnhancePrompt({ prompt: longPrompt }, mockServiceClient as any))
        .rejects.toThrow(/prompt too long/i);
    });

    it('should accept valid prompt', async () => {
      const aiResponse = `### BEGIN RESPONSE ###
Here is an enhanced version of the original instruction that is more specific and clear:
<enhanced-prompt>Implement user authentication with JWT tokens and session management.</enhanced-prompt>

### END RESPONSE ###`;
      mockServiceClient.searchAndAsk.mockResolvedValue(aiResponse);

      await expect(handleEnhancePrompt({
        prompt: 'How do I implement authentication?',
      }, mockServiceClient as any)).resolves.toBeDefined();
    });
  });

  describe('AI Enhancement Mode', () => {
    it('should use searchAndAsk for AI enhancement', async () => {
      const aiResponse = `### BEGIN RESPONSE ###
Here is an enhanced version of the original instruction that is more specific and clear:
<enhanced-prompt>Fix the authentication bug in the login flow. Review the JWT token validation logic in src/auth/login.ts and ensure proper session management.</enhanced-prompt>

### END RESPONSE ###`;

      mockServiceClient.searchAndAsk.mockResolvedValue(aiResponse);

      const result = await handleEnhancePrompt({
        prompt: 'fix the login bug',
      }, mockServiceClient as any);

      expect(mockServiceClient.searchAndAsk).toHaveBeenCalledTimes(1);
      expect(result).toContain('Fix the authentication bug');
      expect(result).toContain('JWT token validation');
    });

    it('should parse enhanced prompt from AI response', async () => {
      const enhancedText = 'Implement user authentication with JWT tokens and session management.';
      const aiResponse = `### BEGIN RESPONSE ###
Here is an enhanced version of the original instruction that is more specific and clear:
<enhanced-prompt>${enhancedText}</enhanced-prompt>

### END RESPONSE ###`;

      mockServiceClient.searchAndAsk.mockResolvedValue(aiResponse);

      const result = await handleEnhancePrompt({
        prompt: 'simple prompt',
      }, mockServiceClient as any);

      expect(result).toBe(enhancedText);
    });

    it('should handle multi-line enhanced prompts', async () => {
      const multiLinePrompt = `Debug and fix the user authentication issue.
Specifically:
1. Check JWT token validation
2. Review session management`;

      const aiResponse = `### BEGIN RESPONSE ###
Here is an enhanced version of the original instruction that is more specific and clear:
<enhanced-prompt>${multiLinePrompt}</enhanced-prompt>

### END RESPONSE ###`;

      mockServiceClient.searchAndAsk.mockResolvedValue(aiResponse);

      const result = await handleEnhancePrompt({
        prompt: 'test',
      }, mockServiceClient as any);

      expect(result).toBe(multiLinePrompt);
    });

    it('should handle response without expected XML tags gracefully', async () => {
      const rawResponse = 'AI response without expected XML tags';
      mockServiceClient.searchAndAsk.mockResolvedValue(rawResponse);

      const result = await handleEnhancePrompt({
        prompt: 'test',
      }, mockServiceClient as any);

      expect(result).toContain(rawResponse);
      expect(result).toContain('response format was unexpected');
    });

    it('should throw error when searchAndAsk returns empty response', async () => {
      mockServiceClient.searchAndAsk.mockResolvedValue('');

      await expect(handleEnhancePrompt({
        prompt: 'test',
      }, mockServiceClient as any)).rejects.toThrow(/empty response/i);
    });

    it('should throw authentication error with helpful message', async () => {
      mockServiceClient.searchAndAsk.mockRejectedValue(new Error('API key is required'));

      await expect(handleEnhancePrompt({
        prompt: 'test',
      }, mockServiceClient as any)).rejects.toThrow(/authentication/i);
    });

    it('should propagate other errors from searchAndAsk', async () => {
      mockServiceClient.searchAndAsk.mockRejectedValue(new Error('Network timeout'));

      await expect(handleEnhancePrompt({
        prompt: 'test',
      }, mockServiceClient as any)).rejects.toThrow('Network timeout');
    });
  });

  describe('Tool Schema', () => {
    it('should have correct name', () => {
      expect(enhancePromptTool.name).toBe('enhance_prompt');
    });

    it('should have required prompt property', () => {
      expect(enhancePromptTool.inputSchema.required).toContain('prompt');
    });

    it('should only have prompt property (no use_ai or max_files)', () => {
      const props = Object.keys(enhancePromptTool.inputSchema.properties);
      expect(props).toContain('prompt');
      expect(props).not.toContain('use_ai');
      expect(props).not.toContain('max_files');
      expect(props.length).toBe(1);
    });

    it('should have descriptive description mentioning AI-powered enhancement', () => {
      expect(enhancePromptTool.description).toContain('AI-powered');
      expect(enhancePromptTool.description).toContain('Augment');
    });

    it('should include example in description', () => {
      expect(enhancePromptTool.description).toContain('Example');
      expect(enhancePromptTool.description).toContain('fix the login bug');
    });

    it('should mention authentication requirement', () => {
      expect(enhancePromptTool.description).toContain('authentication');
      expect(enhancePromptTool.description).toContain('auggie login');
    });
  });
});

