import type {
  JsonSchema,
  JsonSchemaPrimitiveType,
  JsonSchemaType,
  JsonSchemaValidationError,
  JsonSchemaValidationResult,
} from '../types/outputSchema.js';

function joinPath(base: string, segment: string): string {
  if (base === '') {
    return segment;
  }
  if (segment.startsWith('[')) {
    return `${base}${segment}`;
  }
  return `${base}.${segment}`;
}

function normalizeTypes(type: JsonSchemaType | undefined): JsonSchemaPrimitiveType[] {
  if (type === undefined) {
    return [];
  }
  return Array.isArray(type) ? type : [type];
}

function typeOfValue(value: unknown): JsonSchemaPrimitiveType {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    case 'object':
      return 'object';
    default:
      return 'string';
  }
}

function matchesType(value: unknown, expected: JsonSchemaPrimitiveType): boolean {
  if (expected === 'integer') {
    return typeof value === 'number' && Number.isInteger(value);
  }
  if (expected === 'number') {
    return typeof value === 'number' && !Number.isNaN(value);
  }
  return typeOfValue(value) === expected;
}

function valueMatchesTypes(value: unknown, schema: JsonSchema): boolean {
  const types = normalizeTypes(schema.type);
  if (types.length === 0) {
    return true;
  }

  if (schema.nullable && value === null) {
    return true;
  }

  return types.some((expected) => matchesType(value, expected));
}

function validateValue(value: unknown, schema: JsonSchema, path: string, errors: JsonSchemaValidationError[]): void {
  if (schema.const !== undefined && value !== schema.const) {
    errors.push({
      path,
      message: `Expected const ${JSON.stringify(schema.const)}`,
    });
    return;
  }

  if (schema.enum !== undefined && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    errors.push({
      path,
      message: `Expected one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`,
    });
    return;
  }

  if (schema.type !== undefined && !valueMatchesTypes(value, schema)) {
    const types = normalizeTypes(schema.type);
    errors.push({
      path,
      message: `Expected type ${types.join(' | ')} but received ${typeOfValue(value)}`,
    });
    return;
  }

  if (value === null) {
    return;
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, message: `Expected minimum ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, message: `Expected maximum ${schema.maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path, message: `Expected at least ${schema.minItems} items` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ path, message: `Expected at most ${schema.maxItems} items` });
    }

    if (schema.items !== undefined) {
      const itemSchema = Array.isArray(schema.items) ? undefined : schema.items;
      if (itemSchema) {
        value.forEach((entry, index) => {
          validateValue(entry, itemSchema, joinPath(path, `[${index}]`), errors);
        });
      }
    }
    return;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;

    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in record)) {
          errors.push({ path: joinPath(path, key), message: 'Required property is missing' });
        }
      }
    }

    if (schema.properties) {
      for (const [key, propertySchema] of Object.entries(schema.properties)) {
        if (key in record) {
          validateValue(record[key], propertySchema, joinPath(path, key), errors);
        }
      }
    }

    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(record)) {
        if (!(key in schema.properties)) {
          errors.push({ path: joinPath(path, key), message: 'Additional property is not allowed' });
        }
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const [key, entry] of Object.entries(record)) {
        if (schema.properties && key in schema.properties) {
          continue;
        }
        validateValue(entry, schema.additionalProperties, joinPath(path, key), errors);
      }
    }
  }
}

export function validateAgainstJsonSchema(value: unknown, schema: JsonSchema): JsonSchemaValidationResult {
  const errors: JsonSchemaValidationError[] = [];
  validateValue(value, schema, '', errors);
  return {
    valid: errors.length === 0,
    errors,
  };
}
