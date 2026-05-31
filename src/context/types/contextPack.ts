/**
 * Context Pack V3 — structured, ephemeral context artifact for MCP tools.
 *
 * Pure type definitions; assembly lives in contextPackAssembler.ts.
 */

export const CONTEXT_PACK_SCHEMA_VERSION = '3.0' as const;

export type ContextPackSchemaVersion = typeof CONTEXT_PACK_SCHEMA_VERSION;

export type ContextPackItemKind = 'file' | 'snippet' | 'memory' | 'hint' | 'external';

export interface ContextPackItem {
  /** Stable item identifier derived from kind, path, rank, and content fingerprint. */
  id: string;
  kind: ContextPackItemKind;
  /** Zero-based rank within the assembled pack (lower = higher priority). */
  rank: number;
  /** Workspace-relative path when the item originates from a file. */
  path?: string;
  /** Primary text payload for the item (snippet body, memory text, hint, etc.). */
  content: string;
  /** Conservative token estimate for this item's content. */
  token_count: number;
  /** Normalized relevance score in the 0–1 range when available. */
  relevance?: number;
  /** Human-readable line range (e.g. "12-45") when applicable. */
  lines?: string;
  /** Short explanation of why this item was selected. */
  selection_rationale?: string;
}

export interface ContextPackTokenBudget {
  /** Requested token ceiling for the pack. */
  requested: number;
  /** Sum of token_count across included items. */
  used: number;
  /** True when items were dropped or trimmed to satisfy budget or size limits. */
  truncated: boolean;
}

export interface ContextPackMetadata {
  /** Number of items included in the pack. */
  item_count: number;
  /** Distinct file paths represented among file/snippet items. */
  file_count: number;
  /** Mirrors token_budget.truncated for quick consumers checks. */
  truncated: boolean;
  /** Reasons truncation occurred, when truncated is true. */
  truncation_reasons?: ContextPackTruncationReason[];
  /** Original bundle summary when assembled from a ContextBundle. */
  summary?: string;
  /** Retrieval timing from the source bundle, in milliseconds. */
  search_time_ms?: number;
  /** ISO-8601 timestamp of assembly (informational; excluded from pack id hash). */
  assembled_at: string;
}

export type ContextPackTruncationReason =
  | 'token_budget'
  | 'max_items'
  | 'max_item_content_chars'
  | 'max_total_content_chars';

export interface ContextPackV3 {
  schema_version: ContextPackSchemaVersion;
  /** Deterministic pack identifier: ctxp_<sha256-prefix>. */
  id: string;
  /** Query or goal that produced this context. */
  query: string;
  /** Ordered context items, highest priority first. */
  items: ContextPackItem[];
  token_budget: ContextPackTokenBudget;
  metadata: ContextPackMetadata;
}

/** Default assembly limits to prevent unbounded payloads. */
export const DEFAULT_CONTEXT_PACK_LIMITS = {
  maxItems: 100,
  maxItemContentChars: 32_000,
  maxTotalContentChars: 256_000,
  defaultTokenBudget: 8_000,
  minTokenBudget: 500,
  maxTokenBudget: 100_000,
  charsPerToken: 4,
} as const;

export type ContextPackLimits = typeof DEFAULT_CONTEXT_PACK_LIMITS;
