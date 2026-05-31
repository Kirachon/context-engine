import {
  ErrorCode,
  McpError,
  type ReadResourceResult,
  type Resource,
} from '@modelcontextprotocol/sdk/types.js';
import {
  applyResourceDiscoverability,
  getDefaultDiscoverabilityTitle,
} from '../tooling/discoverability.js';
import { getContextPackStore } from '../../context/contextPackStore.js';
import { auditLogResourceRead } from '../../telemetry/auditLog.js';
import { getToolManifest } from '../tools/manifest.js';
import {
  getPlanHistoryService,
  getPlanPersistenceService,
} from '../tools/planManagement.js';
import {
  CHUNK_RESOURCE_URI_PREFIX,
  CONTEXT_PACK_RESOURCE_URI_PREFIX,
  FILE_RESOURCE_URI_PREFIX,
  matchesPolicyEnforcedResourceUri,
  readPolicyEnforcedChunkResource,
  readPolicyEnforcedContextPackResource,
  readPolicyEnforcedFileResource,
  readPolicyEnforcedSymbolResource,
  SYMBOL_RESOURCE_URI_PREFIX,
  type ResourceReadContext,
} from './policyEnforcedReads.js';

export {
  CHUNK_RESOURCE_URI_PREFIX,
  CONTEXT_PACK_RESOURCE_URI_PREFIX,
  FILE_RESOURCE_URI_PREFIX,
  SYMBOL_RESOURCE_URI_PREFIX,
  type ResourceReadContext,
} from './policyEnforcedReads.js';

export const TOOL_MANIFEST_RESOURCE_URI = 'context-engine://tool-manifest';
export const PLAN_RESOURCE_URI_PREFIX = 'context-engine://plans/';
export const PLAN_HISTORY_RESOURCE_URI_PREFIX = 'context-engine://plan-history/';
const RESOURCE_NOT_FOUND_MESSAGE = 'Resource not found';
const MAX_LISTED_CONTEXT_PACKS = 20;

function buildContextPackResourceUri(packId: string): string {
  return `${CONTEXT_PACK_RESOURCE_URI_PREFIX}${encodeURIComponent(packId)}`;
}

function buildPlanResourceUri(planId: string): string {
  return `${PLAN_RESOURCE_URI_PREFIX}${encodeURIComponent(planId)}`;
}

function buildPlanHistoryResourceUri(planId: string): string {
  return `${PLAN_HISTORY_RESOURCE_URI_PREFIX}${encodeURIComponent(planId)}`;
}

function buildTextResourceContents(uri: string, text: string): ReadResourceResult {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text,
      },
    ],
  };
}

function resourceNotFoundError(uri: string): McpError {
  return new McpError(ErrorCode.InvalidParams, `${RESOURCE_NOT_FOUND_MESSAGE}: ${uri}`);
}

function decodePlanIdFromResourceUri(uri: string, prefix: string): string {
  if (!uri.startsWith(prefix)) {
    throw resourceNotFoundError(uri);
  }

  const encodedPlanId = uri.slice(prefix.length);
  if (!encodedPlanId) {
    throw resourceNotFoundError(uri);
  }

  try {
    const planId = decodeURIComponent(encodedPlanId);
    if (!planId.trim()) {
      throw new Error('empty plan id');
    }
    return planId;
  } catch {
    throw resourceNotFoundError(uri);
  }
}

export async function buildResourceList(): Promise<Resource[]> {
  const persistenceService = getPlanPersistenceService();
  const knownPlans = await persistenceService.listPlans({
    sort_by: 'name',
    sort_order: 'asc',
  });

  const resources: Resource[] = [
    applyResourceDiscoverability({
      uri: TOOL_MANIFEST_RESOURCE_URI,
      name: 'tool-manifest',
      title: getDefaultDiscoverabilityTitle('tool-manifest'),
      description: 'JSON tool manifest for the current Context Engine server.',
      mimeType: 'application/json',
    }),
  ];

  for (const plan of knownPlans) {
    resources.push(
      applyResourceDiscoverability({
        uri: buildPlanResourceUri(plan.id),
        name: `plan:${plan.id}`,
        title: getDefaultDiscoverabilityTitle('saved-plan'),
        description: `Saved plan ${plan.id}.`,
        mimeType: 'application/json',
      }),
      applyResourceDiscoverability({
        uri: buildPlanHistoryResourceUri(plan.id),
        name: `plan-history:${plan.id}`,
        title: getDefaultDiscoverabilityTitle('plan-history'),
        description: `Version history for saved plan ${plan.id}.`,
        mimeType: 'application/json',
      })
    );
  }

  try {
    const recentPacks = await getContextPackStore().list(MAX_LISTED_CONTEXT_PACKS);
    for (const pack of recentPacks) {
      resources.push(
        applyResourceDiscoverability({
          uri: buildContextPackResourceUri(pack.id),
          name: `context-pack:${pack.id}`,
          title: getDefaultDiscoverabilityTitle('context-pack'),
          description: `Saved context pack ${pack.id} for query "${pack.query}".`,
          mimeType: 'application/json',
        })
      );
    }
  } catch {
    // Context pack store is optional until workspace services initialize.
  }

  return resources;
}

export async function readResourceByUri(
  uri: string,
  context?: ResourceReadContext
): Promise<ReadResourceResult> {
  try {
    const result = await readResourceByUriInternal(uri, context);
    auditLogResourceRead(uri, 'success');
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const outcome = errorMessage.includes('redacted') || errorMessage.includes('blocked')
      ? (errorMessage.includes('blocked') ? 'blocked' : 'redacted')
      : 'error';
    auditLogResourceRead(uri, outcome, { errorMessage });
    throw error;
  }
}

async function readResourceByUriInternal(
  uri: string,
  context?: ResourceReadContext
): Promise<ReadResourceResult> {
  if (matchesPolicyEnforcedResourceUri(uri)) {
    if (uri.startsWith(FILE_RESOURCE_URI_PREFIX)) {
      return readPolicyEnforcedFileResource(uri, context);
    }
    if (uri.startsWith(CHUNK_RESOURCE_URI_PREFIX)) {
      return readPolicyEnforcedChunkResource(uri, context);
    }
    if (uri.startsWith(SYMBOL_RESOURCE_URI_PREFIX)) {
      return await readPolicyEnforcedSymbolResource(uri, context);
    }
    if (uri.startsWith(CONTEXT_PACK_RESOURCE_URI_PREFIX)) {
      return await readPolicyEnforcedContextPackResource(uri, context, (packId) =>
        getContextPackStore().get(packId)
      );
    }
  }

  if (uri === TOOL_MANIFEST_RESOURCE_URI) {
    return buildTextResourceContents(uri, JSON.stringify(getToolManifest(), null, 2));
  }

  if (uri.startsWith(PLAN_RESOURCE_URI_PREFIX)) {
    const planId = decodePlanIdFromResourceUri(uri, PLAN_RESOURCE_URI_PREFIX);
    const persistenceService = getPlanPersistenceService();
    const plan = await persistenceService.loadPlan(planId);
    if (!plan) {
      throw resourceNotFoundError(uri);
    }
    return buildTextResourceContents(uri, JSON.stringify(plan, null, 2));
  }

  if (uri.startsWith(PLAN_HISTORY_RESOURCE_URI_PREFIX)) {
    const planId = decodePlanIdFromResourceUri(uri, PLAN_HISTORY_RESOURCE_URI_PREFIX);
    const persistenceService = getPlanPersistenceService();
    const planExists = await persistenceService.planExists(planId);
    if (!planExists) {
      throw resourceNotFoundError(uri);
    }

    const historyService = getPlanHistoryService();
    const history = historyService.getHistory(planId, { include_plans: true });
    if (!history) {
      throw resourceNotFoundError(uri);
    }
    return buildTextResourceContents(uri, JSON.stringify(history, null, 2));
  }

  throw resourceNotFoundError(uri);
}
