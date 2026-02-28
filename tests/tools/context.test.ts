/**
 * Unit tests for get_context_for_prompt tool
 *
 * Tests the Layer 3 - MCP Interface functionality for context enhancement
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { handleGetContext, GetContextArgs, getContextTool } from '../../src/mcp/tools/context.js';
import { ContextServiceClient, ContextBundle, FileContext } from '../../src/mcp/serviceClient.js';

describe('get_context_for_prompt Tool', () => {
  let mockServiceClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockServiceClient = {
      getFile: jest.fn(),
      semanticSearch: jest.fn(),
      getContextForPrompt: jest.fn(),
      indexWorkspace: jest.fn(),
      clearCache: jest.fn(),
    };
  });

  describe('Input Validation', () => {
    it('should reject empty query', async () => {
      await expect(handleGetContext({ query: '' }, mockServiceClient as any))
        .rejects.toThrow(/invalid query/i);
    });

    it('should reject null query', async () => {
      await expect(handleGetContext({ query: null as any }, mockServiceClient as any))
        .rejects.toThrow(/invalid query/i);
    });

    it('should reject query over 1000 characters', async () => {
      const longQuery = 'a'.repeat(1001);
      await expect(handleGetContext({ query: longQuery }, mockServiceClient as any))
        .rejects.toThrow(/query too long/i);
    });

    it('should reject max_files less than 1', async () => {
      await expect(handleGetContext({ query: 'test', max_files: 0 }, mockServiceClient as any))
        .rejects.toThrow(/invalid max_files/i);
    });

    it('should reject max_files greater than 20', async () => {
      await expect(handleGetContext({ query: 'test', max_files: 21 }, mockServiceClient as any))
        .rejects.toThrow(/invalid max_files/i);
    });

    it('should reject invalid token_budget', async () => {
      await expect(handleGetContext({ query: 'test', token_budget: 100 }, mockServiceClient as any))
        .rejects.toThrow(/invalid token_budget/i);
    });

    it('should reject non-boolean include_related', async () => {
      await expect(handleGetContext({ query: 'test', include_related: 'yes' as any }, mockServiceClient as any))
        .rejects.toThrow(/invalid include_related/i);
    });

    it('should reject min_relevance below 0', async () => {
      await expect(handleGetContext({ query: 'test', min_relevance: -0.01 }, mockServiceClient as any))
        .rejects.toThrow(/invalid min_relevance/i);
    });

    it('should reject min_relevance above 1', async () => {
      await expect(handleGetContext({ query: 'test', min_relevance: 1.01 }, mockServiceClient as any))
        .rejects.toThrow(/invalid min_relevance/i);
    });

    it('should reject non-numeric min_relevance', async () => {
      await expect(handleGetContext({ query: 'test', min_relevance: '0.3' as any }, mockServiceClient as any))
        .rejects.toThrow(/invalid min_relevance/i);
    });

    it('should accept valid parameters', async () => {
      const mockBundle: ContextBundle = createMockContextBundle();
      mockServiceClient.getContextForPrompt.mockResolvedValue(mockBundle);

      await expect(handleGetContext({
        query: 'test query',
        max_files: 5,
        token_budget: 8000,
        include_related: true,
        min_relevance: 0.3,
      }, mockServiceClient as any)).resolves.toBeDefined();
    });

    it('should normalize whitespace-only around query', async () => {
      const mockBundle: ContextBundle = createMockContextBundle();
      mockServiceClient.getContextForPrompt.mockResolvedValue(mockBundle);

      const result = await handleGetContext({ query: '   test query   ' }, mockServiceClient as any);
      expect(result).toContain('**Query:** "test query"');
    });
  });

  describe('Output Formatting', () => {
    it('should include summary header', async () => {
      const mockBundle = createMockContextBundle();
      mockServiceClient.getContextForPrompt.mockResolvedValue(mockBundle);

      const result = await handleGetContext({ query: 'test' }, mockServiceClient as any);

      expect(result).toContain('# 📚 Codebase Context');
      expect(result).toContain('**Query:**');
    });

    it('should include file overview table', async () => {
      const mockBundle = createMockContextBundle();
      mockServiceClient.getContextForPrompt.mockResolvedValue(mockBundle);

      const result = await handleGetContext({ query: 'test' }, mockServiceClient as any);

      expect(result).toContain('## 📁 Files Overview');
      expect(result).toContain('| # | File | Relevance | Summary |');
    });

    it('should include hints section', async () => {
      const mockBundle = createMockContextBundle();
      mockBundle.hints = ['Test hint 1', 'Test hint 2'];
      mockServiceClient.getContextForPrompt.mockResolvedValue(mockBundle);

      const result = await handleGetContext({ query: 'test' }, mockServiceClient as any);

      expect(result).toContain('## 💡 Key Insights');
      expect(result).toContain('Test hint 1');
    });

    it('should include code snippets with syntax highlighting', async () => {
      const mockBundle = createMockContextBundle();
      mockServiceClient.getContextForPrompt.mockResolvedValue(mockBundle);

      const result = await handleGetContext({ query: 'test' }, mockServiceClient as any);

      expect(result).toContain('```typescript');
      expect(result).toContain('```');
    });

    it('should show empty state message when no results', async () => {
      const emptyBundle: ContextBundle = {
        summary: 'No results',
        query: 'test',
        files: [],
        hints: [],
        metadata: {
          totalFiles: 0,
          totalSnippets: 0,
          totalTokens: 0,
          tokenBudget: 8000,
          truncated: false,
          searchTimeMs: 50,
        },
      };
      mockServiceClient.getContextForPrompt.mockResolvedValue(emptyBundle);

      const result = await handleGetContext({ query: 'nonexistent' }, mockServiceClient as any);

      expect(result).toContain('No relevant code found');
    });
  });

  describe('Tool Schema', () => {
    it('should have correct name', () => {
      expect(getContextTool.name).toBe('get_context_for_prompt');
    });

    it('should have required query property', () => {
      expect(getContextTool.inputSchema.required).toContain('query');
    });

    it('should have all expected properties', () => {
      const props = Object.keys(getContextTool.inputSchema.properties);
      expect(props).toContain('query');
      expect(props).toContain('max_files');
      expect(props).toContain('token_budget');
      expect(props).toContain('include_related');
      expect(props).toContain('min_relevance');
    });
  });
});

/**
 * Helper to create mock context bundle
 */
function createMockContextBundle(): ContextBundle {
  const mockFile: FileContext = {
    path: 'src/test.ts',
    extension: '.ts',
    summary: 'Test module with helper functions',
    relevance: 0.85,
    tokenCount: 150,
    snippets: [
      {
        text: 'export function testHelper() {\n  return true;\n}',
        lines: '1-3',
        relevance: 0.85,
        tokenCount: 15,
        codeType: 'function',
      },
    ],
  };

  return {
    summary: 'Context for "test": 1 files from src, primarily containing function definitions',
    query: 'test',
    files: [mockFile],
    hints: ['File types: .ts (1)', 'Code patterns: function (1)'],
    metadata: {
      totalFiles: 1,
      totalSnippets: 1,
      totalTokens: 150,
      tokenBudget: 8000,
      truncated: false,
      searchTimeMs: 120,
    },
  };
}
