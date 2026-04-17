/**
 * Status Endpoint
 * 
 * Returns index status information.
 */

import type { Router } from 'express';
import { Router as createRouter } from 'express';
import type { ContextServiceClient } from '../../mcp/serviceClient.js';
import {
    createHashEmbeddingRuntime,
    describeEmbeddingRuntimeSelection,
    describeEmbeddingRuntimeStatus,
    describeLastEmbeddingRuntimeStatus,
    type EmbeddingRuntimeStatus,
} from '../../internal/retrieval/embeddingRuntime.js';

function sanitizeDowngradeReason(reason: string): string {
    // Map internal reason strings to stable category codes so we do not leak local paths,
    // model identifiers, or upstream error text over HTTP. Full details remain in server logs.
    if (/differs from configured/i.test(reason)) return 'active_runtime_mismatch';
    if (/unavailable|not loaded|load.*fail|module.*missing/i.test(reason)) return 'runtime_unavailable';
    if (/retry|backoff/i.test(reason)) return 'awaiting_retry';
    return 'runtime_degraded';
}

function buildRetrievalStatusPayload(status: EmbeddingRuntimeStatus) {
    return {
        state: status.state,
        configured: status.configured,
        active: status.active,
        hashFallbackActive: status.hashFallbackActive,
        downgrade: status.downgrade
            ? {
                  reason: sanitizeDowngradeReason(status.downgrade.reason),
                  since: status.downgrade.since,
              }
            : null,
        loadFailures: status.loadFailures,
        // Do not echo raw error text over HTTP; expose a boolean-ish stable code only.
        lastFailure: status.lastFailure ? 'runtime_error' : null,
        lastFailureAt: status.lastFailureAt ?? null,
        nextRetryAt: status.nextRetryAt ?? null,
    };
}

function resolveRetrievalStatus(): EmbeddingRuntimeStatus {
    // Prefer the live-derived status so configuration changes (e.g., disabling the
    // transformer embeddings feature flag) are reflected immediately instead of
    // serving a stale observed snapshot from a previous runtime configuration.
    const described = describeEmbeddingRuntimeStatus(true);
    if (described) {
        return described;
    }
    const observed = describeLastEmbeddingRuntimeStatus();
    if (observed) {
        return observed;
    }
    // Hash runtime is the configured backend (transformer flag disabled): report as healthy
    // with no downgrade so CI gates don't mis-classify intentional hash-only deployments.
    const hashSelection = describeEmbeddingRuntimeSelection(true);
    const fallbackSelection = {
        id: createHashEmbeddingRuntime().id,
        modelId: createHashEmbeddingRuntime().modelId,
        vectorDimension: createHashEmbeddingRuntime().vectorDimension,
    };
    return {
        state: 'healthy',
        configured: hashSelection,
        active: hashSelection,
        fallback: fallbackSelection,
        loadFailures: 0,
        hashFallbackActive: false,
        downgrade: null,
    };
}

/**
 * Create status router.
 * 
 * Endpoints:
 * - GET /api/v1/status - Returns index status
 * - GET /api/v1/retrieval/status - Returns embedding runtime status (read-only).
 */
export function createStatusRouter(serviceClient: ContextServiceClient): Router {
    const router = createRouter();

    router.get('/status', (_req, res) => {
        try {
            const status = serviceClient.getIndexStatus();
            res.json(status);
        } catch (error) {
            console.error('[api:status]', error);
            res.status(500).json({ error: 'status_unavailable' });
        }
    });

    router.get('/retrieval/status', (_req, res) => {
        try {
            const status = resolveRetrievalStatus();
            res.json(buildRetrievalStatusPayload(status));
        } catch (error) {
            console.error('[api:retrieval/status]', error);
            res.status(500).json({ error: 'retrieval_status_unavailable' });
        }
    });

    return router;
}
