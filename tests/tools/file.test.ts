/**
 * Unit tests for get_file tool
 *
 * Tests the Layer 3 - MCP Interface functionality for file retrieval
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { handleGetFile, GetFileArgs, getFileTool } from '../../src/mcp/tools/file.js';
import { ContextServiceClient } from '../../src/mcp/serviceClient.js';

describe('get_file Tool', () => {
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
    it('should reject empty path', async () => {
      await expect(handleGetFile({ path: '' }, mockServiceClient as any))
        .rejects.toThrow(/invalid path/i);
    });

    it('should reject null path', async () => {
      await expect(handleGetFile({ path: null as any }, mockServiceClient as any))
        .rejects.toThrow(/invalid path/i);
    });

    it('should reject path over 500 characters', async () => {
      const longPath = 'a/'.repeat(251) + 'file.txt';
      await expect(handleGetFile({ path: longPath }, mockServiceClient as any))
        .rejects.toThrow(/path too long/i);
    });

    it('should reject invalid start_line', async () => {
      mockServiceClient.getFile.mockResolvedValue('line 1\nline 2\nline 3');

      await expect(handleGetFile({ path: 'test.ts', start_line: 0 }, mockServiceClient as any))
        .rejects.toThrow(/invalid start_line/i);
    });

    it('should reject non-numeric start_line', async () => {
      mockServiceClient.getFile.mockResolvedValue('line 1\nline 2\nline 3');

      await expect(handleGetFile({ path: 'test.ts', start_line: '2' as any }, mockServiceClient as any))
        .rejects.toThrow(/invalid start_line/i);
    });

    it('should reject invalid end_line', async () => {
      mockServiceClient.getFile.mockResolvedValue('line 1\nline 2\nline 3');

      await expect(handleGetFile({ path: 'test.ts', end_line: 0 }, mockServiceClient as any))
        .rejects.toThrow(/invalid end_line/i);
    });

    it('should reject when start_line > end_line', async () => {
      mockServiceClient.getFile.mockResolvedValue('line 1\nline 2\nline 3');

      await expect(handleGetFile({ path: 'test.ts', start_line: 5, end_line: 2 }, mockServiceClient as any))
        .rejects.toThrow(/start_line must be less than or equal to end_line/i);
    });

    it('should accept valid parameters', async () => {
      mockServiceClient.getFile.mockResolvedValue('file content');

      await expect(handleGetFile({ path: 'test.ts' }, mockServiceClient as any)).resolves.toBeDefined();
    });
  });

  describe('Output Formatting', () => {
    it('should include file header', async () => {
      mockServiceClient.getFile.mockResolvedValue('const x = 1;');

      const result = await handleGetFile({ path: 'test.ts' }, mockServiceClient as any);

      expect(result).toContain('# 📄 File:');
      expect(result).toContain('test.ts');
    });

    it('should include metadata table', async () => {
      mockServiceClient.getFile.mockResolvedValue('line 1\nline 2');

      const result = await handleGetFile({ path: 'src/test.ts' }, mockServiceClient as any);

      expect(result).toContain('| Property | Value |');
      expect(result).toContain('**Path**');
      expect(result).toContain('**Lines**');
      expect(result).toContain('**Size**');
    });

    it('should include syntax-highlighted code block', async () => {
      mockServiceClient.getFile.mockResolvedValue('const x = 1;');

      const result = await handleGetFile({ path: 'test.ts' }, mockServiceClient as any);

      expect(result).toContain('```typescript');
      expect(result).toContain('const x = 1;');
      expect(result).toContain('```');
    });

    it('should use correct language for different file types', async () => {
      mockServiceClient.getFile.mockResolvedValue('x = 1');

      const result = await handleGetFile({ path: 'test.py' }, mockServiceClient as any);

      expect(result).toContain('```python');
    });

    it('should handle line ranges correctly', async () => {
      mockServiceClient.getFile.mockResolvedValue('line 1\nline 2\nline 3\nline 4\nline 5');

      const result = await handleGetFile({ path: 'test.ts', start_line: 2, end_line: 4 }, mockServiceClient as any);

      expect(result).toContain('Lines 2-4 of 5');
      expect(result).toContain('line 2');
      expect(result).toContain('line 4');
      expect(result).not.toContain('line 5');
    });
  });

  describe('Tool Schema', () => {
    it('should have correct name', () => {
      expect(getFileTool.name).toBe('get_file');
    });

    it('should have required path property', () => {
      expect(getFileTool.inputSchema.required).toContain('path');
    });

    it('should have path, start_line, and end_line properties', () => {
      const props = Object.keys(getFileTool.inputSchema.properties);
      expect(props).toContain('path');
      expect(props).toContain('start_line');
      expect(props).toContain('end_line');
    });
  });
});
