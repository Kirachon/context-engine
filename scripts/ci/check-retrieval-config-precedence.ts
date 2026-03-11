import { resolveRetrievalProviderEnv } from '../../src/retrieval/providers/env.ts';

type EnvInput = Record<string, string | undefined>;

assertDeepEqual(
  'default env resolves to local_native without force flag',
  resolve({}),
  {
    providerId: 'local_native',
    shadowCompareEnabled: false,
    shadowSampleRate: 0,
  }
);

assertDeepEqual(
  'configured local_native provider is honored when legacy override is off',
  resolve({
    CE_RETRIEVAL_PROVIDER: 'local_native',
  }),
  {
    providerId: 'local_native',
    shadowCompareEnabled: false,
    shadowSampleRate: 0,
  }
);

assertThrows(
  'removed provider selection is rejected',
  () =>
    resolve({
      CE_RETRIEVAL_PROVIDER: 'augment_legacy',
    }),
  /Invalid CE_RETRIEVAL_PROVIDER value/i
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
