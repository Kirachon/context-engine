/**
 * Health Endpoint
 *
 * Liveness check for server availability, plus additive R6 composite health.
 * Legacy fields (`status`, `version`, `timestamp`) are preserved unchanged so
 * old clients keep working. Subsystem truth lives under `composite` /
 * `components` and never collapses unknown/unavailable critical subsystems
 * into an unqualified healthy verdict.
 */

import type { Router } from 'express';
import { Router as createRouter } from 'express';
import type { ContextServiceClient } from '../../mcp/serviceClient.js';
import {
  unknownCompositeHealth,
  type CompositeHealth,
  type SessionHealthInput,
} from '../../mcp/tooling/compositeHealth.js';

export interface HealthRouterOptions {
  /** Optional service client for subsystem composite health. */
  serviceClient?: ContextServiceClient;
  /** Optional HTTP session probe (active count / caps). */
  getSessionHealth?: () => SessionHealthInput | undefined;
}

/**
 * Create health check router.
 *
 * Endpoints:
 * - GET /health - Returns server health status (legacy + additive composite)
 */
export function createHealthRouter(version: string, options: HealthRouterOptions = {}): Router {
  const router = createRouter();

  router.get('/health', (_req, res) => {
    let composite: CompositeHealth;
    try {
      const session = options.getSessionHealth?.();
      composite =
        options.serviceClient && typeof options.serviceClient.getCompositeHealth === 'function'
          ? options.serviceClient.getCompositeHealth(session)
          : unknownCompositeHealth('service_client_unavailable');
    } catch {
      composite = unknownCompositeHealth('composite_probe_failed');
    }

    res.json({
      // Legacy liveness fields — do not repurpose; old clients depend on them.
      status: 'ok',
      version,
      timestamp: new Date().toISOString(),
      // R6 additive composite health.
      composite,
      components: composite.components,
    });
  });

  return router;
}
