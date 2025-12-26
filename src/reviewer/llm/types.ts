import type { EnterpriseFinding } from '../types.js';

export interface LLMCallResult {
  findings: EnterpriseFinding[];
  warnings: string[];
  raw_json?: string;
}

export interface EnterpriseLLMClient {
  call(searchQuery: string, prompt: string): Promise<string>;
  model?: string;
}

