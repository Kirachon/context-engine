import { describe, expect, it, jest } from '@jest/globals';
import { createClientBoundFactory } from '../../src/mcp/tooling/serviceFactory.js';

describe('tooling/serviceFactory', () => {
  it('reuses service instance for the same client object', () => {
    const build = jest.fn((client: object) => ({ client }));
    const factory = createClientBoundFactory(build);
    const client = {};

    const first = factory.get(client);
    const second = factory.get(client);

    expect(first).toBe(second);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('creates a new service instance when client identity changes', () => {
    const build = jest.fn((client: object) => ({ client }));
    const factory = createClientBoundFactory(build);
    const clientA = {};
    const clientB = {};

    const fromA = factory.get(clientA);
    const fromB = factory.get(clientB);

    expect(fromA).not.toBe(fromB);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('creates a new service after reset', () => {
    const build = jest.fn((client: object) => ({ client, id: build.mock.calls.length + 1 }));
    const factory = createClientBoundFactory(build);
    const client = {};

    const first = factory.get(client);
    factory.reset();
    const second = factory.get(client);

    expect(first).not.toBe(second);
    expect(build).toHaveBeenCalledTimes(2);
  });
});
