import {
  callRelationshipsOutputSchema,
  codebaseRetrievalOutputSchema,
  findCallersOutputSchema,
  findCalleesOutputSchema,
  getContextForPromptOutputSchema,
  impactAnalysisOutputSchema,
  indexStatusOutputSchema,
  semanticSearchOutputSchema,
  symbolDefinitionOutputSchema,
  symbolReferencesOutputSchema,
  symbolSearchOutputSchema,
  toolManifestOutputSchema,
  traceSymbolOutputSchema,
  whyThisContextOutputSchema,
} from '../schemas/convertedToolOutputSchemas.js';
import type { JsonSchema, JsonSchemaValidationResult, ToolWithOutputSchema } from '../types/outputSchema.js';
import { validateAgainstJsonSchema } from './jsonSchemaValidator.js';

export const CONVERTED_TOOL_OUTPUT_SCHEMAS: Readonly<Record<string, JsonSchema>> = Object.freeze({
  call_relationships: callRelationshipsOutputSchema,
  codebase_retrieval: codebaseRetrievalOutputSchema,
  find_callers: findCallersOutputSchema,
  find_callees: findCalleesOutputSchema,
  get_context_for_prompt: getContextForPromptOutputSchema,
  impact_analysis: impactAnalysisOutputSchema,
  index_status: indexStatusOutputSchema,
  semantic_search: semanticSearchOutputSchema,
  symbol_definition: symbolDefinitionOutputSchema,
  symbol_references: symbolReferencesOutputSchema,
  symbol_search: symbolSearchOutputSchema,
  tool_manifest: toolManifestOutputSchema,
  trace_symbol: traceSymbolOutputSchema,
  why_this_context: whyThisContextOutputSchema,
});

export function listConvertedToolsWithOutputSchema(): string[] {
  return Object.keys(CONVERTED_TOOL_OUTPUT_SCHEMAS).sort();
}

export function getToolOutputSchema(toolName: string): JsonSchema | undefined {
  return CONVERTED_TOOL_OUTPUT_SCHEMAS[toolName];
}

export function isConvertedToolWithOutputSchema(toolName: string): boolean {
  return toolName in CONVERTED_TOOL_OUTPUT_SCHEMAS;
}

export function validateStructuredContent(
  toolName: string,
  structuredContent: unknown
): JsonSchemaValidationResult {
  const schema = getToolOutputSchema(toolName);
  if (!schema) {
    return {
      valid: false,
      errors: [{ path: '', message: `No output schema registered for tool: ${toolName}` }],
    };
  }

  return validateAgainstJsonSchema(structuredContent, schema);
}

export function applyOutputSchema<T extends { name: string; outputSchema?: JsonSchema }>(
  tool: T
): ToolWithOutputSchema<T> {
  const schema = getToolOutputSchema(tool.name);
  if (!schema) {
    return tool;
  }

  return {
    ...tool,
    outputSchema: tool.outputSchema ?? schema,
  };
}
