import type { EnterpriseFinding } from '../types.js';
import type { OpenAITaskResult } from '../../mcp/openaiTaskRuntime.js';

export interface LLMCallResult {
  findings: EnterpriseFinding[];
  warnings: string[];
  raw_json?: string;
}

export interface EnterpriseLLMClient {
  call(searchQuery: string, prompt: string): Promise<string | OpenAITaskResult<string>>;
  model?: string;
}
