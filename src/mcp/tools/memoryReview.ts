import { type Tool } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as path from 'path';
import { featureEnabled } from '../../config/features.js';
import { ContextServiceClient } from '../serviceClient.js';
import { gateBulkDraftPromotion } from '../memorySuggestionConflicts.js';
import { assertPromotionPayloadSafeForPersistence } from '../memorySuggestionSafety.js';
import {
  createDraftSuggestionRecord,
  transitionDraftSuggestionState,
  toPromotionPayload,
  type DraftSuggestionMetadata,
  type DraftSuggestionRecord,
  type DraftSuggestionState,
} from '../memorySuggestions.js';
import { MemorySuggestionStore } from '../memorySuggestionStore.js';
import { type ApprovedMemoryRecord } from '../memorySuggestionConflicts.js';
import { persistMemoryEntry } from './memory.js';
import {
  validateFiniteNumberInRange,
  validateMaxLength,
  validateOneOf,
  validateTrimmedNonEmptyString,
} from '../tooling/validation.js';

const MAX_BATCH_CAP = 5;
const MIN_BATCH_CAP = 3;
const MEMORY_DIR = '.memories';
const CATEGORY_FILES: Record<'preferences' | 'decisions' | 'facts', string> = {
  preferences: 'preferences.md',
  decisions: 'decisions.md',
  facts: 'facts.md',
};
const SUPPRESSION_FILE = 'memory-suppressions.json';

type ReviewAction = 'list_batches' | 'approve' | 'dismiss' | 'edit' | 'snooze' | 'undo_last_batch' | 'suppress_pattern';

type DraftView = {
  draft_id: string;
  session_id: string;
  state: DraftSuggestionState;
  category: DraftSuggestionRecord['category'];
  title?: string;
  content: string;
  confidence: number;
  suppressed: boolean;
  created_at: string;
  updated_at: string;
  reviewed_at?: string;
  expires_at?: string;
  store_version?: number;
};

type BatchView = {
  batch_id: string;
  session_id: string;
  batch_cap: number;
  draft_count: number;
  visible_count: number;
  hidden_count: number;
  suppressed_count: number;
  truncated: boolean;
  latest_updated_at: string;
  drafts: DraftView[];
};

type ReviewResult = {
  success: boolean;
  action: ReviewAction;
  message: string;
  batch_cap?: number;
  batch_count?: number;
  batches?: BatchView[];
  batch?: BatchView;
  selected_drafts?: DraftView[];
  updated_drafts?: DraftView[];
  no_op_drafts?: string[];
  blocked_drafts?: Array<{
    draft_id: string;
    reason: string;
    conflict_matches?: Array<{
      approved_index: number;
      approved_title?: string;
      approved_category: string;
      contradiction_reason: string;
      relevance_score: number;
    }>;
  }>;
  suppressed_patterns?: string[];
  suppressed_count?: number;
};

export interface ReviewMemorySuggestionsArgs {
  action: ReviewAction;
  session_id?: string;
  draft_id?: string;
  batch_cap?: number;
  override_reason?: string;
  pattern?: string;
  content?: string;
  title?: string;
  subtype?: string;
  tags?: string[];
  priority?: DraftSuggestionMetadata['priority'];
  source?: string;
  linked_files?: string[];
  linked_plans?: string[];
  evidence?: string;
  owner?: string;
}

function normalizeString(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeList(values?: string[]): string[] | undefined {
  if (!values) {
    return undefined;
  }

  const normalized = values.map((value) => value.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeBatchCap(value?: number): number {
  if (value === undefined) {
    return MAX_BATCH_CAP;
  }

  validateFiniteNumberInRange(value, MIN_BATCH_CAP, MAX_BATCH_CAP, 'batch_cap must be between 3 and 5');
  return value;
}

function normalizePattern(pattern: string): string {
  const normalized = pattern.trim();
  if (!normalized) {
    throw new Error('pattern is required');
  }
  validateMaxLength(normalized, 200, 'pattern too long: maximum 200 characters');
  return normalized.toLowerCase();
}

function draftSearchText(record: Pick<DraftSuggestionRecord, 'title' | 'content' | 'conflict_key' | 'metadata'>): string {
  return [
    record.title,
    record.content,
    record.conflict_key,
    record.metadata.source,
    record.metadata.evidence,
    record.metadata.tags?.join(' '),
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function isSuppressed(record: DraftSuggestionRecord, patterns: string[]): boolean {
  const searchable = draftSearchText(record);
  return patterns.some((pattern) => searchable.includes(pattern));
}

function serializeDraft(record: DraftSuggestionRecord, suppressed: boolean): DraftView {
  return {
    draft_id: record.draft_id,
    session_id: record.session_id,
    state: record.state,
    category: record.category,
    ...(record.title ? { title: record.title } : {}),
    content: record.content,
    confidence: record.confidence,
    suppressed,
    created_at: record.created_at,
    updated_at: record.updated_at,
    ...(record.reviewed_at ? { reviewed_at: record.reviewed_at } : {}),
    ...(record.expires_at ? { expires_at: record.expires_at } : {}),
    ...(record.store_version !== undefined ? { store_version: record.store_version } : {}),
  };
}

function sortDrafts(a: DraftSuggestionRecord, b: DraftSuggestionRecord): number {
  return a.created_at.localeCompare(b.created_at) || a.draft_id.localeCompare(b.draft_id);
}

function cloneMetadata(metadata: DraftSuggestionMetadata): DraftSuggestionMetadata {
  return {
    ...(metadata.subtype ? { subtype: metadata.subtype } : {}),
    ...(metadata.tags ? { tags: [...metadata.tags] } : {}),
    ...(metadata.priority ? { priority: metadata.priority } : {}),
    ...(metadata.source ? { source: metadata.source } : {}),
    ...(metadata.linked_files ? { linked_files: [...metadata.linked_files] } : {}),
    ...(metadata.linked_plans ? { linked_plans: [...metadata.linked_plans] } : {}),
    ...(metadata.evidence ? { evidence: metadata.evidence } : {}),
    ...(metadata.created_at ? { created_at: metadata.created_at } : {}),
    ...(metadata.updated_at ? { updated_at: metadata.updated_at } : {}),
    ...(metadata.owner ? { owner: metadata.owner } : {}),
  };
}

function parseApprovedMemoryBlocks(category: DraftSuggestionRecord['category'], content: string): ApprovedMemoryRecord[] {
  const blocks: ApprovedMemoryRecord[] = [];
  const lines = content.split(/\r?\n/u);
  let currentTitle: string | undefined;
  let currentContent: string[] = [];
  let currentSource: string | undefined;
  let currentConflictKey: string | undefined;

  const flush = (): void => {
    const text = currentContent.join('\n').trim();
    if (!currentTitle && !text) {
      currentContent = [];
      currentSource = undefined;
      currentConflictKey = undefined;
      return;
    }

    blocks.push({
      category,
      content: text,
      ...(currentTitle ? { title: currentTitle } : {}),
      ...(currentSource ? { source: currentSource } : {}),
      ...(currentConflictKey ? { conflict_key: currentConflictKey } : {}),
    });

    currentTitle = undefined;
    currentContent = [];
    currentSource = undefined;
    currentConflictKey = undefined;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const heading = /^###\s+\[(?:[^\]]+)\]\s+(.+)$/u.exec(line);
    if (heading) {
      flush();
      currentTitle = heading[1]?.trim();
      continue;
    }

    const meta = /^-\s+\[meta\]\s+([a-z_]+)\s*:\s*(.+)$/iu.exec(line);
    if (meta) {
      const key = meta[1]!.toLowerCase();
      const value = meta[2]!.trim();
      if (key === 'source') {
        currentSource = value;
      }
      continue;
    }

    if (line.startsWith('- ')) {
      currentContent.push(line.slice(2).trim());
      continue;
    }

    if (line.length > 0) {
      currentContent.push(line);
    }
  }

  flush();
  return blocks.filter((block) => block.content.trim().length > 0);
}

function loadApprovedMemories(workspacePath: string): ApprovedMemoryRecord[] {
  const memoriesDir = path.join(workspacePath, MEMORY_DIR);
  if (!fs.existsSync(memoriesDir)) {
    return [];
  }

  const memories: ApprovedMemoryRecord[] = [];
  for (const [category, fileName] of Object.entries(CATEGORY_FILES) as Array<[
    DraftSuggestionRecord['category'],
    string,
  ]>) {
    const filePath = path.join(memoriesDir, fileName);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    memories.push(...parseApprovedMemoryBlocks(category, fs.readFileSync(filePath, 'utf-8')));
  }

  return memories;
}

function suppressionFilePath(workspacePath: string): string {
  return path.join(workspacePath, '.context-engine-memory-suggestions', SUPPRESSION_FILE);
}

function loadSuppressionPatterns(workspacePath: string): string[] {
  const filePath = suppressionFilePath(workspacePath);
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { patterns?: unknown };
    if (!Array.isArray(raw.patterns)) {
      return [];
    }
    return [...new Set(raw.patterns.filter((pattern): pattern is string => typeof pattern === 'string' && pattern.trim().length > 0).map((pattern) => pattern.trim().toLowerCase()))].sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function saveSuppressionPatterns(workspacePath: string, patterns: string[]): string[] {
  const uniquePatterns = [...new Set(patterns.map((pattern) => pattern.trim().toLowerCase()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
  const filePath = suppressionFilePath(workspacePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({ version: 1, updated_at: new Date().toISOString(), patterns: uniquePatterns }, null, 2)}\n`,
    'utf-8'
  );
  return uniquePatterns;
}

function currentVisibleDrafts(workspacePath: string, sessionId?: string, batchCap = MAX_BATCH_CAP): { drafts: DraftSuggestionRecord[]; suppressedCount: number; hiddenCount: number } {
  const store = new MemorySuggestionStore(workspacePath);
  const drafts = store.listDrafts(sessionId).sort(sortDrafts);
  const patterns = loadSuppressionPatterns(workspacePath);
  const visibleDrafts = drafts.filter((draft) => !isSuppressed(draft, patterns));
  return {
    drafts: visibleDrafts.slice(0, batchCap),
    suppressedCount: drafts.length - visibleDrafts.length,
    hiddenCount: Math.max(0, visibleDrafts.length - Math.min(visibleDrafts.length, batchCap)),
  };
}

function batchSummaries(workspacePath: string, sessionId?: string, batchCap = MAX_BATCH_CAP): BatchView[] {
  const store = new MemorySuggestionStore(workspacePath);
  const allDrafts = store.listDrafts(sessionId).sort(sortDrafts);
  const patterns = loadSuppressionPatterns(workspacePath);
  const grouped = new Map<string, DraftSuggestionRecord[]>();

  for (const draft of allDrafts) {
    const list = grouped.get(draft.session_id) ?? [];
    list.push(draft);
    grouped.set(draft.session_id, list);
  }

  return [...grouped.entries()]
    .sort((a, b) => {
      const leftLatest = a[1].at(-1)?.updated_at ?? a[1].at(-1)?.created_at ?? '';
      const rightLatest = b[1].at(-1)?.updated_at ?? b[1].at(-1)?.created_at ?? '';
      return rightLatest.localeCompare(leftLatest) || a[0].localeCompare(b[0]);
    })
    .map(([session, drafts]) => {
      const visible = drafts.filter((draft) => !isSuppressed(draft, patterns));
      const batchDrafts = visible.slice(0, batchCap);
      return {
        batch_id: session,
        session_id: session,
        batch_cap: batchCap,
        draft_count: drafts.length,
        visible_count: batchDrafts.length,
        hidden_count: Math.max(0, visible.length - batchDrafts.length),
        suppressed_count: drafts.length - visible.length,
        truncated: visible.length > batchDrafts.length,
        latest_updated_at: drafts.at(-1)?.updated_at ?? drafts.at(-1)?.created_at ?? new Date().toISOString(),
        drafts: batchDrafts.map((draft) => serializeDraft(draft, false)),
      };
    });
}

function buildUpdatedDraft(record: DraftSuggestionRecord, updates: Partial<Pick<DraftSuggestionRecord, 'content' | 'title' | 'metadata'>>): DraftSuggestionRecord {
  return createDraftSuggestionRecord({
    draft_id: record.draft_id,
    session_id: record.session_id,
    source_type: record.source_type,
    source_ref: record.source_ref,
    category: record.category,
    content: updates.content ?? record.content,
    title: updates.title ?? record.title,
    metadata: updates.metadata ?? record.metadata,
    score_breakdown: record.score_breakdown,
    confidence: record.confidence,
    created_at: record.created_at,
    updated_at: new Date().toISOString(),
    expires_at: record.expires_at,
  });
}

function sessionOrDefault(sessionId?: string): string {
  return validateTrimmedNonEmptyString(sessionId, 'session_id is required');
}

export const reviewMemorySuggestionsTool: Tool = {
  name: 'review_memory_suggestions',
  description: `Review draft memory batches and perform idempotent batch actions.

Batch listing enforces the Phase 1 cap (target 3-5, hard cap 5). Approved
suggestions remain review-state only in this phase; durable writes stay in the
existing memory tools. Undo is pre-promotion only in Phase 1.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list_batches', 'approve', 'dismiss', 'edit', 'snooze', 'undo_last_batch', 'suppress_pattern'],
        description: 'Batch review action to perform',
      },
      session_id: {
        type: 'string',
        description: 'Session ID for batch-scoped actions',
      },
      draft_id: {
        type: 'string',
        description: 'Optional draft ID for single-draft actions',
      },
      batch_cap: {
        type: 'number',
        description: 'Maximum drafts to show or operate on per batch (default: 5, range: 3-5)',
        default: 5,
      },
      override_reason: {
        type: 'string',
        description: 'Optional override reason for conflict-blocked approval',
      },
      pattern: {
        type: 'string',
        description: 'Pattern to suppress across future draft batches',
      },
      content: {
        type: 'string',
        description: 'Updated draft content for edit actions',
      },
      title: {
        type: 'string',
        description: 'Updated draft title for edit actions',
      },
      subtype: {
        type: 'string',
        description: 'Updated subtype for edit actions',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Updated tags for edit actions',
      },
      priority: {
        type: 'string',
        enum: ['critical', 'helpful', 'archive'],
        description: 'Updated priority for edit actions',
      },
      source: {
        type: 'string',
        description: 'Updated source for edit actions',
      },
      linked_files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Updated linked file list for edit actions',
      },
      linked_plans: {
        type: 'array',
        items: { type: 'string' },
        description: 'Updated linked plan list for edit actions',
      },
      evidence: {
        type: 'string',
        description: 'Updated evidence for edit actions',
      },
      owner: {
        type: 'string',
        description: 'Updated owner for edit actions',
      },
    },
    required: ['action'],
  },
};

export async function handleReviewMemorySuggestions(
  args: ReviewMemorySuggestionsArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const action = validateTrimmedNonEmptyString(args.action, 'action is required') as ReviewAction;
  validateOneOf(
    action,
    ['list_batches', 'approve', 'dismiss', 'edit', 'snooze', 'undo_last_batch', 'suppress_pattern'] as const,
    'action must be one of: list_batches, approve, dismiss, edit, snooze, undo_last_batch, suppress_pattern'
  );

  const workspacePath = serviceClient.getWorkspacePath();
  const batchCap = normalizeBatchCap(args.batch_cap);
  const store = new MemorySuggestionStore(workspacePath);

  if (!featureEnabled('memory_suggestions_v1')) {
    return JSON.stringify(
      {
        success: false,
        action,
        error: 'Memory suggestion review is disabled. Enable CE_MEMORY_SUGGESTIONS_V1 to use this tool.',
      },
      null,
      2
    );
  }

  try {
    if (action === 'list_batches') {
      return JSON.stringify(
        {
          success: true,
          action,
          message: 'Draft batches listed successfully.',
          batch_cap: batchCap,
          batch_count: batchSummaries(workspacePath, normalizeString(args.session_id), batchCap).length,
          batches: batchSummaries(workspacePath, normalizeString(args.session_id), batchCap),
          suppressed_patterns: loadSuppressionPatterns(workspacePath),
        },
        null,
        2
      );
    }

    if (action === 'suppress_pattern') {
      const pattern = normalizePattern(validateTrimmedNonEmptyString(args.pattern, 'pattern is required'));
      const nextPatterns = saveSuppressionPatterns(workspacePath, [...loadSuppressionPatterns(workspacePath), pattern]);
      const targeted = normalizeString(args.session_id)
        ? store.listDrafts(validateTrimmedNonEmptyString(args.session_id, 'session_id is required'))
        : store.listDrafts();
      const matchingDrafts = targeted.filter((draft) => isSuppressed(draft, [pattern]));
      const updatedDrafts = matchingDrafts.map((draft) => {
        if (draft.state === 'dismissed' || draft.state === 'expired') {
          return draft;
        }
        return store.compareAndSetDraftState({
          sessionId: draft.session_id,
          draftId: draft.draft_id,
          expectedVersion: draft.store_version ?? 0,
          nextState: 'dismissed',
          updatedAt: new Date().toISOString(),
        });
      });

      return JSON.stringify(
        {
          success: true,
          action,
          message: matchingDrafts.length > 0
            ? `Suppressed pattern "${pattern}" and dismissed ${updatedDrafts.length} matching draft(s).`
            : `Suppressed pattern "${pattern}".`,
          suppressed_patterns: nextPatterns,
          suppressed_count: updatedDrafts.length,
          updated_drafts: updatedDrafts.map((draft) => serializeDraft(draft, true)),
        },
        null,
        2
      );
    }

    if (action === 'undo_last_batch') {
      const sessionId = sessionOrDefault(args.session_id);
      const drafts = store.listDrafts(sessionId).filter((draft) => draft.state === 'reviewed');
      if (drafts.length === 0) {
        return JSON.stringify(
          {
            success: true,
            action,
            message: `No reviewed drafts found for session ${sessionId}.`,
            batch_cap: batchCap,
            no_op_drafts: [],
          },
          null,
          2
        );
      }

      const lastReviewedAt = drafts.map((draft) => draft.reviewed_at ?? draft.updated_at).sort().at(-1);
      const toUndo = drafts.filter((draft) => (draft.reviewed_at ?? draft.updated_at) === lastReviewedAt);
      const reverted = toUndo.map((draft) => store.compareAndSetDraftState({
        sessionId,
        draftId: draft.draft_id,
        expectedVersion: draft.store_version ?? 0,
        nextState: 'batched',
        updatedAt: new Date().toISOString(),
      }));

      return JSON.stringify(
        {
          success: true,
          action,
          message: `Reverted the last reviewed batch for session ${sessionId}.`,
          batch_cap: batchCap,
          updated_drafts: reverted.map((draft) => serializeDraft(draft, false)),
        },
        null,
        2
      );
    }

    const sessionId = sessionOrDefault(args.session_id);
    const explicitDraftId = normalizeString(args.draft_id);
    const allDrafts = store.listDrafts(sessionId).sort(sortDrafts);
    const suppressionPatterns = loadSuppressionPatterns(workspacePath);
    const selectedDrafts = explicitDraftId
      ? allDrafts.filter((draft) => draft.draft_id === explicitDraftId)
      : allDrafts.filter((draft) => !isSuppressed(draft, suppressionPatterns)).slice(0, batchCap);

    if (selectedDrafts.length === 0) {
      return JSON.stringify(
        {
          success: true,
          action,
          message: explicitDraftId
            ? `No draft found for ${sessionId}/${explicitDraftId}.`
            : `No visible drafts found for session ${sessionId}.`,
          batch_cap: batchCap,
          no_op_drafts: [],
        },
        null,
        2
      );
    }

    if (action === 'edit') {
      if (!explicitDraftId) {
        throw new Error('draft_id is required for edit');
      }
      const draft = selectedDrafts[0]!;
      const updatedMetadata = {
        ...cloneMetadata(draft.metadata),
        ...(normalizeString(args.subtype) ? { subtype: normalizeString(args.subtype) } : {}),
        ...(args.tags ? { tags: normalizeList(args.tags) } : {}),
        ...(args.priority ? { priority: args.priority } : {}),
        ...(normalizeString(args.source) ? { source: normalizeString(args.source) } : {}),
        ...(args.linked_files ? { linked_files: normalizeList(args.linked_files) } : {}),
        ...(args.linked_plans ? { linked_plans: normalizeList(args.linked_plans) } : {}),
        ...(normalizeString(args.evidence) ? { evidence: normalizeString(args.evidence) } : {}),
        ...(normalizeString(args.owner) ? { owner: normalizeString(args.owner) } : {}),
      };
      const nextContent = normalizeString(args.content) ?? draft.content;
      const nextTitle = normalizeString(args.title) ?? draft.title;
      const unchanged =
        draft.content === nextContent &&
        draft.title === nextTitle &&
        JSON.stringify(cloneMetadata(draft.metadata)) === JSON.stringify(updatedMetadata);
      if (unchanged) {
        return JSON.stringify(
          {
            success: true,
            action,
            message: `Draft ${sessionId}/${draft.draft_id} already matches the requested edit.`,
            batch_cap: batchCap,
            no_op_drafts: [draft.draft_id],
            selected_drafts: [serializeDraft(draft, isSuppressed(draft, suppressionPatterns))],
          },
          null,
          2
        );
      }

      const nextRecord = createDraftSuggestionRecord({
        draft_id: draft.draft_id,
        session_id: draft.session_id,
        source_type: draft.source_type,
        source_ref: draft.source_ref,
        category: draft.category,
        content: nextContent,
        title: nextTitle,
        metadata: updatedMetadata,
        score_breakdown: draft.score_breakdown,
        confidence: draft.confidence,
        created_at: draft.created_at,
        updated_at: new Date().toISOString(),
        expires_at: draft.expires_at,
      });
      const savedRecord = {
        ...nextRecord,
        store_version: (draft.store_version ?? 0) + 1,
      };
      store.saveDraft(savedRecord);

      return JSON.stringify(
        {
          success: true,
          action,
          message: `Updated draft ${sessionId}/${draft.draft_id}.`,
          batch_cap: batchCap,
          updated_drafts: [serializeDraft(savedRecord, isSuppressed(savedRecord, suppressionPatterns))],
        },
        null,
        2
      );
    }

    if (action === 'dismiss') {
      const updated = selectedDrafts.map((draft) => {
        if (draft.state === 'dismissed') {
          return draft;
        }
        return store.compareAndSetDraftState({
          sessionId,
          draftId: draft.draft_id,
          expectedVersion: draft.store_version ?? 0,
          nextState: 'dismissed',
          updatedAt: new Date().toISOString(),
        });
      });

      return JSON.stringify(
        {
          success: true,
          action,
          message: `Dismissed ${updated.length} draft(s) for session ${sessionId}.`,
          batch_cap: batchCap,
          updated_drafts: updated.map((draft) => serializeDraft(draft, isSuppressed(draft, suppressionPatterns))),
        },
        null,
        2
      );
    }

    if (action === 'snooze') {
      const updated = selectedDrafts.map((draft) => {
        if (draft.state === 'snoozed') {
          return draft;
        }
        return store.compareAndSetDraftState({
          sessionId,
          draftId: draft.draft_id,
          expectedVersion: draft.store_version ?? 0,
          nextState: 'snoozed',
          updatedAt: new Date().toISOString(),
        });
      });

      return JSON.stringify(
        {
          success: true,
          action,
          message: `Snoozed ${updated.length} draft(s) for session ${sessionId}.`,
          batch_cap: batchCap,
          updated_drafts: updated.map((draft) => serializeDraft(draft, isSuppressed(draft, suppressionPatterns))),
        },
        null,
        2
      );
    }

    if (action === 'approve') {
      const approvedMemories = loadApprovedMemories(workspacePath);
      const promotableDrafts = selectedDrafts.filter(
        (draft) => draft.state !== 'promoted' && draft.state !== 'promoted_pending_index'
      );
      const gate = gateBulkDraftPromotion(promotableDrafts, approvedMemories, {
        override_reason: normalizeString(args.override_reason),
      });
      const updatedDrafts: DraftSuggestionRecord[] = [];
      const noOpDrafts: string[] = [];

      for (const draft of selectedDrafts) {
        if (draft.state === 'promoted' || draft.state === 'promoted_pending_index') {
          noOpDrafts.push(draft.draft_id);
          continue;
        }
      }

      for (const draft of gate.eligible) {
        let currentDraft = draft;
        if (currentDraft.state === 'drafted' || currentDraft.state === 'snoozed') {
          currentDraft = store.compareAndSetDraftState({
            sessionId,
            draftId: currentDraft.draft_id,
            expectedVersion: currentDraft.store_version ?? 0,
            nextState: 'batched',
            updatedAt: new Date().toISOString(),
          });
        }
        const reviewedDraft = currentDraft.state === 'reviewed'
          ? currentDraft
          : store.compareAndSetDraftState({
              sessionId,
              draftId: currentDraft.draft_id,
              expectedVersion: currentDraft.store_version ?? 0,
              nextState: 'reviewed',
              reviewedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });

        const payload = toPromotionPayload(reviewedDraft);
        assertPromotionPayloadSafeForPersistence(payload);
        const persistResult = await persistMemoryEntry(payload, serviceClient);
        const promotionState = persistResult.indexed ? 'promoted' : 'promoted_pending_index';
        const promoted = store.promoteDraftOnce({
          sessionId,
          draftId: reviewedDraft.draft_id,
          idempotencyKey: `review_memory_suggestions:${reviewedDraft.session_id}:${reviewedDraft.draft_id}:${reviewedDraft.promotion_payload_hash}`,
          nextState: promotionState,
          indexStatus: persistResult.indexed ? 'completed' : 'pending',
          updatedAt: new Date().toISOString(),
          promote: () => persistResult,
        });

        if (!promoted.promoted) {
          noOpDrafts.push(reviewedDraft.draft_id);
          updatedDrafts.push(promoted.record);
          continue;
        }

        updatedDrafts.push(promoted.record);
      }

      return JSON.stringify(
        {
          success: true,
          action,
          message: `Approved ${updatedDrafts.length} draft(s) for session ${sessionId}${gate.blocked.length > 0 ? `; ${gate.blocked.length} blocked by policy.` : ''}`,
          batch_cap: batchCap,
          updated_drafts: updatedDrafts.map((draft) => serializeDraft(draft, isSuppressed(draft, suppressionPatterns))),
          no_op_drafts: noOpDrafts,
          blocked_drafts: gate.blocked.map(({ draft, decision }) => ({
            draft_id: draft.draft_id,
            reason: 'conflict_block',
            conflict_matches: decision.conflict_matches.map((match) => ({
              approved_index: match.approved_index,
              approved_title: match.approved_memory.title,
              approved_category: match.approved_memory.category,
              contradiction_reason: match.contradiction_reason,
              relevance_score: match.relevance_score,
            })),
          })),
        },
        null,
        2
      );
    }

    throw new Error(`Unsupported action: ${action}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ success: false, action, error: errorMessage }, null, 2);
  }
}
