/**
 * Unit tests for enhance_prompt tool
 *
 * Tests the AI-powered Prompt Enhancer that transforms simple prompts
 * into detailed, structured prompts using the searchAndAsk AI pipeline
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { handleEnhancePrompt, EnhancePromptArgs, enhancePromptTool } from '../../src/mcp/tools/enhance.js';
import { ContextServiceClient } from '../../src/mcp/serviceClient.js';
import { parseEnhancedPrompt } from '../../src/internal/handlers/enhancement.js';

describe('enhance_prompt Tool (AI Mode Only)', () => {
  let mockServiceClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockServiceClient = {
      semanticSearch: jest.fn(() => Promise.resolve([])),
      searchAndAsk: jest.fn(),
    };
  });

  afterEach(() => {
    delete process.env.CE_ENHANCE_PROMPT_MODE;
    delete process.env.CE_ENHANCE_PROMPT_USE_RETRIEVAL;
    delete process.env.CE_ENHANCE_PROMPT_RESPONSE_FORMAT;
    delete process.env.CE_ENHANCE_PROMPT_CACHE_TTL_MS;
    delete process.env.CE_ENHANCE_PROMPT_TOOL_VERSION;
    delete process.env.CONTEXT_ENGINE_RETRIEVAL_PIPELINE;
  });

  describe('Input Validation', () => {
    it('should reject empty prompt', async () => {
      await expect(handleEnhancePrompt({ prompt: '' }, mockServiceClient as any))
        .rejects.toThrow('Invalid prompt parameter: must be a non-empty string');
    });

    it('should reject null prompt', async () => {
      await expect(handleEnhancePrompt({ prompt: null as any }, mockServiceClient as any))
        .rejects.toThrow('Invalid prompt parameter: must be a non-empty string');
    });

    it('should reject undefined prompt', async () => {
      await expect(handleEnhancePrompt({ prompt: undefined as any }, mockServiceClient as any))
        .rejects.toThrow('Invalid prompt parameter: must be a non-empty string');
    });

    it('should reject whitespace-only prompt after trimming', async () => {
      await expect(handleEnhancePrompt({ prompt: '   \n\t  ' }, mockServiceClient as any))
        .rejects.toThrow('Invalid prompt parameter: must be a non-empty string');
    });

    it('should reject prompt over 10000 characters', async () => {
      const longPrompt = 'a'.repeat(10001);
      await expect(handleEnhancePrompt({ prompt: longPrompt }, mockServiceClient as any))
        .rejects.toThrow('Prompt too long: maximum 10000 characters');
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

    it('should trim prompt before forwarding to AI enhancement', async () => {
      const aiResponse = `### BEGIN RESPONSE ###
Here is an enhanced version of the original instruction that is more specific and clear:
<enhanced-prompt>Trimmed prompt validation passed.</enhanced-prompt>

### END RESPONSE ###`;
      mockServiceClient.searchAndAsk.mockResolvedValue(aiResponse);

      await handleEnhancePrompt({
        prompt: '   fix the login bug   ',
      }, mockServiceClient as any);

      expect(mockServiceClient.searchAndAsk).toHaveBeenCalledWith(
        'fix the login bug',
        expect.any(String),
        expect.objectContaining({ timeoutMs: expect.any(Number) })
      );
      const timeoutMs = mockServiceClient.searchAndAsk.mock.calls[0][2]?.timeoutMs;
      expect(timeoutMs).toBeGreaterThanOrEqual(1000);
      expect(timeoutMs).toBeLessThanOrEqual(8000);
    });
  });

  describe('AI Enhancement Mode', () => {
    describe('Mode Resolution', () => {
      it('should use default light mode behavior when mode is unset', async () => {
        delete process.env.CE_ENHANCE_PROMPT_MODE;

        const aiResponse = `### BEGIN RESPONSE ###
Here is an enhanced version of the original instruction that is more specific and clear:
<enhanced-prompt>Default light mode enhancement.</enhanced-prompt>

### END RESPONSE ###`;
        mockServiceClient.searchAndAsk.mockResolvedValue(aiResponse);

        const result = await handleEnhancePrompt({
          prompt: 'improve test defaults',
        }, mockServiceClient as any);

        expect(result).toBe('Default light mode enhancement.');
        expect(mockServiceClient.searchAndAsk).toHaveBeenCalledTimes(1);
        expect(mockServiceClient.searchAndAsk).toHaveBeenCalledWith(
          'improve test defaults',
          expect.not.stringContaining('Here is relevant code context that may help:'),
          expect.objectContaining({ timeoutMs: expect.any(Number) })
        );
        const timeoutMs = mockServiceClient.searchAndAsk.mock.calls[0][2]?.timeoutMs;
        expect(timeoutMs).toBeGreaterThanOrEqual(1000);
        expect(timeoutMs).toBeLessThanOrEqual(8000);
      });

      it('should use deterministic fallback when enhance mode is off', async () => {
        process.env.CE_ENHANCE_PROMPT_MODE = 'off';
        mockServiceClient.searchAndAsk.mockRejectedValue(new Error('request timeout while enhancing'));

        const result = await handleEnhancePrompt({
          prompt: 'stabilize ci workflow',
        }, mockServiceClient as any);

        expect(mockServiceClient.searchAndAsk).toHaveBeenCalledTimes(1);
        expect(result).toContain('Improve and execute this request with clear scope and outputs: stabilize ci workflow');
        expect(result).toContain('Requirements:');
      });

      it('should include retrieval context in rich mode path selection', async () => {
        process.env.CE_ENHANCE_PROMPT_MODE = 'rich';
        mockServiceClient.semanticSearch.mockResolvedValue([
          {
            path: 'src/auth/login.ts',
            content: 'export async function login() { return true; }',
            relevanceScore: 0.95,
            matchType: 'keyword',
          },
        ]);
        mockServiceClient.searchAndAsk.mockResolvedValue(
          `### BEGIN RESPONSE ###
Here is an enhanced version of the original instruction that is more specific and clear:
<enhanced-prompt>Rich mode enhancement.</enhanced-prompt>

### END RESPONSE ###`
        );

        await handleEnhancePrompt({
          prompt: 'fix login path selection',
        }, mockServiceClient as any);

        expect(mockServiceClient.searchAndAsk).toHaveBeenCalledTimes(1);
        const promptText = mockServiceClient.searchAndAsk.mock.calls[0][1];
        expect(promptText).toContain('Here is relevant code context that may help:');
        expect(promptText).toContain('File: src/auth/login.ts');
      });
    });

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

    it('should fallback deterministically on timeout errors', async () => {
      mockServiceClient.searchAndAsk.mockRejectedValue(new Error('Network timeout'));

      await expect(handleEnhancePrompt({
        prompt: 'test',
      }, mockServiceClient as any)).resolves.toContain('Improve and execute this request');
    });

    it('should fallback deterministically on queue pressure errors', async () => {
      mockServiceClient.searchAndAsk.mockRejectedValue(new Error('SEARCH_QUEUE_FULL: queue saturated'));

      await expect(handleEnhancePrompt({
        prompt: 'handle queue pressure',
      }, mockServiceClient as any)).resolves.toContain('Improve and execute this request');
    });

    it('should not fallback on provider configuration failures', async () => {
      mockServiceClient.searchAndAsk.mockRejectedValue(
        new Error('Provider configuration invalid: CE_AI_PROVIDER value is unsupported')
      );

      await expect(handleEnhancePrompt({
        prompt: 'test config failure',
      }, mockServiceClient as any)).rejects.toThrow(/authentication and valid provider configuration/i);
    });

    it('returns structured JSON metadata when CE_ENHANCE_PROMPT_RESPONSE_FORMAT=json and AI succeeds', async () => {
      process.env.CE_ENHANCE_PROMPT_RESPONSE_FORMAT = 'json';
      mockServiceClient.searchAndAsk.mockResolvedValue(
        `### BEGIN RESPONSE ###
Here is an enhanced version of the original instruction that is more specific and clear:
<enhanced-prompt>Structured AI enhancement output.</enhanced-prompt>

### END RESPONSE ###`
      );

      const raw = await handleEnhancePrompt(
        { prompt: 'structured response please' },
        mockServiceClient as any
      );
      const parsed = JSON.parse(raw);
      expect(parsed.enhanced_prompt).toBe('Structured AI enhancement output.');
      expect(parsed.source).toBe('ai');
      expect(parsed.reason_code).toBe('ai_enhanced');
    });

    it('returns structured JSON metadata when CE_ENHANCE_PROMPT_RESPONSE_FORMAT=json and fallback is used', async () => {
      process.env.CE_ENHANCE_PROMPT_RESPONSE_FORMAT = 'json';
      mockServiceClient.searchAndAsk.mockRejectedValue(new Error('SEARCH_QUEUE_FULL: queue saturated'));

      const raw = await handleEnhancePrompt(
        { prompt: 'fallback json please' },
        mockServiceClient as any
      );
      const parsed = JSON.parse(raw);
      expect(parsed.source).toBe('fallback');
      expect(parsed.reason_code).toBe('fallback_timeout_or_queue_or_transient');
      expect(parsed.enhanced_prompt).toContain('Improve and execute this request');
    });

    describe('Snippet cache hardening', () => {
      it('reuses cached snippet for deterministic same-key inputs', async () => {
        process.env.CE_ENHANCE_PROMPT_MODE = 'light';
        process.env.CE_ENHANCE_PROMPT_CACHE_TTL_MS = '60000';
        mockServiceClient.getActiveAIProviderId = jest.fn(() => 'provider-alpha');
        mockServiceClient.getIndexFingerprint = jest.fn(() => 'index-fingerprint-1');
        mockServiceClient.localKeywordSearch = jest.fn(async () => [
          {
            path: 'src/auth/login.ts',
            content: 'export function login() { return true; }',
            relevanceScore: 0.9,
          },
        ]);
        mockServiceClient.searchAndAsk.mockResolvedValue(
          `### BEGIN RESPONSE ###
Here is an enhanced version of the original instruction that is more specific and clear:
<enhanced-prompt>Deterministic cache reuse output.</enhanced-prompt>

### END RESPONSE ###`
        );

        await handleEnhancePrompt({ prompt: 'cache deterministic same-key prompt' }, mockServiceClient as any);
        await handleEnhancePrompt({ prompt: 'cache deterministic same-key prompt' }, mockServiceClient as any);

        expect(mockServiceClient.localKeywordSearch).toHaveBeenCalledTimes(1);
        expect(mockServiceClient.searchAndAsk).toHaveBeenCalledTimes(2);
      });

      it('invalidates cache when provider changes', async () => {
        process.env.CE_ENHANCE_PROMPT_MODE = 'light';
        process.env.CE_ENHANCE_PROMPT_CACHE_TTL_MS = '60000';
        mockServiceClient.getActiveAIProviderId = jest
          .fn()
          .mockReturnValueOnce('provider-alpha')
          .mockReturnValueOnce('provider-beta');
        mockServiceClient.getIndexFingerprint = jest.fn(() => 'index-fingerprint-1');
        mockServiceClient.localKeywordSearch = jest.fn(async () => [
          {
            path: 'src/auth/login.ts',
            content: 'export function login() { return true; }',
            relevanceScore: 0.9,
          },
        ]);
        mockServiceClient.searchAndAsk.mockResolvedValue(
          `### BEGIN RESPONSE ###
Here is an enhanced version of the original instruction that is more specific and clear:
<enhanced-prompt>Provider-isolated cache output.</enhanced-prompt>

### END RESPONSE ###`
        );

        await handleEnhancePrompt({ prompt: 'cache provider boundary prompt' }, mockServiceClient as any);
        await handleEnhancePrompt({ prompt: 'cache provider boundary prompt' }, mockServiceClient as any);

        expect(mockServiceClient.localKeywordSearch).toHaveBeenCalledTimes(2);
      });

      it('invalidates cache when index fingerprint changes', async () => {
        process.env.CE_ENHANCE_PROMPT_MODE = 'light';
        process.env.CE_ENHANCE_PROMPT_CACHE_TTL_MS = '60000';
        mockServiceClient.getActiveAIProviderId = jest.fn(() => 'provider-alpha');
        mockServiceClient.getIndexFingerprint = jest
          .fn()
          .mockReturnValueOnce('index-fingerprint-1')
          .mockReturnValueOnce('index-fingerprint-2');
        mockServiceClient.localKeywordSearch = jest.fn(async () => [
          {
            path: 'src/auth/login.ts',
            content: 'export function login() { return true; }',
            relevanceScore: 0.9,
          },
        ]);
        mockServiceClient.searchAndAsk.mockResolvedValue(
          `### BEGIN RESPONSE ###
Here is an enhanced version of the original instruction that is more specific and clear:
<enhanced-prompt>Index-isolated cache output.</enhanced-prompt>

### END RESPONSE ###`
        );

        await handleEnhancePrompt({ prompt: 'cache index boundary prompt' }, mockServiceClient as any);
        await handleEnhancePrompt({ prompt: 'cache index boundary prompt' }, mockServiceClient as any);

        expect(mockServiceClient.localKeywordSearch).toHaveBeenCalledTimes(2);
      });

      it('invalidates cache when retrieval profile changes', async () => {
        process.env.CE_ENHANCE_PROMPT_CACHE_TTL_MS = '60000';
        process.env.CONTEXT_ENGINE_RETRIEVAL_PIPELINE = '1';
        mockServiceClient.getActiveAIProviderId = jest.fn(() => 'provider-alpha');
        mockServiceClient.getIndexFingerprint = jest.fn(() => 'index-fingerprint-1');
        mockServiceClient.localKeywordSearch = jest.fn(async () => [
          {
            path: 'src/auth/light.ts',
            content: 'export function localLightSearch() { return true; }',
            relevanceScore: 0.95,
          },
        ]);
        mockServiceClient.semanticSearch = jest.fn(async () => [
          {
            path: 'src/auth/rich.ts',
            content: 'export function richSearch() { return true; }',
            relevanceScore: 0.92,
          },
        ]);
        mockServiceClient.searchAndAsk.mockResolvedValue(
          `### BEGIN RESPONSE ###
Here is an enhanced version of the original instruction that is more specific and clear:
<enhanced-prompt>Profile-isolated cache output.</enhanced-prompt>

### END RESPONSE ###`
        );

        process.env.CE_ENHANCE_PROMPT_MODE = 'light';
        await handleEnhancePrompt({ prompt: 'cache profile boundary prompt' }, mockServiceClient as any);
        process.env.CE_ENHANCE_PROMPT_MODE = 'rich';
        await handleEnhancePrompt({ prompt: 'cache profile boundary prompt' }, mockServiceClient as any);

        expect(mockServiceClient.localKeywordSearch).toHaveBeenCalledTimes(2);
        expect(mockServiceClient.semanticSearch).toHaveBeenCalled();
      });

      it('invalidates cache when tool version changes', async () => {
        process.env.CE_ENHANCE_PROMPT_MODE = 'light';
        process.env.CE_ENHANCE_PROMPT_CACHE_TTL_MS = '60000';
        mockServiceClient.getActiveAIProviderId = jest.fn(() => 'provider-alpha');
        mockServiceClient.getIndexFingerprint = jest.fn(() => 'index-fingerprint-1');
        mockServiceClient.localKeywordSearch = jest.fn(async () => [
          {
            path: 'src/auth/login.ts',
            content: 'export function login() { return true; }',
            relevanceScore: 0.9,
          },
        ]);
        mockServiceClient.searchAndAsk.mockResolvedValue(
          `### BEGIN RESPONSE ###
Here is an enhanced version of the original instruction that is more specific and clear:
<enhanced-prompt>Tool-version-isolated cache output.</enhanced-prompt>

### END RESPONSE ###`
        );

        process.env.CE_ENHANCE_PROMPT_TOOL_VERSION = 'test-tool-v1';
        await handleEnhancePrompt({ prompt: 'cache tool version boundary prompt' }, mockServiceClient as any);

        process.env.CE_ENHANCE_PROMPT_TOOL_VERSION = 'test-tool-v2';
        await handleEnhancePrompt({ prompt: 'cache tool version boundary prompt' }, mockServiceClient as any);

        expect(mockServiceClient.localKeywordSearch).toHaveBeenCalledTimes(2);
      });

      it('does not reuse stale entries after TTL expiry', async () => {
        process.env.CE_ENHANCE_PROMPT_MODE = 'light';
        process.env.CE_ENHANCE_PROMPT_CACHE_TTL_MS = '5';
        mockServiceClient.getActiveAIProviderId = jest.fn(() => 'provider-alpha');
        mockServiceClient.getIndexFingerprint = jest.fn(() => 'index-fingerprint-1');
        mockServiceClient.localKeywordSearch = jest.fn(async () => [
          {
            path: 'src/auth/login.ts',
            content: 'export function login() { return true; }',
            relevanceScore: 0.9,
          },
        ]);
        mockServiceClient.searchAndAsk.mockResolvedValue(
          `### BEGIN RESPONSE ###
Here is an enhanced version of the original instruction that is more specific and clear:
<enhanced-prompt>TTL cache output.</enhanced-prompt>

### END RESPONSE ###`
        );

        await handleEnhancePrompt({ prompt: 'cache ttl expiry prompt' }, mockServiceClient as any);
        await new Promise((resolve) => setTimeout(resolve, 20));
        await handleEnhancePrompt({ prompt: 'cache ttl expiry prompt' }, mockServiceClient as any);

        expect(mockServiceClient.localKeywordSearch).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('Parser Hardening', () => {
    it('should reject the placeholder enhanced prompt marker', () => {
      const response = '<enhanced-prompt>enhanced prompt goes here</enhanced-prompt>';
      expect(parseEnhancedPrompt(response)).toBeNull();
    });

    it('should still parse valid non-placeholder enhanced prompts', () => {
      const response = '<enhanced-prompt>Use strict validation and safe defaults.</enhanced-prompt>';
      expect(parseEnhancedPrompt(response)).toBe('Use strict validation and safe defaults.');
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
      expect(enhancePromptTool.description).toContain('searchAndAsk');
    });

    it('should include example in description', () => {
      expect(enhancePromptTool.description).toContain('Example');
      expect(enhancePromptTool.description).toContain('fix the login bug');
    });

    it('should mention authentication requirement', () => {
      expect(enhancePromptTool.description).toContain('authentication');
      expect(enhancePromptTool.description).toContain('OpenAI session');
    });
  });
});
