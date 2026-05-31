import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import type { JsonSchema } from '../types/outputSchema.js';
import { validateAgainstJsonSchema } from './jsonSchemaValidator.js';

export function assertValidToolInput(
  toolName: string,
  args: unknown,
  inputSchema: JsonSchema | undefined
): void {
  if (!inputSchema) {
    return;
  }

  const normalizedArgs = args ?? {};
  const validation = validateAgainstJsonSchema(normalizedArgs, inputSchema);
  if (validation.valid) {
    return;
  }

  const detail = validation.errors
    .map((error) => {
      const path = error.path.length > 0 ? error.path : '(root)';
      return `${path}: ${error.message}`;
    })
    .join('; ');

  throw new McpError(
    ErrorCode.InvalidParams,
    `Invalid arguments for tool "${toolName}": ${detail}`
  );
}

export function buildToolInputSchemaMap(
  entries: Array<{ tool: { name: string; inputSchema?: JsonSchema } }>
): Map<string, JsonSchema> {
  return new Map(
    entries.flatMap((entry) => {
      const schema = entry.tool.inputSchema;
      return schema ? [[entry.tool.name, schema] as const] : [];
    })
  );
}
