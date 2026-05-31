import type {
  ContextEngineStructuredContent,
  ContextEngineToolHandlerResult,
  ContextEngineToolResult,
} from '../types/toolResult.js';

export function isToolResult(value: unknown): value is ContextEngineToolResult {
  return Boolean(
    value &&
    typeof value === 'object' &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

export function okResult<T extends ContextEngineStructuredContent>(
  text: string,
  structuredContent?: T,
  options: {
    meta?: Record<string, unknown>;
  } = {}
): ContextEngineToolResult<T> {
  return {
    content: [{ type: 'text', text }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
    ...(options.meta === undefined ? {} : { _meta: options.meta }),
  };
}

export function errorResult<T extends ContextEngineStructuredContent>(
  text: string,
  structuredContent?: T,
  options: {
    meta?: Record<string, unknown>;
  } = {}
): ContextEngineToolResult<T> {
  return {
    ...okResult(text, structuredContent, options),
    isError: true,
  };
}

export function normalizeToolResult(result: ContextEngineToolHandlerResult): ContextEngineToolResult {
  if (isToolResult(result)) {
    return result;
  }

  return {
    content: [
      {
        type: 'text',
        text: result,
      },
    ],
  };
}
