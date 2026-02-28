/**
 * Shared service factory helpers for MCP tools.
 *
 * These helpers centralize lazy singleton lifecycle with WeakRef-bound
 * serviceClient identity checks so tools can reuse services safely.
 */

export type ServiceBuilder<TService, TClient> = (client: TClient) => TService;

export type ServiceFactory<TService, TClient> = {
  get: (client: TClient) => TService;
  reset: () => void;
};

/**
 * Create a WeakRef-bound lazy factory for a single service instance.
 * A new instance is created whenever the input client identity changes.
 */
export function createClientBoundFactory<TService, TClient extends object>(
  build: ServiceBuilder<TService, TClient>
): ServiceFactory<TService, TClient> {
  let cachedService: TService | null = null;
  let cachedClientRef: WeakRef<TClient> | null = null;

  return {
    get(client: TClient): TService {
      const cachedClient = cachedClientRef?.deref();
      if (cachedService && cachedClient === client) {
        return cachedService;
      }

      cachedService = build(client);
      cachedClientRef = new WeakRef(client);
      return cachedService;
    },

    reset(): void {
      cachedService = null;
      cachedClientRef = null;
    },
  };
}
