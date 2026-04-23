import { afterEach, describe, expect, it } from '@jest/globals';

import {
  __resetObservabilityForTests,
  startObservability,
  shutdownObservability,
} from '../../src/observability/otel.js';

describe('observability bootstrap', () => {
  afterEach(async () => {
    delete process.env.CE_OBSERVABILITY_ENABLED;
    delete process.env.CE_OBSERVABILITY_EXPORTER_URL;
    await shutdownObservability();
    __resetObservabilityForTests();
  });

  it('is default-off and idempotent when observability is disabled', async () => {
    const first = await startObservability();
    const second = await startObservability();

    expect(first.enabled).toBe(false);
    expect(first.reason).toBe('disabled');
    expect(second).toBe(first);
  });

  it('degrades to disabled when observability is enabled but OpenTelemetry packages are unavailable', async () => {
    process.env.CE_OBSERVABILITY_ENABLED = 'true';

    const handle = await startObservability();

    expect(handle.enabled).toBe(false);
    expect(handle.reason).toBe('dependencies_unavailable');
  });
});
