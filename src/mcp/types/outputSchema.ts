/**
 * Lightweight JSON Schema subset used for MCP tool outputSchema contracts.
 */

export type JsonSchemaPrimitiveType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

export type JsonSchemaType = JsonSchemaPrimitiveType | JsonSchemaPrimitiveType[];

export type JsonSchema = {
  type?: JsonSchemaType;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  items?: JsonSchema | JsonSchema[];
  enum?: readonly unknown[];
  const?: unknown;
  additionalProperties?: boolean | JsonSchema;
  nullable?: boolean;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

export type ToolOutputSchema = JsonSchema;

export type JsonSchemaValidationError = {
  path: string;
  message: string;
};

export type JsonSchemaValidationResult = {
  valid: boolean;
  errors: JsonSchemaValidationError[];
};

export type ToolWithOutputSchema<T extends { name: string }> = T & {
  outputSchema?: ToolOutputSchema;
};
