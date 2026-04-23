/**
 * Layer 2: Context Service Layer
 *
 * This layer adapts raw retrieval from the legacy runtime (Layer 1)
 * into agent-friendly context bundles optimized for prompt enhancement.
 *
 * Responsibilities:
 * - Decide how much context to return
 * - Format snippets for optimal LLM consumption
 * - Deduplicate results by file path
 * - Enforce token/file limits
 * - Apply relevance scoring and ranking
 * - Generate context summaries and hints
 * - Manage token budgets for LLM context windows
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import type { WorkerMessage } from '../worker/messages.js';
import { featureEnabled } from '../config/features.js';
import { envInt, envMs } from '../config/env.js';
import { incCounter, observeDurationMs, setGauge } from '../metrics/metrics.js';
import { formatRequestLogPrefix } from '../telemetry/requestContext.js';
import { evaluateStartupAutoIndex } from './tooling/indexFreshness.js';
import {
  filterEntriesByPathScope,
  matchesNormalizedPathScope,
  normalizePathScopeInput,
  scopeApplied,
  serializeNormalizedPathScope,
  type PathScopeInput,
  type NormalizedPathScope,
} from './tooling/pathScope.js';
import {
  EXTERNAL_GROUNDING_PROVIDER_VERSION,
  fetchExternalGrounding,
  serializeExternalSourcesForCache,
  type ExternalReferenceSnippet,
  type GroundingWarning,
  type NormalizedExternalSource,
} from './tooling/externalGrounding.js';
import {
  buildIndexStateWorkspaceFingerprint,
  hashIndexStateContent,
  JsonIndexStateStore,
  type IndexStateFile,
  type IndexStateLoadMetadata,
} from './indexStateStore.js';
import { isMemorySuggestionPath, MEMORY_SUGGESTIONS_DIR, MemorySuggestionStore } from './memorySuggestionStore.js';
import { resolveAIProviderId } from '../ai/providers/factory.js';
import type { AIProvider, AIProviderId } from '../ai/providers/types.js';
import { createRetrievalProvider } from '../retrieval/providers/factory.js';
import { resolveRetrievalProviderId, shouldRunShadowCompare } from '../retrieval/providers/env.js';
import {
  parseFormattedResults as parseFormattedSemanticResults,
} from '../retrieval/providers/semanticRuntime.js';
import { describeEmbeddingRuntimeStatus, type EmbeddingRuntimeStatus } from '../internal/retrieval/embeddingRuntime.js';
import { scoreLexicalCandidates } from '../internal/retrieval/lexical.js';
import {
  snapshotRetrievalV2FeatureFlags,
  type RetrievalArtifactV2Metadata,
  type RetrievalFallbackDomain,
} from '../internal/retrieval/v2Contracts.js';
import {
  buildConnectorFingerprint,
  createConnectorRegistry,
  formatConnectorHint,
} from '../internal/connectors/registry.js';
import {
  createHeuristicChunkParser,
  type ChunkRecord,
} from '../internal/retrieval/chunking.js';
import { createTreeSitterChunkParser } from '../internal/retrieval/treeSitterChunkParser.js';
import {
  type GraphDegradedReason,
  type GraphPayloadFile,
  type GraphStatus,
  type GraphStoreSnapshot,
} from '../internal/graph/persistentGraphStore.js';
import { isOperationalDocsQuery } from '../retrieval/providers/queryHeuristics.js';
import {
  ServiceClientGraphAccess,
  type ServiceClientGraphNavigationSnapshot,
} from './serviceClientGraphAccess.js';
import {
  clearLocalNativeIndexLifecycle,
  finalizeLocalNativeIndexLifecycle,
} from './serviceClientLifecycle.js';
import {
  ServiceClientRuntimeAccess,
} from './serviceClientRuntimeAccess.js';
import { ServiceClientRetrievalAccess } from './serviceClientRetrievalAccess.js';
import { getConfiguredShadowCompareState } from './serviceClientRetrievalRuntime.js';
import type {
  RetrievalProvider,
  RetrievalProviderId,
} from '../retrieval/providers/types.js';

// ============================================================================
// Type Definitions
// ============================================================================

export interface SearchResult {
  path: string;
  content: string;
  score?: number;
  lines?: string;
  /** Relevance score normalized to 0-1 range */
  relevanceScore?: number;
  matchType?: 'semantic' | 'keyword' | 'hybrid';
  retrievedAt?: string;
  chunkId?: string;
}

export interface IndexStatus {
  workspace: string;
  status: 'idle' | 'indexing' | 'error';
  lastIndexed: string | null;
  fileCount: number;
  isStale: boolean;
  lastError?: string;
  embeddingRuntime?: EmbeddingRuntimeStatus;
}

export interface IndexResult {
  indexed: number;
  skipped: number;
  errors: string[];
  duration: number;
  /**
   * Total number of indexable (non-ignored, supported) files discovered for the run.
   * Useful when indexing is optimized to skip unchanged files.
   */
  totalIndexable?: number;
  /** Number of files skipped because they were unchanged (when enabled). */
  unchangedSkipped?: number;
  /** Deterministic counts for why files were skipped during indexing. */
  skipReasons?: Partial<Record<IndexSkipReason, number>>;
  /** Deterministic denominator for skip reason ratio calculations. */
  skipReasonTotal?: number;
  /** Deterministic counts for file handling outcomes, including metadata-only fallbacks. */
  fileOutcomes?: Partial<Record<IndexFileOutcome, number>>;
  /** Deterministic denominator for file outcome ratio calculations. */
  fileOutcomeTotal?: number;
}

export interface StartupAutoIndexResult {
  started: boolean;
  reason: 'healthy' | 'indexing' | 'unindexed' | 'stale' | 'error' | 'disabled';
  summary: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSymbolUsagePattern(symbol: string): RegExp {
  return new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(symbol)}([^A-Za-z0-9_$]|$)`);
}

function isDeclarationLikeSymbolLine(line: string, symbol: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  const escapedSymbol = escapeRegExp(symbol);
  if (/^import\b/.test(trimmed)) {
    return true;
  }

  if (new RegExp(`^export\\s+(type\\s+)?\\{[^}]*\\b${escapedSymbol}\\b[^}]*\\}(\\s+from\\b.*)?;?$`).test(trimmed)) {
    return true;
  }

  const declarationPatterns = [
    new RegExp(`\\b(function|class|interface|type|enum|const|let|var)\\s+${escapedSymbol}\\b`),
    new RegExp(`\\b(def|func)\\s+${escapedSymbol}\\b`),
    new RegExp(`^(async\\s+)?\\*?${escapedSymbol}\\s*\\(`),
    new RegExp(`^(get|set)\\s+${escapedSymbol}\\s*\\(`),
    new RegExp(`\\b(public|private|protected|internal|static|async|abstract|virtual|override|readonly|final|sealed)\\b.*\\b${escapedSymbol}\\s*\\(`),
    new RegExp(`\\b${escapedSymbol}\\s*[:=]\\s*(async\\s+)?function\\b`),
  ];

  return declarationPatterns.some((pattern) => pattern.test(trimmed));
}

function buildSymbolReferenceSnippet(
  content: string,
  referenceLineIndex: number,
  windowRadius: number = 2
): { snippet: string; startLine: number; endLine: number } {
  const lines = content.split(/\r?\n/);
  const startIndex = Math.max(0, referenceLineIndex - windowRadius);
  const endIndex = Math.min(lines.length - 1, referenceLineIndex + windowRadius);
  return {
    snippet: lines.slice(startIndex, endIndex + 1).join('\n').trim(),
    startLine: startIndex + 1,
    endLine: endIndex + 1,
  };
}

function resolveLookupIntent(query: string): LookupIntentResolution {
  const trimmed = query.trim();
  if (!trimmed) {
    return { intent: 'discovery' };
  }

  for (const candidate of LOOKUP_INTENT_PATTERNS) {
    const match = trimmed.match(candidate.pattern);
    if (match?.[1]) {
      return {
        intent: candidate.intent,
        symbol: match[1],
      };
    }
  }

  return { intent: 'discovery' };
}

const CALL_RELATIONSHIPS_KEYWORD_BLOCKLIST = new Set<string>([
  'if', 'else', 'for', 'while', 'switch', 'case', 'return', 'typeof', 'instanceof',
  'await', 'new', 'function', 'class', 'super', 'this', 'throw', 'try', 'catch',
  'finally', 'do', 'in', 'of', 'void', 'delete', 'yield', 'async', 'default',
  'with', 'var', 'let', 'const', 'true', 'false', 'null', 'undefined', 'break',
  'continue', 'import', 'export', 'from', 'as', 'extends', 'implements', 'interface',
  'type', 'enum', 'public', 'private', 'protected', 'static', 'abstract', 'readonly',
  'override', 'get', 'set', 'constructor',
  'def', 'func', 'lambda', 'pass', 'raise', 'except', 'elif', 'fn', 'print',
]);

function buildCallSitePattern(symbol: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(symbol)}\\s*\\(`);
}

function findEnclosingDeclaration(lines: string[], lineIndex: number): string | undefined {
  for (let i = lineIndex; i >= 0; i -= 1) {
    const trimmed = (lines[i] ?? '').trim();
    if (!trimmed) continue;

    let m: RegExpMatchArray | null;
    m = trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (m) return m[1];
    m = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (m) return m[1];
    m = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[:=]\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][A-Za-z0-9_$]*\s*=>)/);
    if (m) return m[1];
    m = trimmed.match(/^(?:public|private|protected|static|async|abstract|override|readonly)(?:\s+(?:public|private|protected|static|async|abstract|override|readonly))*\s+(?:[A-Za-z_$][A-Za-z0-9_$]*\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
    if (m && !CALL_RELATIONSHIPS_KEYWORD_BLOCKLIST.has(m[1])) return m[1];
    m = trimmed.match(/^(?:get|set)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
    if (m) return m[1];
    m = trimmed.match(/^def\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (m) return m[1];
    m = trimmed.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (m) return m[1];
    m = trimmed.match(/^(?:async\s+)?\*?([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*\{?\s*$/);
    if (m && !CALL_RELATIONSHIPS_KEYWORD_BLOCKLIST.has(m[1])) return m[1];
  }
  return undefined;
}

function extractCalleeIdentifiers(
  bodyText: string,
  excludeSymbol: string
): Array<{ identifier: string; lineOffset: number; count: number }> {
  const lines = bodyText.split(/\r?\n/);
  const stats = new Map<string, { lineOffset: number; count: number }>();
  const identifierRegex = /([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    let match: RegExpExecArray | null;
    identifierRegex.lastIndex = 0;
    while ((match = identifierRegex.exec(line)) !== null) {
      const identifier = match[1];
      if (CALL_RELATIONSHIPS_KEYWORD_BLOCKLIST.has(identifier)) continue;
      if (identifier === excludeSymbol) continue;
      const before = line.slice(0, match.index);
      if (/[A-Za-z0-9_$]$/.test(before)) continue;
      const existing = stats.get(identifier);
      if (existing) {
        existing.count += 1;
      } else {
        stats.set(identifier, { lineOffset: i, count: 1 });
      }
    }
  }

  return [...stats.entries()].map(([identifier, info]) => ({
    identifier,
    lineOffset: info.lineOffset,
    count: info.count,
  }));
}

function extractFunctionBody(
  lines: string[],
  definitionLineIndex: number
): { bodyText: string; bodyStartLineIndex: number } | undefined {
  let depth = 0;
  let started = false;
  let bodyStartLineIndex = definitionLineIndex;
  const bodyLines: string[] = [];

  for (let i = definitionLineIndex; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    let lineToAppend = '';
    for (let c = 0; c < line.length; c += 1) {
      const ch = line[c];
      if (!started) {
        if (ch === '{') {
          started = true;
          depth = 1;
          bodyStartLineIndex = i;
          continue;
        }
      } else {
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            bodyLines.push(lineToAppend);
            return { bodyText: bodyLines.join('\n'), bodyStartLineIndex };
          }
        }
        lineToAppend += ch;
      }
    }
    if (started) bodyLines.push(lineToAppend);
  }

  if (!started) return undefined;
  return { bodyText: bodyLines.join('\n'), bodyStartLineIndex };
}

export type CallRelationshipDirection = 'callers' | 'callees' | 'both';

export interface CallRelationshipsCallerEntry {
  file: string;
  line: number;
  snippet: string;
  score: number;
  callerSymbol?: string;
}

export interface CallRelationshipsCalleeEntry {
  file: string;
  line: number;
  snippet: string;
  score: number;
  calleeSymbol: string;
}

export interface CallRelationshipsResult {
  symbol: string;
  callers: CallRelationshipsCallerEntry[];
  callees: CallRelationshipsCalleeEntry[];
  metadata: {
    symbol: string;
    direction: CallRelationshipDirection;
    totalCallers: number;
    totalCallees: number;
    resolutionBackend?: SymbolNavigationBackend;
    fallbackReason?: SymbolNavigationFallbackReason;
    graphStatus?: GraphStatus | 'unavailable';
    graphDegradedReason?: GraphDegradedReason | null;
  };
}

export type SymbolDefinitionKind =
  | 'class'
  | 'function'
  | 'interface'
  | 'type'
  | 'enum'
  | 'const'
  | 'method'
  | 'unknown';

export type SymbolDefinitionResult =
  | { found: false; symbol: string; metadata?: SymbolNavigationDiagnostics }
  | {
      found: true;
      symbol: string;
      file: string;
      line: number;
      column?: number;
      kind: SymbolDefinitionKind;
      snippet: string;
      score: number;
      metadata?: SymbolNavigationDiagnostics;
    };

function classifySymbolDefinitionKind(line: string, symbol: string): SymbolDefinitionKind {
  const trimmed = line.trim();
  const escapedSymbol = escapeRegExp(symbol);

  if (new RegExp(`\\bclass\\s+${escapedSymbol}\\b`).test(trimmed)) return 'class';
  if (new RegExp(`\\binterface\\s+${escapedSymbol}\\b`).test(trimmed)) return 'interface';
  if (new RegExp(`\\benum\\s+${escapedSymbol}\\b`).test(trimmed)) return 'enum';
  if (new RegExp(`\\btype\\s+${escapedSymbol}\\b`).test(trimmed)) return 'type';
  if (new RegExp(`\\bfunction\\s+${escapedSymbol}\\b`).test(trimmed)) return 'function';
  if (new RegExp(`\\b(def|func)\\s+${escapedSymbol}\\b`).test(trimmed)) return 'function';
  if (new RegExp(`\\b${escapedSymbol}\\s*[:=]\\s*(async\\s+)?function\\b`).test(trimmed)) return 'function';
  if (new RegExp(`\\b(const|let|var)\\s+${escapedSymbol}\\b`).test(trimmed)) return 'const';
  if (new RegExp(`^(get|set)\\s+${escapedSymbol}\\s*\\(`).test(trimmed)) return 'method';
  if (new RegExp(`\\b(public|private|protected|internal|static|async|abstract|virtual|override|readonly|final|sealed)\\b.*\\b${escapedSymbol}\\s*\\(`).test(trimmed)) {
    return 'method';
  }
  if (new RegExp(`^(async\\s+)?\\*?${escapedSymbol}\\s*\\(`).test(trimmed)) return 'method';
  return 'unknown';
}

export interface WatcherStatus {
  enabled: boolean;
  watching: number;
  pendingChanges: number;
  lastFlush?: string;
}

export interface SnippetInfo {
  text: string;
  lines: string;
  /** Relevance score for this snippet (0-1) */
  relevance: number;
  /** Estimated token count */
  tokenCount: number;
  /** Type of code (function, class, import, etc.) */
  codeType?: string;
}

export interface FileContext {
  path: string;
  /** File extension for syntax highlighting hints */
  extension: string;
  /** High-level summary of what this file contains */
  summary: string;
  /** Relevance score for this file (0-1) */
  relevance: number;
  /** Estimated total token count for this file's context */
  tokenCount: number;
  snippets: SnippetInfo[];
  /** Related files that might be needed for full context */
  relatedFiles?: string[];
  /** Short reason this file was selected into the context pack. */
  selectionRationale?: string;
}

/** A memory entry retrieved from .memories/ directory */
export type MemoryPriority = 'critical' | 'helpful' | 'archive';

export interface MemoryEntry {
  /** Category of the memory (preferences, decisions, facts) */
  category: string;
  /** Content of the memory */
  content: string;
  /** Relevance score (0-1) */
  relevanceScore: number;
  /** Optional title parsed from memory heading */
  title?: string;
  /** Optional subtype tag (for example: review_finding, incident) */
  subtype?: string;
  /** Optional priority used by ranking */
  priority?: MemoryPriority;
  /** Optional metadata tags */
  tags?: string[];
  /** Optional source reference */
  source?: string;
  /** Optional linked file paths */
  linkedFiles?: string[];
  /** Optional linked plan identifiers */
  linkedPlans?: string[];
  /** Optional evidence reference */
  evidence?: string;
  /** Optional owner for lifecycle maintenance */
  owner?: string;
  /** Optional created timestamp (ISO) */
  createdAt?: string;
  /** Optional updated timestamp (ISO) */
  updatedAt?: string;
  /** True when selected as part of the startup memory pack */
  startupPack?: boolean;
  /** Final ranking score used for sorting */
  rankScore?: number;
}

export interface ContextBundle {
  /** High-level summary of the context */
  summary: string;
  /** Query that generated this context */
  query: string;
  /** Files with relevant context, ordered by relevance */
  files: FileContext[];
  /** Key insights and hints for the LLM */
  hints: string[];
  /** Dependency map between selected files and related file suggestions. */
  dependencyMap?: Record<string, string[]>;
  /** Relevant memories from .memories/ directory */
  memories?: MemoryEntry[];
  /** Optional external references supplied by the caller. */
  externalReferences?: ExternalReferenceSnippet[];
  /** Metadata about the context bundle */
  metadata: {
    totalFiles: number;
    totalSnippets: number;
    totalTokens: number;
    tokenBudget: number;
    truncated: boolean;
    truncationReasons?: ContextTruncationReason[];
    searchTimeMs: number;
    memoriesIncluded?: number;
    memoryCandidates?: number;
    memoriesStartupPackIncluded?: number;
    draftMemoriesIncluded?: number;
    draftMemoryCandidates?: number;
    externalSourcesRequested?: number;
    externalSourcesUsed?: number;
    externalWarnings?: GroundingWarning[];
    routingDiagnostics?: ContextRoutingDiagnostics;
  };
}

export type IndexSkipReason =
  | 'file_too_large'
  | 'binary_file'
  | 'read_error'
  | 'ignored_or_unsupported'
  | 'invalid_path'
  | 'unchanged';

export type IndexFileOutcome =
  | 'full_content'
  | 'metadata_only'
  | 'size_skip'
  | 'binary_skip'
  | 'read_error'
  | 'ignored_or_unsupported'
  | 'invalid_path'
  | 'unchanged';

export interface ContextRoutingDiagnostics {
  selectedIntent: LookupIntent;
  selectedRoute: 'semantic_discovery' | 'lookup_definition' | 'lookup_references' | 'lookup_body' | 'semantic_fallback';
  symbol: string | null;
  symbolHit: boolean;
  declarationHit: boolean;
  parserSource: string | null;
  parserProvenance: string[];
  downgradeReason: 'definition_snippet' | null;
  fallbackReason: 'lookup_symbol_not_found' | 'lookup_body_unavailable' | 'lookup_route_error' | null;
  oversizedFileOutcome: IndexFileOutcome | null;
  shadowCompare?: ContextRoutingShadowCompareReceipt;
}

export interface ContextRoutingShadowCompareReceipt {
  enabled: boolean;
  executed: boolean;
  sampleRate: number;
  primaryRoute: ContextRoutingDiagnostics['selectedRoute'];
  shadowRoute: 'semantic_discovery';
  primaryResultCount: number;
  shadowResultCount: number;
  overlapCount: number;
  top1Overlap: boolean;
  misrouteDetected: boolean;
}

type FileReadResult =
  | { content: string; outcome: 'full_content' | 'metadata_only'; skipReason?: undefined }
  | { content: null; outcome: 'size_skip' | 'binary_skip' | 'read_error'; skipReason: 'file_too_large' | 'binary_file' | 'read_error' };

export type ContextTruncationReason = 'token_budget' | 'external_grounding';
type LookupIntent = 'discovery' | 'definition' | 'references' | 'body';
type LookupIntentResolution = { intent: LookupIntent; symbol?: string };
type LookupRouteAttempt = {
  results: SearchResult[];
  selectedRoute: ContextRoutingDiagnostics['selectedRoute'];
  symbolHit: boolean;
  declarationHit: boolean;
  parserSource: string | null;
  parserProvenance: string[];
  downgradeReason: ContextRoutingDiagnostics['downgradeReason'];
  fallbackReason: ContextRoutingDiagnostics['fallbackReason'];
  oversizedFileOutcome: ContextRoutingDiagnostics['oversizedFileOutcome'];
};
type HydratedDefinitionSearchResult = {
  result: SearchResult | null;
  declarationHit: boolean;
  parserSource: string | null;
  parserProvenance: string[];
  downgradeReason: ContextRoutingDiagnostics['downgradeReason'];
};

export type PathScopeOptions = PathScopeInput;

export interface ContextOptions extends PathScopeInput {
  /** Maximum number of files to include (default: 5) */
  maxFiles?: number;
  /** Maximum tokens for the entire context (default: 8000) */
  tokenBudget?: number;
  /** Include related/dependency files (default: true) */
  includeRelated?: boolean;
  /** Minimum relevance score to include (0-1, default: 0.3) */
  minRelevance?: number;
  /** Include file summaries (default: true) */
  includeSummaries?: boolean;
  /** Include memories from .memories/ directory (default: true) */
  includeMemories?: boolean;
  /** Include session-scoped draft memory suggestions when explicitly enabled. */
  includeDraftMemories?: boolean;
  /** Session ID required when includeDraftMemories is enabled. */
  draftSessionId?: string;
  /** Bypass caches (default: false). */
  bypassCache?: boolean;
  /** Prefer a local keyword-first search path before semantic fallback. */
  preferLocalSearch?: boolean;
  /** Queue lane for semantic retrieval work (default: interactive). */
  priority?: 'interactive' | 'background';
  /** Optional workspace-relative include glob filters. */
  includePaths?: string[];
  /** Optional workspace-relative exclude glob filters. */
  excludePaths?: string[];
  /** Optional normalized external references supplied by caller. */
  externalSources?: NormalizedExternalSource[];
}

const LOOKUP_INTENT_PATTERNS: ReadonlyArray<{ intent: LookupIntent; pattern: RegExp }> = [
  {
    intent: 'body',
    pattern: /\b(?:show|get|find|inspect)?\s*(?:body|implementation|refactor(?:\s+target)?)\b(?:\s+(?:of|for))?\s+`?([A-Za-z_$][A-Za-z0-9_$]*)`?/i,
  },
  {
    intent: 'definition',
    pattern: /\b(?:definition|declaration)\b(?:\s+(?:of|for))?\s+`?([A-Za-z_$][A-Za-z0-9_$]*)`?/i,
  },
  {
    intent: 'references',
    pattern: /\breferences?\b(?:\s+(?:of|for))?\s+`?([A-Za-z_$][A-Za-z0-9_$]*)`?/i,
  },
];
const MAX_HYDRATED_DECLARATION_LINES = 80;
const MAX_HYDRATED_DECLARATION_CHARS = 4_000;

export interface SearchDiagnostics {
  filters_applied: string[];
  filtered_paths_count: number;
  second_pass_used: boolean;
}

export type SymbolNavigationBackend = 'graph' | 'heuristic_fallback';

export type SymbolNavigationFallbackReason =
  | GraphDegradedReason
  | 'graph_symbol_not_found'
  | 'graph_definition_not_found'
  | 'graph_reference_not_found'
  | 'graph_call_edge_not_found'
  | 'graph_scope_filtered'
  | null;

export interface SymbolNavigationDiagnostics {
  tool:
    | 'symbol_search'
    | 'symbol_references'
    | 'symbol_definition'
    | 'call_relationships';
  backend: SymbolNavigationBackend;
  graph_status: GraphStatus | 'unavailable';
  graph_degraded_reason: GraphDegradedReason | null;
  fallback_reason: SymbolNavigationFallbackReason;
}

interface MemoryRetrievalResult {
  selected: MemoryEntry[];
  candidateCount: number;
  startupPackCount: number;
}

type ChunkSearchEngine = {
  search: (query: string, topK: number, options?: ChunkSearchOptions) => Promise<SearchResult[]>;
  clearCache?: () => void;
};

type ChunkSearchOptions = {
  bypassCache?: boolean;
  workspacePath?: string;
  indexStatePath?: string;
  chunkIndexPath?: string;
  includeArtifacts?: boolean;
  includeDocs?: boolean;
  includeJson?: boolean;
  queryTokens?: string[];
  symbolTokens?: string[];
  codeIntent?: boolean;
  opsEvidenceIntent?: boolean;
  normalizedQuery?: string;
};

type LexicalSearchEngine = {
  refresh?: () => Promise<void> | void;
  applyWorkspaceChanges?: (changes: WorkspaceFileChange[]) => Promise<void> | void;
  search: (query: string, topK: number, options?: LexicalSearchOptions) => Promise<SearchResult[]>;
  clearCache?: () => void;
};

type LexicalSearchOptions = {
  bypassCache?: boolean;
  workspacePath?: string;
  indexStatePath?: string;
  sqliteIndexPath?: string;
  includeArtifacts?: boolean;
  includeDocs?: boolean;
  includeJson?: boolean;
  queryTokens?: string[];
  symbolTokens?: string[];
  codeIntent?: boolean;
  opsEvidenceIntent?: boolean;
  normalizedQuery?: string;
};

export interface RetrievalRuntimeMetadata {
  providerId: RetrievalProviderId;
  shadowCompare: {
    enabled: boolean;
    sampleRate: number;
  };
  v2: {
    retrievalRewriteV2: boolean;
    retrievalRankingV2: boolean;
    retrievalRankingV3: boolean;
    retrievalRequestMemoV2: boolean;
  };
}

export interface RetrievalArtifactMetadataOptions {
  fallbackDomain?: RetrievalFallbackDomain;
  fallbackReason?: string | null;
}

export type RetrievalArtifactObservability = RetrievalArtifactV2Metadata & {
  shadow_compare: {
    enabled: boolean;
    sampleRate: number;
  };
};

export interface WorkspaceFileChange {
  type: 'add' | 'change' | 'unlink';
  path: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Maximum file size to read (1MB per best practices - larger files typically are generated/data) */
const MAX_FILE_SIZE = 1 * 1024 * 1024;

/** Special files to index by exact name (no extension-based matching) */
const INDEXABLE_FILES_BY_NAME = new Set([
  'Makefile',
  'makefile',
  'GNUmakefile',
  'Dockerfile',
  'dockerfile',
  'Containerfile',
  'Jenkinsfile',
  'Vagrantfile',
  'Procfile',
  'Rakefile',
  'Gemfile',
  'Brewfile',
  '.gitignore',
  '.gitattributes',
  '.dockerignore',
  '.npmrc',
  '.nvmrc',
  '.npmignore',
  '.prettierrc',
  '.eslintrc',
  '.babelrc',
  '.browserslistrc',
  '.editorconfig',
  'tsconfig.json',
  'jsconfig.json',
  'package.json',
  'composer.json',
  'pubspec.yaml',
  'analysis_options.yaml',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'requirements.txt',
  'Pipfile',
  'Cargo.toml',
  'go.mod',
  'go.sum',
  'build.gradle',
  'settings.gradle',
  'pom.xml',
  'CMakeLists.txt',
  'meson.build',
  'WORKSPACE',
  'BUILD',
  'BUILD.bazel',
]);

/** Default token budget for context */
const DEFAULT_TOKEN_BUDGET = 8000;

/** Approximate characters per token (conservative estimate) */
const CHARS_PER_TOKEN = 4;

/** Cache TTL in milliseconds (1 minute) */
const CACHE_TTL_MS = envMs('CE_SEARCH_CACHE_TTL_MS', 60_000, { min: 0 });

/** Default timeout for AI API calls in milliseconds (2 minutes) */
const DEFAULT_API_TIMEOUT_MS = 120000;
const DEFAULT_SEARCH_QUEUE_MAX = 50;
const SEARCH_QUEUE_TIMEOUT_ADMISSION_SLOT_MS = 2500;
const SEARCH_QUEUE_TIMEOUT_EXECUTION_FLOOR_MS = 2000;
const FALLBACK_DISCOVER_FILES_CACHE_TTL_MS = envMs('CE_FALLBACK_DISCOVER_FILES_CACHE_TTL_MS', 30_000, {
  min: 0,
  max: 5 * 60_000,
});
const FALLBACK_SEARCH_READ_CONCURRENCY = envInt('CE_FALLBACK_SEARCH_READ_CONCURRENCY', 8, {
  min: 1,
  max: 16,
});
type SearchAndAskPriority = 'interactive' | 'background';

function formatScopedLog(message: string): string {
  return `${formatRequestLogPrefix()} ${message}`;
}
type SearchQueueRejectMode = 'observe' | 'shadow' | 'enforce';

function resolveSearchQueueRejectMode(raw: string | undefined): SearchQueueRejectMode {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === 'observe' || normalized === 'shadow' || normalized === 'enforce') {
    return normalized;
  }
  // Staged rollout policy: observe/shadow can surface saturation before we
  // flip the queue to hard enforcement, but enforce remains the default.
  return 'enforce';
}

/** State file name for persisting index state */
const STATE_FILE_NAME = '.context-engine-context-state.json';
const LEGACY_STATE_FILE_NAME = '.augment-context-state.json';

/** Separate fingerprint file (stable across restarts; only changes when we save a new index). */
const INDEX_FINGERPRINT_FILE_NAME = '.context-engine-index-fingerprint.json';
const LEGACY_INDEX_FINGERPRINT_FILE_NAME = '.augment-index-fingerprint.json';

/** File name for persisting semantic search cache (safe to delete). */
const SEARCH_CACHE_FILE_NAME = '.context-engine-search-cache.json';
const LEGACY_SEARCH_CACHE_FILE_NAME = '.augment-search-cache.json';

/** File name for persisting context bundle cache (safe to delete). */
const CONTEXT_CACHE_FILE_NAME = '.context-engine-context-cache.json';
const LEGACY_CONTEXT_CACHE_FILE_NAME = '.augment-context-cache.json';

/** Persistent cache TTL (7 days). */
const PERSISTENT_CACHE_TTL_MS = envMs('CE_PERSISTENT_CACHE_TTL_MS', 7 * 24 * 60 * 60 * 1000, { min: 0 });

const PERSISTENT_SEARCH_CACHE_MAX_ENTRIES = envInt('CE_PERSIST_SEARCH_CACHE_MAX_ENTRIES', 500, { min: 0, max: 10000 });
const PERSISTENT_CONTEXT_CACHE_MAX_ENTRIES = envInt('CE_PERSIST_CONTEXT_CACHE_MAX_ENTRIES', 100, { min: 0, max: 5000 });

/** Context ignore file names (in order of preference) */
const CONTEXT_IGNORE_FILES = ['.contextignore', '.augment-ignore'];

/** Memory directory for persistent cross-session memories */
const MEMORIES_DIR = '.memories';

const nodeRequire = createRequire(import.meta.url);

// ============================================================================
// Request Queue for Serializing SDK Calls
// ============================================================================

/**
 * Queue for serializing searchAndAsk calls to prevent provider runtime concurrency issues.
 *
 * The active semantic retrieval runtime may not be thread-safe for concurrent
 * searchAndAsk calls. This queue ensures only one call runs at a time
 * while allowing other operations to continue.
 *
 * Includes timeout protection to prevent indefinite hangs on API calls.
 */
class SearchQueueFullError extends Error {
  readonly code = 'SEARCH_QUEUE_FULL';
  readonly retryAfterMs: number;

  constructor(
    maxQueueSize: number,
    lane: SearchAndAskPriority,
    envVarName: 'CE_SEARCH_AND_ASK_QUEUE_MAX' | 'CE_SEARCH_AND_ASK_QUEUE_MAX_BACKGROUND',
    retryAfterMs: number
  ) {
    super(
      `Search queue is full for ${lane} lane (max ${maxQueueSize}). Try again later or increase ${envVarName}. retry_after_ms=${retryAfterMs}`
    );
    this.name = 'SearchQueueFullError';
    this.retryAfterMs = retryAfterMs;
  }
}

class SearchQueue {
  private queue: Array<{
    execute: () => Promise<string>;
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    timeoutMs: number;
    settled: boolean;
    timer: NodeJS.Timeout;
    removeAbortListener?: () => void;
  }> = [];
  private running = false;
  private maxQueueSize: number;
  private lane: SearchAndAskPriority;
  private maxQueueEnvVarName: 'CE_SEARCH_AND_ASK_QUEUE_MAX' | 'CE_SEARCH_AND_ASK_QUEUE_MAX_BACKGROUND';
  private rejectMode: SearchQueueRejectMode;

  constructor(
    maxQueueSize: number,
    lane: SearchAndAskPriority,
    maxQueueEnvVarName: 'CE_SEARCH_AND_ASK_QUEUE_MAX' | 'CE_SEARCH_AND_ASK_QUEUE_MAX_BACKGROUND',
    rejectMode: SearchQueueRejectMode
  ) {
    this.maxQueueSize = maxQueueSize;
    this.lane = lane;
    this.maxQueueEnvVarName = maxQueueEnvVarName;
    this.rejectMode = rejectMode;
  }

  /**
   * Create a promise that resolves with a timeout
   */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`${operation} timed out after ${timeoutMs}ms. Consider breaking down the query into smaller parts.`));
      }, timeoutMs);

      promise
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  /**
   * Enqueue a searchAndAsk call for serialized execution with timeout protection
   * @param fn The function to execute
   * @param timeoutMs Timeout in milliseconds (default: 120000 = 2 minutes)
   */
  async enqueue(
    fn: () => Promise<string>,
    timeoutMs: number = DEFAULT_API_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<string> {
    if (signal?.aborted) {
      return Promise.reject(new Error('searchAndAsk request cancelled before queue admission.'));
    }
    if (this.maxQueueSize > 0 && this.queue.length >= this.maxQueueSize) {
      const retryAfterMs =
        Math.max(1, this.queue.length) * SEARCH_QUEUE_TIMEOUT_ADMISSION_SLOT_MS + SEARCH_QUEUE_TIMEOUT_EXECUTION_FLOOR_MS;
      if (this.rejectMode === 'enforce') {
        return Promise.reject(
          new SearchQueueFullError(this.maxQueueSize, this.lane, this.maxQueueEnvVarName, retryAfterMs)
        );
      }
      console.error(
        `[SearchQueue] ${this.rejectMode} mode: queue saturation observed for ${this.lane} lane; ` +
        `max=${this.maxQueueSize} current=${this.queue.length} retry_after_ms=${retryAfterMs}`
      );
    }
    return new Promise<string>((resolve, reject) => {
      const item: {
        execute: () => Promise<string>;
        resolve: (value: string) => void;
        reject: (error: Error) => void;
        timeoutMs: number;
        settled: boolean;
        timer: NodeJS.Timeout;
        removeAbortListener?: () => void;
      } = {
        execute: fn,
        resolve,
        reject,
        timeoutMs,
        settled: false,
        timer: setTimeout(() => {
          if (item.settled) return;
          item.settled = true;
          item.reject(
            new Error(
              `AI API request timed out after ${timeoutMs}ms (including queue wait time).`
            )
          );
        }, timeoutMs),
      };
      const settleWithError = (error: Error): void => {
        if (item.settled) return;
        item.settled = true;
        clearTimeout(item.timer);
        item.removeAbortListener?.();
        item.reject(error);
      };
      const onAbort = () => {
        settleWithError(new Error('searchAndAsk request cancelled while waiting in queue.'));
      };
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
        item.removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      }
      this.queue.push(item);
      this.processQueue();
    });
  }

  /**
   * Process the queue, executing one call at a time with timeout protection
   */
  private async processQueue(): Promise<void> {
    if (this.running || this.queue.length === 0) {
      return;
    }

    this.running = true;
    const item = this.queue.shift()!;
    if (item.settled) {
      this.running = false;
      if (this.queue.length > 0) {
        this.processQueue();
      }
      return;
    }

    try {
      // Wrap the execution with timeout protection
      const result = await this.withTimeout(
        item.execute(),
        item.timeoutMs,
        'AI API request'
      );
      if (!item.settled) {
        item.settled = true;
        clearTimeout(item.timer);
        item.removeAbortListener?.();
        item.resolve(result);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(formatScopedLog(`[SearchQueue] Request failed: ${errorMessage}`));
      if (!item.settled) {
        item.settled = true;
        clearTimeout(item.timer);
        item.removeAbortListener?.();
        item.reject(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      this.running = false;
      // Process next item if available
      if (this.queue.length > 0) {
        this.processQueue();
      }
    }
  }

  /**
   * Get current queue length (for monitoring/debugging)
   */
  get length(): number {
    return this.queue.length;
  }

  /**
   * Total in-flight + waiting requests.
   */
  get depth(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  /**
   * Check if a call is currently running
   */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Clear all pending items in the queue (for cleanup/shutdown)
   */
  clearPending(): number {
    const count = this.queue.length;
    for (const item of this.queue) {
      if (!item.settled) {
        item.settled = true;
        clearTimeout(item.timer);
        item.removeAbortListener?.();
        item.reject(new Error('Queue cleared'));
      }
    }
    this.queue = [];
    return count;
  }
}

/** Default directories to always exclude - organized by category */
const DEFAULT_EXCLUDED_DIRS = new Set([
  // === Package/Dependency Directories ===
  'node_modules',
  'vendor',          // Go, PHP, Ruby
  'Pods',            // iOS/CocoaPods
  '.pub-cache',      // Dart pub cache
  'packages',        // Some package managers

  // === Build Output Directories ===
  'dist',
  'build',
  'out',
  'target',          // Rust, Java/Maven
  'bin',             // Go, .NET
  'obj',             // .NET
  'release',
  'debug',
  '.output',

  // === Version Control ===
  '.git',
  '.svn',
  '.hg',
  '.fossil',

  // === Python Virtual Environments & Caches ===
  '__pycache__',
  'venv',
  '.venv',
  'env',
  '.env',            // Also a directory in some cases
  '.tox',
  '.nox',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'htmlcov',
  '.eggs',
  '*.egg-info',

  // === Flutter/Dart Specific ===
  '.dart_tool',      // Dart tooling cache (critical to exclude)
  '.flutter-plugins',
  '.flutter-plugins-dependencies',
  'ephemeral',       // Flutter platform ephemeral directories
  '.symlinks',       // iOS Flutter symlinks

  // === Gradle/Android ===
  '.gradle',

  // === IDE & Editor Directories ===
  '.idea',
  '.vscode',
  '.vs',
  '.fleet',
  '.zed',
  '.cursor',
  'resources',       // IDE resources (e.g., Antigravity)
  'extensions',      // IDE extensions

  // === Test Coverage & Reports ===
  'coverage',
  '.nyc_output',
  'test-results',
  'reports',

  // === Modern Build Tools ===
  '.next',           // Next.js
  '.nuxt',           // Nuxt.js
  '.svelte-kit',     // SvelteKit
  '.astro',          // Astro
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.angular',
  '.webpack',
  '.esbuild',
  '.rollup.cache',
  MEMORY_SUGGESTIONS_DIR,

  // === Temporary & Generated ===
  'tmp',
  'temp',
  '.tmp',
  '.temp',
  'logs',
]);

/** Default file patterns to always exclude - organized by category */
const DEFAULT_EXCLUDED_PATTERNS = [
  // === Minified/Bundled Files ===
  '*.min.js',
  '*.min.css',
  '*.bundle.js',
  '*.chunk.js',

  // === Source Maps ===
  '*.map',
  '*.js.map',
  '*.css.map',

  // === Lock Files (auto-generated, verbose, low AI value) ===
  '*.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'composer.lock',
  'pubspec.lock',      // Flutter/Dart
  'bun.lockb',         // Bun (binary)
  'shrinkwrap.yaml',

  // === Generated Code - Dart/Flutter ===
  '*.g.dart',          // json_serializable, build_runner
  '*.freezed.dart',    // freezed package
  '*.mocks.dart',      // mockito
  '*.gr.dart',         // auto_route
  '*.pb.dart',         // protobuf
  '*.pbjson.dart',     // protobuf JSON
  '*.pbserver.dart',   // protobuf server

  // === Generated Code - Other Languages ===
  '*.generated.ts',
  '*.generated.js',
  '*.pb.go',           // Go protobuf
  '*.pb.cc',           // C++ protobuf
  '*.pb.h',
  '*_pb2.py',          // Python protobuf
  '*_pb2_grpc.py',

  // === Logs & Temporary Files ===
  '*.log',
  '*.tmp',
  '*.temp',
  '*.bak',
  '*.swp',
  '*.swo',
  '*~',                // Backup files

  // === Context Engine Cache/State ===
  '.context-engine-search-cache.json',
  '.augment-search-cache.json',

  // === Compiled Python ===
  '*.pyc',
  '*.pyo',
  '*.pyd',

  // === Compiled Java/JVM ===
  '*.class',
  '*.jar',
  '*.war',
  '*.ear',

  // === Compiled Binaries & Libraries ===
  '*.dll',
  '*.exe',
  '*.so',
  '*.dylib',
  '*.a',
  '*.lib',
  '*.o',
  '*.obj',
  '*.wasm',
  '*.dill',            // Dart kernel

  // === Binary Images ===
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.gif',
  '*.bmp',
  '*.webp',
  '*.ico',
  '*.icns',
  '*.tiff',
  '*.tif',
  '*.svg',             // Often large, sometimes useful
  '*.psd',
  '*.ai',
  '*.sketch',

  // === Fonts ===
  '*.ttf',
  '*.otf',
  '*.woff',
  '*.woff2',
  '*.eot',

  // === Media Files ===
  '*.mp3',
  '*.mp4',
  '*.wav',
  '*.ogg',
  '*.webm',
  '*.mov',
  '*.avi',
  '*.flv',
  '*.m4a',
  '*.m4v',

  // === Documents & Archives ===
  '*.pdf',
  '*.doc',
  '*.docx',
  '*.xls',
  '*.xlsx',
  '*.ppt',
  '*.pptx',
  '*.zip',
  '*.tar',
  '*.gz',
  '*.rar',
  '*.7z',

  // === Secrets & Credentials (security) ===
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.staging',
  '*.key',
  '*.pem',
  '*.p12',
  '*.jks',
  '*.keystore',
  'secrets.yaml',
  'secrets.json',

  // === IDE-specific Files ===
  '*.iml',
  '.project',
  '.classpath',

  // === OS Files ===
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',

  // === Flutter-specific Generated ===
  '.flutter-plugins',
  '.flutter-plugins-dependencies',
  '*.stamp',
];

/** File extensions to index - organized by category for maintainability */
const INDEXABLE_EXTENSIONS = new Set([
  // === TypeScript/JavaScript ===
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',

  // === Python ===
  '.py', '.pyw', '.pyi',  // Added .pyi for type stubs

  // === JVM Languages ===
  '.java', '.kt', '.kts', '.scala', '.groovy',

  // === Go ===
  '.go',

  // === Rust ===
  '.rs',

  // === C/C++ ===
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx',

  // === .NET ===
  '.cs', '.fs', '.fsx',  // Added F#

  // === Ruby ===
  '.rb', '.rake', '.gemspec',

  // === PHP ===
  '.php',

  // === Mobile Development ===
  '.swift',
  '.m', '.mm',  // Objective-C
  '.dart',      // Flutter/Dart (Essential per best practices)
  '.arb',       // Flutter internationalization files

  // === Frontend Frameworks ===
  '.vue', '.svelte', '.astro',

  // === Web Templates & Styles ===
  '.html', '.htm',
  '.css', '.scss', '.sass', '.less', '.styl',

  // === Configuration Files ===
  '.json', '.yaml', '.yml', '.toml',
  '.xml',       // Android manifests, Maven configs, etc.
  '.plist',     // iOS configuration files
  '.gradle',    // Android build files
  '.properties', // Java properties files
  '.ini', '.cfg', '.conf',
  '.editorconfig',
  '.env.example', '.env.template', '.env.sample',  // Environment templates (NOT actual .env)

  // === Documentation ===
  '.md', '.mdx', '.txt', '.rst',

  // === Database ===
  '.sql', '.prisma',

  // === API/Schema Definitions ===
  '.graphql', '.gql',
  '.proto',     // Protocol Buffers
  '.thrift',    // Apache Thrift IDL
  '.avsc',      // Avro schema
  '.avdl',      // Avro IDL
  '.capnp',     // Cap'n Proto schema
  '.openapi', '.swagger',

  // === Shell Scripts ===
  '.sh', '.bash', '.zsh', '.fish',
  '.ps1', '.psm1', '.bat', '.cmd',

  // === Infrastructure & DevOps ===
  '.dockerfile',
  '.tf', '.hcl',  // Terraform
  '.nix',         // Nix configuration
  '.bicep',       // Azure Bicep templates
  '.rego',        // Open Policy Agent
  '.cue',         // CUE configuration language
  '.jsonnet', '.libsonnet', // Jsonnet
  '.http', '.rest', // API request collections

  // ============================================================================
  // NEW EXTENSIONS (44 additions - 2025-12-22)
  // ============================================================================

  // === Functional Programming Languages ===
  '.ex', '.exs',            // Elixir (Phoenix framework, distributed systems)
  '.erl', '.hrl',           // Erlang (OTP, telecom, distributed systems)
  '.hs', '.lhs',            // Haskell (functional programming, Pandoc)
  '.clj', '.cljs', '.cljc', // Clojure (JVM functional, ClojureScript)
  '.ml', '.mli',            // OCaml (functional, type systems, compilers)

  // === Scientific & Data Languages ===
  '.r', '.R',               // R language (statistics, data science, academia)
  '.jl',                    // Julia (scientific computing, ML, high-performance)

  // === Scripting Languages ===
  '.lua',                   // Lua (game dev, Neovim, embedded scripting)
  '.pl', '.pm', '.pod',     // Perl (system admin, text processing, legacy)
  '.tcl',                   // Tcl scripting

  // === Modern Systems Languages ===
  '.zig',                   // Zig (modern C replacement, growing adoption)
  '.nim',                   // Nim (efficient, expressive, Python-like syntax)
  '.cr',                    // Crystal (Ruby-like syntax, compiled performance)
  '.v',                     // V language (simple, fast compilation)

  // === Build Systems ===
  '.cmake',                 // CMake (cross-platform C/C++ builds)
  '.mk', '.mak',            // Make (alternative Makefile extensions)
  '.bazel', '.bzl',         // Bazel (Google's build tool, monorepos)
  '.ninja',                 // Ninja (fast build system)
  '.sbt',                   // Scala Build Tool
  '.podspec',               // CocoaPods (iOS dependency management)
  '.sln',                   // Visual Studio solution

  // === Documentation Formats ===
  '.adoc', '.asciidoc',     // AsciiDoc (technical docs, books)
  '.tex', '.latex',         // LaTeX (academic papers, technical docs)
  '.org',                   // Org-mode (Emacs docs, literate programming)
  '.wiki',                  // Wiki markup

  // === Web Templates ===
  '.hbs', '.handlebars',    // Handlebars (template engine)
  '.ejs',                   // Embedded JavaScript templates
  '.pug', '.jade',          // Pug templates (Node.js, formerly Jade)
  '.jsp',                   // JavaServer Pages
  '.erb',                   // Embedded Ruby (Rails views)
  '.twig',                  // Twig (PHP/Symfony templates)

  // === Additional Enterprise/Scientific Languages ===
  '.kql',                   // Kusto query language
  '.sol',                   // Solidity
  '.sv', '.vh', '.vhd', '.vhdl', // Hardware description languages
  '.cob', '.cbl', '.cpy',   // COBOL
  '.f', '.f90', '.f95', '.f03', '.f08', // Fortran
  '.pas', '.pp',            // Pascal

  // === Build Files (by name, not extension - handled separately) ===
  // Makefile, Dockerfile, Jenkinsfile - handled in shouldIndexFile
]);

// ============================================================================
// Cache Entry Type
// ============================================================================

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

interface PersistentCacheFile {
  version: number;
  entries: Record<string, CacheEntry<SearchResult[]>>;
}

interface PersistentContextCacheFile {
  version: number;
  entries: Record<string, CacheEntry<ContextBundle>>;
}

interface IndexFingerprintFile {
  version: number;
  fingerprint: string;
  updatedAt: string;
}

interface ChunkIndexInvalidationNotice {
  reason: 'chunking_config' | 'workspace_fingerprint' | 'parser' | 'invalid_payload';
  chunkIndexPath: string;
}

interface KeywordFallbackSearchInFlightRequest {
  generation: number;
  shouldCache: boolean;
  promise: Promise<SearchResult[]>;
}

interface SemanticSearchInFlightRequest {
  generation: number;
  shouldCache: boolean;
  promise: Promise<SearchResult[]>;
}

// ============================================================================
// Context Service Client
// ============================================================================

export class ContextServiceClient {
  private workspacePath: string;
  private indexChain: Promise<void> = Promise.resolve();
  private indexStateStore: JsonIndexStateStore | null = null;
  private indexStateProviderMismatchWarned = false;
  private indexStateSchemaWarningWarned = false;
  private indexStateCompatibilityWarned = false;
  private chunkIndexCompatibilityWarned = false;

  /** LRU cache for search results */
  private searchCache: Map<string, CacheEntry<SearchResult[]>> = new Map();

  /** Maximum cache size */
  private readonly maxCacheSize = 100;

  /** Persistent semantic search cache (best-effort). */
  private persistentSearchCache: Map<string, CacheEntry<SearchResult[]>> = new Map();
  private persistentCacheLoaded = false;
  private persistentCacheWriteTimer: NodeJS.Timeout | null = null;
  private semanticSearchCacheGeneration = 0;
  private semanticSearchInFlight: Map<string, SemanticSearchInFlightRequest> = new Map();
  private chunkSearchEngine: ChunkSearchEngine | null = null;
  private chunkSearchEngineLoadAttempted = false;
  private lexicalSqliteSearchEngine: LexicalSearchEngine | null = null;
  private lexicalSqliteSearchEngineLoadAttempted = false;
  private readonly graphAccess: ServiceClientGraphAccess;

  /** Persistent context bundle cache (best-effort). */
  private persistentContextCache: Map<string, CacheEntry<ContextBundle>> = new Map();
  private persistentContextCacheLoaded = false;
  private persistentContextCacheWriteTimer: NodeJS.Timeout | null = null;

  /** Index status metadata */
  private indexStatus: IndexStatus;
  private startupAutoIndexScheduled = false;

  /** Whether lightweight disk hydration has already been attempted for this process. */
  private indexStatusDiskHydrated = false;

  /** Loaded ignore patterns (from .gitignore and .contextignore) */
  private ignorePatterns: string[] = [];

  /** Flag to track if ignore patterns have been loaded */
  private ignorePatternsLoaded: boolean = false;

  /**
   * Queue lanes for serializing searchAndAsk calls to prevent SDK concurrency issues.
   * Interactive lane remains default behavior. Background lane isolates long-running
   * non-interactive work so it cannot starve user-facing requests.
   */
  private readonly searchQueueInteractiveMax = envInt('CE_SEARCH_AND_ASK_QUEUE_MAX', DEFAULT_SEARCH_QUEUE_MAX);
  private readonly searchQueueBackgroundMax = envInt(
    'CE_SEARCH_AND_ASK_QUEUE_MAX_BACKGROUND',
    this.searchQueueInteractiveMax
  );
  private readonly searchQueueRejectMode = resolveSearchQueueRejectMode(process.env.CE_SEARCH_AND_ASK_QUEUE_REJECT_MODE);
  private readonly searchQueues: Record<SearchAndAskPriority, SearchQueue> = {
    interactive: new SearchQueue(
      this.searchQueueInteractiveMax,
      'interactive',
      'CE_SEARCH_AND_ASK_QUEUE_MAX',
      this.searchQueueRejectMode
    ),
    background: new SearchQueue(
      this.searchQueueBackgroundMax,
      'background',
      'CE_SEARCH_AND_ASK_QUEUE_MAX_BACKGROUND',
      this.searchQueueRejectMode
    ),
  };

  // ============================================================================
  // Reactive Commit Cache (Phase 1)
  // ============================================================================

  /** Enable commit-based cache keying for reactive reviews */
  private commitCacheEnabled: boolean = false;

  /** Current commit hash for cache key generation */
  private currentCommitHash: string | null = null;

  /** Cache hit counter for telemetry */
  private cacheHits: number = 0;

  /** Cache miss counter for telemetry */
  private cacheMisses: number = 0;
  private readonly aiProviderId: AIProviderId;
  private readonly retrievalProviderId: RetrievalProviderId;
  private readonly retrievalProvider: RetrievalProvider;
  private readonly runtimeAccess: ServiceClientRuntimeAccess;
  private readonly retrievalAccess: ServiceClientRetrievalAccess;
  private readonly connectorRegistry = createConnectorRegistry();
  private aiProvider: AIProvider | null = null;
  private lastSearchDiagnostics: SearchDiagnostics | null = null;
  private lastSymbolNavigationDiagnostics: SymbolNavigationDiagnostics | null = null;
  private fallbackDiscoverFilesCache: {
    cacheKey: string;
    cachedAt: number;
    files: string[];
  } | null = null;
  private fallbackDiscoverFilesInFlight: Promise<string[]> | null = null;
  private keywordFallbackSearchCacheGeneration = 0;
  private keywordFallbackSearchCache: Map<string, CacheEntry<SearchResult[]>> = new Map();
  private keywordFallbackSearchInFlight: Map<string, KeywordFallbackSearchInFlightRequest> = new Map();

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.graphAccess = new ServiceClientGraphAccess({
      workspacePath,
      debugSearch: process.env.CE_DEBUG_SEARCH === 'true',
      logWarning: (message) => console.warn(message),
    });
    this.aiProviderId = resolveAIProviderId();
    this.runtimeAccess = new ServiceClientRuntimeAccess({
      workspacePath,
      getAIProviderId: () => this.aiProviderId,
      getCachedProvider: () => this.aiProvider,
      setCachedProvider: (provider) => {
        this.aiProvider = provider;
      },
    });
    const activeRetrievalProviderId = resolveRetrievalProviderId();
    this.retrievalAccess = new ServiceClientRetrievalAccess({
      retrievalProviderId: activeRetrievalProviderId,
      workspacePath,
      getIndexFingerprint: () => this.getIndexFingerprint(),
      searchAndAsk: (searchQuery, prompt, options) => this.searchAndAsk(searchQuery, prompt, options),
      keywordFallbackSearch: (query, topK, options) => this.keywordFallbackSearch(query, topK, options),
      indexWorkspaceLocalNativeFallback: () => this.indexWorkspaceLocalNativeFallback(),
      indexFilesLocalNativeFallback: (filePaths) => this.indexFilesLocalNativeFallback(filePaths),
      clearIndexWithProviderRuntime: (options) => this.clearIndexWithProviderRuntime(options),
      getIndexStatus: async () => this.getIndexStatus(),
    });
    this.retrievalProvider = createRetrievalProvider({
      providerId: activeRetrievalProviderId,
      callbacks: this.createRetrievalProviderCallbacks(),
    });
    this.retrievalProviderId = this.retrievalProvider.id;
    this.indexStatus = {
      workspace: workspacePath,
      status: 'idle',
      lastIndexed: null,
      fileCount: 0,
      isStale: true,
    };
  }

  getActiveAIProviderId(): AIProviderId {
    return this.runtimeAccess.getActiveAIProviderId();
  }

  getActiveRetrievalProviderId(): RetrievalProviderId {
    return this.retrievalProviderId;
  }

  getRetrievalRuntimeMetadata(): RetrievalRuntimeMetadata {
    return this.retrievalAccess.getRuntimeMetadata();
  }

  getRetrievalArtifactMetadata(
    options?: RetrievalArtifactMetadataOptions
  ): RetrievalArtifactObservability {
    return this.retrievalAccess.getArtifactMetadata(options);
  }

  getActiveAIModelLabel(): string {
    return this.runtimeAccess.getActiveAIModelLabel();
  }

  getLastSearchDiagnostics(): SearchDiagnostics | null {
    if (!this.lastSearchDiagnostics) {
      return null;
    }
    return {
      filters_applied: [...this.lastSearchDiagnostics.filters_applied],
      filtered_paths_count: this.lastSearchDiagnostics.filtered_paths_count,
      second_pass_used: this.lastSearchDiagnostics.second_pass_used,
    };
  }

  private setLastSearchDiagnostics(next: SearchDiagnostics | null): void {
    this.lastSearchDiagnostics = next;
  }

  getLastSymbolNavigationDiagnostics(): SymbolNavigationDiagnostics | null {
    if (!this.lastSymbolNavigationDiagnostics) {
      return null;
    }
    return { ...this.lastSymbolNavigationDiagnostics };
  }

  private setLastSymbolNavigationDiagnostics(next: SymbolNavigationDiagnostics | null): void {
    this.lastSymbolNavigationDiagnostics = next ? { ...next } : null;
  }

  private createRetrievalProviderCallbacks() {
    return this.retrievalAccess.createProviderCallbacks();
  }

  private normalizePathScopeOptions(scope?: PathScopeOptions): NormalizedPathScope | undefined {
    const normalizedScope = normalizePathScopeInput(scope);
    return scopeApplied(normalizedScope) ? normalizedScope : undefined;
  }

  private getPathScopeCacheFragment(scope?: PathScopeOptions): string {
    const normalizedScope = this.normalizePathScopeOptions(scope);
    if (!normalizedScope) {
      return 'scope=unscoped';
    }

    return `scope=${serializeNormalizedPathScope(normalizedScope)}`;
  }

  private pathMatchesScope(filePath: string, scope?: PathScopeOptions): boolean {
    return matchesNormalizedPathScope(filePath, this.normalizePathScopeOptions(scope));
  }

  public filterSearchResultsByScope(results: SearchResult[], scope?: PathScopeOptions): SearchResult[] {
    const normalizedScope = this.normalizePathScopeOptions(scope);
    if (!normalizedScope) {
      return results;
    }
    return filterEntriesByPathScope(results, normalizedScope);
  }

  private filterPathsByScope(paths: string[], scope?: PathScopeOptions): string[] {
    const normalizedScope = this.normalizePathScopeOptions(scope);
    if (!normalizedScope) {
      return paths;
    }
    return paths.filter((filePath) => matchesNormalizedPathScope(filePath, normalizedScope));
  }

  private getFallbackDiscoverFilesCacheKey(): string {
    return this.workspacePath;
  }

  private async getCachedFallbackFiles(options?: { bypassCache?: boolean }): Promise<string[]> {
    const bypassCache = options?.bypassCache === true;
    const cacheKey = this.getFallbackDiscoverFilesCacheKey();
    const now = Date.now();
    const cached = this.fallbackDiscoverFilesCache;
    if (
      !bypassCache
      && this.fallbackDiscoverFilesInFlight
    ) {
      return this.fallbackDiscoverFilesInFlight;
    }
    if (
      !bypassCache
      && cached
      && cached.cacheKey === cacheKey
      && (now - cached.cachedAt) <= FALLBACK_DISCOVER_FILES_CACHE_TTL_MS
    ) {
      return cached.files;
    }

    const fetchFiles = this.discoverFiles(this.workspacePath);
    if (!bypassCache) {
      this.fallbackDiscoverFilesInFlight = fetchFiles;
    }

    let files: string[];
    try {
      files = await fetchFiles;
    } finally {
      if (!bypassCache) {
        this.fallbackDiscoverFilesInFlight = null;
      }
    }

    if (!bypassCache) {
      this.fallbackDiscoverFilesCache = {
        cacheKey,
        cachedAt: Date.now(),
        files,
      };
    }

    return files;
  }

  private getIndexStateStore(): JsonIndexStateStore | null {
    if (!featureEnabled('index_state_store')) {
      return null;
    }
    if (!this.indexStateStore) {
      this.indexStateStore = new JsonIndexStateStore(this.workspacePath);
    }
    return this.indexStateStore;
  }

  private warnIndexStateLoadMetadata(metadata: IndexStateLoadMetadata): void {
    if (metadata.warnings.length === 0 || this.indexStateSchemaWarningWarned) {
      return;
    }
    this.indexStateSchemaWarningWarned = true;
    console.warn(formatScopedLog(`[ContextServiceClient] ${metadata.warnings[0]}`));
  }

  private getCurrentIndexStateWorkspaceFingerprint(): string {
    return buildIndexStateWorkspaceFingerprint(this.workspacePath);
  }

  private getCurrentIndexStateFeatureFlagsSnapshot(): string {
    return JSON.stringify(snapshotRetrievalV2FeatureFlags());
  }

  private loadIndexStateForActiveProvider(store: JsonIndexStateStore): IndexStateFile {
    const loaded = store.loadWithMetadata();
    this.warnIndexStateLoadMetadata(loaded.metadata);

    if (typeof loaded.metadata.unsupported_schema_version === 'number') {
      return {
        ...loaded.state,
        provider_id: this.retrievalProviderId,
        files: {},
      };
    }

    if (loaded.state.provider_id === this.retrievalProviderId) {
      const workspaceMatches = loaded.state.workspace_fingerprint === this.getCurrentIndexStateWorkspaceFingerprint();
      const featureFlagsMatch =
        typeof loaded.state.feature_flags_snapshot !== 'string'
        || loaded.state.feature_flags_snapshot === this.getCurrentIndexStateFeatureFlagsSnapshot();
      if (workspaceMatches && featureFlagsMatch) {
        return loaded.state;
      }

      if (!this.indexStateCompatibilityWarned) {
        this.indexStateCompatibilityWarned = true;
        console.warn(
          formatScopedLog(
            `[ContextServiceClient] Ignoring index state entries for incompatible workspace/feature-flags snapshot while active provider is "${this.retrievalProviderId}".`
          )
        );
      }

      return {
        ...loaded.state,
        provider_id: this.retrievalProviderId,
        files: {},
      };
    }

    if (!this.indexStateProviderMismatchWarned) {
      this.indexStateProviderMismatchWarned = true;
      console.warn(
        formatScopedLog(
          `[ContextServiceClient] Ignoring index state entries for provider "${loaded.state.provider_id}" while active provider is "${this.retrievalProviderId}".`
        )
      );
    }

    return {
      ...loaded.state,
      provider_id: this.retrievalProviderId,
      files: {},
    };
  }

  private hashContent(contents: string): string {
    return hashIndexStateContent(contents);
  }

  /**
   * Get the workspace path for this client
   */
  getWorkspacePath(): string {
    return this.workspacePath;
  }

  /**
   * Compute staleness based on last indexed timestamp (stale if >24h or missing)
   */
  private computeIsStale(lastIndexed: string | null): boolean {
    if (!lastIndexed) return true;
    const last = Date.parse(lastIndexed);
    if (Number.isNaN(last)) return true;
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    return Date.now() - last > ONE_DAY_MS;
  }

  /**
   * Resolve the next lastIndexed value while guarding against stale timestamp clobbering.
   * - `undefined`: keep current value
   * - `null`: explicitly clear current value
   * - `string`: keep the most recent valid timestamp between current and incoming
   */
  private resolveLastIndexed(nextValue: string | null | undefined): string | null {
    if (nextValue === undefined) {
      return this.indexStatus.lastIndexed;
    }
    if (nextValue === null) {
      return null;
    }

    const current = this.indexStatus.lastIndexed;
    if (!current) {
      return nextValue;
    }

    const currentMs = Date.parse(current);
    const nextMs = Date.parse(nextValue);

    if (Number.isNaN(currentMs)) {
      return nextValue;
    }
    if (Number.isNaN(nextMs)) {
      return current;
    }

    return nextMs >= currentMs ? nextValue : current;
  }

  /**
   * Update index status with staleness recompute
   */
  private updateIndexStatus(partial: Partial<IndexStatus>): void {
    const isSuccessfulIndexCycle =
      this.indexStatus.status === 'indexing' &&
      partial.status === 'idle' &&
      partial.lastIndexed !== undefined &&
      partial.lastIndexed !== null;
    const shouldClearLastError = Object.prototype.hasOwnProperty.call(partial, 'lastError')
      && partial.lastError === undefined
      && isSuccessfulIndexCycle;
    const normalizedPartial: Partial<IndexStatus> = { ...partial };
    if (
      !shouldClearLastError &&
      Object.prototype.hasOwnProperty.call(normalizedPartial, 'lastError') &&
      normalizedPartial.lastError === undefined
    ) {
      delete normalizedPartial.lastError;
    }
    const nextLastIndexed = this.resolveLastIndexed(partial.lastIndexed);
    const nextIsStale =
      normalizedPartial.isStale !== undefined
        ? normalizedPartial.isStale
        : this.computeIsStale(nextLastIndexed);

    this.indexStatus = {
      ...this.indexStatus,
      ...normalizedPartial,
      lastIndexed: nextLastIndexed,
      isStale: nextIsStale,
    };
  }

  /**
   * Load ignore patterns from .gitignore and .contextignore files
   */
  private loadIgnorePatterns(): void {
    if (this.ignorePatternsLoaded) return;

    this.ignorePatterns = [...DEFAULT_EXCLUDED_PATTERNS];
    const debugIndex = process.env.CE_DEBUG_INDEX === 'true';

    // Try to load .gitignore
    const gitignorePath = path.join(this.workspacePath, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      try {
        const content = fs.readFileSync(gitignorePath, 'utf-8');
        const patterns = this.parseIgnoreFile(content);
        this.ignorePatterns.push(...patterns);
        if (debugIndex) {
          console.error(`Loaded ${patterns.length} patterns from .gitignore`);
        }
      } catch (error) {
        console.error('Error loading .gitignore:', error);
      }
    }

    // Try to load context ignore files (.contextignore plus the legacy compatibility alias)
    for (const ignoreFileName of CONTEXT_IGNORE_FILES) {
      const contextIgnorePath = path.join(this.workspacePath, ignoreFileName);
      if (fs.existsSync(contextIgnorePath)) {
        try {
          const content = fs.readFileSync(contextIgnorePath, 'utf-8');
          const patterns = this.parseIgnoreFile(content);
          this.ignorePatterns.push(...patterns);
          if (debugIndex) {
            console.error(`Loaded ${patterns.length} patterns from ${ignoreFileName}`);
          }
        } catch (error) {
          console.error(`Error loading ${ignoreFileName}:`, error);
        }
      }
    }

    if (debugIndex) {
      console.error(`Total ignore patterns loaded: ${this.ignorePatterns.length}`);
    }
    this.ignorePatternsLoaded = true;
  }

  /**
   * Parse an ignore file content into patterns
   */
  private parseIgnoreFile(content: string): string[] {
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#')); // Remove empty lines and comments
  }

  /**
   * Get the loaded ignore patterns for use by external components (e.g., FileWatcher).
   * Loads patterns from .gitignore and .contextignore if not already loaded.
   * Returns patterns suitable for chokidar's ignored option.
   */
  getIgnorePatterns(): string[] {
    this.loadIgnorePatterns();
    return [...this.ignorePatterns];
  }

  /**
   * Get the default excluded directories as an array.
   * Useful for file watchers that need to ignore these directories.
   */
  getExcludedDirectories(): string[] {
    return Array.from(DEFAULT_EXCLUDED_DIRS);
  }

  // ==========================================================================
  // Policy / Environment Checks
  // ==========================================================================

  /**
   * Determine whether offline-only policy is enabled via env var.
   */
  private isOfflineMode(): boolean {
    return this.runtimeAccess.isOfflineMode();
  }

  /**
   * Check if a path should be ignored based on loaded patterns
   *
   * Handles gitignore-style patterns:
   * - Patterns starting with / are anchored to root
   * - Patterns ending with / only match directories
   * - Other patterns match anywhere in the path
   */
  private shouldIgnorePath(relativePath: string): boolean {
    // Normalize path separators
    const normalizedPath = relativePath.replace(/\\/g, '/');
    if (isMemorySuggestionPath(normalizedPath)) {
      return true;
    }
    const fileName = path.basename(normalizedPath);

    for (const rawPattern of this.ignorePatterns) {
      let pattern = rawPattern;

      // Skip negation patterns (gitignore !pattern)
      if (pattern.startsWith('!')) continue;

      // Handle root-anchored patterns (starting with /)
      const isRootAnchored = pattern.startsWith('/');
      if (isRootAnchored) {
        pattern = pattern.slice(1);
      }

      // Handle directory-only patterns (ending with /)
      const isDirOnly = pattern.endsWith('/');
      if (isDirOnly) {
        pattern = pattern.slice(0, -1);
      }

      // For simple patterns without wildcards or slashes, match against filename
      if (!pattern.includes('/') && !pattern.includes('*') && !pattern.includes('?')) {
        if (fileName === pattern || normalizedPath === pattern) {
          return true;
        }
        continue;
      }

      // For glob patterns, use minimatch
      try {
        // If root-anchored, match from the start
        if (isRootAnchored) {
          if (minimatch(normalizedPath, pattern, { dot: true })) {
            return true;
          }
        } else {
          // Match anywhere in path (using matchBase for simple patterns)
          if (minimatch(normalizedPath, pattern, { dot: true, matchBase: !pattern.includes('/') })) {
            return true;
          }
          // Also try matching with ** prefix for patterns without it
          if (!pattern.startsWith('**') && minimatch(normalizedPath, `**/${pattern}`, { dot: true })) {
            return true;
          }
        }
      } catch {
        // Invalid pattern, skip
      }
    }
    return false;
  }

  // ==========================================================================
  // SDK Initialization
  // ==========================================================================

  /**
   * Preferred write path for workspace state.
   */
  private getStateFilePath(): string {
    return this.getPreferredWorkspaceArtifactPath(STATE_FILE_NAME);
  }

  private getPreferredWorkspaceArtifactPath(fileName: string): string {
    return path.join(this.workspacePath, fileName);
  }

  private resolveWorkspaceArtifactPath(preferredFileName: string, legacyFileName?: string): string {
    const preferredPath = this.getPreferredWorkspaceArtifactPath(preferredFileName);
    if (fs.existsSync(preferredPath)) {
      return preferredPath;
    }

    if (legacyFileName) {
      const legacyPath = path.join(this.workspacePath, legacyFileName);
      if (fs.existsSync(legacyPath)) {
        return legacyPath;
      }
    }

    return preferredPath;
  }

  private getReadableStateFilePath(): string {
    return this.resolveWorkspaceArtifactPath(STATE_FILE_NAME, LEGACY_STATE_FILE_NAME);
  }

  /**
   * Best-effort, lightweight index status hydration from persisted files.
   * This intentionally avoids ensureInitialized()/SDK boot so callers like
   * getIndexStatus() can surface persisted metadata immediately after restart.
   */
  private hydrateIndexStatusFromDisk(): void {
    if (this.indexStatusDiskHydrated) {
      return;
    }
    this.indexStatusDiskHydrated = true;

    const nextStatus: Partial<IndexStatus> = {};

    try {
      const stateFilePath = this.getReadableStateFilePath();
      if (fs.existsSync(stateFilePath)) {
        const stats = fs.statSync(stateFilePath);
        const restoredAt = stats.mtime.toISOString();
        const shouldHydrateStatus = this.indexStatus.status !== 'indexing' && this.indexStatus.status !== 'error';
        if (shouldHydrateStatus) {
          nextStatus.status = 'idle';
          const resolvedLastIndexed = this.resolveLastIndexed(restoredAt);
          if (resolvedLastIndexed !== this.indexStatus.lastIndexed) {
            nextStatus.lastIndexed = resolvedLastIndexed;
          }
        }
      }
    } catch {
      // Best-effort only; keep existing in-memory status on any fs/stat failure.
    }

    if (!this.indexStatus.fileCount) {
      try {
        const store = new JsonIndexStateStore(this.workspacePath);
        const known = Object.keys(this.loadIndexStateForActiveProvider(store).files).length;
        if (known > 0) {
          nextStatus.fileCount = known;
        }
      } catch {
        // Best-effort only; ignore parse/read errors.
      }
    }

    if (Object.keys(nextStatus).length > 0) {
      this.updateIndexStatus(nextStatus);
    }
  }

  private enqueueIndexing<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.indexChain.then(fn, fn);
    this.indexChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async runIndexWorker(files?: string[]): Promise<IndexResult> {
    const startTime = Date.now();
    return new Promise<IndexResult>((resolve, reject) => {
      const workerSpec = this.getIndexWorkerSpec();
      if (!workerSpec) {
        reject(new Error('Index worker unavailable: missing built worker (dist/worker/IndexWorker.js) and tsx loader is not installed/resolvable.'));
        return;
      }
      const worker = new Worker(workerSpec.url, {
        execArgv: workerSpec.execArgv,
        workerData: {
          workspacePath: this.workspacePath,
          files,
        },
      });

      let done = false;
      const finalize = async (fn: () => void): Promise<void> => {
        if (done) return;
        done = true;
        try {
          await worker.terminate();
        } catch {
          // ignore
        }
        fn();
      };

      worker.on('message', (message: WorkerMessage) => {
        if (message.type === 'index_complete') {
          void finalize(() => {
            resolve({
              indexed: message.count,
              skipped: message.skipped ?? 0,
              errors: message.errors ?? [],
              duration: message.duration ?? (Date.now() - startTime),
              totalIndexable: message.totalIndexable,
              unchangedSkipped: message.unchangedSkipped,
            });
          });
        } else if (message.type === 'index_error') {
          void finalize(() => {
            reject(new Error(message.error));
          });
        }
      });

      worker.on('error', (error) => {
        void finalize(() => {
          reject(error);
        });
      });

      worker.on('exit', (code) => {
        if (done) return;
        if (code !== 0) {
          void finalize(() => {
            reject(new Error(`Index worker exited with code ${code}`));
          });
        } else {
          void finalize(() => {
            resolve({
              indexed: 0,
              skipped: 0,
              errors: [],
              duration: Date.now() - startTime,
            });
          });
        }
      });
    });
  }

  private getIndexWorkerSpec(): { url: URL; execArgv?: string[] } | null {
    const jsUrl = new URL('../worker/IndexWorker.js', import.meta.url);
    const jsPath = fileURLToPath(jsUrl);
    if (fs.existsSync(jsPath)) {
      return { url: jsUrl };
    }

    // Development / tsx execution: spawn the TS worker with tsx loader.
    // Important: resolve tsx relative to THIS package, not process.cwd(),
    // since some clients (e.g. GUI wrappers) run with a different cwd.
    const require = createRequire(import.meta.url);
    let tsxEntrypoint: string | null = null;
    try {
      tsxEntrypoint = require.resolve('tsx');
    } catch {
      tsxEntrypoint = null;
    }

    if (!tsxEntrypoint) {
      return null;
    }

    return {
      url: new URL('../worker/IndexWorker.dev.ts', import.meta.url),
      execArgv: ['--import', tsxEntrypoint],
    };
  }

  // ==========================================================================
  // File Discovery
  // ==========================================================================

  /**
   * Check if a file should be indexed based on extension or name
   */
  private shouldIndexFile(filePath: string): boolean {
    const fileName = path.basename(filePath);

    // Check if file matches by exact name first (Makefile, Dockerfile, etc.)
    if (INDEXABLE_FILES_BY_NAME.has(fileName)) {
      return true;
    }

    // Then check by extension
    const ext = path.extname(filePath).toLowerCase();
    return INDEXABLE_EXTENSIONS.has(ext);
  }

  /**
   * Recursively discover all indexable files in a directory
   */
  private async discoverFiles(dirPath: string, relativeTo: string = dirPath): Promise<string[]> {
    // Load ignore patterns on first call
    this.loadIgnorePatterns();

    const debugIndex = process.env.CE_DEBUG_INDEX === 'true';

    const files: string[] = [];

    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const relativePath = path.relative(relativeTo, fullPath);

        // Skip hidden files/directories (starting with .) except for special dotfiles
        if (entry.name.startsWith('.') && !INDEXABLE_FILES_BY_NAME.has(entry.name)) {
          continue;
        }

        // Skip default excluded directories
        if (entry.isDirectory() && DEFAULT_EXCLUDED_DIRS.has(entry.name)) {
          if (debugIndex) {
            console.error(`Skipping excluded directory: ${relativePath}`);
          }
          continue;
        }

        // Check against loaded ignore patterns
        if (this.shouldIgnorePath(relativePath)) {
          if (debugIndex) {
            console.error(`Skipping ignored path: ${relativePath}`);
          }
          continue;
        }

        if (entry.isDirectory()) {
          const subFiles = await this.discoverFiles(fullPath, relativeTo);
          files.push(...subFiles);
        } else if (entry.isFile() && this.shouldIndexFile(entry.name)) {
          files.push(relativePath);
        }
      }
    } catch (error) {
      const fsError = error as NodeJS.ErrnoException;
      if (fsError?.code === 'ENOENT') {
        if (debugIndex) {
          console.error(`[discoverFiles] Directory disappeared during scan (skipping): ${dirPath}`);
        }
      } else {
        console.error(`Error discovering files in ${dirPath}:`, error);
      }
    }

    return files;
  }

  /**
   * Check if file content appears to be binary
   */
  private isBinaryContent(content: string): boolean {
    // Check for null bytes or high concentration of non-printable characters
    const nonPrintableCount = (content.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g) || []).length;
    const ratio = nonPrintableCount / content.length;
    return ratio > 0.1 || content.includes('\x00');
  }

  private isLikelyBinaryBuffer(buffer: Buffer): boolean {
    if (buffer.length === 0) {
      return false;
    }

    let nonPrintableCount = 0;
    for (const byte of buffer) {
      if (byte === 0) {
        return true;
      }
      if ((byte < 32 || byte > 126) && byte !== 9 && byte !== 10 && byte !== 13) {
        nonPrintableCount += 1;
      }
    }

    return (nonPrintableCount / buffer.length) > 0.1;
  }

  private buildLargeFileMetadataSummary(relativePath: string, sizeBytes: number, modifiedTimeMs: number): string {
    return [
      '[context-engine large-file metadata]',
      `path: ${relativePath}`,
      `extension: ${path.extname(relativePath) || '(none)'}`,
      `size_bytes: ${sizeBytes}`,
      `modified_time_ms: ${Math.trunc(modifiedTimeMs)}`,
      'index_strategy: metadata_only',
      'reason_code: metadata_only',
      `safe_size_limit_bytes: ${MAX_FILE_SIZE}`,
      'note: content omitted because the file exceeded the safe indexing threshold',
    ].join('\n');
  }

  /**
   * Read file contents with size limit check
   */
  private readFileContents(relativePath: string): FileReadResult {
    try {
      const fullPath = path.join(this.workspacePath, relativePath);
      const stats = fs.statSync(fullPath);

      if (stats.size > MAX_FILE_SIZE) {
        const fd = fs.openSync(fullPath, 'r');
        try {
          const probeBuffer = Buffer.alloc(Math.min(8192, stats.size));
          const bytesRead = fs.readSync(fd, probeBuffer, 0, probeBuffer.length, 0);
          if (this.isLikelyBinaryBuffer(probeBuffer.subarray(0, bytesRead))) {
            console.error(`Skipping large binary file: ${relativePath}`);
            return { content: null, outcome: 'binary_skip', skipReason: 'binary_file' };
          }
        } finally {
          fs.closeSync(fd);
        }

        console.error(`Indexing large file as metadata-only: ${relativePath} (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);
        return {
          content: this.buildLargeFileMetadataSummary(relativePath, stats.size, stats.mtimeMs),
          outcome: 'metadata_only',
        };
      }

      const content = fs.readFileSync(fullPath, 'utf-8');

      // Check for binary content
      if (this.isBinaryContent(content)) {
        console.error(`Skipping binary file: ${relativePath}`);
        return { content: null, outcome: 'binary_skip', skipReason: 'binary_file' };
      }

      return { content, outcome: 'full_content' };
    } catch (error) {
      console.error(`Error reading file ${relativePath}:`, error);
      return { content: null, outcome: 'read_error', skipReason: 'read_error' };
    }
  }

  private async readFileContentsAsync(relativePath: string): Promise<FileReadResult> {
    try {
      const fullPath = path.join(this.workspacePath, relativePath);
      const stats = await fs.promises.stat(fullPath);

      if (stats.size > MAX_FILE_SIZE) {
        const handle = await fs.promises.open(fullPath, 'r');
        try {
          const probeBuffer = Buffer.alloc(Math.min(8192, stats.size));
          const { bytesRead } = await handle.read(probeBuffer, 0, probeBuffer.length, 0);
          if (this.isLikelyBinaryBuffer(probeBuffer.subarray(0, bytesRead))) {
            console.error(`Skipping large binary file: ${relativePath}`);
            return { content: null, outcome: 'binary_skip', skipReason: 'binary_file' };
          }
        } finally {
          await handle.close();
        }

        console.error(`Indexing large file as metadata-only: ${relativePath} (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);
        return {
          content: this.buildLargeFileMetadataSummary(relativePath, stats.size, stats.mtimeMs),
          outcome: 'metadata_only',
        };
      }

      const content = await fs.promises.readFile(fullPath, 'utf-8');

      if (this.isBinaryContent(content)) {
        console.error(`Skipping binary file: ${relativePath}`);
        return { content: null, outcome: 'binary_skip', skipReason: 'binary_file' };
      }

      return { content, outcome: 'full_content' };
    } catch (error) {
      console.error(`Error reading file ${relativePath}:`, error);
      return { content: null, outcome: 'read_error', skipReason: 'read_error' };
    }
  }

  // ==========================================================================
  // Cache Management
  // ==========================================================================

  /**
   * Get cached search results if valid
   */
  private getCachedSearch(cacheKey: string): SearchResult[] | null {
    const entry = this.searchCache.get(cacheKey);
    if (entry && Date.now() - entry.timestamp < CACHE_TTL_MS) {
      return entry.data;
    }
    // Remove stale entry
    if (entry) {
      this.searchCache.delete(cacheKey);
    }
    return null;
  }

  /**
   * Cache search results with LRU eviction
   */
  private setCachedSearch(cacheKey: string, results: SearchResult[]): void {
    // LRU eviction if cache is full
    if (this.searchCache.size >= this.maxCacheSize) {
      const oldestKey = this.searchCache.keys().next().value;
      if (oldestKey) {
        this.searchCache.delete(oldestKey);
      }
    }
    this.searchCache.set(cacheKey, {
      data: results,
      timestamp: Date.now(),
    });
  }

  /**
   * Clear the search cache
   */
  clearCache(): void {
    this.searchCache.clear();
    this.semanticSearchCacheGeneration += 1;
    this.semanticSearchInFlight.clear();
    this.keywordFallbackSearchCacheGeneration += 1;
    this.keywordFallbackSearchCache.clear();
    this.keywordFallbackSearchInFlight.clear();
    this.clearChunkSearchEngineCache();
    this.clearLexicalSqliteSearchEngineCache();
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.fallbackDiscoverFilesCache = null;
    this.fallbackDiscoverFilesInFlight = null;
  }

  private isChunkAwareExactSearchEnabled(): boolean {
    return featureEnabled('retrieval_chunk_search_v1');
  }

  private isLexicalSqliteSearchEnabled(): boolean {
    return featureEnabled('retrieval_sqlite_fts5_v1');
  }

  private clearChunkSearchEngineCache(): void {
    try {
      this.chunkSearchEngine?.clearCache?.();
    } catch {
      // Best-effort cache reset only.
    } finally {
      this.chunkSearchEngine = null;
      this.chunkSearchEngineLoadAttempted = false;
    }
  }

  private clearLexicalSqliteSearchEngineCache(): void {
    try {
      this.lexicalSqliteSearchEngine?.clearCache?.();
    } catch {
      // Best-effort cache reset only.
    } finally {
      this.lexicalSqliteSearchEngine = null;
      this.lexicalSqliteSearchEngineLoadAttempted = false;
    }
  }

  private clearGraphStoreCache(): void {
    this.graphAccess.clearCache();
  }

  private getGraphStore() {
    return this.graphAccess.getStore();
  }

  private async refreshGraphStore(
    options?: { indexedFiles?: Record<string, { hash: string; indexed_at?: string }> }
  ): Promise<void> {
    await this.graphAccess.refresh(options);
  }

  private getGraphNavigationSnapshot(): ServiceClientGraphNavigationSnapshot {
    return this.graphAccess.getNavigationSnapshot();
  }

  private buildSymbolNavigationDiagnostics(
    tool: SymbolNavigationDiagnostics['tool'],
    backend: SymbolNavigationBackend,
    graphState: { snapshot: GraphStoreSnapshot | null; fallbackReason: GraphDegradedReason | 'graph_missing' | null },
    fallbackReason: SymbolNavigationFallbackReason
  ): SymbolNavigationDiagnostics {
    return {
      tool,
      backend,
      graph_status: graphState.snapshot?.graph_status ?? 'unavailable',
      graph_degraded_reason: graphState.snapshot?.degraded_reason ?? null,
      fallback_reason: fallbackReason,
    };
  }

  private normalizeGraphPath(value: string): string {
    return value.replace(/\\/g, '/');
  }

  private readSnippetFromFile(
    fileCache: Map<string, string>,
    filePath: string,
    lineNumber: number
  ): Promise<{ snippet: string; startLine: number; endLine: number } | null> {
    return (async () => {
      const normalizedPath = this.normalizeGraphPath(filePath);
      let content = fileCache.get(normalizedPath);
      if (content === undefined) {
        try {
          content = await this.getFile(normalizedPath);
        } catch {
          return null;
        }
        fileCache.set(normalizedPath, content);
      }
      return buildSymbolReferenceSnippet(content, Math.max(0, lineNumber - 1));
    })();
  }

  private scoreGraphPath(pathValue: string): number {
    const normalizedPath = this.normalizeGraphPath(pathValue);
    let score = 0;
    if (normalizedPath.startsWith('src/')) score += 30;
    if (normalizedPath.startsWith('tests/') || normalizedPath.startsWith('test/')) score -= 10;
    if (/\/__tests__\//.test(normalizedPath)) score -= 5;
    if (normalizedPath.includes('node_modules/')) score -= 50;
    score -= Math.min(20, normalizedPath.length / 8);
    return score;
  }

  private findDefinitionRecordForSymbol(
    payload: GraphPayloadFile,
    symbolId: string
  ) {
    return payload.definitions.find((definition) => definition.symbol_id === symbolId) ?? null;
  }
 
  private async refreshLexicalSqliteSearchEngine(changes?: WorkspaceFileChange[]): Promise<void> {
    if (!this.isLexicalSqliteSearchEnabled()) {
      return;
    }

    const lexicalSearchEngine = this.getLexicalSqliteSearchEngine();
    if (!lexicalSearchEngine) {
      return;
    }

    try {
      if (changes && changes.length > 0 && typeof lexicalSearchEngine.applyWorkspaceChanges === 'function') {
        try {
          await lexicalSearchEngine.applyWorkspaceChanges(changes);
          return;
        } catch (error) {
          if (process.env.CE_DEBUG_SEARCH === 'true') {
            console.error('[lexicalSearch] incremental background refresh failed, retrying full refresh:', error);
          }
        }
      }

      if (typeof lexicalSearchEngine.refresh === 'function') {
        await lexicalSearchEngine.refresh();
      }
    } catch (error) {
      if (process.env.CE_DEBUG_SEARCH === 'true') {
        console.error('[lexicalSearch] background refresh failed:', error);
      }
    }
  }

  private buildChunkSearchEngineFromModule(moduleExports: Record<string, unknown>): ChunkSearchEngine | null {
    const workspacePath = this.workspacePath;
    const indexStatePath = path.join(this.workspacePath, '.context-engine-index-state.json');
    const chunkIndexPath = path.join(this.workspacePath, '.context-engine-chunk-index.json');
    const moduleOptions = {
      workspacePath,
      indexStatePath,
      chunkIndexPath,
      onInvalidatedIndex: (details: ChunkIndexInvalidationNotice) => {
        this.handleIncompatibleChunkIndex(details);
      },
    };

    const factoryCandidates = [
      moduleExports.createWorkspaceChunkSearchIndex,
      moduleExports.createChunkSearchIndex,
      moduleExports.default,
    ];

    for (const candidate of factoryCandidates) {
      if (typeof candidate !== 'function') {
        continue;
      }

      try {
        const factory = candidate as (options: {
          workspacePath: string;
          indexStatePath: string;
          chunkIndexPath: string;
        }) => ChunkSearchEngine | null | undefined;
        const engine = factory(moduleOptions);
        if (engine && typeof engine.search === 'function') {
          return engine;
        }
      } catch {
        // Try the next factory candidate.
      }
    }

    const directSearch = moduleExports.search;
    if (typeof directSearch === 'function') {
      const search = directSearch as (
        query: string,
        topK: number,
        options?: ChunkSearchOptions
      ) => Promise<SearchResult[]>;
      return {
        search: (query: string, topK: number, options?: ChunkSearchOptions) =>
          search(
            query,
            topK,
            {
              ...moduleOptions,
              ...options,
            }
          ),
        clearCache: typeof moduleExports.clearCache === 'function'
          ? () => {
              void (moduleExports.clearCache as () => void)();
            }
          : undefined,
      };
    }

    return null;
  }

  private buildLexicalSqliteSearchEngineFromModule(moduleExports: Record<string, unknown>): LexicalSearchEngine | null {
    const workspacePath = this.workspacePath;
    const indexStatePath = path.join(this.workspacePath, '.context-engine-index-state.json');
    const sqliteIndexPath = path.join(this.workspacePath, '.context-engine-lexical-index.sqlite');
    const moduleOptions = { workspacePath, indexStatePath, sqliteIndexPath };

    const factoryCandidates = [
      moduleExports.createWorkspaceLexicalSearchIndex,
      moduleExports.createLexicalSearchIndex,
      moduleExports.default,
    ];

    for (const candidate of factoryCandidates) {
      if (typeof candidate !== 'function') {
        continue;
      }

      try {
        const factory = candidate as (options: {
          workspacePath: string;
          indexStatePath: string;
          sqliteIndexPath: string;
        }) => LexicalSearchEngine | null | undefined;
        const engine = factory(moduleOptions);
        if (engine && typeof engine.search === 'function') {
          return engine;
        }
      } catch {
        // Try the next factory candidate.
      }
    }

    const directSearch = moduleExports.search;
    if (typeof directSearch === 'function') {
      const search = directSearch as (
        query: string,
        topK: number,
        options?: LexicalSearchOptions
      ) => Promise<SearchResult[]>;
      return {
        search: (query: string, topK: number, options?: LexicalSearchOptions) =>
          search(
            query,
            topK,
            {
              ...moduleOptions,
              ...options,
            }
          ),
        refresh: typeof moduleExports.refresh === 'function'
          ? () => {
              const refresh = moduleExports.refresh as () => Promise<void> | void;
              return refresh();
            }
          : undefined,
        applyWorkspaceChanges: typeof moduleExports.applyWorkspaceChanges === 'function'
          ? (changes: WorkspaceFileChange[]) => {
              const applyWorkspaceChanges = moduleExports.applyWorkspaceChanges as (
                nextChanges: WorkspaceFileChange[]
              ) => Promise<void> | void;
              return applyWorkspaceChanges(changes);
            }
          : undefined,
        clearCache: typeof moduleExports.clearCache === 'function'
          ? () => {
              void (moduleExports.clearCache as () => void)();
            }
          : undefined,
      };
    }

    return null;
  }

  private getChunkSearchEngine(): ChunkSearchEngine | null {
    if (!this.isChunkAwareExactSearchEnabled()) {
      return null;
    }

    if (this.chunkSearchEngine) {
      return this.chunkSearchEngine;
    }

    if (this.chunkSearchEngineLoadAttempted) {
      return null;
    }

    this.chunkSearchEngineLoadAttempted = true;

    try {
      const moduleExports = nodeRequire('../internal/retrieval/chunkIndex.js') as Record<string, unknown>;
      const engine = this.buildChunkSearchEngineFromModule(moduleExports);
      if (engine) {
        this.chunkSearchEngine = engine;
        return engine;
      }
    } catch (error) {
      if (process.env.CE_DEBUG_SEARCH === 'true') {
        console.error('[chunkSearch] Exact-search helper unavailable, falling back to file scan:', error);
      }
    }

    return null;
  }

  private handleIncompatibleChunkIndex(details: ChunkIndexInvalidationNotice): void {
    this.invalidatePersistentContextCacheArtifacts();

    const statePath = this.getReadableStateFilePath();
    if (fs.existsSync(statePath)) {
      this.writeIndexFingerprintFile(crypto.randomUUID());
    }

    if (this.chunkIndexCompatibilityWarned) {
      return;
    }
    this.chunkIndexCompatibilityWarned = true;
    console.warn(
      formatScopedLog(
        `[ContextServiceClient] Discarding incompatible chunk index (${details.reason}) at ${details.chunkIndexPath}; semantic fallback will continue until the chunk index is rebuilt.`
      )
    );
  }

  private invalidatePersistentContextCacheArtifacts(): void {
    this.persistentContextCache.clear();
    this.persistentContextCacheLoaded = false;

    if (this.persistentContextCacheWriteTimer) {
      clearTimeout(this.persistentContextCacheWriteTimer);
      this.persistentContextCacheWriteTimer = null;
    }

    const cachePaths = [
      this.getPreferredWorkspaceArtifactPath(CONTEXT_CACHE_FILE_NAME),
      this.getReadablePersistentContextCachePath(),
    ];
    for (const cachePath of new Set(cachePaths)) {
      if (!fs.existsSync(cachePath)) {
        continue;
      }
      try {
        fs.unlinkSync(cachePath);
      } catch {
        // Best-effort cache invalidation only.
      }
    }
  }

  private getLexicalSqliteSearchEngine(): LexicalSearchEngine | null {
    if (!this.isLexicalSqliteSearchEnabled()) {
      return null;
    }

    if (this.lexicalSqliteSearchEngine) {
      return this.lexicalSqliteSearchEngine;
    }

    if (this.lexicalSqliteSearchEngineLoadAttempted) {
      return null;
    }

    this.lexicalSqliteSearchEngineLoadAttempted = true;

    try {
      const moduleExports = nodeRequire('../internal/retrieval/sqliteLexicalIndex.js') as Record<string, unknown>;
      const engine = this.buildLexicalSqliteSearchEngineFromModule(moduleExports);
      if (engine) {
        this.lexicalSqliteSearchEngine = engine;
        return engine;
      }
    } catch (error) {
      if (process.env.CE_DEBUG_SEARCH === 'true') {
        console.error('[lexicalSearch] SQLite helper unavailable, falling back to chunk/file scan:', error);
      }
    }

    return null;
  }

  private isPersistentCacheEnabled(): boolean {
    if (process.env.JEST_WORKER_ID) return false;
    const raw = process.env.CE_PERSIST_SEARCH_CACHE;
    if (!raw) return true;
    const normalized = raw.toLowerCase();
    return !(normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off');
  }

  private getReadablePersistentCachePath(): string {
    return this.resolveWorkspaceArtifactPath(SEARCH_CACHE_FILE_NAME, LEGACY_SEARCH_CACHE_FILE_NAME);
  }

  private loadPersistentCacheIfNeeded(): void {
    if (!this.isPersistentCacheEnabled()) return;
    if (this.persistentCacheLoaded) return;
    this.persistentCacheLoaded = true;

    const cachePath = this.getReadablePersistentCachePath();
    if (!fs.existsSync(cachePath)) return;

    try {
      const raw = fs.readFileSync(cachePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PersistentCacheFile>;
      if (!parsed || typeof parsed !== 'object') return;
      if (parsed.version !== 1) return;
      if (!parsed.entries || typeof parsed.entries !== 'object') return;

      const now = Date.now();
      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (!entry || typeof entry !== 'object') continue;
        const ts = (entry as any).timestamp;
        const data = (entry as any).data;
        if (typeof ts !== 'number' || !Array.isArray(data)) continue;
        if (now - ts > PERSISTENT_CACHE_TTL_MS) continue;
        this.persistentSearchCache.set(key, { timestamp: ts, data });
      }
    } catch {
      // Ignore corrupt cache files.
    }
  }

  private schedulePersistentCacheWrite(): void {
    if (!this.isPersistentCacheEnabled()) return;
    if (this.persistentCacheWriteTimer) return;

    this.persistentCacheWriteTimer = setTimeout(() => {
      this.persistentCacheWriteTimer = null;
      void this.writePersistentCacheToDisk();
    }, 250);
  }

  private async writePersistentCacheToDisk(): Promise<void> {
    try {
      const cachePath = this.getPreferredWorkspaceArtifactPath(SEARCH_CACHE_FILE_NAME);
      const tmpPath = `${cachePath}.tmp`;

      const entries: Record<string, CacheEntry<SearchResult[]>> = {};
      for (const [key, value] of this.persistentSearchCache.entries()) {
        entries[key] = value;
      }

      const payload: PersistentCacheFile = { version: 1, entries };
      await fs.promises.writeFile(tmpPath, JSON.stringify(payload), 'utf-8');
      await fs.promises.rename(tmpPath, cachePath);
    } catch {
      // Best-effort cache; ignore failures.
    }
  }

  private writeIndexFingerprintFile(fingerprint: string): void {
    const fingerprintPath = this.getPreferredWorkspaceArtifactPath(INDEX_FINGERPRINT_FILE_NAME);
    try {
      const tmpPath = `${fingerprintPath}.tmp`;
      const payload: IndexFingerprintFile = {
        version: 1,
        fingerprint,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(tmpPath, JSON.stringify(payload), 'utf-8');
      fs.renameSync(tmpPath, fingerprintPath);
    } catch {
      // Best-effort; ignore failures.
    }
  }

  private getIndexFingerprint(): string {
    try {
      const statePath = this.getReadableStateFilePath();
      if (!fs.existsSync(statePath)) return 'no-state';

      const fingerprintPath = this.resolveWorkspaceArtifactPath(
        INDEX_FINGERPRINT_FILE_NAME,
        LEGACY_INDEX_FINGERPRINT_FILE_NAME
      );
      if (fs.existsSync(fingerprintPath)) {
        try {
          const raw = fs.readFileSync(fingerprintPath, 'utf-8');
          const parsed = JSON.parse(raw) as Partial<IndexFingerprintFile>;
          const fp = (parsed as any)?.fingerprint;
          if (parsed?.version === 1 && typeof fp === 'string' && fp.length > 0) {
            return `fingerprint:${fp}`;
          }
        } catch {
          // Ignore parse errors; we'll recreate below.
        }
      }

      // Fingerprint file missing/corrupt: create one. This stays stable across restarts
      // even if the SDK touches the state file timestamps.
      const fingerprint = crypto.randomUUID();
      this.writeIndexFingerprintFile(fingerprint);
      return `fingerprint:${fingerprint}`;
    } catch {
      return 'unknown';
    }
  }

  private getPersistentSearch(cacheKey: string): SearchResult[] | null {
    if (!this.isPersistentCacheEnabled()) return null;
    this.loadPersistentCacheIfNeeded();
    const entry = this.persistentSearchCache.get(cacheKey);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > PERSISTENT_CACHE_TTL_MS) {
      this.persistentSearchCache.delete(cacheKey);
      return null;
    }
    // Touch for LRU behavior.
    this.persistentSearchCache.delete(cacheKey);
    this.persistentSearchCache.set(cacheKey, entry);
    return entry.data;
  }

  private setPersistentSearch(cacheKey: string, results: SearchResult[]): void {
    if (!this.isPersistentCacheEnabled()) return;
    this.loadPersistentCacheIfNeeded();
    // Cap persistent cache size to avoid unbounded growth.
    if (this.persistentSearchCache.size >= PERSISTENT_SEARCH_CACHE_MAX_ENTRIES) {
      const oldestKey = this.persistentSearchCache.keys().next().value;
      if (oldestKey) {
        this.persistentSearchCache.delete(oldestKey);
      }
    }
    this.persistentSearchCache.set(cacheKey, { data: results, timestamp: Date.now() });
    this.schedulePersistentCacheWrite();
  }

  // ==========================================================================
  // Persistent Context Bundle Cache (Phase 1A)
  // ==========================================================================

  private isPersistentContextCacheEnabled(): boolean {
    if (process.env.JEST_WORKER_ID) return false;
    const raw = process.env.CE_PERSIST_CONTEXT_CACHE;
    if (!raw) return true;
    const normalized = raw.toLowerCase();
    return !(normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off');
  }

  private getReadablePersistentContextCachePath(): string {
    return this.resolveWorkspaceArtifactPath(CONTEXT_CACHE_FILE_NAME, LEGACY_CONTEXT_CACHE_FILE_NAME);
  }

  private loadPersistentContextCacheIfNeeded(): void {
    if (!this.isPersistentContextCacheEnabled()) return;
    if (this.persistentContextCacheLoaded) return;
    this.persistentContextCacheLoaded = true;

    const cachePath = this.getReadablePersistentContextCachePath();
    if (!fs.existsSync(cachePath)) return;

    try {
      const raw = fs.readFileSync(cachePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PersistentContextCacheFile>;
      if (!parsed || typeof parsed !== 'object') return;
      if (parsed.version !== 1) return;
      if (!parsed.entries || typeof parsed.entries !== 'object') return;

      const now = Date.now();
      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (!entry || typeof entry !== 'object') continue;
        const ts = (entry as any).timestamp;
        const data = (entry as any).data;
        if (typeof ts !== 'number' || !data || typeof data !== 'object') continue;
        if (now - ts > PERSISTENT_CACHE_TTL_MS) continue;
        this.persistentContextCache.set(key, { timestamp: ts, data: data as ContextBundle });
      }
    } catch {
      // Ignore corrupt cache files.
    }
  }

  private schedulePersistentContextCacheWrite(): void {
    if (!this.isPersistentContextCacheEnabled()) return;
    if (this.persistentContextCacheWriteTimer) return;

    this.persistentContextCacheWriteTimer = setTimeout(() => {
      this.persistentContextCacheWriteTimer = null;
      void this.writePersistentContextCacheToDisk();
    }, 250);
  }

  private async writePersistentContextCacheToDisk(): Promise<void> {
    try {
      const cachePath = this.getPreferredWorkspaceArtifactPath(CONTEXT_CACHE_FILE_NAME);
      const tmpPath = `${cachePath}.tmp`;

      const entries: Record<string, CacheEntry<ContextBundle>> = {};
      for (const [key, value] of this.persistentContextCache.entries()) {
        entries[key] = value;
      }

      const payload: PersistentContextCacheFile = { version: 1, entries };
      await fs.promises.writeFile(tmpPath, JSON.stringify(payload), 'utf-8');
      await fs.promises.rename(tmpPath, cachePath);
    } catch {
      // Best-effort cache; ignore failures.
    }
  }

  private getPersistentContextBundle(cacheKey: string): ContextBundle | null {
    if (!this.isPersistentContextCacheEnabled()) return null;
    this.loadPersistentContextCacheIfNeeded();
    const entry = this.persistentContextCache.get(cacheKey);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > PERSISTENT_CACHE_TTL_MS) {
      this.persistentContextCache.delete(cacheKey);
      return null;
    }
    // Touch for LRU behavior.
    this.persistentContextCache.delete(cacheKey);
    this.persistentContextCache.set(cacheKey, entry);
    return entry.data;
  }

  private setPersistentContextBundle(cacheKey: string, bundle: ContextBundle): void {
    if (!this.isPersistentContextCacheEnabled()) return;
    this.loadPersistentContextCacheIfNeeded();

    if (this.persistentContextCache.size >= PERSISTENT_CONTEXT_CACHE_MAX_ENTRIES) {
      const oldestKey = this.persistentContextCache.keys().next().value;
      if (oldestKey) {
        this.persistentContextCache.delete(oldestKey);
      }
    }
    this.persistentContextCache.set(cacheKey, { data: bundle, timestamp: Date.now() });
    this.schedulePersistentContextCacheWrite();
  }

  // ==========================================================================
  // Reactive Commit Cache Methods (Phase 1)
  // ==========================================================================

  /**
   * Enable commit-based cache keying for reactive mode.
   * When enabled, cache keys are prefixed with the commit hash for consistency.
   * 
   * @param commitHash Git commit hash to use as cache key prefix
   */
  enableCommitCache(commitHash: string): void {
    if (process.env.REACTIVE_COMMIT_CACHE !== 'true') {
      console.error('[ContextServiceClient] Commit cache feature flag not enabled (set REACTIVE_COMMIT_CACHE=true)');
      return;
    }
    this.commitCacheEnabled = true;
    this.currentCommitHash = commitHash;
    console.error(`[ContextServiceClient] Commit cache enabled for ${commitHash.substring(0, 12)}`);
  }

  /**
   * Disable commit-based cache keying and clear the current commit hash.
   */
  disableCommitCache(): void {
    if (this.commitCacheEnabled) {
      console.error('[ContextServiceClient] Commit cache disabled');
    }
    this.commitCacheEnabled = false;
    this.currentCommitHash = null;
  }

  /**
   * Generate cache key with optional commit hash prefix.
   * Used internally by semanticSearch when commit cache is enabled.
   * 
   * @param query Search query
   * @param topK Number of results
   * @returns Cache key string
   */
  private getCommitAwareCacheKey(
    query: string,
    topK: number,
    providerId?: RetrievalProviderId,
    scope?: PathScopeOptions
  ): string {
    const retrievalProvider = providerId ?? this.getActiveRetrievalProviderId();
    const baseKey = `${retrievalProvider}:${query}:${topK}:${this.getPathScopeCacheFragment(scope)}`;
    if (this.commitCacheEnabled && this.currentCommitHash) {
      return `${this.currentCommitHash.substring(0, 12)}:${baseKey}`;
    }
    return baseKey;
  }

  private getSemanticSearchInFlightKey(
    query: string,
    topK: number,
    providerId: RetrievalProviderId,
    maxOutputLength?: number,
    scope?: PathScopeOptions
  ): string {
    const baseKey = this.getCommitAwareCacheKey(query, topK, providerId, scope);
    return `${baseKey}|maxOutputLength=${maxOutputLength ?? 'default'}`;
  }

  private getKeywordFallbackSearchCacheKey(query: string, topK: number, scope?: PathScopeOptions): string {
    const baseKey = `keyword:${query}:${topK}:${this.getPathScopeCacheFragment(scope)}`;
    if (this.commitCacheEnabled && this.currentCommitHash) {
      return `${this.currentCommitHash.substring(0, 12)}:${baseKey}`;
    }
    return baseKey;
  }

  private getCachedKeywordFallbackSearch(cacheKey: string): SearchResult[] | null {
    const entry = this.keywordFallbackSearchCache.get(cacheKey);
    if (entry && Date.now() - entry.timestamp < CACHE_TTL_MS) {
      return entry.data;
    }
    if (entry) {
      this.keywordFallbackSearchCache.delete(cacheKey);
    }
    return null;
  }

  private setCachedKeywordFallbackSearch(cacheKey: string, results: SearchResult[]): void {
    if (this.keywordFallbackSearchCache.size >= this.maxCacheSize) {
      const oldestKey = this.keywordFallbackSearchCache.keys().next().value;
      if (oldestKey) {
        this.keywordFallbackSearchCache.delete(oldestKey);
      }
    }
    this.keywordFallbackSearchCache.set(cacheKey, {
      data: results,
      timestamp: Date.now(),
    });
  }

  /**
   * Prefetch context for files in background (non-blocking).
   * Useful for warming the cache before a review starts.
   * 
   * @param filePaths Array of file paths to prefetch
   * @param commitHash Optional commit hash for cache keying
   */
  async prefetchFilesContext(filePaths: string[], commitHash?: string): Promise<void> {
    if (commitHash) {
      this.enableCommitCache(commitHash);
    }

    // Use setImmediate to avoid blocking the event loop
    setImmediate(async () => {
      console.error(`[prefetch] Starting prefetch for ${filePaths.length} files`);
      const startTime = Date.now();
      let successCount = 0;

      for (const filePath of filePaths) {
        try {
          await this.semanticSearch(`file:${filePath}`, 5);
          successCount++;
        } catch (e) {
          console.error(`[prefetch] Failed for ${filePath}:`, e);
        }
      }

      const elapsed = Date.now() - startTime;
      console.error(`[prefetch] Completed: ${successCount}/${filePaths.length} files in ${elapsed}ms`);
    });
  }

  /**
   * Invalidate cache entries for a specific commit or all entries.
   * 
   * @param commitHash Optional commit hash to invalidate (all if not provided)
   */
  invalidateCommitCache(commitHash?: string): void {
    if (!commitHash) {
      this.clearCache();
      console.error('[ContextServiceClient] Cleared entire cache');
      return;
    }

    const prefix = commitHash.substring(0, 12);
    let invalidated = 0;

    for (const key of this.searchCache.keys()) {
      if (key.startsWith(prefix)) {
        this.searchCache.delete(key);
        invalidated++;
      }
    }

    console.error(`[ContextServiceClient] Invalidated ${invalidated} cache entries for commit ${prefix}`);
  }

  /**
   * Get cache statistics for telemetry and monitoring.
   * 
   * @returns Cache statistics object
   */
  getCacheStats(): { size: number; hitRate: number; commitKeyed: boolean; currentCommit: string | null; hits: number; misses: number } {
    const total = this.cacheHits + this.cacheMisses;
    return {
      size: this.searchCache.size,
      hitRate: total > 0 ? this.cacheHits / total : 0,
      commitKeyed: this.commitCacheEnabled,
      currentCommit: this.currentCommitHash,
      hits: this.cacheHits,
      misses: this.cacheMisses,
    };
  }

  private isLocalNativeRetrievalProvider(): boolean {
    return this.retrievalProviderId === 'local_native' || this.retrievalProviderId === 'local_native_v2';
  }

  private normalizeWorkspaceChangePath(rawPath: string): string | null {
    const relativePath = path.isAbsolute(rawPath)
      ? path.relative(this.workspacePath, rawPath)
      : rawPath;
    const normalized = relativePath.replace(/\\/g, '/').trim();
    if (!normalized || normalized.startsWith('..') || path.isAbsolute(normalized)) {
      return null;
    }
    return normalized;
  }

  private writeLocalNativeStateMarker(indexedAtIso: string): void {
    const stateFilePath = this.getStateFilePath();
    const payload = {
      version: 1,
      provider: this.retrievalProviderId,
      indexedAt: indexedAtIso,
    };
    try {
      fs.writeFileSync(stateFilePath, JSON.stringify(payload), 'utf-8');
    } catch {
      // Best-effort; index status can still be derived from in-memory metadata.
    }
  }

  private async indexWorkspaceLocalNativeFallback(): Promise<IndexResult> {
    const startTime = Date.now();
    this.loadIgnorePatterns();
    const filePaths = await this.discoverFiles(this.workspacePath);
    const indexedAtIso = new Date().toISOString();
    if (filePaths.length === 0) {
      this.updateIndexStatus({
        status: 'error',
        lastError: 'No indexable files found',
        fileCount: 0,
      });
      return {
        indexed: 0,
        skipped: 0,
        errors: ['No indexable files found'],
        duration: Date.now() - startTime,
      };
    }

    const store = this.getIndexStateStore();
    const prior = store ? this.loadIndexStateForActiveProvider(store) : null;
    const nextFiles: Record<string, { hash: string; indexed_at: string }> = {};
    let indexed = 0;
    let skipped = 0;
    let unchangedSkipped = 0;
    const skipReasons: Partial<Record<IndexSkipReason, number>> = {};
    const fileOutcomes: Partial<Record<IndexFileOutcome, number>> = {};
    const skipUnchanged = Boolean(store) && featureEnabled('skip_unchanged_indexing');

    for (const relativePath of filePaths) {
      const readResult = await this.readFileContentsAsync(relativePath);
      if (readResult.content === null) {
        skipped += 1;
        skipReasons[readResult.skipReason] = (skipReasons[readResult.skipReason] ?? 0) + 1;
        fileOutcomes[readResult.outcome] = (fileOutcomes[readResult.outcome] ?? 0) + 1;
        continue;
      }
      const contents = readResult.content;
      fileOutcomes[readResult.outcome] = (fileOutcomes[readResult.outcome] ?? 0) + 1;

      const nextHash = this.hashContent(contents);
      if (skipUnchanged) {
        const previous = prior?.files[relativePath];
        if (previous?.hash === nextHash) {
          unchangedSkipped += 1;
          skipReasons.unchanged = (skipReasons.unchanged ?? 0) + 1;
          fileOutcomes.unchanged = (fileOutcomes.unchanged ?? 0) + 1;
          nextFiles[relativePath] = previous;
          continue;
        }
      }

      indexed += 1;
      if (store) {
        nextFiles[relativePath] = {
          hash: nextHash,
          indexed_at: indexedAtIso,
        };
      }
    }

    if (store) {
      store.save({
        version: typeof prior?.version === 'number' ? prior.version + 1 : 2,
        provider_id: this.retrievalProviderId,
        updated_at: indexedAtIso,
        feature_flags_snapshot: this.getCurrentIndexStateFeatureFlagsSnapshot(),
        files: nextFiles,
      });
    }

    await finalizeLocalNativeIndexLifecycle({
      indexedAtIso,
      fileCount: store ? Object.keys(nextFiles).length : filePaths.length - skipped,
      status: 'idle',
      lastError: undefined,
      writeStateMarker: (nextIndexedAtIso) => this.writeLocalNativeStateMarker(nextIndexedAtIso),
      writeFingerprint: () => this.writeIndexFingerprintFile(crypto.randomUUID()),
      updateIndexStatus: (partial) => this.updateIndexStatus(partial),
      clearCache: () => this.clearCache(),
      refreshGraphStore: (graphOptions) => this.refreshGraphStore(graphOptions),
      graphIndexedFiles: store ? nextFiles : undefined,
    });

    const skipReasonTotal = Object.values(skipReasons).reduce((sum, count) => sum + (count ?? 0), 0);
    const fileOutcomeTotal = Object.values(fileOutcomes).reduce((sum, count) => sum + (count ?? 0), 0);

    return {
      indexed,
      skipped: skipped + unchangedSkipped,
      errors: [],
      duration: Date.now() - startTime,
      totalIndexable: filePaths.length - skipped,
      unchangedSkipped,
      skipReasons: Object.keys(skipReasons).length > 0 ? skipReasons : undefined,
      skipReasonTotal: skipReasonTotal > 0 ? skipReasonTotal : undefined,
      fileOutcomes: Object.keys(fileOutcomes).length > 0 ? fileOutcomes : undefined,
      fileOutcomeTotal: fileOutcomeTotal > 0 ? fileOutcomeTotal : undefined,
    };
  }

  private async indexFilesLocalNativeFallback(filePaths: string[]): Promise<IndexResult> {
    const startTime = Date.now();
    this.loadIgnorePatterns();
    const uniquePaths = Array.from(new Set(filePaths));
    const normalizedPaths: string[] = [];
    let skipped = 0;
    const skipReasons: Partial<Record<IndexSkipReason, number>> = {};
    const fileOutcomes: Partial<Record<IndexFileOutcome, number>> = {};

    for (const rawPath of uniquePaths) {
      const relativePath = path.isAbsolute(rawPath)
        ? path.relative(this.workspacePath, rawPath)
        : rawPath;
      if (!relativePath || relativePath.startsWith('..')) {
        skipped += 1;
        skipReasons.invalid_path = (skipReasons.invalid_path ?? 0) + 1;
        fileOutcomes.invalid_path = (fileOutcomes.invalid_path ?? 0) + 1;
        continue;
      }
      if (this.shouldIgnorePath(relativePath) || !this.shouldIndexFile(relativePath)) {
        skipped += 1;
        skipReasons.ignored_or_unsupported = (skipReasons.ignored_or_unsupported ?? 0) + 1;
        fileOutcomes.ignored_or_unsupported = (fileOutcomes.ignored_or_unsupported ?? 0) + 1;
        continue;
      }
      normalizedPaths.push(relativePath);
    }

    if (normalizedPaths.length === 0) {
      this.updateIndexStatus({
        status: 'error',
        lastError: 'No indexable file changes provided',
      });
      this.clearCache();
      return {
        indexed: 0,
        skipped,
        errors: ['No indexable file changes provided'],
        duration: Date.now() - startTime,
      };
    }

    const indexedAtIso = new Date().toISOString();
    const store = this.getIndexStateStore();
    const prior = store ? this.loadIndexStateForActiveProvider(store) : null;
    const nextFiles: Record<string, { hash: string; indexed_at: string }> = prior ? { ...prior.files } : {};
    let indexed = 0;

    for (const relativePath of normalizedPaths) {
      const readResult = await this.readFileContentsAsync(relativePath);
      if (readResult.content === null) {
        skipped += 1;
        skipReasons[readResult.skipReason] = (skipReasons[readResult.skipReason] ?? 0) + 1;
        fileOutcomes[readResult.outcome] = (fileOutcomes[readResult.outcome] ?? 0) + 1;
        if (store) {
          delete nextFiles[relativePath];
        }
        continue;
      }
      const contents = readResult.content;
      fileOutcomes[readResult.outcome] = (fileOutcomes[readResult.outcome] ?? 0) + 1;
      indexed += 1;
      if (store) {
        nextFiles[relativePath] = {
          hash: this.hashContent(contents),
          indexed_at: indexedAtIso,
        };
      }
    }

    if (store && prior) {
      store.save({
        version: typeof prior.version === 'number' ? prior.version + 1 : 2,
        provider_id: this.retrievalProviderId,
        updated_at: indexedAtIso,
        feature_flags_snapshot: this.getCurrentIndexStateFeatureFlagsSnapshot(),
        files: nextFiles,
      });
    }

    await finalizeLocalNativeIndexLifecycle({
      indexedAtIso,
      fileCount: store ? Object.keys(nextFiles).length : Math.max(this.indexStatus.fileCount, indexed),
      status: indexed > 0 ? 'idle' : 'error',
      lastError: indexed > 0 ? undefined : 'No indexable file changes provided',
      writeStateMarker: (nextIndexedAtIso) => this.writeLocalNativeStateMarker(nextIndexedAtIso),
      writeFingerprint: () => this.writeIndexFingerprintFile(crypto.randomUUID()),
      updateIndexStatus: (partial) => this.updateIndexStatus(partial),
      clearCache: () => this.clearCache(),
      refreshGraphStore: (graphOptions) => this.refreshGraphStore(graphOptions),
      graphIndexedFiles: store ? nextFiles : undefined,
      shouldRefreshGraph: indexed > 0,
    });

    const skipReasonTotal = Object.values(skipReasons).reduce((sum, count) => sum + (count ?? 0), 0);
    const fileOutcomeTotal = Object.values(fileOutcomes).reduce((sum, count) => sum + (count ?? 0), 0);

    return {
      indexed,
      skipped,
      errors: indexed > 0 ? [] : ['No indexable file changes provided'],
      duration: Date.now() - startTime,
      skipReasons: Object.keys(skipReasons).length > 0 ? skipReasons : undefined,
      skipReasonTotal: skipReasonTotal > 0 ? skipReasonTotal : undefined,
      fileOutcomes: Object.keys(fileOutcomes).length > 0 ? fileOutcomes : undefined,
      fileOutcomeTotal: fileOutcomeTotal > 0 ? fileOutcomeTotal : undefined,
    };
  }

  // ==========================================================================
  // Core Operations
  // ==========================================================================

  /**
   * Index the workspace directory via the active retrieval provider.
   */
  async indexWorkspace(): Promise<IndexResult> {
    return this.retrievalProvider.indexWorkspace();
  }

  /**
   * Run workspace indexing in a background worker thread.
   */
  async indexWorkspaceInBackground(): Promise<void> {
    const currentStatus = this.getIndexStatus();
    if (currentStatus.status === 'indexing') {
      return;
    }
    this.updateIndexStatus({ status: 'indexing', lastError: undefined });
    return this.runBackgroundIndexingCore();
  }

  startAutoIndexOnStartupIfNeeded(options?: {
    enabled?: boolean;
    log?: (message: string) => void;
  }): StartupAutoIndexResult {
    const enabled = options?.enabled ?? true;
    const log = options?.log ?? console.error;

    if (!enabled) {
      return {
        started: false,
        reason: 'disabled',
        summary: 'Startup auto-index is disabled.',
      };
    }

    const decision = evaluateStartupAutoIndex(this.getIndexStatus());
    if (!decision.shouldAutoIndex) {
      return {
        started: false,
        reason: decision.freshness.code,
        summary: decision.freshness.summary,
      };
    }

    if (this.indexStatus.status === 'indexing' || this.startupAutoIndexScheduled) {
      return {
        started: false,
        reason: 'indexing',
        summary: 'Startup auto-index skipped because indexing is already in progress.',
      };
    }

    this.startupAutoIndexScheduled = true;
    this.updateIndexStatus({ status: 'indexing', lastError: undefined });
    setImmediate(() => {
      this.startupAutoIndexScheduled = false;
      void this.runBackgroundIndexingCore().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`[startup] Background indexing failed: ${message}`);
      });
    });

    return {
      started: true,
      reason: decision.freshness.code,
      summary: decision.freshness.summary,
    };
  }

  private async runBackgroundIndexingCore(): Promise<void> {
    if (this.isOfflineMode()) {
      const message = 'Background indexing is disabled while CONTEXT_ENGINE_OFFLINE_ONLY is enabled.';
      console.error(message);
      this.updateIndexStatus({ status: 'error', lastError: message });
      throw new Error(message);
    }

    if (this.isLocalNativeRetrievalProvider()) {
      await this.indexWorkspace();
      return;
    }

    const workerSpec = this.getIndexWorkerSpec();
    if (!workerSpec) {
      console.error('[indexWorkspaceInBackground] Index worker unavailable; falling back to in-process indexing.');
      await this.indexWorkspace();
      return;
    }

    return new Promise((resolve, reject) => {
      const worker = new Worker(workerSpec.url, {
        execArgv: workerSpec.execArgv,
        workerData: {
          workspacePath: this.workspacePath,
        },
      });

      let settled = false;
      worker.on('message', (message: WorkerMessage) => {
        if (message.type === 'index_complete') {
          void (async () => {
            if (settled) return;
            settled = true;

            const nextFileCount =
              message.totalIndexable ??
              (this.indexStatus.fileCount > 0 ? this.indexStatus.fileCount : message.count);

            this.updateIndexStatus({
              status: message.errors?.length ? 'error' : 'idle',
              lastIndexed: new Date().toISOString(),
              fileCount: nextFileCount,
              lastError: message.errors?.[message.errors.length - 1],
            });

            this.clearCache();

            await worker.terminate();
            resolve();
          })().catch(async (e) => {
            try {
              await worker.terminate();
            } catch {
              // ignore
            }
            reject(e);
          });
        } else if (message.type === 'index_error') {
          if (settled) return;
          settled = true;
          this.updateIndexStatus({
            status: 'error',
            lastError: message.error,
          });
          void worker.terminate().finally(() => {
            reject(new Error(message.error));
          });
        }
      });

      worker.on('error', (error) => {
        if (settled) return;
        settled = true;
        this.updateIndexStatus({ status: 'error', lastError: String(error) });
        void worker.terminate().finally(() => {
          reject(error);
        });
      });

      worker.on('exit', (code) => {
        if (settled) return;
        settled = true;
        if (code !== 0) {
          const err = new Error(`Index worker exited with code ${code}`);
          this.updateIndexStatus({ status: 'error', lastError: err.message });
          reject(err);
        }
      });
    });
  }

  /**
   * Get current index status metadata
   */
  getIndexStatus(): IndexStatus {
    this.hydrateIndexStatusFromDisk();
    // Refresh staleness dynamically based on lastIndexed
    this.updateIndexStatus({});
    const embeddingRuntime = describeEmbeddingRuntimeStatus(featureEnabled('retrieval_lancedb_v1'));
    if (embeddingRuntime && embeddingRuntime.state !== 'uninitialized') {
      return {
        ...this.indexStatus,
        embeddingRuntime,
      };
    }
    return { ...this.indexStatus };
  }

  /**
   * Incrementally index a list of file paths (relative to workspace)
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    return this.retrievalProvider.indexFiles(filePaths);
  }

  /**
   * Apply watcher-originated file changes using the incremental local-native paths.
   * Delete events prune persisted index-state entries to avoid full reindex work.
   */
  async applyWorkspaceChanges(changes: WorkspaceFileChange[]): Promise<void> {
    if (!Array.isArray(changes) || changes.length === 0) {
      return;
    }

    const latestByPath = new Map<string, WorkspaceFileChange['type']>();
    for (const change of changes) {
      if (!change || typeof change.path !== 'string') {
        continue;
      }
      if (change.type !== 'add' && change.type !== 'change' && change.type !== 'unlink') {
        continue;
      }
      const normalizedPath = this.normalizeWorkspaceChangePath(change.path);
      if (!normalizedPath) {
        continue;
      }
      latestByPath.set(normalizedPath, change.type);
    }

    if (latestByPath.size === 0) {
      return;
    }

    const deletedPaths: string[] = [];
    const upsertPaths: string[] = [];
    for (const [filePath, changeType] of latestByPath.entries()) {
      if (changeType === 'unlink') {
        deletedPaths.push(filePath);
      } else {
        upsertPaths.push(filePath);
      }
    }

    if (deletedPaths.length > 0) {
      await this.pruneDeletedIndexEntries(deletedPaths);
    }

    if (upsertPaths.length > 0) {
      await this.indexFiles(upsertPaths);
    }

    await this.refreshLexicalSqliteSearchEngine(
      Array.from(latestByPath.entries()).map(([path, type]) => ({ path, type }))
    );
  }

  /**
   * Clear index state and caches
   */
  async clearIndex(): Promise<void> {
    await this.retrievalProvider.clearIndex();
  }

  private async pruneDeletedIndexEntries(filePaths: string[]): Promise<number> {
    const normalizedPaths = Array.from(
      new Set(
        filePaths
          .map((filePath) => this.normalizeWorkspaceChangePath(filePath))
          .filter((value): value is string => Boolean(value))
      )
    );
    if (normalizedPaths.length === 0) {
      return 0;
    }

    // Search reads files from disk at query time, so cache invalidation is always safe
    // even when index-state storage is disabled.
    this.clearCache();

    if (!this.isLocalNativeRetrievalProvider()) {
      return 0;
    }

    const store = this.getIndexStateStore();
    if (!store) {
      return 0;
    }

    const prior = this.loadIndexStateForActiveProvider(store);
    const nextFiles = { ...prior.files };
    let removed = 0;
    for (const filePath of normalizedPaths) {
      if (Object.prototype.hasOwnProperty.call(nextFiles, filePath)) {
        delete nextFiles[filePath];
        removed += 1;
      }
    }

    if (removed === 0) {
      return 0;
    }

    const updatedAtIso = new Date().toISOString();
    store.save({
      version: typeof prior.version === 'number' ? prior.version + 1 : 2,
      provider_id: this.retrievalProviderId,
      updated_at: updatedAtIso,
      feature_flags_snapshot: this.getCurrentIndexStateFeatureFlagsSnapshot(),
      files: nextFiles,
    });
    await finalizeLocalNativeIndexLifecycle({
      indexedAtIso: updatedAtIso,
      fileCount: Object.keys(nextFiles).length,
      status: 'idle',
      lastError: undefined,
      writeStateMarker: (nextIndexedAtIso) => this.writeLocalNativeStateMarker(nextIndexedAtIso),
      writeFingerprint: () => this.writeIndexFingerprintFile(crypto.randomUUID()),
      updateIndexStatus: (partial) => this.updateIndexStatus(partial),
      clearCache: () => this.clearCache(),
      refreshGraphStore: (graphOptions) => this.refreshGraphStore(graphOptions),
      graphIndexedFiles: nextFiles,
    });

    return removed;
  }

  private async clearIndexWithProviderRuntime(options?: { localNative?: boolean }): Promise<void> {
    if (options?.localNative) {
      console.error('[clearIndex] Clearing local_native retrieval metadata.');
    }
    this.indexStatusDiskHydrated = false;

    await clearLocalNativeIndexLifecycle({
      fingerprintPath: path.join(this.workspacePath, INDEX_FINGERPRINT_FILE_NAME),
      stateStorePaths: [
        path.join(this.workspacePath, '.context-engine-index-state.json'),
        path.join(this.workspacePath, '.augment-index-state.json'),
      ],
      stateFilePaths: [
        this.getStateFilePath(),
        this.getReadableStateFilePath(),
      ],
      clearCache: () => this.clearCache(),
      resetIgnorePatterns: () => {
        this.ignorePatternsLoaded = false;
        this.ignorePatterns = [];
      },
      clearGraphArtifacts: () => this.graphAccess.clearArtifacts(),
      updateIndexStatus: (partial) => this.updateIndexStatus(partial),
      logInfo: (message) => console.error(message),
      logError: (message, error) => console.error(message, error),
    });
  }

  /**
   * Perform semantic search using the active retrieval provider.
   */
  async semanticSearch(
    query: string,
    topK: number = 10,
    options?: {
      bypassCache?: boolean;
      maxOutputLength?: number;
      priority?: 'interactive' | 'background';
      includePaths?: string[];
      excludePaths?: string[];
    }
  ): Promise<SearchResult[]> {
    const metricsStart = Date.now();
    const debugSearch = process.env.CE_DEBUG_SEARCH === 'true';
    const bypassCache = options?.bypassCache ?? false;
    const normalizedScope = this.normalizePathScopeOptions(options);
    const retrievalProvider = this.getActiveRetrievalProviderId();
    this.setLastSearchDiagnostics(null);

    // Use commit-aware cache key when reactive mode is enabled
    const memoryCacheKey = this.getCommitAwareCacheKey(query, topK, retrievalProvider, normalizedScope);

    if (!bypassCache) {
      const cached = this.getCachedSearch(memoryCacheKey);
      if (cached) {
        this.cacheHits++;
        incCounter(
          'context_engine_semantic_search_total',
          { cache: 'memory', bypass: bypassCache ? 'true' : 'false' },
          1,
          'Total semanticSearch calls (labeled by cache path).'
        );
        observeDurationMs(
          'context_engine_semantic_search_duration_seconds',
          { cache: 'memory', bypass: bypassCache ? 'true' : 'false' },
          Date.now() - metricsStart,
          { help: 'semanticSearch end-to-end duration in seconds (includes cache hits).' }
        );
        if (debugSearch) {
          console.error(formatScopedLog(`[semanticSearch] Cache hit for query: ${query}`));
        }
        return cached;
      }
    }

    const indexFingerprint = this.getIndexFingerprint();
    const persistentCacheKey = (indexFingerprint !== 'no-state' && indexFingerprint !== 'unknown')
      ? `${indexFingerprint}:${memoryCacheKey}`
      : null;

    if (!bypassCache && persistentCacheKey) {
      const persistent = this.getPersistentSearch(persistentCacheKey);
      if (persistent) {
        this.cacheHits++;
        incCounter(
          'context_engine_semantic_search_total',
          { cache: 'persistent', bypass: bypassCache ? 'true' : 'false' },
          1,
          'Total semanticSearch calls labeled by cache path.'
        );
        observeDurationMs(
          'context_engine_semantic_search_duration_seconds',
          { cache: 'persistent', bypass: bypassCache ? 'true' : 'false' },
          Date.now() - metricsStart,
          { help: 'semanticSearch end-to-end duration in seconds (includes cache hits).' }
        );
        return persistent;
      }
    }

    const inFlightKey = this.getSemanticSearchInFlightKey(
      query,
      topK,
      retrievalProvider,
      options?.maxOutputLength,
      normalizedScope
    );
    const inFlightRequest = this.semanticSearchInFlight.get(inFlightKey);
    if (inFlightRequest) {
      if (inFlightRequest.generation === this.semanticSearchCacheGeneration) {
        inFlightRequest.shouldCache = inFlightRequest.shouldCache || !bypassCache;
        this.cacheHits++;
        incCounter(
          'context_engine_semantic_search_total',
          { cache: 'inflight', bypass: bypassCache ? 'true' : 'false' },
          1,
          'Total semanticSearch calls labeled by cache path.'
        );
        const searchResults = await inFlightRequest.promise;
        observeDurationMs(
          'context_engine_semantic_search_duration_seconds',
          { cache: 'inflight', bypass: bypassCache ? 'true' : 'false' },
          Date.now() - metricsStart,
          { help: 'semanticSearch end-to-end duration in seconds (includes cache hits).' }
        );
        return searchResults;
      }

      this.semanticSearchInFlight.delete(inFlightKey);
    }

    const currentSearchGeneration = this.semanticSearchCacheGeneration;
    const sharedRequest: SemanticSearchInFlightRequest = {
      generation: currentSearchGeneration,
      shouldCache: !bypassCache,
      promise: Promise.resolve().then(async () => {
        try {
          const searchResults = this.filterSearchResultsByScope(
            await this.retrievalProvider.search(query, topK, options),
            normalizedScope
          );

          if (
            sharedRequest.generation === this.semanticSearchCacheGeneration &&
            sharedRequest.shouldCache
          ) {
            // Cache results
            this.setCachedSearch(memoryCacheKey, searchResults);
            if (persistentCacheKey) {
              this.setPersistentSearch(persistentCacheKey, searchResults);
            }
          }
          this.maybeRunRetrievalShadowCompare(query, topK, searchResults);
          this.cacheMisses++;
          incCounter(
            'context_engine_semantic_search_total',
            { cache: 'miss', bypass: bypassCache ? 'true' : 'false' },
            1,
            'Total semanticSearch calls labeled by cache path.'
          );
          observeDurationMs(
            'context_engine_semantic_search_duration_seconds',
            { cache: 'miss', bypass: bypassCache ? 'true' : 'false' },
            Date.now() - metricsStart,
            { help: 'semanticSearch end-to-end duration in seconds (includes cache hits).' }
          );
          return searchResults;
        } catch (error) {
          console.error(formatScopedLog('Search failed:'), error);
          this.cacheMisses++;
          incCounter(
            'context_engine_semantic_search_total',
            { cache: 'error', bypass: bypassCache ? 'true' : 'false' },
            1,
            'Total semanticSearch calls labeled by cache path.'
          );
          observeDurationMs(
            'context_engine_semantic_search_duration_seconds',
            { cache: 'error', bypass: bypassCache ? 'true' : 'false' },
            Date.now() - metricsStart,
            { help: 'semanticSearch end-to-end duration in seconds (includes cache hits).' }
          );
          try {
            return await this.keywordFallbackSearch(query, topK, {
              bypassCache,
              includePaths: normalizedScope?.includePaths,
              excludePaths: normalizedScope?.excludePaths,
            });
          } catch {
            return [];
          }
        } finally {
          if (this.semanticSearchInFlight.get(inFlightKey) === sharedRequest) {
            this.semanticSearchInFlight.delete(inFlightKey);
          }
        }
      }),
    };
    this.semanticSearchInFlight.set(inFlightKey, sharedRequest);

    try {
      return await sharedRequest.promise;
    } finally {
      if (this.semanticSearchInFlight.get(inFlightKey) === sharedRequest) {
        this.semanticSearchInFlight.delete(inFlightKey);
      }
    }
  }

  private async searchWithProviderRuntime(
    query: string,
    topK: number,
    options?: {
      bypassCache?: boolean;
      maxOutputLength?: number;
      priority?: 'interactive' | 'background';
        includePaths?: string[];
        excludePaths?: string[];
      }
  ): Promise<SearchResult[]> {
    return this.retrievalAccess.searchWithProviderRuntime(query, topK, options);
  }

  /**
   * Deterministic local retrieval path for internal callers that should not depend on provider output format.
   */
  async localKeywordSearch(
    query: string,
    topK: number = 10,
    options?: { bypassCache?: boolean; includePaths?: string[]; excludePaths?: string[] }
  ): Promise<SearchResult[]> {
    return this.keywordFallbackSearch(query, topK, {
      bypassCache: options?.bypassCache,
      includePaths: options?.includePaths,
      excludePaths: options?.excludePaths,
    });
  }

  /**
   * Deterministic symbol-first navigation path for identifier-style lookups.
   * This intentionally bypasses semantic providers and relies on local exact/symbol-aware ranking.
   */
  async symbolSearch(
    symbol: string,
    topK: number = 10,
    options?: { bypassCache?: boolean; includePaths?: string[]; excludePaths?: string[] }
  ): Promise<SearchResult[]> {
    const trimmedSymbol = symbol.trim();
    this.setLastSymbolNavigationDiagnostics(null);
    if (!trimmedSymbol) {
      return [];
    }

    const graphState = this.getGraphNavigationSnapshot();
    if (graphState.payload) {
      const scope = normalizePathScopeInput({
        includePaths: options?.includePaths,
        excludePaths: options?.excludePaths,
      });
      const fileCache = new Map<string, string>();
      const matchingSymbols = graphState.payload.symbols
        .filter((candidate) => {
          if (!matchesNormalizedPathScope(candidate.path, scope)) {
            return false;
          }
          if (candidate.name === trimmedSymbol) {
            return true;
          }
          if (candidate.name.toLowerCase() === trimmedSymbol.toLowerCase()) {
            return true;
          }
          return candidate.name.includes(trimmedSymbol);
        })
        .map((candidate) => ({
          symbol: candidate,
          definition: this.findDefinitionRecordForSymbol(graphState.payload!, candidate.id),
        }))
        .filter((candidate) => candidate.definition)
        .sort((left, right) => {
          const leftExact = left.symbol.name === trimmedSymbol ? 2 : left.symbol.name.toLowerCase() === trimmedSymbol.toLowerCase() ? 1 : 0;
          const rightExact = right.symbol.name === trimmedSymbol ? 2 : right.symbol.name.toLowerCase() === trimmedSymbol.toLowerCase() ? 1 : 0;
          if (rightExact !== leftExact) return rightExact - leftExact;
          const leftScore = this.scoreGraphPath(left.symbol.path) - left.symbol.start_line / 50;
          const rightScore = this.scoreGraphPath(right.symbol.path) - right.symbol.start_line / 50;
          if (rightScore !== leftScore) return rightScore - leftScore;
          return left.symbol.path.localeCompare(right.symbol.path);
        });

      if (matchingSymbols.length > 0) {
        const limited = matchingSymbols.slice(0, Math.max(1, Math.min(50, Math.floor(topK))));
        const scored = limited.map((entry, index) => {
          const exactness = entry.symbol.name === trimmedSymbol ? 40 : entry.symbol.name.toLowerCase() === trimmedSymbol.toLowerCase() ? 20 : 10;
          return {
            entry,
            score: Math.max(1, 100 + exactness + this.scoreGraphPath(entry.symbol.path) - entry.symbol.start_line / 50 - index),
          };
        });
        const maxScore = Math.max(...scored.map((entry) => entry.score));
        const results = await Promise.all(scored.map(async ({ entry, score }) => {
          const snippet = await this.readSnippetFromFile(fileCache, entry.symbol.path, entry.definition!.start_line);
          return {
            path: this.normalizeGraphPath(entry.symbol.path),
            content: snippet?.snippet ?? entry.symbol.name,
            lines: `${entry.definition!.start_line}-${entry.definition!.end_line}`,
            relevanceScore: maxScore > 0 ? Math.max(0, Math.min(1, score / maxScore)) : 0,
            matchType: 'keyword' as const,
            retrievedAt: new Date().toISOString(),
            chunkId: `${this.normalizeGraphPath(entry.symbol.path)}#graph-symbol-${entry.definition!.start_line}`,
          };
        }));

        this.setLastSymbolNavigationDiagnostics(
          this.buildSymbolNavigationDiagnostics('symbol_search', 'graph', graphState, null)
        );
        return results;
      }
    }

    const fallbackReason = graphState.payload
      ? (scopeApplied({ includePaths: options?.includePaths, excludePaths: options?.excludePaths }) ? 'graph_scope_filtered' : 'graph_symbol_not_found')
      : graphState.fallbackReason;
    const results = await this.localKeywordSearch(trimmedSymbol, topK, {
      bypassCache: options?.bypassCache,
      includePaths: options?.includePaths,
      excludePaths: options?.excludePaths,
    });
    this.setLastSymbolNavigationDiagnostics(
      this.buildSymbolNavigationDiagnostics('symbol_search', 'heuristic_fallback', graphState, fallbackReason)
    );
    return results;
  }

  /**
   * Deterministic local reference lookup for known identifiers.
   * Returns non-declaration usages only, keeping navigation focused on call sites and consumers.
   */
  async symbolReferencesSearch(
    symbol: string,
    topK: number = 10,
    options?: { bypassCache?: boolean; includePaths?: string[]; excludePaths?: string[] }
  ): Promise<SearchResult[]> {
    const trimmedSymbol = symbol.trim();
    this.setLastSymbolNavigationDiagnostics(null);
    if (!trimmedSymbol) {
      return [];
    }

    const graphState = this.getGraphNavigationSnapshot();
    if (graphState.payload) {
      const scope = normalizePathScopeInput({
        includePaths: options?.includePaths,
        excludePaths: options?.excludePaths,
      });
      const fileCache = new Map<string, string>();
      const definitionBySymbolId = new Map(
        graphState.payload.definitions.map((definition) => [definition.symbol_id, definition] as const)
      );
      const referenceCandidates = graphState.payload.references
        .filter((reference) =>
          reference.symbol_name === trimmedSymbol
          && matchesNormalizedPathScope(reference.path, scope)
          && !(
            reference.symbol_id
            && reference.source_symbol_id === reference.symbol_id
            && reference.line === (definitionBySymbolId.get(reference.symbol_id)?.start_line ?? -1)
          )
        )
        .map((reference) => {
          const definition = reference.symbol_id ? definitionBySymbolId.get(reference.symbol_id) ?? null : null;
          let score = 60 + reference.confidence * 20 + this.scoreGraphPath(reference.path);
          if (reference.source_symbol_id) score += 10;
          if (definition && definition.path !== reference.path) score += 12;
          return { reference, score };
        })
        .sort((left, right) => right.score - left.score || left.reference.path.localeCompare(right.reference.path) || left.reference.line - right.reference.line)
        .slice(0, Math.max(1, Math.min(50, Math.floor(topK))));

      if (referenceCandidates.length > 0) {
        const maxScore = Math.max(...referenceCandidates.map((entry) => entry.score));
        const results = await Promise.all(referenceCandidates.map(async ({ reference, score }) => {
          const snippet = await this.readSnippetFromFile(fileCache, reference.path, reference.line);
          return {
            path: this.normalizeGraphPath(reference.path),
            content: snippet?.snippet ?? trimmedSymbol,
            lines: snippet ? `${snippet.startLine}-${snippet.endLine}` : `${reference.line}-${reference.line}`,
            relevanceScore: maxScore > 0 ? Math.max(0, Math.min(1, score / maxScore)) : 0,
            matchType: 'keyword' as const,
            retrievedAt: new Date().toISOString(),
            chunkId: `${this.normalizeGraphPath(reference.path)}#graph-ref-L${reference.line}`,
          };
        }));

        this.setLastSymbolNavigationDiagnostics(
          this.buildSymbolNavigationDiagnostics('symbol_references', 'graph', graphState, null)
        );
        return results;
      }
    }

    const candidateLimit = Math.min(Math.max(topK * 12, 60), 200);
    const keywordCandidates = await this.localKeywordSearch(trimmedSymbol, candidateLimit, {
      bypassCache: options?.bypassCache,
      includePaths: options?.includePaths,
      excludePaths: options?.excludePaths,
    });
    if (keywordCandidates.length === 0) {
      return [];
    }

    const symbolPattern = buildSymbolUsagePattern(trimmedSymbol);
    const retrievedAt = new Date().toISOString();
    const candidates: Array<SearchResult & { __score: number }> = [];
    const seenPaths = new Set<string>();

    for (const keywordCandidate of keywordCandidates) {
      const filePath = keywordCandidate.path;
      if (seenPaths.has(filePath)) {
        continue;
      }
      seenPaths.add(filePath);

      let content: string;
      try {
        content = await this.getFile(filePath);
      } catch {
        continue;
      }

      const lines = content.split(/\r?\n/);
      let firstReferenceLineIndex = -1;
      let hitCount = 0;

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (!symbolPattern.test(line)) {
          continue;
        }
        if (isDeclarationLikeSymbolLine(line, trimmedSymbol)) {
          continue;
        }
        if (firstReferenceLineIndex === -1) {
          firstReferenceLineIndex = index;
        }
        hitCount += 1;
      }

      if (firstReferenceLineIndex === -1) {
        continue;
      }

      const snippet = buildSymbolReferenceSnippet(content, firstReferenceLineIndex);
      const normalizedPath = filePath.replace(/\\/g, '/');
      let score = hitCount * 10 + Math.round((keywordCandidate.relevanceScore ?? keywordCandidate.score ?? 0) * 20);
      if (normalizedPath.startsWith('src/')) score += 12;
      if (normalizedPath.startsWith('tests/') || normalizedPath.startsWith('test/')) score += 6;
      if (/\/__tests__\//.test(normalizedPath)) score += 3;

      candidates.push({
        path: normalizedPath,
        content: snippet.snippet,
        lines: `${snippet.startLine}-${snippet.endLine}`,
        relevanceScore: undefined,
        matchType: 'keyword',
        retrievedAt,
        chunkId: `${normalizedPath}#ref-L${firstReferenceLineIndex + 1}`,
        __score: score,
      });
    }

    if (candidates.length === 0) {
      this.setLastSymbolNavigationDiagnostics(
        this.buildSymbolNavigationDiagnostics(
          'symbol_references',
          'heuristic_fallback',
          graphState,
          graphState.payload ? 'graph_reference_not_found' : graphState.fallbackReason
        )
      );
      return [];
    }

    const maxScore = Math.max(...candidates.map((candidate) => candidate.__score));
    const results = candidates
      .sort((a, b) => b.__score - a.__score || a.path.localeCompare(b.path))
      .slice(0, Math.max(1, Math.min(50, Math.floor(topK))))
      .map(({ __score, ...result }) => ({
        ...result,
        relevanceScore: maxScore > 0 ? Math.max(0, Math.min(1, __score / maxScore)) : 0,
      }));
    this.setLastSymbolNavigationDiagnostics(
      this.buildSymbolNavigationDiagnostics(
        'symbol_references',
        'heuristic_fallback',
        graphState,
        graphState.payload ? 'graph_reference_not_found' : graphState.fallbackReason
      )
    );
    return results;
  }

  /**
   * Deterministic single-result symbol definition lookup.
   * Returns the single best canonical declaration site for a known identifier.
   */
  async symbolDefinition(
    symbol: string,
    options?: { bypassCache?: boolean; includePaths?: string[]; excludePaths?: string[]; languageHint?: string }
  ): Promise<SymbolDefinitionResult> {
    const trimmedSymbol = symbol.trim();
    this.setLastSymbolNavigationDiagnostics(null);
    if (!trimmedSymbol) {
      return { found: false, symbol: trimmedSymbol };
    }

    const graphState = this.getGraphNavigationSnapshot();
    if (graphState.payload) {
      const scope = normalizePathScopeInput({
        includePaths: options?.includePaths,
        excludePaths: options?.excludePaths,
      });
      const definitionCandidates = graphState.payload.symbols
        .filter((candidate) =>
          candidate.name === trimmedSymbol
          && matchesNormalizedPathScope(candidate.path, scope)
        )
        .map((candidate) => ({
          symbol: candidate,
          definition: this.findDefinitionRecordForSymbol(graphState.payload!, candidate.id),
        }))
        .filter((candidate) => candidate.definition)
        .map((candidate) => {
          let score = 100;
          if (candidate.symbol.name === trimmedSymbol) score += 50;
          if (candidate.symbol.kind !== 'unknown') score += 40;
          score += this.scoreGraphPath(candidate.symbol.path);
          score -= Math.min(15, candidate.symbol.start_line / 50);
          return { ...candidate, score };
        })
        .sort((left, right) =>
          right.score - left.score
          || left.symbol.path.localeCompare(right.symbol.path)
          || left.symbol.start_line - right.symbol.start_line
        );

      if (definitionCandidates.length > 0) {
        const best = definitionCandidates[0]!;
        const snippet = await this.readSnippetFromFile(new Map<string, string>(), best.symbol.path, best.definition!.start_line);
        const metadata = this.buildSymbolNavigationDiagnostics('symbol_definition', 'graph', graphState, null);
        this.setLastSymbolNavigationDiagnostics(metadata);
        return {
          found: true,
          symbol: trimmedSymbol,
          file: this.normalizeGraphPath(best.symbol.path),
          line: best.definition!.start_line,
          column: 1,
          kind: classifySymbolDefinitionKind(snippet?.snippet ?? best.symbol.name, trimmedSymbol) || 'unknown',
          snippet: snippet?.snippet ?? best.symbol.name,
          score: Math.round(best.score * 100) / 100,
          metadata,
        };
      }
    }

    const candidateLimit = 200;
    const keywordCandidates = await this.localKeywordSearch(trimmedSymbol, candidateLimit, {
      bypassCache: options?.bypassCache,
      includePaths: options?.includePaths,
      excludePaths: options?.excludePaths,
    });
    if (keywordCandidates.length === 0) {
      const metadata = this.buildSymbolNavigationDiagnostics(
        'symbol_definition',
        'heuristic_fallback',
        graphState,
        graphState.payload ? 'graph_definition_not_found' : graphState.fallbackReason
      );
      this.setLastSymbolNavigationDiagnostics(metadata);
      return { found: false, symbol: trimmedSymbol, metadata };
    }

    const symbolPattern = buildSymbolUsagePattern(trimmedSymbol);

    type DeclarationCandidate = {
      path: string;
      lineIndex: number;
      column: number;
      kind: SymbolDefinitionKind;
      exactCase: boolean;
      isImport: boolean;
      snippet: string;
      snippetStart: number;
      snippetEnd: number;
    };
    const declarations: DeclarationCandidate[] = [];
    const seenPaths = new Set<string>();

    for (const keywordCandidate of keywordCandidates) {
      const filePath = keywordCandidate.path;
      if (seenPaths.has(filePath)) {
        continue;
      }
      seenPaths.add(filePath);

      let content: string;
      try {
        content = await this.getFile(filePath);
      } catch {
        continue;
      }

      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (!symbolPattern.test(line)) {
          continue;
        }
        if (!isDeclarationLikeSymbolLine(line, trimmedSymbol)) {
          continue;
        }

        const trimmedLine = line.trim();
        const isImport = /^import\b/.test(trimmedLine);
        const exactCase = line.includes(trimmedSymbol);
        const kind = isImport ? 'unknown' : classifySymbolDefinitionKind(line, trimmedSymbol);
        const columnIndex = line.indexOf(trimmedSymbol);
        const snippet = buildSymbolReferenceSnippet(content, index);
        const normalizedPath = filePath.replace(/\\/g, '/');

        declarations.push({
          path: normalizedPath,
          lineIndex: index,
          column: columnIndex >= 0 ? columnIndex + 1 : 1,
          kind,
          exactCase,
          isImport,
          snippet: snippet.snippet,
          snippetStart: snippet.startLine,
          snippetEnd: snippet.endLine,
        });
        break;
      }
    }

    if (declarations.length === 0) {
      const metadata = this.buildSymbolNavigationDiagnostics(
        'symbol_definition',
        'heuristic_fallback',
        graphState,
        graphState.payload ? 'graph_definition_not_found' : graphState.fallbackReason
      );
      this.setLastSymbolNavigationDiagnostics(metadata);
      return { found: false, symbol: trimmedSymbol, metadata };
    }

    const scoreFor = (candidate: DeclarationCandidate): number => {
      let score = 0;
      if (!candidate.isImport && candidate.kind !== 'unknown') score += 100;
      if (candidate.exactCase) score += 50;
      const normalized = candidate.path;
      if (normalized.startsWith('src/')) score += 30;
      if (normalized.startsWith('tests/') || normalized.startsWith('test/')) score -= 10;
      if (/\/__tests__\//.test(normalized)) score -= 5;
      if (normalized.includes('node_modules/')) score -= 50;
      score -= Math.min(20, normalized.length / 8);
      score -= Math.min(15, candidate.lineIndex / 50);
      return score;
    };

    const ranked = declarations
      .map((candidate) => ({ candidate, score: scoreFor(candidate) }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const aSrc = a.candidate.path.startsWith('src/') ? 0 : 1;
        const bSrc = b.candidate.path.startsWith('src/') ? 0 : 1;
        if (aSrc !== bSrc) return aSrc - bSrc;
        if (a.candidate.path.length !== b.candidate.path.length) {
          return a.candidate.path.length - b.candidate.path.length;
        }
        if (a.candidate.lineIndex !== b.candidate.lineIndex) {
          return a.candidate.lineIndex - b.candidate.lineIndex;
        }
        return a.candidate.path.localeCompare(b.candidate.path);
      });

    const best = ranked[0];
    const metadata = this.buildSymbolNavigationDiagnostics(
      'symbol_definition',
      'heuristic_fallback',
      graphState,
      graphState.payload ? 'graph_definition_not_found' : graphState.fallbackReason
    );
    this.setLastSymbolNavigationDiagnostics(metadata);
    return {
      found: true,
      symbol: trimmedSymbol,
      file: best.candidate.path,
      line: best.candidate.lineIndex + 1,
      column: best.candidate.column,
      kind: best.candidate.kind,
      snippet: best.candidate.snippet,
      score: Math.round(best.score * 100) / 100,
      metadata,
    };
  }

  private async searchResultsForLookupIntent(
    lookup: LookupIntentResolution,
    scope?: NormalizedPathScope,
    options?: { bypassCache?: boolean }
  ): Promise<LookupRouteAttempt> {
    const bypassCache = options?.bypassCache === true;
    if (!lookup.symbol || lookup.intent === 'discovery') {
      return {
        results: [],
        selectedRoute: 'semantic_fallback',
        symbolHit: false,
        declarationHit: false,
        parserSource: null,
        parserProvenance: [],
        downgradeReason: null,
        fallbackReason: 'lookup_route_error',
        oversizedFileOutcome: null,
      };
    }

    if (lookup.intent === 'references') {
      const references = await this.symbolReferencesSearch(lookup.symbol, 10, {
        bypassCache,
        includePaths: scope?.includePaths,
        excludePaths: scope?.excludePaths,
      });
      return references.length > 0
        ? {
            results: references,
            selectedRoute: 'lookup_references',
            symbolHit: true,
            declarationHit: false,
            parserSource: null,
            parserProvenance: [],
            downgradeReason: null,
            fallbackReason: null,
            oversizedFileOutcome: null,
          }
        : {
            results: [],
            selectedRoute: 'semantic_fallback',
            symbolHit: false,
            declarationHit: false,
            parserSource: null,
            parserProvenance: [],
            downgradeReason: null,
            fallbackReason: 'lookup_symbol_not_found',
            oversizedFileOutcome: null,
          };
    }

    const definition = await this.symbolDefinition(lookup.symbol, {
      bypassCache,
      includePaths: scope?.includePaths,
      excludePaths: scope?.excludePaths,
    });
    if (!definition.found) {
      return {
        results: [],
        selectedRoute: 'semantic_fallback',
        symbolHit: false,
        declarationHit: false,
        parserSource: null,
        parserProvenance: [],
        downgradeReason: null,
        fallbackReason: 'lookup_symbol_not_found',
        oversizedFileOutcome: null,
      };
    }

    const hydrated = await this.hydrateDefinitionSearchResult(definition, {
      requireBody: lookup.intent === 'body',
    });
    if (!hydrated.result) {
      return {
        results: [],
        selectedRoute: 'semantic_fallback',
        symbolHit: true,
        declarationHit: false,
        parserSource: hydrated.parserSource,
        parserProvenance: hydrated.parserProvenance,
        downgradeReason: hydrated.downgradeReason,
        fallbackReason: lookup.intent === 'body' ? 'lookup_body_unavailable' : 'lookup_route_error',
        oversizedFileOutcome: null,
      };
    }

    return {
      results: [hydrated.result],
      selectedRoute: lookup.intent === 'body' ? 'lookup_body' : 'lookup_definition',
      symbolHit: true,
      declarationHit: hydrated.declarationHit,
      parserSource: hydrated.parserSource,
      parserProvenance: hydrated.parserProvenance,
      downgradeReason: hydrated.downgradeReason,
      fallbackReason: null,
      oversizedFileOutcome: null,
    };
  }

  private async hydrateDefinitionSearchResult(
    definition: Extract<SymbolDefinitionResult, { found: true }>,
    options?: { requireBody?: boolean }
  ): Promise<HydratedDefinitionSearchResult> {
    const normalizedPath = definition.file.replace(/\\/g, '/');

    try {
      const content = await this.getFile(normalizedPath);
      const { chunk: declarationChunk, parserProvenance } = this.findDeclarationChunkForSymbol(
        content,
        normalizedPath,
        definition.symbol,
        definition.line
      );
      if (declarationChunk && (!options?.requireBody || this.chunkContainsBody(declarationChunk))) {
        const hydrated = this.clampDeclarationChunk(declarationChunk);
        return {
          result: {
            path: normalizedPath,
            content: hydrated.content,
            lines: hydrated.lines,
            relevanceScore: 1,
            matchType: 'keyword',
            retrievedAt: new Date().toISOString(),
            chunkId: declarationChunk.chunkId,
          },
          declarationHit: true,
          parserSource: declarationChunk.parserSource ?? null,
          parserProvenance,
          downgradeReason: null,
        };
      }

      if (options?.requireBody) {
        return {
          result: null,
          declarationHit: false,
          parserSource: declarationChunk?.parserSource ?? null,
          parserProvenance,
          downgradeReason: null,
        };
      }
    } catch {
      // Fall back to the deterministic definition snippet below.
    }

    if (options?.requireBody) {
      return {
        result: null,
        declarationHit: false,
        parserSource: null,
        parserProvenance: [],
        downgradeReason: null,
      };
    }

    const lineCount = definition.snippet.split(/\r?\n/).length;
    const endLine = Math.max(definition.line, definition.line + lineCount - 1);
    return {
      result: {
        path: normalizedPath,
        content: definition.snippet,
        lines: `${definition.line}-${endLine}`,
        relevanceScore: 1,
        matchType: 'keyword',
        retrievedAt: new Date().toISOString(),
        chunkId: `${normalizedPath}#def-L${definition.line}`,
      },
      declarationHit: true,
      parserSource: null,
      parserProvenance: [],
      downgradeReason: 'definition_snippet',
    };
  }

  private findDeclarationChunkForSymbol(
    content: string,
    filePath: string,
    symbol: string,
    line: number
  ): { chunk: ChunkRecord | null; parserProvenance: string[] } {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const parsers = [
      featureEnabled('retrieval_tree_sitter_v1') ? createTreeSitterChunkParser() : null,
      createHeuristicChunkParser(),
    ].filter(Boolean) as Array<{ id: string; parse: (source: string, options: { path: string }) => ChunkRecord[] }>;
    const parserProvenance = parsers.map((parser) => parser.id);

    for (const parser of parsers) {
      const chunks = parser.parse(content, { path: normalizedPath });
      const declarationChunks = chunks.filter((chunk) => chunk.kind === 'declaration');
      const exactWithLine = declarationChunks.find((chunk) =>
        chunk.symbolName === symbol && line >= chunk.startLine && line <= chunk.endLine
      );
      if (exactWithLine) {
        return { chunk: exactWithLine, parserProvenance };
      }

      const exact = declarationChunks.find((chunk) => chunk.symbolName === symbol);
      if (exact) {
        return { chunk: exact, parserProvenance };
      }

      const lineMatch = declarationChunks.find((chunk) => line >= chunk.startLine && line <= chunk.endLine);
      if (lineMatch) {
        return { chunk: lineMatch, parserProvenance };
      }
    }

    return { chunk: null, parserProvenance };
  }

  private chunkContainsBody(chunk: ChunkRecord): boolean {
    const lines = chunk.content.split(/\r?\n/).map((line) => line.trim());
    const trimmed = chunk.content.trim();
    if (lines.length <= 1) {
      return /=>|=[^=]|\{.*\}/.test(trimmed);
    }

    return lines.slice(1).some((line) => line.length > 0 && !/^[)}\]};,]+$/.test(line));
  }

  private clampDeclarationChunk(chunk: ChunkRecord): { content: string; lines: string } {
    let snippetLines = chunk.content.split(/\r?\n/);
    let truncated = false;

    if (snippetLines.length > MAX_HYDRATED_DECLARATION_LINES) {
      snippetLines = snippetLines.slice(0, MAX_HYDRATED_DECLARATION_LINES);
      truncated = true;
    }

    let snippetContent = snippetLines.join('\n').trimEnd();
    while (snippetContent.length > MAX_HYDRATED_DECLARATION_CHARS && snippetLines.length > 1) {
      snippetLines = snippetLines.slice(0, -1);
      snippetContent = snippetLines.join('\n').trimEnd();
      truncated = true;
    }

    if (truncated) {
      snippetContent = `${snippetContent}\n... [truncated: declaration body exceeds limit]`;
    }

    const endLine = Math.max(chunk.startLine, chunk.startLine + snippetLines.length - 1);
    return {
      content: snippetContent,
      lines: `${chunk.startLine}-${endLine}`,
    };
  }

  /**
   * Deterministic call-graph navigation for known function/method symbols.
   * Returns callers (call-sites) and/or callees (identifiers invoked inside the body)
   * based on local heuristics. Callee extraction supports brace-language bodies (TS/JS/Java/Go/C#);
   * non-brace languages (e.g., Python) yield empty callee bodies in v1.
   */
  async callRelationships(
    symbol: string,
    options?: {
      direction?: CallRelationshipDirection;
      topK?: number;
      bypassCache?: boolean;
      includePaths?: string[];
      excludePaths?: string[];
      languageHint?: string;
    }
  ): Promise<CallRelationshipsResult> {
    const trimmedSymbol = symbol.trim();
    const direction: CallRelationshipDirection = options?.direction ?? 'both';
    const topK = Math.max(1, Math.min(100, Math.floor(options?.topK ?? 20)));

    const empty: CallRelationshipsResult = {
      symbol: trimmedSymbol,
      callers: [],
      callees: [],
      metadata: {
        symbol: trimmedSymbol,
        direction,
        totalCallers: 0,
        totalCallees: 0,
      },
    };
    this.setLastSymbolNavigationDiagnostics(null);

    if (!trimmedSymbol) {
      return empty;
    }

    const graphState = this.getGraphNavigationSnapshot();
    if (graphState.payload) {
      const graphScope = normalizePathScopeInput({
        includePaths: options?.includePaths,
        excludePaths: options?.excludePaths,
      });
      const fileCache = new Map<string, string>();
      let callers: CallRelationshipsCallerEntry[] = [];
      let callees: CallRelationshipsCalleeEntry[] = [];

      if (direction === 'callers' || direction === 'both') {
        callers = await this.computeGraphCallers(graphState.payload, trimmedSymbol, topK, graphScope, fileCache);
      }

      if (direction === 'callees' || direction === 'both') {
        callees = await this.computeGraphCallees(graphState.payload, trimmedSymbol, topK, graphScope, fileCache);
      }

      if (callers.length > 0 || callees.length > 0) {
        const metadata = this.buildSymbolNavigationDiagnostics('call_relationships', 'graph', graphState, null);
        this.setLastSymbolNavigationDiagnostics(metadata);
        return {
          symbol: trimmedSymbol,
          callers,
          callees,
          metadata: {
            symbol: trimmedSymbol,
            direction,
            totalCallers: callers.length,
            totalCallees: callees.length,
            resolutionBackend: metadata.backend,
            fallbackReason: metadata.fallback_reason,
            graphStatus: metadata.graph_status,
            graphDegradedReason: metadata.graph_degraded_reason,
          },
        };
      }
    }

    let callers: CallRelationshipsCallerEntry[] = [];
    let callees: CallRelationshipsCalleeEntry[] = [];

    if (direction === 'callers' || direction === 'both') {
      callers = await this.computeCallers(trimmedSymbol, topK, options);
    }

    if (direction === 'callees' || direction === 'both') {
      callees = await this.computeCallees(trimmedSymbol, topK, options);
    }

    const metadata = this.buildSymbolNavigationDiagnostics(
      'call_relationships',
      'heuristic_fallback',
      graphState,
      graphState.payload ? 'graph_call_edge_not_found' : graphState.fallbackReason
    );
    this.setLastSymbolNavigationDiagnostics(metadata);
    return {
      symbol: trimmedSymbol,
      callers,
      callees,
      metadata: {
        symbol: trimmedSymbol,
        direction,
        totalCallers: callers.length,
        totalCallees: callees.length,
        resolutionBackend: metadata.backend,
        fallbackReason: metadata.fallback_reason,
        graphStatus: metadata.graph_status,
        graphDegradedReason: metadata.graph_degraded_reason,
      },
    };
  }

  private async computeGraphCallers(
    payload: GraphPayloadFile,
    trimmedSymbol: string,
    topK: number,
    scope: NormalizedPathScope,
    fileCache: Map<string, string>
  ): Promise<CallRelationshipsCallerEntry[]> {
    const symbolIds = new Set(
      payload.symbols
        .filter((candidate) => candidate.name === trimmedSymbol)
        .map((candidate) => candidate.id)
    );
    const symbolById = new Map(payload.symbols.map((candidate) => [candidate.id, candidate] as const));
    const candidates = payload.call_edges
      .filter((edge) =>
        matchesNormalizedPathScope(edge.path, scope)
        && (edge.target_symbol_name === trimmedSymbol || (edge.target_symbol_id !== null && symbolIds.has(edge.target_symbol_id)))
      )
      .sort((left, right) =>
        right.confidence - left.confidence
        || this.scoreGraphPath(right.path) - this.scoreGraphPath(left.path)
        || left.path.localeCompare(right.path)
        || left.line - right.line
      )
      .slice(0, Math.max(1, Math.min(200, topK * 6)));

    const withSnippets = await Promise.all(candidates.map(async (edge) => {
      const snippet = await this.readSnippetFromFile(fileCache, edge.path, edge.line);
      const sourceSymbol = edge.source_symbol_id ? symbolById.get(edge.source_symbol_id) ?? null : null;
      const score = 70 + edge.confidence * 20 + this.scoreGraphPath(edge.path) + (sourceSymbol ? 10 : 0);
      return {
        file: this.normalizeGraphPath(edge.path),
        line: edge.line,
        snippet: snippet?.snippet ?? `${trimmedSymbol}(...)`,
        score: Math.round(score * 100) / 100,
        callerSymbol: sourceSymbol?.name,
        __score: score,
      };
    }));

    return withSnippets
      .sort((left, right) => right.__score - left.__score || left.file.localeCompare(right.file) || left.line - right.line)
      .slice(0, topK)
      .map(({ __score, ...entry }) => entry);
  }

  private async computeGraphCallees(
    payload: GraphPayloadFile,
    trimmedSymbol: string,
    topK: number,
    scope: NormalizedPathScope,
    fileCache: Map<string, string>
  ): Promise<CallRelationshipsCalleeEntry[]> {
    const sourceCandidates = payload.symbols
      .filter((candidate) => candidate.name === trimmedSymbol && matchesNormalizedPathScope(candidate.path, scope))
      .map((candidate) => ({
        symbol: candidate,
        definition: this.findDefinitionRecordForSymbol(payload, candidate.id),
      }))
      .filter((candidate) => candidate.definition)
      .sort((left, right) =>
        this.scoreGraphPath(right.symbol.path) - this.scoreGraphPath(left.symbol.path)
        || left.symbol.start_line - right.symbol.start_line
      );

    const source = sourceCandidates[0]?.symbol;
    if (!source) {
      return [];
    }

    const candidates = payload.call_edges
      .filter((edge) => edge.source_symbol_id === source.id && matchesNormalizedPathScope(edge.path, scope))
      .sort((left, right) =>
        right.confidence - left.confidence
        || left.line - right.line
        || left.target_symbol_name.localeCompare(right.target_symbol_name)
      )
      .slice(0, Math.max(1, Math.min(200, topK * 6)));

    const withSnippets = await Promise.all(candidates.map(async (edge) => {
      const snippet = await this.readSnippetFromFile(fileCache, edge.path, edge.line);
      const score = 50 + edge.confidence * 20;
      return {
        file: this.normalizeGraphPath(edge.path),
        line: edge.line,
        snippet: snippet?.snippet ?? `${edge.target_symbol_name}(...)`,
        score: Math.round(score * 100) / 100,
        calleeSymbol: edge.target_symbol_name,
        __score: score,
      };
    }));

    return withSnippets
      .sort((left, right) =>
        right.__score - left.__score
        || left.calleeSymbol.localeCompare(right.calleeSymbol)
        || left.line - right.line
      )
      .slice(0, topK)
      .map(({ __score, ...entry }) => entry);
  }

  private async computeCallers(
    trimmedSymbol: string,
    topK: number,
    options?: { bypassCache?: boolean; includePaths?: string[]; excludePaths?: string[] }
  ): Promise<CallRelationshipsCallerEntry[]> {
    const candidateLimit = Math.min(Math.max(topK * 12, 60), 200);
    const keywordCandidates = await this.localKeywordSearch(trimmedSymbol, candidateLimit, {
      bypassCache: options?.bypassCache,
      includePaths: options?.includePaths,
      excludePaths: options?.excludePaths,
    });
    if (keywordCandidates.length === 0) return [];

    const callSitePattern = buildCallSitePattern(trimmedSymbol);
    const seenPaths = new Set<string>();
    type CallerCandidate = CallRelationshipsCallerEntry & { __score: number };
    const out: CallerCandidate[] = [];

    for (const keywordCandidate of keywordCandidates) {
      const filePath = keywordCandidate.path;
      if (seenPaths.has(filePath)) continue;
      seenPaths.add(filePath);

      let content: string;
      try {
        content = await this.getFile(filePath);
      } catch {
        continue;
      }

      const lines = content.split(/\r?\n/);
      const normalizedPath = filePath.replace(/\\/g, '/');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (!callSitePattern.test(line)) continue;
        if (isDeclarationLikeSymbolLine(line, trimmedSymbol)) continue;

        const snippet = buildSymbolReferenceSnippet(content, index);
        const enclosing = findEnclosingDeclaration(lines, index - 1);

        let score = 0;
        if (normalizedPath.startsWith('src/')) score += 30;
        if (normalizedPath.startsWith('tests/') || normalizedPath.startsWith('test/')) score -= 10;
        if (/\/__tests__\//.test(normalizedPath)) score -= 5;
        if (normalizedPath.includes('node_modules/')) score -= 50;
        if (line.includes(trimmedSymbol)) score += 50;
        score -= Math.min(20, normalizedPath.length / 8);

        const entry: CallerCandidate = {
          file: normalizedPath,
          line: index + 1,
          snippet: snippet.snippet,
          score: Math.round(score * 100) / 100,
          __score: score,
        };
        if (enclosing) entry.callerSymbol = enclosing;
        out.push(entry);
      }
    }

    return out
      .sort((a, b) => b.__score - a.__score || a.file.localeCompare(b.file) || a.line - b.line)
      .slice(0, topK)
      .map(({ __score, ...entry }) => entry);
  }

  private async computeCallees(
    trimmedSymbol: string,
    topK: number,
    options?: { bypassCache?: boolean; includePaths?: string[]; excludePaths?: string[]; languageHint?: string }
  ): Promise<CallRelationshipsCalleeEntry[]> {
    const definition = await this.symbolDefinition(trimmedSymbol, {
      bypassCache: options?.bypassCache,
      includePaths: options?.includePaths,
      excludePaths: options?.excludePaths,
      languageHint: options?.languageHint,
    });
    if (!definition.found) return [];

    let content: string;
    try {
      content = await this.getFile(definition.file);
    } catch {
      return [];
    }
    const lines = content.split(/\r?\n/);
    const definitionLineIndex = Math.max(0, definition.line - 1);
    const body = extractFunctionBody(lines, definitionLineIndex);
    if (!body) return [];

    const identifiers = extractCalleeIdentifiers(body.bodyText, trimmedSymbol);
    if (identifiers.length === 0) return [];

    const normalizedPath = definition.file.replace(/\\/g, '/');
    const callees: Array<CallRelationshipsCalleeEntry & { __score: number }> = identifiers.map((info) => {
      const absoluteLineIndex = body.bodyStartLineIndex + info.lineOffset;
      const snippet = buildSymbolReferenceSnippet(content, absoluteLineIndex);
      const score = info.count * 10;
      return {
        file: normalizedPath,
        line: absoluteLineIndex + 1,
        snippet: snippet.snippet,
        score: Math.round(score * 100) / 100,
        calleeSymbol: info.identifier,
        __score: score,
      };
    });

    return callees
      .sort(
        (a, b) =>
          b.__score - a.__score ||
          a.calleeSymbol.localeCompare(b.calleeSymbol) ||
          a.line - b.line
      )
      .slice(0, topK)
      .map(({ __score, ...entry }) => entry);
  }

  private getConfiguredShadowCompareState(): { enabled: boolean; sampleRate: number } {
    return getConfiguredShadowCompareState();
  }

  private maybeRunRetrievalShadowCompare(query: string, topK: number, primaryResults: SearchResult[]): void {
    const shadowCompare = this.getConfiguredShadowCompareState();
    if (!shouldRunShadowCompare({
      shadowCompareEnabled: shadowCompare.enabled,
      shadowSampleRate: shadowCompare.sampleRate,
    })) {
      return;
    }

    setImmediate(() => {
      void this.runRetrievalShadowCompare(query, topK, primaryResults, shadowCompare.sampleRate);
    });
  }

  private buildContextRoutingShadowCompareReceipt(
    primaryRoute: ContextRoutingDiagnostics['selectedRoute'],
    primaryResults: SearchResult[],
    shadowResults: SearchResult[],
    sampleRate: number
  ): ContextRoutingShadowCompareReceipt {
    const primaryPaths = new Set(primaryResults.map((result) => result.path));
    const shadowPaths = new Set(shadowResults.map((result) => result.path));
    let overlapCount = 0;
    for (const candidate of primaryPaths) {
      if (shadowPaths.has(candidate)) {
        overlapCount += 1;
      }
    }

    const top1Overlap = primaryResults.length > 0
      && shadowResults.length > 0
      && primaryResults[0]!.path === shadowResults[0]!.path;

    return {
      enabled: true,
      executed: true,
      sampleRate,
      primaryRoute,
      shadowRoute: 'semantic_discovery',
      primaryResultCount: primaryResults.length,
      shadowResultCount: shadowResults.length,
      overlapCount,
      top1Overlap,
      misrouteDetected: primaryResults.length > 0 && shadowResults.length > 0 && !top1Overlap,
    };
  }

  private async maybeBuildLookupRoutingShadowCompareReceipt(
    query: string,
    topK: number,
    primaryRoute: ContextRoutingDiagnostics['selectedRoute'],
    primaryResults: SearchResult[],
    normalizedScope: NormalizedPathScope | undefined,
    bypassCache: boolean,
    priority: ContextOptions['priority']
  ): Promise<ContextRoutingShadowCompareReceipt | undefined> {
    const shadowCompare = this.getConfiguredShadowCompareState();
    if (!shadowCompare.enabled) {
      return undefined;
    }

    if (!shouldRunShadowCompare({
      shadowCompareEnabled: shadowCompare.enabled,
      shadowSampleRate: shadowCompare.sampleRate,
    })) {
      return {
        enabled: true,
        executed: false,
        sampleRate: shadowCompare.sampleRate,
        primaryRoute,
        shadowRoute: 'semantic_discovery',
        primaryResultCount: primaryResults.length,
        shadowResultCount: 0,
        overlapCount: 0,
        top1Overlap: false,
        misrouteDetected: false,
      };
    }

    const semanticSearch = (q: string, k: number) =>
      bypassCache
        ? this.semanticSearch(q, k, { bypassCache: true, priority, ...normalizedScope })
        : this.semanticSearch(q, k, { priority, ...normalizedScope });

    const previousDiagnostics = this.getLastSearchDiagnostics();
    try {
      const shadowResults = await semanticSearch(query, topK);
      return this.buildContextRoutingShadowCompareReceipt(
        primaryRoute,
        primaryResults,
        shadowResults,
        shadowCompare.sampleRate
      );
    } catch {
      return {
        enabled: true,
        executed: false,
        sampleRate: shadowCompare.sampleRate,
        primaryRoute,
        shadowRoute: 'semantic_discovery',
        primaryResultCount: primaryResults.length,
        shadowResultCount: 0,
        overlapCount: 0,
        top1Overlap: false,
        misrouteDetected: false,
      };
    } finally {
      this.setLastSearchDiagnostics(previousDiagnostics);
    }
  }

  private async runRetrievalShadowCompare(
    query: string,
    topK: number,
    primaryResults: SearchResult[],
    sampleRate: number
  ): Promise<void> {
    const previousDiagnostics = this.getLastSearchDiagnostics();
    try {
      const shadowResults = await this.keywordFallbackSearch(query, topK);
      const primaryPaths = new Set(primaryResults.map((result) => result.path));
      const shadowPaths = new Set(shadowResults.map((result) => result.path));
      let overlap = 0;
      for (const candidate of primaryPaths) {
        if (shadowPaths.has(candidate)) {
          overlap += 1;
        }
      }

      const queryHash = crypto.createHash('sha1').update(query).digest('hex').slice(0, 10);
      console.error(
        formatScopedLog(
          `[retrieval_shadow_compare] provider=${this.getActiveRetrievalProviderId()} sample_rate=${sampleRate.toFixed(2)} ` +
          `query_hash=${queryHash} primary=${primaryResults.length} shadow=${shadowResults.length} overlap=${overlap}`
        )
      );
    } catch {
      // Shadow compare is best-effort only and must not affect primary retrieval.
    } finally {
      this.setLastSearchDiagnostics(previousDiagnostics);
    }
  }

  /**
   * Perform AI-powered search + ask using the active provider.
   *
   * @param searchQuery - Semantic query to guide provider context.
   * @param prompt - Optional prompt to send to the provider.
   * @returns Provider response text.
   * @throws Error if provider invocation fails or authentication is invalid.
   */
  async searchAndAsk(
    searchQuery: string,
    prompt?: string,
    options?: { timeoutMs?: number; priority?: SearchAndAskPriority; signal?: AbortSignal }
  ): Promise<string> {
    return this.runtimeAccess.searchAndAsk({
      searchQuery,
      prompt,
      timeoutMs: options?.timeoutMs,
      priority: options?.priority,
      signal: options?.signal,
      searchQueues: this.searchQueues,
    });
  }

  /**
   * Fallback retrieval path when semantic formatting changes and no structured snippets can be parsed.
   * This performs a bounded keyword scan across indexable files to preserve tool usability.
   */
  private async keywordFallbackSearch(
    query: string,
    topK: number,
    options?: { bypassCache?: boolean; includePaths?: string[]; excludePaths?: string[] }
  ): Promise<SearchResult[]> {
    const bypassCache = options?.bypassCache === true;
    const normalizedScope = this.normalizePathScopeOptions(options);
    const cacheKey = this.getKeywordFallbackSearchCacheKey(query, topK, normalizedScope);
    if (!bypassCache) {
      const cached = this.getCachedKeywordFallbackSearch(cacheKey);
      if (cached) {
        this.cacheHits++;
        return cached;
      }

      const inFlightRequest = this.keywordFallbackSearchInFlight.get(cacheKey);
      if (inFlightRequest && inFlightRequest.generation === this.keywordFallbackSearchCacheGeneration) {
        inFlightRequest.shouldCache = inFlightRequest.shouldCache || !bypassCache;
        this.cacheHits++;
        return inFlightRequest.promise;
      }
    }

    const rawQuery = query.trim();
    const includeArtifacts = /\binclude:artifacts\b/i.test(rawQuery);
    const includeDocs = /\binclude:docs\b/i.test(rawQuery);
    const includeJson = /\binclude:json\b/i.test(rawQuery);
    const cleanedQuery = rawQuery.replace(/\binclude:(artifacts|docs|json)\b/gi, ' ').trim();
    const normalizedQuery = cleanedQuery.toLowerCase();
    if (!normalizedQuery) return [];

    const stopwords = new Set(['and', 'the', 'for', 'with', 'from', 'that', 'this', 'where']);
    const queryTokens = Array.from(
      new Set(
        normalizedQuery
          .split(/[^a-z0-9_./-]+/i)
          .map((token) => token.trim())
          .filter((token) => token.length >= 3 && !stopwords.has(token))
      )
    );
    if (queryTokens.length === 0) return [];

    const symbolTokens = Array.from(
      new Set(
        cleanedQuery
          .split(/[^A-Za-z0-9_./-]+/g)
          .map((token) => token.trim())
          .filter((token) => token.length >= 3 && (/[A-Z_]/.test(token) || token.length >= 12))
          .map((token) => token.toLowerCase())
      )
    );

    const identifierLikeToken = cleanedQuery
      .split(/[^A-Za-z0-9_./-]+/g)
      .map((token) => token.trim())
      .filter(Boolean)
      .some((token) => /[A-Z_]/.test(token) || token.length >= 12);
    const codeIntent = /\b(function|class|interface|test|factory|provider|handler|module|api|implementation|code|file)\b/i.test(cleanedQuery)
      || identifierLikeToken;
    const opsEvidenceIntent = /\b(benchmark|report|receipt|metrics?|snapshot|artifact|baseline|json)\b/i.test(cleanedQuery);
    const pureCodeIntent = codeIntent && !opsEvidenceIntent;
    const shouldBlendChunkSearch = identifierLikeToken && this.isChunkAwareExactSearchEnabled();
    const rerankKeywordFallbackResults = (results: SearchResult[]): SearchResult[] => {
      if (results.length <= 1) {
        return results;
      }
      return scoreLexicalCandidates(results, {
        query: cleanedQuery,
        queryVariant: cleanedQuery,
        variantIndex: 0,
        variantWeight: 1,
      })
        .map((result) => ({
          path: result.path,
          content: result.content,
          score: result.score,
          lines: result.lines,
          relevanceScore: result.relevanceScore,
          matchType: result.matchType,
          retrievedAt: result.retrievedAt,
          chunkId: result.chunkId,
        }))
        .slice(0, topK);
    };
    const mergeKeywordFallbackResults = (
      primary: SearchResult[],
      secondary: SearchResult[]
    ): SearchResult[] => {
      const merged = new Map<string, SearchResult>();
      for (const result of [...primary, ...secondary]) {
        const key = `${result.path}::${result.chunkId ?? ''}::${result.lines ?? ''}`;
        if (!merged.has(key)) {
          merged.set(key, result);
        }
      }
      return rerankKeywordFallbackResults(Array.from(merged.values()));
    };
    const runChunkSearch = async (): Promise<SearchResult[]> => {
      const chunkSearchEngine = this.getChunkSearchEngine();
      if (!chunkSearchEngine) {
        return [];
      }
      const chunkResults = await chunkSearchEngine.search(rawQuery, topK, {
        bypassCache,
        workspacePath: this.workspacePath,
        includeArtifacts,
        includeDocs,
        includeJson,
        queryTokens,
        symbolTokens,
        codeIntent,
        opsEvidenceIntent,
        normalizedQuery,
      });
      return this.filterSearchResultsByScope(chunkResults, normalizedScope);
    };

    if (this.isLexicalSqliteSearchEnabled()) {
      const lexicalSearchEngine = this.getLexicalSqliteSearchEngine();
      if (lexicalSearchEngine) {
        try {
          const indexStatePath = path.join(this.workspacePath, '.context-engine-index-state.json');
          const sqliteIndexPath = path.join(this.workspacePath, '.context-engine-lexical-index.sqlite');
          const lexicalResults = await lexicalSearchEngine.search(rawQuery, topK, {
            bypassCache,
            workspacePath: this.workspacePath,
            indexStatePath,
            sqliteIndexPath,
            includeArtifacts,
            includeDocs,
            includeJson,
            queryTokens,
            symbolTokens,
            codeIntent,
            opsEvidenceIntent,
            normalizedQuery,
          });
          const scopedLexicalResults = this.filterSearchResultsByScope(lexicalResults, normalizedScope);
          if (scopedLexicalResults.length > 0) {
            if (shouldBlendChunkSearch) {
              let scopedChunkResults: SearchResult[] = [];
              try {
                scopedChunkResults = await runChunkSearch();
              } catch (error) {
                if (process.env.CE_DEBUG_SEARCH === 'true') {
                  console.error('[chunkSearch] Helper search failed during lexical blend, keeping SQLite results:', error);
                }
              }
              if (scopedChunkResults.length > 0) {
                const mergedResults = mergeKeywordFallbackResults(scopedChunkResults, scopedLexicalResults);
                this.setLastSearchDiagnostics({
                  filters_applied: normalizedScope ? ['scope:lexical', 'scope:chunk'] : [],
                  filtered_paths_count: Math.max(
                    0,
                    lexicalResults.length + scopedChunkResults.length - mergedResults.length
                  ),
                  second_pass_used: false,
                });
                return mergedResults;
              }
            }
            this.setLastSearchDiagnostics({
              filters_applied: normalizedScope ? ['scope:lexical'] : [],
              filtered_paths_count: Math.max(0, lexicalResults.length - scopedLexicalResults.length),
              second_pass_used: false,
            });
            return shouldBlendChunkSearch ? rerankKeywordFallbackResults(scopedLexicalResults) : scopedLexicalResults;
          }
        } catch (error) {
          if (process.env.CE_DEBUG_SEARCH === 'true') {
            console.error('[lexicalSearch] SQLite helper search failed, falling back to chunk/file scan:', error);
          }
        }
      }
    }

    if (this.isChunkAwareExactSearchEnabled()) {
      try {
        const scopedChunkResults = await runChunkSearch();
        if (scopedChunkResults.length > 0) {
          this.setLastSearchDiagnostics({
            filters_applied: normalizedScope ? ['scope:chunk'] : [],
            filtered_paths_count: 0,
            second_pass_used: false,
          });
          return shouldBlendChunkSearch ? rerankKeywordFallbackResults(scopedChunkResults) : scopedChunkResults;
        }
      } catch (error) {
        if (process.env.CE_DEBUG_SEARCH === 'true') {
          console.error('[chunkSearch] Helper search failed, falling back to file scan:', error);
        }
      }
    }

    const computeKeywordFallbackSearch = async (): Promise<SearchResult[]> => {
      const allFiles = await this.getCachedFallbackFiles(options);
      const files = this.filterPathsByScope(allFiles, normalizedScope);
      if (files.length === 0) return [];
      const filtersApplied: string[] = [];
      const scopeFilteredPathsCount = Math.max(0, allFiles.length - files.length);
      if (normalizedScope?.includePaths?.length) filtersApplied.push('scope:include_paths');
      if (normalizedScope?.excludePaths?.length) filtersApplied.push('scope:exclude_paths');
      if (pureCodeIntent && !includeArtifacts) filtersApplied.push('exclude:artifacts');
      if (codeIntent && !includeDocs) filtersApplied.push('deprioritize:docs');
      if (codeIntent && !includeJson) filtersApplied.push('deprioritize:json');

      const runPass = async (allowHardExclusions: boolean): Promise<{
        rankedResults: Array<SearchResult & { __score: number }>;
        filteredPathsCount: number;
      }> => {
        let filteredPathsCount = 0;
        const ranked = files
          .map((filePath) => {
            const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
            if (allowHardExclusions && pureCodeIntent && !includeArtifacts && normalizedPath.startsWith('artifacts/')) {
              filteredPathsCount += 1;
              return null;
            }

            const lowerPath = filePath.toLowerCase();
            let score = 0;
            if (lowerPath.includes(normalizedQuery)) score += 8;
            for (const token of queryTokens) {
              if (lowerPath.includes(token)) score += 2;
            }
            if (codeIntent) {
              if (normalizedPath.startsWith('src/') || normalizedPath.startsWith('test/') || normalizedPath.startsWith('tests/')) {
                score += 8;
              }
              if (/\/__tests__\//.test(normalizedPath)) {
                score += 4;
              }
              if (!includeDocs && /^(docs|benchmark|bench|tmp|coverage|dist|build)\//.test(normalizedPath)) {
                score -= 8;
              }
              if (!includeJson && normalizedPath.endsWith('.json')) {
                score -= 5;
              } else if (!includeDocs && normalizedPath.endsWith('.md')) {
                score -= 3;
              }
            }
            return { filePath, score };
          })
          .filter((candidate): candidate is { filePath: string; score: number } => candidate !== null)
          .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));

        const scanLimit = Math.min(
          Math.max(topK * 30, 120),
          ranked.length
        );
        const candidates = ranked.slice(0, scanLimit);
        const retrievedAt = new Date().toISOString();
        const scoredResults: Array<SearchResult & { __score: number }> = [];

        const scoreCandidate = async (
          candidate: { filePath: string; score: number }
        ): Promise<(SearchResult & { __score: number }) | null> => {
          try {
            const content = await this.getFile(candidate.filePath);
            const lowerContent = content.toLowerCase();
            let matchIndex = lowerContent.indexOf(normalizedQuery);
            if (matchIndex === -1) {
              for (const token of queryTokens) {
                const idx = lowerContent.indexOf(token);
                if (idx !== -1) {
                  matchIndex = idx;
                  break;
                }
              }
            }
            if (matchIndex === -1) return null;

            const snippetStart = Math.max(0, matchIndex - 200);
            const snippetEnd = Math.min(content.length, matchIndex + 400);
            const snippet = content.substring(snippetStart, snippetEnd).trim();
            if (!snippet) return null;

            const normalizedPath = candidate.filePath.replace(/\\/g, '/').toLowerCase();
            let finalScore = candidate.score;
            const hasFactoryIntent = queryTokens.includes('factory');
            const hasProviderIntent = queryTokens.includes('provider');
            const hasTestIntent = queryTokens.includes('test') || queryTokens.includes('tests');
            if (lowerContent.includes(normalizedQuery)) {
              finalScore += 16;
            }
            for (const token of queryTokens) {
              if (lowerContent.includes(token)) {
                finalScore += 2;
              }
            }
            let symbolHitCount = 0;
            for (const symbol of symbolTokens) {
              if (lowerContent.includes(symbol)) {
                finalScore += 28;
                symbolHitCount += 1;
              }
              if (normalizedPath.includes(symbol)) {
                finalScore += 16;
              }
            }
            if (codeIntent) {
              if (symbolHitCount > 0) {
                finalScore += 70 * symbolHitCount;
              }
              if (/\/ai\/providers\//.test(normalizedPath)) {
                finalScore += 14;
              }
              if (/\/factory\.(ts|tsx|js|jsx)$/.test(normalizedPath)) {
                finalScore += hasFactoryIntent ? 70 : 30;
              }
              if (/\/factory\.test\.(ts|tsx|js|jsx)$/.test(normalizedPath)) {
                finalScore += hasFactoryIntent ? 65 : 25;
                if (hasTestIntent) {
                  finalScore += 30;
                }
              }
              if (hasProviderIntent && /\/providers\//.test(normalizedPath)) {
                finalScore += 18;
              }
            }

            const startLine = content.slice(0, snippetStart).split('\n').length;
            const endLine = startLine + Math.max(0, snippet.split('\n').length - 1);

            return {
              path: candidate.filePath.replace(/\\/g, '/'),
              content: snippet,
              lines: `${startLine}-${Math.max(startLine, endLine)}`,
              relevanceScore: undefined,
              matchType: 'keyword',
              retrievedAt,
              __score: finalScore,
            };
          } catch {
            // Skip files that cannot be read in fallback mode.
            return null;
          }
        };

        const concurrency = Math.max(1, Math.min(FALLBACK_SEARCH_READ_CONCURRENCY, candidates.length));
        for (let index = 0; index < candidates.length; index += concurrency) {
          const batch = candidates.slice(index, index + concurrency);
          const batchResults = await Promise.all(batch.map((candidate) => scoreCandidate(candidate)));
          for (const result of batchResults) {
            if (result) {
              scoredResults.push(result);
            }
          }
        }
        return {
          rankedResults: scoredResults
            .sort((a, b) => b.__score - a.__score || a.path.localeCompare(b.path))
            .slice(0, topK),
          filteredPathsCount,
        };
      };

      const firstPass = await runPass(true);
      let rankedResults = firstPass.rankedResults;
      let secondPassUsed = false;
      let filteredPathsCount = firstPass.filteredPathsCount + scopeFilteredPathsCount;

      if (rankedResults.length === 0 && firstPass.filteredPathsCount > 0) {
        secondPassUsed = true;
        const secondPass = await runPass(false);
        rankedResults = secondPass.rankedResults;
        filteredPathsCount += secondPass.filteredPathsCount;
      }

      this.setLastSearchDiagnostics({
        filters_applied: filtersApplied,
        filtered_paths_count: filteredPathsCount,
        second_pass_used: secondPassUsed,
      });

      if (rankedResults.length === 0) {
        return [];
      }

      const maxScore = Math.max(...rankedResults.map((item) => item.__score));
      const minScore = Math.min(...rankedResults.map((item) => item.__score));
      const scoreRange = Math.max(1, maxScore - minScore);

      return rankedResults.map(({ __score, ...result }) => ({
        ...result,
        relevanceScore: Math.max(0, Math.min(1, 0.4 + (0.6 * (__score - minScore)) / scoreRange)),
      }));
    };

    const currentGeneration = this.keywordFallbackSearchCacheGeneration;
    const sharedRequest: KeywordFallbackSearchInFlightRequest = {
      generation: currentGeneration,
      shouldCache: !bypassCache,
      promise: Promise.resolve().then(async () => {
        const rankedResults = await computeKeywordFallbackSearch();
        if (sharedRequest.generation === this.keywordFallbackSearchCacheGeneration && sharedRequest.shouldCache) {
          this.setCachedKeywordFallbackSearch(cacheKey, rankedResults);
        }
        return rankedResults;
      }),
    };
    if (!bypassCache) {
      this.keywordFallbackSearchInFlight.set(cacheKey, sharedRequest);
    }

    try {
      return await sharedRequest.promise;
    } finally {
      if (this.keywordFallbackSearchInFlight.get(cacheKey) === sharedRequest) {
        this.keywordFallbackSearchInFlight.delete(cacheKey);
      }
    }
  }

  private parseFormattedResults(formattedResults: string, topK: number): SearchResult[] {
    return parseFormattedSemanticResults(formattedResults, topK);
  }

  // ==========================================================================
  // File Operations with Security
  // ==========================================================================

  /**
   * Validate file path to prevent path traversal attacks
   */
  private validateFilePath(filePath: string): string {
    // Normalize the path
    const normalized = path.normalize(filePath);

    // Reject absolute paths (must be relative to workspace)
    if (path.isAbsolute(normalized)) {
      throw new Error(`Invalid path: absolute paths not allowed. Use paths relative to workspace.`);
    }

    // Reject path traversal attempts
    if (normalized.startsWith('..') || normalized.includes(`..${path.sep}`)) {
      throw new Error(`Invalid path: path traversal not allowed.`);
    }

    // Build full path safely
    const fullPath = path.resolve(this.workspacePath, normalized);

    // Ensure the resolved path is still within workspace
    if (!fullPath.startsWith(path.resolve(this.workspacePath))) {
      throw new Error(`Invalid path: path must be within workspace.`);
    }

    return fullPath;
  }

  /**
   * Get file contents with security checks
   */
  async getFile(filePath: string): Promise<string> {
    const fullPath = this.validateFilePath(filePath);

    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Check file size
    const stats = fs.statSync(fullPath);
    if (stats.size > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${filePath} (${(stats.size / 1024 / 1024).toFixed(2)}MB > ${MAX_FILE_SIZE / 1024 / 1024}MB limit)`);
    }

    return fs.readFileSync(fullPath, 'utf-8');
  }

  // ==========================================================================
  // Token Estimation Utilities
  // ==========================================================================

  /**
   * Estimate token count for a string (conservative estimate)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  /**
   * Detect the type of code in a snippet
   */
  private detectCodeType(content: string): string {
    const trimmed = content.trim();

    // Common patterns
    if (/^(export\s+)?(async\s+)?function\s+\w+/.test(trimmed)) return 'function';
    if (/^(export\s+)?(abstract\s+)?class\s+\w+/.test(trimmed)) return 'class';
    if (/^(export\s+)?interface\s+\w+/.test(trimmed)) return 'interface';
    if (/^(export\s+)?type\s+\w+/.test(trimmed)) return 'type';
    if (/^(export\s+)?const\s+\w+/.test(trimmed)) return 'constant';
    if (/^import\s+/.test(trimmed)) return 'import';
    if (/^(export\s+)?enum\s+\w+/.test(trimmed)) return 'enum';
    if (/^\s*\/\*\*/.test(trimmed)) return 'documentation';
    if (/^(describe|it|test)\s*\(/.test(trimmed)) return 'test';

    return 'code';
  }

  /**
   * Generate a summary for a file based on its path and content patterns
   */
  private generateFileSummary(filePath: string, snippets: SnippetInfo[]): string {
    const ext = path.extname(filePath);
    const basename = path.basename(filePath, ext);
    const dirname = path.dirname(filePath);

    // Analyze code types in snippets
    const codeTypes = snippets.map(s => s.codeType).filter(Boolean);
    const uniqueTypes = [...new Set(codeTypes)];

    // Generate contextual summary
    let summary = '';

    // Infer purpose from path
    if (dirname.includes('test') || basename.includes('.test') || basename.includes('.spec')) {
      summary = `Test file for ${basename.replace(/\.(test|spec)$/, '')}`;
    } else if (dirname.includes('types') || basename.includes('types')) {
      summary = 'Type definitions';
    } else if (dirname.includes('utils') || basename.includes('util')) {
      summary = 'Utility functions';
    } else if (dirname.includes('components')) {
      summary = `UI component: ${basename}`;
    } else if (dirname.includes('hooks')) {
      summary = `React hook: ${basename}`;
    } else if (dirname.includes('api') || dirname.includes('routes')) {
      summary = `API endpoint: ${basename}`;
    } else if (basename === 'index') {
      summary = `Entry point for ${dirname}`;
    } else {
      summary = `${basename} module`;
    }

    // Add code type info
    if (uniqueTypes.length > 0) {
      summary += ` (contains: ${uniqueTypes.slice(0, 3).join(', ')})`;
    }

    return summary;
  }

  // ==========================================================================
  // Enhanced Prompt Context Engine
  // ==========================================================================

  /**
   * Find related files based on imports and references
   */
  private async findRelatedFiles(filePath: string, existingPaths: Set<string>): Promise<string[]> {
    try {
      const content = await this.getFile(filePath);
      const relatedFiles: string[] = [];

      // Extract imports (TypeScript/JavaScript)
      const importRegex = /(?:import|from)\s+['"]([^'"]+)['"]/g;
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        const importPath = match[1];
        // Skip node_modules imports
        if (!importPath.startsWith('.')) continue;

        // Resolve the import path
        const dir = path.dirname(filePath);
        let resolvedPath = path.join(dir, importPath);

        // Try common extensions
        const extensions = ['.ts', '.tsx', '.js', '.jsx', ''];
        for (const ext of extensions) {
          const testPath = resolvedPath + ext;
          if (!existingPaths.has(testPath)) {
            try {
              await this.getFile(testPath);
              relatedFiles.push(testPath);
              break;
            } catch {
              // File doesn't exist with this extension
            }
          }
        }
      }

      return relatedFiles.slice(0, 3); // Limit related files
    } catch {
      return [];
    }
  }

  /**
   * Smart snippet extraction - get the most relevant parts of content
   */
  private extractSmartSnippet(content: string, maxTokens: number): string {
    const lines = content.split('\n');

    // If content fits, return as-is
    if (this.estimateTokens(content) <= maxTokens) {
      return content;
    }

    // Priority: function/class definitions, then imports, then other
    const priorityLines: { line: string; index: number; priority: number }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let priority = 0;

      // High priority: function/class definitions
      if (/^(export\s+)?(async\s+)?function\s+\w+/.test(line.trim())) priority = 10;
      else if (/^(export\s+)?(abstract\s+)?class\s+\w+/.test(line.trim())) priority = 10;
      else if (/^(export\s+)?interface\s+\w+/.test(line.trim())) priority = 9;
      else if (/^(export\s+)?type\s+\w+/.test(line.trim())) priority = 8;
      // Medium priority: exports and constants
      else if (/^export\s+(const|let|var)\s+/.test(line.trim())) priority = 7;
      // Lower priority: imports (useful for context)
      else if (/^import\s+/.test(line.trim())) priority = 5;
      // Documentation comments
      else if (/^\s*\/\*\*/.test(line) || /^\s*\*/.test(line)) priority = 4;
      // Regular code
      else if (line.trim().length > 0) priority = 1;

      priorityLines.push({ line, index: i, priority });
    }

    // Sort by priority (descending) then by original order
    priorityLines.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.index - b.index;
    });

    // Build snippet within token budget
    const selectedLines: { line: string; index: number }[] = [];
    let tokenCount = 0;

    for (const { line, index, priority } of priorityLines) {
      const lineTokens = this.estimateTokens(line + '\n');
      if (tokenCount + lineTokens > maxTokens) break;
      selectedLines.push({ line, index });
      tokenCount += lineTokens;
    }

    // Sort by original order and join
    selectedLines.sort((a, b) => a.index - b.index);

    // Add ellipsis indicators for gaps
    let result = '';
    let lastIndex = -1;
    for (const { line, index } of selectedLines) {
      if (lastIndex !== -1 && index > lastIndex + 1) {
        result += '\n// ... (lines omitted) ...\n';
      }
      result += line + '\n';
      lastIndex = index;
    }

    return result.trim();
  }

  private parseMetadataListField(rawValue?: string): string[] | undefined {
    if (!rawValue) return undefined;
    const entries = rawValue
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return entries.length > 0 ? entries : undefined;
  }

  private parseMemoryEntry(result: SearchResult): MemoryEntry {
    const lines = result.content.split('\n');
    const metadata = new Map<string, string>();
    let title: string | undefined;

    for (const line of lines) {
      const headingMatch = /^###\s+\[[^\]]+\]\s+(.+)$/.exec(line.trim());
      if (headingMatch) {
        title = headingMatch[1].trim();
      }
      const metadataMatch = /^-\s+\[meta\]\s+([a-z_]+)\s*:\s*(.+)$/.exec(line.trim());
      if (metadataMatch) {
        metadata.set(metadataMatch[1], metadataMatch[2].trim());
      }
    }

    const fileName = path.basename(result.path, '.md');
    return {
      category: fileName,
      content: result.content,
      relevanceScore: result.relevanceScore || 0.5,
      title,
      subtype: metadata.get('subtype'),
      priority: metadata.get('priority') as MemoryPriority | undefined,
      tags: this.parseMetadataListField(metadata.get('tags')),
      source: metadata.get('source'),
      linkedFiles: this.parseMetadataListField(metadata.get('linked_files')),
      linkedPlans: this.parseMetadataListField(metadata.get('linked_plans')),
      evidence: metadata.get('evidence'),
      owner: metadata.get('owner'),
      createdAt: metadata.get('created_at'),
      updatedAt: metadata.get('updated_at'),
    };
  }

  private calculateMemoryRankScore(memory: MemoryEntry): number {
    const base = memory.relevanceScore || 0.5;
    let score = base;

    if (memory.priority === 'critical') score += 0.12;
    else if (memory.priority === 'helpful') score += 0.06;
    else if (memory.priority === 'archive') score -= 0.04;

    if (memory.category === 'decisions') score += 0.06;
    if (memory.category === 'preferences') score += 0.03;

    if (memory.subtype === 'review_finding' || memory.subtype === 'failed_attempt') {
      score += 0.04;
    } else if (memory.subtype === 'incident' || memory.subtype === 'plan_note') {
      score += 0.02;
    }

    const updatedAt = memory.updatedAt || memory.createdAt;
    if (updatedAt) {
      const ageDays = Math.floor((Date.now() - Date.parse(updatedAt)) / (1000 * 60 * 60 * 24));
      if (!Number.isNaN(ageDays) && ageDays >= 0) {
        if (ageDays <= 14) score += 0.08;
        else if (ageDays <= 60) score += 0.04;
        else if (ageDays <= 180) score += 0.02;
      }
    }

    return Math.min(1, Math.max(0, score));
  }

  private buildStartupMemoryPack(memories: MemoryEntry[], limit: number): MemoryEntry[] {
    const startupCandidates = memories
      .filter((memory) => memory.priority === 'critical' || memory.category === 'decisions' || memory.category === 'preferences')
      .sort((a, b) => (b.rankScore || 0) - (a.rankScore || 0))
      .slice(0, limit)
      .map((memory) => ({ ...memory, startupPack: true }));
    return startupCandidates;
  }

  /**
   * Retrieve relevant memories from .memories/ directory
   * Memories are searched semantically alongside code context
   */
  private async getRelevantMemories(query: string, maxMemories: number = 5): Promise<MemoryRetrievalResult> {
    const memoriesPath = path.join(this.workspacePath, MEMORIES_DIR);

    // Check if memories directory exists
    if (!fs.existsSync(memoriesPath)) {
      return { selected: [], candidateCount: 0, startupPackCount: 0 };
    }

    const memories: MemoryEntry[] = [];

    // Search for memories in the indexed content
    try {
      const searchResults = await this.semanticSearch(query, maxMemories * 3);

      // Filter to only memory files
      const memoryResults = searchResults.filter(r =>
        r.path.startsWith(MEMORIES_DIR + '/') || r.path.startsWith(MEMORIES_DIR + '\\')
      );

      // Extract metadata and build memory entries
      for (const result of memoryResults) {
        const memory = this.parseMemoryEntry(result);
        memory.rankScore = this.calculateMemoryRankScore(memory);
        memories.push(memory);
      }

      const uniqueMemories = new Map<string, MemoryEntry>();
      for (const memory of memories) {
        const key = `${memory.category}:${memory.title || ''}:${memory.content.slice(0, 160)}`;
        if (!uniqueMemories.has(key)) {
          uniqueMemories.set(key, memory);
        }
      }

      const ranked = Array.from(uniqueMemories.values())
        .sort((a, b) => (b.rankScore || 0) - (a.rankScore || 0));
      const startupPack = this.buildStartupMemoryPack(ranked, Math.min(2, maxMemories));
      const selected: MemoryEntry[] = [];
      const selectedKeys = new Set<string>();
      for (const startupMemory of startupPack) {
        const key = `${startupMemory.category}:${startupMemory.title || ''}:${startupMemory.content.slice(0, 160)}`;
        selectedKeys.add(key);
        selected.push(startupMemory);
      }
      for (const memory of ranked) {
        if (selected.length >= maxMemories) break;
        const key = `${memory.category}:${memory.title || ''}:${memory.content.slice(0, 160)}`;
        if (selectedKeys.has(key)) continue;
        selected.push(memory);
      }

      return {
        selected,
        candidateCount: ranked.length,
        startupPackCount: startupPack.length,
      };
    } catch (error) {
      console.error('[getRelevantMemories] Error searching memories:', error);
    }

    return { selected: [], candidateCount: 0, startupPackCount: 0 };
  }

  private getRelevantDraftMemories(sessionId: string, maxMemories: number = 3): MemoryRetrievalResult {
    if (!featureEnabled('memory_draft_retrieval_v1')) {
      return { selected: [], candidateCount: 0, startupPackCount: 0 };
    }

    const store = new MemorySuggestionStore(this.workspacePath);
    const ranked = store
      .listDrafts(sessionId)
      .filter((draft) => draft.state === 'drafted' || draft.state === 'batched' || draft.state === 'reviewed' || draft.state === 'snoozed')
      .map((draft) => {
        const memory: MemoryEntry = {
          category: draft.category,
          content: draft.content,
          relevanceScore: draft.confidence,
          ...(draft.title ? { title: draft.title } : {}),
          ...(draft.metadata.subtype ? { subtype: draft.metadata.subtype } : {}),
          ...(draft.metadata.priority ? { priority: draft.metadata.priority } : {}),
          ...(draft.metadata.tags ? { tags: draft.metadata.tags } : {}),
          ...(draft.metadata.source ? { source: draft.metadata.source } : {}),
          ...(draft.metadata.linked_files ? { linkedFiles: draft.metadata.linked_files } : {}),
          ...(draft.metadata.linked_plans ? { linkedPlans: draft.metadata.linked_plans } : {}),
          ...(draft.metadata.evidence ? { evidence: draft.metadata.evidence } : {}),
          ...(draft.metadata.owner ? { owner: draft.metadata.owner } : {}),
          ...(draft.metadata.created_at ? { createdAt: draft.metadata.created_at } : {}),
          ...(draft.metadata.updated_at ? { updatedAt: draft.metadata.updated_at } : {}),
        };
        memory.rankScore = this.calculateMemoryRankScore(memory) + Math.min(0.2, draft.confidence * 0.2);
        return memory;
      })
      .sort((a, b) => (b.rankScore || 0) - (a.rankScore || 0));

    return {
      selected: ranked.slice(0, maxMemories),
      candidateCount: ranked.length,
      startupPackCount: 0,
    };
  }

  /**
   * Get enhanced context bundle for prompt enhancement
   * This is the primary method for Layer 2 - Context Service
   */
  async getContextForPrompt(query: string, options?: ContextOptions): Promise<ContextBundle>;
  async getContextForPrompt(query: string, maxFiles?: number): Promise<ContextBundle>;
  async getContextForPrompt(
    query: string,
    optionsOrMaxFiles?: ContextOptions | number
  ): Promise<ContextBundle> {
    const startTime = Date.now();

    // Parse options
    const options: ContextOptions = typeof optionsOrMaxFiles === 'number'
      ? { maxFiles: optionsOrMaxFiles }
      : optionsOrMaxFiles || {};

    const {
      maxFiles = 5,
      tokenBudget = DEFAULT_TOKEN_BUDGET,
      includeRelated = true,
      minRelevance = 0.3,
      includeSummaries = true,
      includeMemories = true,
      includeDraftMemories = false,
      draftSessionId,
      bypassCache = false,
      preferLocalSearch = false,
      priority = 'interactive',
      includePaths,
      excludePaths,
      externalSources,
    } = options;
    const normalizedScope = this.normalizePathScopeOptions({ includePaths, excludePaths });
    const serializedExternalSources = serializeExternalSourcesForCache(externalSources);

    const normalizedCacheOptions = {
      maxFiles,
      tokenBudget,
      includeRelated,
      minRelevance,
      includeSummaries,
      includeMemories,
      includeDraftMemories,
      draftSessionId,
      includePaths: normalizedScope?.includePaths,
      excludePaths: normalizedScope?.excludePaths,
      externalSources: serializedExternalSources,
      externalGroundingVersion: externalSources?.length ? EXTERNAL_GROUNDING_PROVIDER_VERSION : undefined,
    };

    const commitPrefix = (this.commitCacheEnabled && this.currentCommitHash)
      ? `${this.currentCommitHash.substring(0, 12)}:`
      : '';
    const indexFingerprint = this.getIndexFingerprint();
    const connectorSignals = await this.connectorRegistry.collectSignals(this.workspacePath);
    const connectorFingerprint = buildConnectorFingerprint(connectorSignals);
    const persistentCacheKey = (indexFingerprint !== 'no-state' && indexFingerprint !== 'unknown')
      ? `${indexFingerprint}:${connectorFingerprint}:${commitPrefix}context:${query}:${JSON.stringify(normalizedCacheOptions)}`
      : null;

    if (!bypassCache) {
      if (persistentCacheKey) {
        const persistent = this.getPersistentContextBundle(persistentCacheKey);
        if (persistent) {
          incCounter(
            'context_engine_get_context_for_prompt_total',
            { cache: 'persistent' },
            1,
            'Total getContextForPrompt calls (labeled by cache path).'
          );
          observeDurationMs(
            'context_engine_get_context_for_prompt_duration_seconds',
            { cache: 'persistent' },
            Date.now() - startTime,
            { help: 'getContextForPrompt end-to-end duration in seconds (includes cache hits).' }
          );
          return persistent;
        }
      }
    }

    const semanticSearch = (q: string, k: number) =>
      bypassCache
        ? this.semanticSearch(q, k, { bypassCache: true, priority, ...normalizedScope })
        : this.semanticSearch(q, k, { priority, ...normalizedScope });

    const useLocalKeywordSearchFirst = preferLocalSearch || isOperationalDocsQuery(query);
    const runDefaultSearch = () => (
      useLocalKeywordSearchFirst
        ? this.localKeywordSearch(query, maxFiles * 3, normalizedScope)
            .then(results => (results.length > 0 ? results : semanticSearch(query, maxFiles * 3)))
            .catch(() => semanticSearch(query, maxFiles * 3))
        : semanticSearch(query, maxFiles * 3)
    );
    const explicitLookup = featureEnabled('retrieval_declaration_routing_v1')
      ? resolveLookupIntent(query)
      : { intent: 'discovery' as const };
    const searchPlanPromise = (async (): Promise<{ results: SearchResult[]; routingDiagnostics?: ContextRoutingDiagnostics }> => {
      if (!featureEnabled('retrieval_declaration_routing_v1')) {
        return { results: await runDefaultSearch() };
      }

      if (explicitLookup.intent === 'discovery') {
        return {
          results: await runDefaultSearch(),
          routingDiagnostics: {
            selectedIntent: 'discovery',
            selectedRoute: 'semantic_discovery',
            symbol: null,
            symbolHit: false,
            declarationHit: false,
            parserSource: null,
            parserProvenance: [],
            downgradeReason: null,
            fallbackReason: null,
            oversizedFileOutcome: null,
          },
        };
      }

      try {
        const lookupAttempt = await this.searchResultsForLookupIntent(explicitLookup, normalizedScope, { bypassCache });
        if (lookupAttempt.results.length > 0) {
          const shadowCompare = await this.maybeBuildLookupRoutingShadowCompareReceipt(
            query,
            maxFiles * 3,
            lookupAttempt.selectedRoute,
            lookupAttempt.results,
            normalizedScope,
            bypassCache,
            priority
          );
          return {
            results: lookupAttempt.results,
            routingDiagnostics: {
              selectedIntent: explicitLookup.intent,
              selectedRoute: lookupAttempt.selectedRoute,
              symbol: explicitLookup.symbol ?? null,
              symbolHit: lookupAttempt.symbolHit,
              declarationHit: lookupAttempt.declarationHit,
              parserSource: lookupAttempt.parserSource,
              parserProvenance: [...lookupAttempt.parserProvenance],
              downgradeReason: lookupAttempt.downgradeReason,
              fallbackReason: lookupAttempt.fallbackReason,
              oversizedFileOutcome: lookupAttempt.oversizedFileOutcome,
              ...(shadowCompare ? { shadowCompare } : {}),
            },
          };
        }

        return {
          results: await runDefaultSearch(),
          routingDiagnostics: {
            selectedIntent: explicitLookup.intent,
            selectedRoute: 'semantic_fallback',
            symbol: explicitLookup.symbol ?? null,
            symbolHit: lookupAttempt.symbolHit,
            declarationHit: lookupAttempt.declarationHit,
            parserSource: lookupAttempt.parserSource,
            parserProvenance: [...lookupAttempt.parserProvenance],
            downgradeReason: lookupAttempt.downgradeReason,
            fallbackReason: lookupAttempt.fallbackReason,
            oversizedFileOutcome: lookupAttempt.oversizedFileOutcome,
          },
        };
      } catch {
        return {
          results: await runDefaultSearch(),
          routingDiagnostics: {
            selectedIntent: explicitLookup.intent,
            selectedRoute: 'semantic_fallback',
            symbol: explicitLookup.symbol ?? null,
            symbolHit: false,
            declarationHit: false,
            parserSource: null,
            parserProvenance: [],
            downgradeReason: null,
            fallbackReason: 'lookup_route_error',
            oversizedFileOutcome: null,
          },
        };
      }
    })();

    // Perform search and memory retrieval in parallel
    const [{ results: searchResults, routingDiagnostics }, memoryRetrieval] = await Promise.all([
      searchPlanPromise,
      includeMemories
        ? this.getRelevantMemories(query, 5)
        : Promise.resolve({ selected: [], candidateCount: 0, startupPackCount: 0 }),
    ]);
    const draftMemoryRetrieval =
      includeDraftMemories && draftSessionId
        ? this.getRelevantDraftMemories(draftSessionId, 3)
        : { selected: [], candidateCount: 0, startupPackCount: 0 };
    const memories = [...memoryRetrieval.selected, ...draftMemoryRetrieval.selected];

    // Filter by minimum relevance
    const relevantResults = searchResults.filter(
      r => (r.relevanceScore || 0) >= minRelevance
    );

    // Deduplicate and group by file path
    const fileMap = new Map<string, SearchResult[]>();
    for (const result of relevantResults) {
      if (!fileMap.has(result.path)) {
        fileMap.set(result.path, []);
      }
      fileMap.get(result.path)!.push(result);
    }

    // Calculate file-level relevance (max of snippet relevances)
    const fileRelevance = new Map<string, number>();
    for (const [filePath, results] of fileMap) {
      const maxRelevance = Math.max(...results.map(r => r.relevanceScore || 0));
      fileRelevance.set(filePath, maxRelevance);
    }

    // Sort files by relevance and take top files
    const sortedFiles = Array.from(fileMap.entries())
      .sort((a, b) => (fileRelevance.get(b[0]) || 0) - (fileRelevance.get(a[0]) || 0))
      .slice(0, maxFiles);

    // Track token usage
    let truncated = false;
    const truncationReasons = new Set<ContextTruncationReason>();
    const existingPaths = new Set(sortedFiles.map(([p]) => p));

    // Calculate per-file budget upfront for parallel processing
    const perFileBudget = Math.floor(tokenBudget / maxFiles);

    // =========================================================================
    // PARALLELIZATION: Process all files concurrently using Promise.all
    // This replaces the sequential for-loop with parallel file processing,
    // significantly reducing context retrieval time (estimated 2-4 seconds saved)
    // =========================================================================

    /**
     * Process a single file's context (snippets, related files, summary)
     * This function is designed to run in parallel for multiple files
     */
    const processFileContext = async (
      filePath: string,
      results: SearchResult[]
    ): Promise<FileContext | null> => {
      // Build snippets with smart extraction
      const snippets: SnippetInfo[] = [];
      let fileTokens = 0;

      for (const result of results) {
        const snippetBudget = Math.floor(perFileBudget / results.length);
        const smartContent = this.extractSmartSnippet(result.content, snippetBudget);
        const tokenCount = this.estimateTokens(smartContent);
        if (this.estimateTokens(result.content) > snippetBudget) {
          truncated = true;
          truncationReasons.add('token_budget');
        }

        if (fileTokens + tokenCount > perFileBudget) {
          truncated = true;
          truncationReasons.add('token_budget');
          break;
        }

        snippets.push({
          text: smartContent,
          lines: result.lines || 'unknown',
          relevance: result.relevanceScore || 0,
          tokenCount,
          codeType: this.detectCodeType(smartContent),
        });

        fileTokens += tokenCount;
      }

      // Skip files with no snippets
      if (snippets.length === 0) {
        return null;
      }

      // Find related files in parallel (if enabled)
      // Note: Each file's related files are found independently
      const relatedFilesPromise = includeRelated
        ? this.findRelatedFiles(filePath, existingPaths)
        : Promise.resolve(undefined);

      // Generate file summary (CPU-bound, runs immediately)
      const summary = includeSummaries
        ? this.generateFileSummary(filePath, snippets)
        : '';

      // Wait for related files (I/O-bound operation)
      const relatedFiles = await relatedFilesPromise;
      const scopedRelatedFiles = relatedFiles
        ? this.filterPathsByScope(relatedFiles, normalizedScope)
        : relatedFiles;

      return {
        path: filePath,
        extension: path.extname(filePath),
        summary,
        relevance: fileRelevance.get(filePath) || 0,
        tokenCount: fileTokens,
        snippets,
        relatedFiles: scopedRelatedFiles?.length ? scopedRelatedFiles : undefined,
        selectionRationale: `Top relevance ${(fileRelevance.get(filePath) || 0).toFixed(2)} with ${snippets.length} snippet(s)` +
          (summary ? `; ${summary}` : ''),
      };
    };

    // Process all files in parallel
    const fileContextResults = await Promise.all(
      sortedFiles.map(([filePath, results]) => processFileContext(filePath, results))
    );

    // Filter out null results and collect valid file contexts
    const files: FileContext[] = fileContextResults.filter(
      (fc): fc is FileContext => fc !== null
    );

    // Calculate total tokens after parallel processing
    let totalTokens = files.reduce((sum, f) => sum + f.tokenCount, 0);

    // Check if we exceeded the budget (mark as truncated)
    if (totalTokens > tokenBudget) {
      truncated = true;
      truncationReasons.add('token_budget');
      // Trim files to fit budget (keeping highest relevance first - already sorted)
      totalTokens = 0;
      const trimmedFiles: FileContext[] = [];
      for (const file of files) {
        if (totalTokens + file.tokenCount <= tokenBudget) {
          trimmedFiles.push(file);
          totalTokens += file.tokenCount;
        } else {
          break;
        }
      }
      files.length = 0;
      files.push(...trimmedFiles);
    }

    // Update existing paths with related files discovered during parallel processing
    for (const file of files) {
      if (file.relatedFiles) {
        file.relatedFiles.forEach(p => existingPaths.add(p));
      }
    }

    // Generate intelligent hints
    const hints = this.generateContextHints(query, files, searchResults.length);

    // Add memory hint if memories were found
    if (memories.length > 0) {
      const categories = [...new Set(memories.map(m => m.category))];
      hints.push(`Memories: ${memories.length} relevant entries from ${categories.join(', ')}`);
      if (memoryRetrieval.startupPackCount > 0) {
        hints.push(`Startup memory pack: ${memoryRetrieval.startupPackCount} high-priority entries`);
      }
      if (draftMemoryRetrieval.selected.length > 0) {
        hints.push(`Draft memories: ${draftMemoryRetrieval.selected.length} session-scoped suggestion(s) from ${draftSessionId}`);
      }
    }

    if (connectorSignals.length > 0) {
      for (const signal of connectorSignals) {
        hints.push(formatConnectorHint(signal));
      }
    }

    // Build context summary
    const summary = this.generateContextSummary(query, files);

    const searchTimeMs = Date.now() - startTime;

    const externalGrounding = await fetchExternalGrounding(externalSources);

    const bundle: ContextBundle = {
      summary,
      query,
      files,
      hints,
      dependencyMap: includeRelated
        ? Object.fromEntries(
            files
              .filter((file) => (file.relatedFiles?.length ?? 0) > 0)
              .map((file) => [file.path, file.relatedFiles ?? []])
          )
        : undefined,
      memories: memories.length > 0 ? memories : undefined,
      externalReferences: externalGrounding.references.length > 0 ? externalGrounding.references : undefined,
      metadata: {
        totalFiles: files.length,
        totalSnippets: files.reduce((sum, f) => sum + f.snippets.length, 0),
        totalTokens,
        tokenBudget,
        truncated: truncated || externalGrounding.truncated,
        ...(truncationReasons.size > 0 || externalGrounding.truncated
          ? {
              truncationReasons: [
                ...truncationReasons,
                ...(externalGrounding.truncated ? ['external_grounding' as const] : []),
              ],
            }
          : {}),
        searchTimeMs,
        memoriesIncluded: memories.length,
        memoryCandidates: memoryRetrieval.candidateCount,
        memoriesStartupPackIncluded: memoryRetrieval.startupPackCount,
        draftMemoriesIncluded: draftMemoryRetrieval.selected.length,
        draftMemoryCandidates: draftMemoryRetrieval.candidateCount,
        ...(externalSources?.length
          ? {
              externalSourcesRequested: externalSources.length,
              externalSourcesUsed: externalGrounding.references.length,
            }
          : {}),
        ...(externalGrounding.warnings.length > 0
          ? { externalWarnings: externalGrounding.warnings }
          : {}),
        ...(routingDiagnostics
          ? { routingDiagnostics }
          : {}),
      },
    };

    if (!bypassCache && persistentCacheKey) {
      this.setPersistentContextBundle(persistentCacheKey, bundle);
    }
    incCounter(
      'context_engine_get_context_for_prompt_total',
      { cache: 'miss' },
      1,
      'Total getContextForPrompt calls (labeled by cache path).'
    );
    observeDurationMs(
      'context_engine_get_context_for_prompt_duration_seconds',
      { cache: 'miss' },
      Date.now() - startTime,
      { help: 'getContextForPrompt end-to-end duration in seconds (includes cache hits).' }
    );
    return bundle;
  }

  /**
   * Generate intelligent hints based on the context
   */
  private generateContextHints(
    query: string,
    files: FileContext[],
    totalResults: number
  ): string[] {
    const hints: string[] = [];

    // File type distribution
    const extensions = new Map<string, number>();
    for (const file of files) {
      const ext = file.extension || 'unknown';
      extensions.set(ext, (extensions.get(ext) || 0) + 1);
    }
    if (extensions.size > 0) {
      const extList = Array.from(extensions.entries())
        .map(([ext, count]) => `${ext} (${count})`)
        .join(', ');
      hints.push(`File types: ${extList}`);
    }

    // Code type distribution
    const codeTypes = new Map<string, number>();
    for (const file of files) {
      for (const snippet of file.snippets) {
        if (snippet.codeType) {
          codeTypes.set(snippet.codeType, (codeTypes.get(snippet.codeType) || 0) + 1);
        }
      }
    }
    if (codeTypes.size > 0) {
      const typeList = Array.from(codeTypes.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([type, count]) => `${type} (${count})`)
        .join(', ');
      hints.push(`Code patterns: ${typeList}`);
    }

    // Related files hint
    const relatedFiles = files.flatMap(f => f.relatedFiles || []);
    if (relatedFiles.length > 0) {
      hints.push(`Related files to consider: ${relatedFiles.slice(0, 3).join(', ')}`);
    }

    // Coverage hint
    if (totalResults > files.length) {
      hints.push(`Showing ${files.length} of ${totalResults} matching files`);
    }

    // High relevance hint
    const highRelevanceFiles = files.filter(f => f.relevance > 0.7);
    if (highRelevanceFiles.length > 0) {
      hints.push(`Highly relevant: ${highRelevanceFiles.map(f => path.basename(f.path)).join(', ')}`);
    }

    return hints;
  }

  /**
   * Generate a high-level summary of the context
   */
  private generateContextSummary(query: string, files: FileContext[]): string {
    if (files.length === 0) {
      return `No relevant code found for: "${query}"`;
    }

    // Get the most common directory
    const dirs = files.map(f => path.dirname(f.path));
    const dirCounts = new Map<string, number>();
    for (const dir of dirs) {
      dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);
    }
    const topDir = Array.from(dirCounts.entries())
      .sort((a, b) => b[1] - a[1])[0]?.[0] || '';

    // Get the dominant code types
    const allCodeTypes = files.flatMap(f => f.snippets.map(s => s.codeType)).filter(Boolean);
    const dominantType = allCodeTypes.length > 0
      ? allCodeTypes.sort((a, b) =>
        allCodeTypes.filter(t => t === b).length - allCodeTypes.filter(t => t === a).length
      )[0]
      : 'code';

    return `Context for "${query}": ${files.length} files from ${topDir || 'multiple directories'}, primarily containing ${dominantType} definitions`;
  }
}
