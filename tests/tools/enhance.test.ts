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
    delete process.env.CE_ENHANCE_PROMPT_TIMEOUT_MS;
    delete process.env.CE_ENHANCE_PROMPT_RETRY_ATTEMPTS;
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
      expect(timeoutMs).toBeLessThanOrEqual(120000);
    });

    it('should honor configured enhance timeout above 30 seconds', async () => {
      process.env.CE_ENHANCE_PROMPT_TIMEOUT_MS = '60000';
      const aiResponse = `### BEGIN RESPONSE ###
Here is an enhanced version of the original instruction that is more specific and clear:
<enhanced-prompt>Configured timeout honored.</enhanced-prompt>

### END RESPONSE ###`;
      mockServiceClient.searchAndAsk.mockResolvedValue(aiResponse);

      await handleEnhancePrompt({
        prompt: 'validate timeout ceiling behavior',
      }, mockServiceClient as any);

      const timeoutMs = mockServiceClient.searchAndAsk.mock.calls[0][2]?.timeoutMs;
      expect(timeoutMs).toBeGreaterThan(30000);
      expect(timeoutMs).toBeLessThanOrEqual(60000);
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

        expect(result).toContain('## Objective');
        expect(result).toContain('Default light mode enhancement.');
        expect(mockServiceClient.searchAndAsk).toHaveBeenCalledTimes(1);
        expect(mockServiceClient.searchAndAsk).toHaveBeenCalledWith(
          'improve test defaults',
          expect.not.stringContaining('Here is relevant code context that may help:'),
          expect.objectContaining({ timeoutMs: expect.any(Number) })
        );
        const timeoutMs = mockServiceClient.searchAndAsk.mock.calls[0][2]?.timeoutMs;
        expect(timeoutMs).toBeGreaterThanOrEqual(1000);
        expect(timeoutMs).toBeLessThanOrEqual(120000);
      });

      it('should return explicit transient error when enhance mode is off and upstream times out', async () => {
        process.env.CE_ENHANCE_PROMPT_MODE = 'off';
        process.env.CE_ENHANCE_PROMPT_RETRY_ATTEMPTS = '0';
        mockServiceClient.searchAndAsk.mockRejectedValue(new Error('request timeout while enhancing'));

        await expect(handleEnhancePrompt({
          prompt: 'stabilize ci workflow',
        }, mockServiceClient as any)).rejects.toThrow(/\[TRANSIENT_UPSTREAM\]/);
        expect(mockServiceClient.searchAndAsk).toHaveBeenCalledTimes(1);
      });

      it('should prefer the highest-relevance files when building rich context', async () => {
        process.env.CE_ENHANCE_PROMPT_MODE = 'rich';
        mockServiceClient.semanticSearch.mockResolvedValue([
          {
            path: 'src/auth/low.ts',
            content: 'export function lowPriorityDraft() { return "draft"; }',
            relevanceScore: 0.35,
            matchType: 'keyword',
          },
          {
            path: 'src/auth/high.ts',
            content: 'export function highPriorityFlow() { return "high"; }',
            relevanceScore: 0.96,
            matchType: 'keyword',
          },
          {
            path: 'src/auth/low.ts',
            content: 'export function lowPriorityDraft() { return "revised"; }',
            relevanceScore: 0.91,
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
        expect(promptText).toContain('File: src/auth/high.ts');
        expect(promptText).toContain('File: src/auth/low.ts');
        expect(promptText.indexOf('File: src/auth/high.ts')).toBeLessThan(
          promptText.indexOf('File: src/auth/low.ts')
        );
        expect(promptText).toContain('revised');
        expect(promptText).not.toContain('draft');
      });
    });

    it('should retry transient timeout once before succeeding', async () => {
      process.env.CE_ENHANCE_PROMPT_RETRY_ATTEMPTS = '1';
      mockServiceClient.searchAndAsk
        .mockRejectedValueOnce(new Error('Network timeout'))
        .mockResolvedValueOnce(
          `### BEGIN RESPONSE ###
Here is an enhanced version of the original instruction that is more specific and clear:
<enhanced-prompt>Recovered after retry.</enhanced-prompt>

### END RESPONSE ###`
        );

      const result = await handleEnhancePrompt({
        prompt: 'retry once please',
      }, mockServiceClient as any);

      expect(result).toContain('## Objective');
      expect(result).toContain('Recovered after retry.');
      expect(mockServiceClient.searchAndAsk).toHaveBeenCalledTimes(2);
    });

    it('should retry with lean prompt context after transient failure', async () => {
      process.env.CE_ENHANCE_PROMPT_MODE = 'rich';
      process.env.CE_ENHANCE_PROMPT_RETRY_ATTEMPTS = '1';
      process.env.CONTEXT_ENGINE_RETRIEVAL_PIPELINE = '1';
      mockServiceClient.semanticSearch = jest.fn(async () => [
        {
          path: 'src/auth/retry.ts',
          content: 'export function retryPath() { return true; }',
          relevanceScore: 0.91,
        },
      ]);
      mockServiceClient.searchAndAsk
        .mockRejectedValueOnce(new Error('SEARCH_QUEUE_FULL: queue saturated'))
        .mockResolvedValueOnce(
          `### BEGIN RESPONSE ###
Here is an enhanced version of the original instruction that is more specific and clear:
<enhanced-prompt>Lean retry succeeded.</enhanced-prompt>

### END RESPONSE ###`
        );

      const result = await handleEnhancePrompt({
        prompt: 'retry with lean prompt',
      }, mockServiceClient as any);

      expect(result).toContain('## Objective');
      expect(result).toContain('Lean retry succeeded.');
      expect(mockServiceClient.searchAndAsk).toHaveBeenCalledTimes(2);
      const firstPrompt = mockServiceClient.searchAndAsk.mock.calls[0][1];
      const secondPrompt = mockServiceClient.searchAndAsk.mock.calls[1][1];
      expect(firstPrompt).toContain('Here is relevant code context that may help:');
      expect(secondPrompt).not.toContain('Here is relevant code context that may help:');
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

    it('should prefer local docs search first for operational prompts in rich mode', async () => {
      process.env.CE_ENHANCE_PROMPT_MODE = 'rich';
      mockServiceClient.localKeywordSearch = jest.fn(async () => [
        {
          path: 'docs/QUICKSTART.md',
          content: 'Quickstart instructions for Codex.',
          relevanceScore: 0.95,
        },
      ]);
      mockServiceClient.semanticSearch = jest.fn(async () => [
        {
          path: 'src/fallback.ts',
          content: 'fallback result',
          relevanceScore: 0.5,
        },
      ]);
      mockServiceClient.searchAndAsk.mockResolvedValue(`### BEGIN RESPONSE ###
Here is an enhanced version of the original instruction that is more specific and clear:
<enhanced-prompt>Use the quickstart docs first for installation guidance.</enhanced-prompt>

### END RESPONSE ###`);

      const result = await handleEnhancePrompt({
        prompt: 'how do I install this mcp on codex via the quickstart docs',
      }, mockServiceClient as any);

      expect(mockServiceClient.localKeywordSearch).toHaveBeenCalledTimes(1);
      expect(mockServiceClient.semanticSearch).not.toHaveBeenCalled();
      expect(mockServiceClient.searchAndAsk).toHaveBeenCalledTimes(1);
      expect(result).toContain('quickstart docs first');
    });

    it('should fall back to richer retrieval when local docs search is empty', async () => {
      process.env.CE_ENHANCE_PROMPT_MODE = 'rich';
      mockServiceClient.localKeywordSearch = jest.fn(async () => []);
      mockServiceClient.semanticSearch = jest.fn(async () => [
        {
          path: 'src/mcp/serviceClient.ts',
          content: 'ContextServiceClient builds context packs.',
          relevanceScore: 0.88,
        },
      ]);
      mockServiceClient.searchAndAsk.mockResolvedValue(`### BEGIN RESPONSE ###
Here is an enhanced version of the original instruction that is more specific and clear:
<enhanced-prompt>Fallback retrieval produced a richer answer.</enhanced-prompt>

### END RESPONSE ###`);

      const result = await handleEnhancePrompt({
        prompt: 'how do I install this mcp on codex when the quickstart docs are missing',
      }, mockServiceClient as any);

      expect(mockServiceClient.localKeywordSearch).toHaveBeenCalledTimes(2);
      expect(mockServiceClient.semanticSearch).toHaveBeenCalledTimes(1);
      expect(mockServiceClient.searchAndAsk).toHaveBeenCalledTimes(1);
      expect(result).toContain('richer answer');
    });

    it('should parse enhanced prompt from AI response and return structured markdown', async () => {
      const enhancedText = 'Implement user authentication with JWT tokens and session management.';
      const aiResponse = `### BEGIN RESPONSE ###
Here is an enhanced version of the original instruction that is more specific and clear:
<enhanced-prompt>${enhancedText}</enhanced-prompt>

### END RESPONSE ###`;

      mockServiceClient.searchAndAsk.mockResolvedValue(aiResponse);

      const result = await handleEnhancePrompt({
        prompt: 'simple prompt',
      }, mockServiceClient as any);

      expect(result).toContain('## Objective');
      expect(result).toContain(enhancedText);
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

      expect(result).toContain('## Objective');
      expect(result).toContain('Debug and fix the user authentication issue.');
    });

    it('should return validation error when response has no expected XML tags', async () => {
      const rawResponse = 'AI response without expected XML tags';
      mockServiceClient.searchAndAsk.mockResolvedValue(rawResponse);

      await expect(handleEnhancePrompt({
        prompt: 'test',
      }, mockServiceClient as any)).rejects.toThrow(/\[VALIDATION_FAILED\]/);
    });

    it('should throw error when searchAndAsk returns empty response', async () => {
      mockServiceClient.searchAndAsk.mockResolvedValue('');

      await expect(handleEnhancePrompt({
        prompt: 'test',
      }, mockServiceClient as any)).rejects.toThrow(/\[VALIDATION_FAILED\]/i);
    });

    it('should throw authentication error with helpful message', async () => {
      process.env.CE_ENHANCE_PROMPT_RETRY_ATTEMPTS = '2';
      mockServiceClient.searchAndAsk.mockRejectedValue(new Error('API key is required'));

      await expect(handleEnhancePrompt({
        prompt: 'test',
      }, mockServiceClient as any)).rejects.toThrow(/authentication/i);
      expect(mockServiceClient.searchAndAsk).toHaveBeenCalledTimes(1);
    });

    it('should surface usage limit errors instead of falling back', async () => {
      mockServiceClient.searchAndAsk.mockRejectedValue(
        new Error('Codex session usage limit reached. Try again at Mar 12th, 2026 3:00 AM.')
      );

      await expect(handleEnhancePrompt({
        prompt: 'quota blocked prompt',
      }, mockServiceClient as any)).rejects.toThrow(/usage limit/i);
      expect(mockServiceClient.searchAndAsk).toHaveBeenCalledTimes(1);
    });

    it('should return transient upstream error on timeout', async () => {
      mockServiceClient.searchAndAsk.mockRejectedValue(new Error('Network timeout'));

      await expect(handleEnhancePrompt({
        prompt: 'test',
      }, mockServiceClient as any)).rejects.toThrow(/\[TRANSIENT_UPSTREAM\]/);
    });

    it('should return transient upstream error on queue pressure', async () => {
      mockServiceClient.searchAndAsk.mockRejectedValue(new Error('SEARCH_QUEUE_FULL: queue saturated'));

      await expect(handleEnhancePrompt({
        prompt: 'handle queue pressure',
      }, mockServiceClient as any)).rejects.toThrow(/\[TRANSIENT_UPSTREAM\]/);
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
      expect(parsed.schema_version).toBeDefined();
      expect(parsed.template_version).toBeDefined();
      expect(parsed.enhanced_prompt).toContain('## Objective');
      expect(parsed.enhanced_prompt).toContain('Structured AI enhancement output.');
      expect(parsed.source).toBe('ai');
      expect(parsed.reason_code).toBe('ai_enhanced');
      expect(parsed).not.toHaveProperty('flow');
    });

    it('returns structured JSON error envelope when CE_ENHANCE_PROMPT_RESPONSE_FORMAT=json and transient failure occurs', async () => {
      process.env.CE_ENHANCE_PROMPT_RESPONSE_FORMAT = 'json';
      mockServiceClient.searchAndAsk.mockRejectedValue(new Error('SEARCH_QUEUE_FULL: queue saturated'));

      const raw = await handleEnhancePrompt(
        { prompt: 'transient json please' },
        mockServiceClient as any
      );
      const parsed = JSON.parse(raw);
      expect(parsed.schema_version).toBeDefined();
      expect(parsed.error_code).toBe('TRANSIENT_UPSTREAM');
      expect(parsed.retryable).toBe(true);
    });

    it('returns retry_after_ms in JSON envelope when upstream provides retry hint', async () => {
      process.env.CE_ENHANCE_PROMPT_RESPONSE_FORMAT = 'json';
      process.env.CE_ENHANCE_PROMPT_RETRY_ATTEMPTS = '0';
      mockServiceClient.searchAndAsk.mockRejectedValue(
        new Error('SEARCH_QUEUE_FULL: queue saturated retry_after_ms=4200')
      );

      const raw = await handleEnhancePrompt(
        { prompt: 'transient with retry hint' },
        mockServiceClient as any
      );
      const parsed = JSON.parse(raw);
      expect(parsed.error_code).toBe('TRANSIENT_UPSTREAM');
      expect(parsed.retryable).toBe(true);
      expect(parsed.retry_after_ms).toBe(4200);
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
