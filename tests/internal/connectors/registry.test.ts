import { describe, expect, it } from '@jest/globals';
import { createConnectorRegistry, buildConnectorFingerprint, formatConnectorHint } from '../../../src/internal/connectors/registry.js';
import type { ContextConnector } from '../../../src/internal/connectors/types.js';

describe('connector registry', () => {
  it('routes through connectors in order and keeps the first successful signal set', async () => {
    const connectors: ContextConnector[] = [
      {
        id: 'first',
        label: 'First',
        collect: async () => null,
      },
      {
        id: 'second',
        label: 'Second',
        collect: async () => ({
          id: 'second',
          label: 'Second',
          status: 'available',
          fingerprint: 'second:fp',
          summary: 'second connector succeeded',
          details: ['detail=a'],
        }),
      },
    ];

    const registry = createConnectorRegistry(connectors);
    const signals = await registry.collectSignals('D:/tmp/workspace');

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      id: 'second',
      label: 'Second',
      status: 'available',
    });
    expect(buildConnectorFingerprint(signals)).toBe('second:fp');
    expect(formatConnectorHint(signals[0]!)).toContain('Second: second connector succeeded');
  });

  it('swallows connector errors and falls back to later connectors', async () => {
    const connectors: ContextConnector[] = [
      {
        id: 'broken',
        label: 'Broken',
        collect: async () => {
          throw new Error('boom');
        },
      },
      {
        id: 'fallback',
        label: 'Fallback',
        collect: async () => ({
          id: 'fallback',
          label: 'Fallback',
          status: 'available',
          fingerprint: 'fallback:fp',
          summary: 'fallback connector succeeded',
          details: [],
        }),
      },
    ];

    const registry = createConnectorRegistry(connectors);
    const signals = await registry.collectSignals('D:/tmp/workspace');

    expect(signals).toHaveLength(1);
    expect(signals[0]?.id).toBe('fallback');
  });
});
