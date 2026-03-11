import { resolveRetrievalProviderEnv } from '../../src/retrieval/providers/env.ts';

type EnvInput = Record<string, string | undefined>;

assertDeepEqual(
  'default env resolves to local_native without force flag',
  resolve({}),
  {
    providerId: 'local_native',
    forceLegacy: false,
    shadowCompareEnabled: false,
    shadowSampleRate: 0,
  }
);

assertDeepEqual(
  'configured local_native provider is honored when force flag is off',
  resolve({
    CE_RETRIEVAL_PROVIDER: 'local_native',
    CE_RETRIEVAL_FORCE_LEGACY: 'false',
  }),
  {
    providerId: 'local_native',
    forceLegacy: false,
    shadowCompareEnabled: false,
    shadowSampleRate: 0,
  }
);

assertDeepEqual(
  'force legacy overrides configured provider',
  resolve({
    CE_RETRIEVAL_PROVIDER: 'local_native',
    CE_RETRIEVAL_FORCE_LEGACY: 'true',
    AUGMENT_API_TOKEN: 'ci-test-token',
  }),
  {
    providerId: 'augment_legacy',
    forceLegacy: true,
    shadowCompareEnabled: false,
    shadowSampleRate: 0,
  }
);

assertDeepEqual(
  'force legacy supports enabled shorthand values',
  resolve({
    CE_RETRIEVAL_PROVIDER: 'local_native',
    CE_RETRIEVAL_FORCE_LEGACY: '1',
    AUGMENT_API_TOKEN: 'ci-test-token',
  }),
  {
    providerId: 'augment_legacy',
    forceLegacy: true,
    shadowCompareEnabled: false,
    shadowSampleRate: 0,
  }
);

assertThrows(
  'invalid force legacy value fails fast',
  () => resolve({ CE_RETRIEVAL_FORCE_LEGACY: 'maybe' }),
  /CE_RETRIEVAL_FORCE_LEGACY/i
);

console.log('Retrieval config precedence check passed.');

function resolve(env: EnvInput) {
  return resolveRetrievalProviderEnv(env as NodeJS.ProcessEnv);
}

function assertDeepEqual<T>(name: string, actual: T, expected: T): void {
  const actualJson = stableJson(actual);
  const expectedJson = stableJson(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${name} failed.\nExpected: ${expectedJson}\nActual:   ${actualJson}`);
  }
}

function assertThrows(name: string, run: () => void, expectedMessage: RegExp): void {
  try {
    run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!expectedMessage.test(message)) {
      throw new Error(`${name} threw unexpected message: ${message}`);
    }
    return;
  }
  throw new Error(`${name} failed: expected an error.`);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}
