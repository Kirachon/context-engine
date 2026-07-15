/**
 * R6 — Additive composite health.
 *
 * Subsystem-specific health reports that sit alongside legacy index/health
 * fields. Overall composition NEVER collapses unknown/unavailable critical
 * subsystems into an unqualified `healthy` verdict.
 */

export const HEALTH_COMPONENT_STATES = [
  'ready',
  'unknown',
  'unavailable',
  'stale',
  'degraded',
  'error',
] as const;

export type HealthComponentState = (typeof HEALTH_COMPONENT_STATES)[number];

export const HEALTH_COMPONENT_IDS = [
  'corpus',
  'lexical',
  'vector',
  'graph',
  'cancellation_queue',
  'session',
] as const;

export type HealthComponentId = (typeof HEALTH_COMPONENT_IDS)[number];

export interface HealthComponentReport {
  state: HealthComponentState;
  /** When true, unknown/unavailable/error/stale/degraded affect overall. */
  critical: boolean;
  detail?: string;
}

export type HealthComponents = Record<HealthComponentId, HealthComponentReport>;

/**
 * Overall composite status. `healthy` is reserved for the case where every
 * critical component is explicitly `ready`. Critical unknown/unavailable
 * never map to `healthy`.
 */
export type CompositeOverallStatus =
  | 'healthy'
  | 'degraded'
  | 'stale'
  | 'unhealthy'
  | 'unknown';

export interface CompositeHealth {
  schema_version: 1;
  overall: CompositeOverallStatus;
  components: HealthComponents;
}

export interface CorpusHealthInput {
  status: 'idle' | 'indexing' | 'error';
  isStale: boolean;
  lastIndexed: string | null;
  staleCauses?: string[];
}

export interface LexicalHealthInput {
  featureEnabled: boolean;
  engineLoaded: boolean | null;
  loadAttempted: boolean;
}

export interface VectorHealthInput {
  runtimeState?: 'uninitialized' | 'healthy' | 'degraded' | null;
  hashFallbackActive?: boolean;
  loadFailures?: number;
}

export interface GraphHealthInput {
  /** null = never probed (unknown); explicit status when known. */
  status: 'ready' | 'empty' | 'degraded' | 'stale' | 'rebuild_required' | 'unavailable' | null;
  degradedReason?: string | null;
  loadAttempted?: boolean;
}

export interface CancellationQueueHealthInput {
  interactiveDepth: number;
  interactiveMax: number;
  backgroundDepth: number;
  backgroundMax: number;
}

export interface SessionHealthInput {
  /** When omitted, session is reported unknown/non-critical (MCP-only callers). */
  activeCount?: number;
  maxSessions?: number;
  admissionRejectedTotal?: number;
}

export interface CompositeHealthInputs {
  corpus: CorpusHealthInput;
  lexical: LexicalHealthInput;
  vector: VectorHealthInput;
  graph: GraphHealthInput;
  cancellationQueue: CancellationQueueHealthInput;
  session?: SessionHealthInput;
}

function component(
  state: HealthComponentState,
  critical: boolean,
  detail?: string
): HealthComponentReport {
  return detail === undefined ? { state, critical } : { state, critical, detail };
}

export function assessCorpusComponent(input: CorpusHealthInput): HealthComponentReport {
  if (input.status === 'error') {
    return component('error', true, 'index_error');
  }
  if (input.status === 'indexing') {
    return component('degraded', true, 'indexing_in_progress');
  }
  if (!input.lastIndexed) {
    return component('stale', true, 'unindexed');
  }
  if (input.isStale) {
    const causes = input.staleCauses?.length ? input.staleCauses.join(',') : 'stale';
    return component('stale', true, causes);
  }
  return component('ready', true);
}

export function assessLexicalComponent(input: LexicalHealthInput): HealthComponentReport {
  if (!input.featureEnabled) {
    return component('unavailable', false, 'feature_disabled');
  }
  if (input.engineLoaded === true) {
    return component('ready', true);
  }
  if (input.loadAttempted && input.engineLoaded === false) {
    return component('unavailable', true, 'engine_unavailable');
  }
  return component('unknown', true, 'not_probed');
}

export function assessVectorComponent(input: VectorHealthInput): HealthComponentReport {
  const state = input.runtimeState ?? null;
  if (state === null || state === 'uninitialized') {
    return component('unknown', true, 'runtime_uninitialized');
  }
  if (state === 'degraded') {
    const detail = input.hashFallbackActive ? 'hash_fallback_active' : 'runtime_degraded';
    return component('degraded', true, detail);
  }
  if ((input.loadFailures ?? 0) > 0 && input.hashFallbackActive) {
    return component('degraded', true, 'hash_fallback_active');
  }
  if (state === 'healthy') {
    return component('ready', true);
  }
  return component('unknown', true, 'runtime_unrecognized');
}

export function assessGraphComponent(input: GraphHealthInput): HealthComponentReport {
  if (input.status === null) {
    if (input.loadAttempted) {
      return component('unavailable', true, 'graph_store_unavailable');
    }
    return component('unknown', true, 'not_probed');
  }
  switch (input.status) {
    case 'ready':
      return component('ready', true);
    case 'empty':
      return component('degraded', true, 'graph_empty');
    case 'degraded':
      return component('degraded', true, input.degradedReason ?? 'graph_degraded');
    case 'stale':
      return component('stale', true, 'graph_stale');
    case 'rebuild_required':
      return component('degraded', true, 'rebuild_required');
    case 'unavailable':
      return component('unavailable', true, input.degradedReason ?? 'graph_unavailable');
    default:
      return component('unknown', true, 'unrecognized_graph_status');
  }
}

export function assessCancellationQueueComponent(
  input: CancellationQueueHealthInput
): HealthComponentReport {
  const interactiveSaturated =
    input.interactiveMax > 0 && input.interactiveDepth >= input.interactiveMax;
  const backgroundSaturated =
    input.backgroundMax > 0 && input.backgroundDepth >= input.backgroundMax;
  if (interactiveSaturated || backgroundSaturated) {
    return component('degraded', true, 'queue_saturated');
  }
  if (input.interactiveDepth < 0 || input.backgroundDepth < 0) {
    return component('error', true, 'invalid_queue_depth');
  }
  return component('ready', true, `interactive=${input.interactiveDepth},background=${input.backgroundDepth}`);
}

export function assessSessionComponent(input?: SessionHealthInput): HealthComponentReport {
  if (
    input === undefined ||
    input.activeCount === undefined ||
    input.maxSessions === undefined
  ) {
    return component('unknown', false, 'not_applicable_outside_http');
  }
  if (input.maxSessions <= 0) {
    return component('error', true, 'invalid_max_sessions');
  }
  if (input.activeCount > input.maxSessions) {
    return component('error', true, 'session_cap_exceeded');
  }
  if (input.activeCount >= input.maxSessions) {
    return component('degraded', true, 'session_cap_reached');
  }
  if ((input.admissionRejectedTotal ?? 0) > 0 && input.activeCount >= input.maxSessions * 0.9) {
    return component('degraded', true, 'admission_pressure');
  }
  return component('ready', true, `active=${input.activeCount},max=${input.maxSessions}`);
}

/**
 * Compose overall status from component reports.
 *
 * Precedence (critical components only):
 *   error → unhealthy
 *   unknown | unavailable → unknown
 *   stale → stale
 *   degraded → degraded
 *   all ready → healthy
 *
 * Non-critical components never flip overall to healthy blockers by themselves,
 * but also never override a worse critical verdict.
 */
export function composeOverallStatus(components: HealthComponents): CompositeOverallStatus {
  const critical = HEALTH_COMPONENT_IDS.map((id) => components[id]).filter((c) => c.critical);

  if (critical.some((c) => c.state === 'error')) {
    return 'unhealthy';
  }
  if (critical.some((c) => c.state === 'unknown' || c.state === 'unavailable')) {
    return 'unknown';
  }
  if (critical.some((c) => c.state === 'stale')) {
    return 'stale';
  }
  if (critical.some((c) => c.state === 'degraded')) {
    return 'degraded';
  }
  if (critical.length > 0 && critical.every((c) => c.state === 'ready')) {
    return 'healthy';
  }
  return 'unknown';
}

export function buildCompositeHealth(inputs: CompositeHealthInputs): CompositeHealth {
  const components: HealthComponents = {
    corpus: assessCorpusComponent(inputs.corpus),
    lexical: assessLexicalComponent(inputs.lexical),
    vector: assessVectorComponent(inputs.vector),
    graph: assessGraphComponent(inputs.graph),
    cancellation_queue: assessCancellationQueueComponent(inputs.cancellationQueue),
    session: assessSessionComponent(inputs.session),
  };
  return {
    schema_version: 1,
    overall: composeOverallStatus(components),
    components,
  };
}

/**
 * Rollback helper: preserve legacy fields and mark every new component
 * unknown when subsystem probes cannot run.
 */
export function unknownCompositeHealth(detail = 'probe_unavailable'): CompositeHealth {
  const components = Object.fromEntries(
    HEALTH_COMPONENT_IDS.map((id) => [
      id,
      component('unknown', id !== 'session', detail),
    ])
  ) as HealthComponents;
  return {
    schema_version: 1,
    overall: composeOverallStatus(components),
    components,
  };
}
