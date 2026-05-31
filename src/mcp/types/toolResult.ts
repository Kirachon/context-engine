import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type TextToolContent = {
  type: 'text';
  text: string;
};

export type ContextEngineStructuredContent = Record<string, unknown>;

export type ContextEngineToolResult<T extends ContextEngineStructuredContent = ContextEngineStructuredContent> =
  Omit<CallToolResult, 'content' | 'structuredContent'> & {
    content: TextToolContent[];
    structuredContent?: T;
  };

export type ContextEngineToolHandlerResult<T extends ContextEngineStructuredContent = ContextEngineStructuredContent> =
  | string
  | ContextEngineToolResult<T>;
