export type {
  ContextEngineStructuredContent,
  ContextEngineToolHandlerResult,
  ContextEngineToolResult,
  TextToolContent,
} from '../types/toolResult.js';

export {
  errorResult,
  isToolResult,
  normalizeToolResult,
  okResult,
} from '../utils/resultBuilder.js';
