import { createHash } from 'crypto';
import { type AddMemoryArgs, type MemoryCategory, type MemoryPriority } from './tools/memory.js';

export type DraftSuggestionState =
  | 'detected'
  | 'drafted'
  | 'batched'
  | 'reviewed'
  | 'promoted'
  | 'promoted_pending_index'
  | 'dismissed'
  | 'snoozed'
  | 'expired';

export interface DraftSuggestionScoreBreakdown {
  repetition: number;
  directive_strength: number;
  source_reliability: number;
  traceability: number;
  stability_penalty: number;
}

export interface DraftSuggestionMetadata {
  subtype?: string;
  tags?: string[];
  priority?: MemoryPriority;
  source?: string;
  linked_files?: string[];
  linked_plans?: string[];
  evidence?: string;
  created_at?: string;
  updated_at?: string;
  owner?: string;
}

export interface DraftSuggestionPromotionResult {
  state: 'promoted' | 'promoted_pending_index';
  promoted_at: string;
  memory_category: MemoryCategory;
  promotion_payload_hash: string;
  promotion_idempotency_key?: string;
  index_status: 'completed' | 'pending';
  memory_title?: string;
  memory_source?: string;
}

export interface DraftSuggestionRecord {
  draft_id: string;
  session_id: string;
  source_type: string;
  source_ref: string;
  state: DraftSuggestionState;
  category: MemoryCategory;
  content: string;
  title?: string;
  metadata: DraftSuggestionMetadata;
  promotion_payload_hash: string;
  score_breakdown: DraftSuggestionScoreBreakdown;
  confidence: number;
  conflict_key: string;
  created_at: string;
  updated_at: string;
  expires_at?: string;
  reviewed_at?: string;
  store_version?: number;
  promotion_result?: DraftSuggestionPromotionResult;
}

export interface CreateDraftSuggestionInput {
  draft_id: string;
  session_id: string;
  source_type: string;
  source_ref: string;
  state?: 'detected' | 'drafted';
  category: MemoryCategory;
  content: string;
  title?: string;
  metadata?: DraftSuggestionMetadata;
  score_breakdown: DraftSuggestionScoreBreakdown;
  confidence: number;
  conflict_key?: string;
  created_at?: string;
  updated_at?: string;
  expires_at?: string;
}

const TERMINAL_STATES = new Set<DraftSuggestionState>([
  'promoted',
  'promoted_pending_index',
  'dismissed',
  'expired',
]);

const VALID_TRANSITIONS: Record<DraftSuggestionState, DraftSuggestionState[]> = {
  detected: ['drafted', 'dismissed', 'expired'],
  drafted: ['batched', 'dismissed', 'snoozed', 'expired'],
  batched: ['reviewed', 'dismissed', 'snoozed', 'expired'],
  reviewed: ['promoted', 'promoted_pending_index', 'dismissed', 'snoozed', 'expired'],
  promoted: [],
  promoted_pending_index: ['promoted'],
  dismissed: [],
  snoozed: ['batched', 'expired'],
  expired: [],
};

function normalizeString(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeStringArray(values?: string[]): string[] | undefined {
  if (!values) {
    return undefined;
  }

  const normalized = values
    .map((value) => value.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeMetadata(metadata?: DraftSuggestionMetadata): DraftSuggestionMetadata {
  return {
    subtype: normalizeString(metadata?.subtype),
    tags: normalizeStringArray(metadata?.tags),
    priority: metadata?.priority,
    source: normalizeString(metadata?.source),
    linked_files: normalizeStringArray(metadata?.linked_files),
    linked_plans: normalizeStringArray(metadata?.linked_plans),
    evidence: normalizeString(metadata?.evidence),
    created_at: normalizeString(metadata?.created_at),
    updated_at: normalizeString(metadata?.updated_at),
    owner: normalizeString(metadata?.owner),
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

function normalizeContent(content: string): string {
  const normalized = content.trim();
  if (!normalized) {
    throw new Error('Draft suggestion content is required');
  }
  return normalized;
}

function normalizeTimestamp(timestamp?: string, fallback?: string): string | undefined {
  const value = timestamp ?? fallback;
  if (!value) {
    return undefined;
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`Invalid ISO timestamp: ${value}`);
  }
  return value;
}

function validateConfidence(confidence: number): void {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error('Draft suggestion confidence must be a number between 0 and 1');
  }
}

export function toPromotionPayload(record: DraftSuggestionRecord): AddMemoryArgs {
  return {
    category: record.category,
    content: record.content,
    title: record.title,
    subtype: record.metadata.subtype,
    tags: record.metadata.tags,
    priority: record.metadata.priority,
    source: record.metadata.source,
    linked_files: record.metadata.linked_files,
    linked_plans: record.metadata.linked_plans,
    evidence: record.metadata.evidence,
    created_at: record.metadata.created_at,
    updated_at: record.metadata.updated_at,
    owner: record.metadata.owner,
  };
}

export function computePromotionPayloadHash(payload: AddMemoryArgs): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

export function createDraftSuggestionRecord(input: CreateDraftSuggestionInput): DraftSuggestionRecord {
  validateConfidence(input.confidence);

  const now = new Date().toISOString();
  const createdAt = normalizeTimestamp(input.created_at, now) ?? now;
  const updatedAt = normalizeTimestamp(input.updated_at, createdAt) ?? createdAt;
  const metadata = normalizeMetadata(input.metadata);
  const content = normalizeContent(input.content);
  const title = normalizeString(input.title);

  const record: DraftSuggestionRecord = {
    draft_id: normalizeString(input.draft_id) ?? '',
    session_id: normalizeString(input.session_id) ?? '',
    source_type: normalizeString(input.source_type) ?? '',
    source_ref: normalizeString(input.source_ref) ?? '',
    state: input.state ?? 'drafted',
    category: input.category,
    content,
    title,
    metadata,
    promotion_payload_hash: '',
    score_breakdown: input.score_breakdown,
    confidence: input.confidence,
    conflict_key: normalizeString(input.conflict_key) ?? `${input.category}:${content.toLowerCase()}`,
    created_at: createdAt,
    updated_at: updatedAt,
    expires_at: normalizeTimestamp(input.expires_at),
    store_version: 0,
  };

  if (!record.draft_id || !record.session_id || !record.source_type || !record.source_ref) {
    throw new Error('Draft suggestion requires draft_id, session_id, source_type, and source_ref');
  }

  if (record.state !== 'detected' && record.state !== 'drafted') {
    throw new Error('New draft suggestions may only start in detected or drafted state');
  }

  record.promotion_payload_hash = computePromotionPayloadHash(toPromotionPayload(record));
  return record;
}

export function canTransitionDraftSuggestion(
  currentState: DraftSuggestionState,
  nextState: DraftSuggestionState
): boolean {
  return VALID_TRANSITIONS[currentState].includes(nextState);
}

export interface TransitionDraftSuggestionOptions {
  reviewed_at?: string;
  updated_at?: string;
  expires_at?: string;
  promotion_result?: Omit<DraftSuggestionPromotionResult, 'promotion_payload_hash' | 'memory_category'>;
}

export function transitionDraftSuggestionState(
  record: DraftSuggestionRecord,
  nextState: DraftSuggestionState,
  options: TransitionDraftSuggestionOptions = {}
): DraftSuggestionRecord {
  if (!canTransitionDraftSuggestion(record.state, nextState)) {
    throw new Error(`Invalid draft suggestion transition: ${record.state} -> ${nextState}`);
  }

  const updatedAt = normalizeTimestamp(options.updated_at, new Date().toISOString()) ?? new Date().toISOString();
  const reviewedAt = options.reviewed_at
    ? normalizeTimestamp(options.reviewed_at)
    : record.reviewed_at
      ? record.reviewed_at
      : nextState === 'reviewed' || nextState === 'promoted' || nextState === 'promoted_pending_index'
        ? updatedAt
        : undefined;

  const nextRecord: DraftSuggestionRecord = {
    ...record,
    state: nextState,
    updated_at: updatedAt,
    reviewed_at: reviewedAt,
    expires_at: normalizeTimestamp(options.expires_at, record.expires_at),
  };

  if (nextState === 'promoted' || nextState === 'promoted_pending_index') {
    if (!reviewedAt) {
      throw new Error('Promoted draft suggestions require reviewed_at');
    }
    nextRecord.promotion_result = {
      state: nextState,
      promoted_at: updatedAt,
      memory_category: nextRecord.category,
      promotion_payload_hash: nextRecord.promotion_payload_hash,
      index_status: nextState === 'promoted' ? 'completed' : 'pending',
      memory_title: nextRecord.title,
      memory_source: nextRecord.metadata.source,
      ...options.promotion_result,
    };
  }

  if (nextState === 'promoted' && record.state === 'promoted_pending_index') {
    nextRecord.promotion_result = {
      state: 'promoted',
      promoted_at: updatedAt,
      memory_category: nextRecord.category,
      promotion_payload_hash: nextRecord.promotion_payload_hash,
      index_status: 'completed',
      memory_title: nextRecord.title,
      memory_source: nextRecord.metadata.source,
    };
  }

  if (TERMINAL_STATES.has(nextState) && nextState !== 'promoted_pending_index') {
    nextRecord.expires_at = nextRecord.expires_at ?? updatedAt;
  }

  return nextRecord;
}
