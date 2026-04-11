import { envBool, envPerfProfile, type ParsedPerfProfile } from './env.js';

export interface FeatureFlags {
  /** Global rollout kill switch for retrieval pipeline optimizations. */
  rollout_kill_switch: boolean;
  /** Enable draft-first memory suggestion detection and review flows. */
  memory_suggestions_v1: boolean;
  /** Allow explicit in-session draft memory retrieval surfaces. */
  memory_draft_retrieval_v1: boolean;
  /** Allow any automatic durable memory save behavior. */
  memory_autosave_v1: boolean;
  /** Persist per-file index state store (JSON sidecar). */
  index_state_store: boolean;
  /** Skip indexing unchanged files (requires index_state_store). */
  skip_unchanged_indexing: boolean;
  /** Normalize EOL when hashing for incremental indexing. */
  hash_normalize_eol: boolean;
  /** Enable in-process metrics collection (Prometheus-format rendering). */
  metrics: boolean;
  /** Expose /metrics on the HTTP server when --http is enabled. */
  http_metrics: boolean;
  /** Enable retrieval query rewrite v2 behavior when selected by tools/options. */
  retrieval_rewrite_v2: boolean;
  /** Enable retrieval ranking signal v2 behavior when selected by tools/options. */
  retrieval_ranking_v2: boolean;
  /** Enable retrieval ranking signal v3 behavior when selected by tools/options. */
  retrieval_ranking_v3: boolean;
  /** Enable request-level retrieval memoization v2 cache keying path. */
  retrieval_request_memo_v2: boolean;
  /** Enable hybrid retrieval planner upgrades (semantic + keyword + symbol aware). */
  retrieval_hybrid_v1: boolean;
  /** Enable context pack v2 formatting and metadata. */
  context_packs_v2: boolean;
  /** Enable retrieval quality guard metadata and fallback policy state reporting. */
  retrieval_quality_guard_v1: boolean;
  /** Enable retrieval provider V2 migration seam hooks. */
  retrieval_provider_v2: boolean;
  /** Enable retrieval artifact V2 metadata generation and validation hooks. */
  retrieval_artifacts_v2: boolean;
  /** Enable retrieval shadow-control V2 policy hooks for canary migration. */
  retrieval_shadow_control_v2: boolean;
  /** Enable Tree-sitter-backed parser extraction for supported code files. */
  retrieval_tree_sitter_v1: boolean;
  /** Enable chunk-aware exact search gating for the next retrieval phase. */
  retrieval_chunk_search_v1: boolean;
  /** Enable SQLite FTS5 lexical search backend for keyword fallback. */
  retrieval_sqlite_fts5_v1: boolean;
  /** Enable LanceDB-backed vector search backend for the MVP vector path. */
  retrieval_lancedb_v1: boolean;
  /** Enable local transformer embeddings for vector-backed retrieval paths. */
  retrieval_transformer_embeddings_v1: boolean;
  /** Enable a local cross-encoder rerank path ahead of the legacy bi-encoder rerank runtime. */
  retrieval_cross_encoder_rerank_v1: boolean;
}

export type PerfProfile = ParsedPerfProfile;
type FeatureFlagName = keyof FeatureFlags;

const FEATURE_FLAG_ENV_VARS = {
  rollout_kill_switch: 'CE_ROLLOUT_KILL_SWITCH',
  memory_suggestions_v1: 'CE_MEMORY_SUGGESTIONS_V1',
  memory_draft_retrieval_v1: 'CE_MEMORY_DRAFT_RETRIEVAL_V1',
  memory_autosave_v1: 'CE_MEMORY_AUTOSAVE_V1',
  index_state_store: 'CE_INDEX_STATE_STORE',
  skip_unchanged_indexing: 'CE_SKIP_UNCHANGED_INDEXING',
  hash_normalize_eol: 'CE_HASH_NORMALIZE_EOL',
  metrics: 'CE_METRICS',
  http_metrics: 'CE_HTTP_METRICS',
  retrieval_rewrite_v2: 'CE_RETRIEVAL_REWRITE_V2',
  retrieval_ranking_v2: 'CE_RETRIEVAL_RANKING_V2',
  retrieval_ranking_v3: 'CE_RETRIEVAL_RANKING_V3',
  retrieval_request_memo_v2: 'CE_RETRIEVAL_REQUEST_MEMO_V2',
  retrieval_hybrid_v1: 'CE_RETRIEVAL_HYBRID_V1',
  context_packs_v2: 'CE_CONTEXT_PACKS_V2',
  retrieval_quality_guard_v1: 'CE_RETRIEVAL_QUALITY_GUARD_V1',
  retrieval_provider_v2: 'CE_RETRIEVAL_PROVIDER_V2',
  retrieval_artifacts_v2: 'CE_RETRIEVAL_ARTIFACTS_V2',
  retrieval_shadow_control_v2: 'CE_RETRIEVAL_SHADOW_CONTROL_V2',
  retrieval_tree_sitter_v1: 'CE_RETRIEVAL_TREE_SITTER_V1',
  retrieval_chunk_search_v1: 'CE_RETRIEVAL_CHUNK_SEARCH_V1',
  retrieval_sqlite_fts5_v1: 'CE_RETRIEVAL_SQLITE_FTS5_V1',
  retrieval_lancedb_v1: 'CE_RETRIEVAL_LANCEDB_V1',
  retrieval_transformer_embeddings_v1: 'CE_RETRIEVAL_TRANSFORMER_EMBEDDINGS_V1',
  retrieval_cross_encoder_rerank_v1: 'CE_RETRIEVAL_CROSS_ENCODER_RERANK_V1',
} as const satisfies Record<FeatureFlagName, string>;

const FEATURE_FLAG_NAMES = Object.keys(FEATURE_FLAG_ENV_VARS) as FeatureFlagName[];

const PERF_PROFILE_DEFAULTS: Record<PerfProfile, Partial<FeatureFlags>> = {
  default: {},
  fast: {
    index_state_store: true,
    skip_unchanged_indexing: true,
    hash_normalize_eol: true,
    retrieval_request_memo_v2: true,
  },
  quality: {
    index_state_store: true,
    skip_unchanged_indexing: true,
    hash_normalize_eol: true,
    retrieval_rewrite_v2: true,
    retrieval_ranking_v3: true,
    retrieval_request_memo_v2: true,
    retrieval_hybrid_v1: true,
    context_packs_v2: true,
    retrieval_quality_guard_v1: true,
    retrieval_chunk_search_v1: true,
    retrieval_sqlite_fts5_v1: true,
    retrieval_lancedb_v1: true,
    retrieval_transformer_embeddings_v1: true,
  },
};

const FEATURE_FLAG_DEPENDENCIES = [
  { flag: 'skip_unchanged_indexing', requires: 'index_state_store' },
  { flag: 'http_metrics', requires: 'metrics' },
  { flag: 'retrieval_transformer_embeddings_v1', requires: 'retrieval_lancedb_v1' },
  { flag: 'retrieval_shadow_control_v2', requires: 'retrieval_provider_v2' },
] as const satisfies ReadonlyArray<{ flag: FeatureFlagName; requires: FeatureFlagName }>;

function isFeatureFlagName(value: string): value is FeatureFlagName {
  return (FEATURE_FLAG_NAMES as readonly string[]).includes(value);
}

function getFeatureKillSwitchesFromEnv(): Set<FeatureFlagName> {
  const raw = process.env.CE_FEATURE_KILL_SWITCHES;
  if (raw === undefined || raw.trim() === '') {
    return new Set();
  }

  const killSwitches = new Set<FeatureFlagName>();
  const invalidNames: string[] = [];

  for (const candidate of raw.split(',').map((value) => value.trim()).filter(Boolean)) {
    if (isFeatureFlagName(candidate)) {
      killSwitches.add(candidate);
      continue;
    }

    invalidNames.push(candidate);
  }

  if (invalidNames.length > 0) {
    throw new Error(
      `Invalid CE_FEATURE_KILL_SWITCHES value. Unknown feature flag(s): ${invalidNames.join(', ')}`
    );
  }

  return killSwitches;
}

function getProfileDefault(profile: PerfProfile, name: FeatureFlagName): boolean {
  return PERF_PROFILE_DEFAULTS[profile][name] ?? false;
}

function resolveFeatureFlags(
  profile: PerfProfile,
  killSwitches: ReadonlySet<FeatureFlagName>
): FeatureFlags {
  const flags = {} as FeatureFlags;

  for (const name of FEATURE_FLAG_NAMES) {
    flags[name] = envBool(FEATURE_FLAG_ENV_VARS[name], getProfileDefault(profile, name));
  }

  for (const name of killSwitches) {
    flags[name] = false;
  }

  return flags;
}

export function getFeatureFlagsFromEnv(): FeatureFlags {
  const perfProfile = envPerfProfile();
  const killSwitches = getFeatureKillSwitchesFromEnv();
  return resolveFeatureFlags(perfProfile, killSwitches);
}

const FEATURE_KILL_SWITCHES = getFeatureKillSwitchesFromEnv();
export const FEATURE_FLAGS: FeatureFlags = resolveFeatureFlags(
  envPerfProfile(),
  FEATURE_KILL_SWITCHES
);

export function featureEnabled(name: FeatureFlagName): boolean {
  return !FEATURE_KILL_SWITCHES.has(name) && FEATURE_FLAGS[name];
}

export function validateFlagCombinations(flags: FeatureFlags): void {
  const errors = FEATURE_FLAG_DEPENDENCIES
    .filter(({ flag, requires }) => flags[flag] && !flags[requires])
    .map(({ flag, requires }) => `${flag} requires ${requires}`);

  if (errors.length > 0) {
    throw new Error(`Invalid feature flag configuration: ${errors.join('; ')}`);
  }
}
