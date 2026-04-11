import { type MemoryCategory } from './tools/memory.js';
import { type DraftSuggestionRecord } from './memorySuggestions.js';

export interface ApprovedMemoryRecord {
  category: MemoryCategory;
  content: string;
  title?: string;
  conflict_key?: string;
  source?: string;
}

export interface ConflictMatch {
  approved_memory: ApprovedMemoryRecord;
  approved_index: number;
  relevance_score: number;
  candidate_conflict_key: string;
  approved_conflict_key: string;
  contradiction_reason: string;
}

export interface PromotionDecision {
  allowed: boolean;
  requires_override_reason: boolean;
  override_applied: boolean;
  conflict_matches: ConflictMatch[];
}

export interface PromotionGateOptions {
  override_reason?: string;
  top_n?: number;
}

export interface BulkPromotionDecision {
  eligible: DraftSuggestionRecord[];
  blocked: Array<{
    draft: DraftSuggestionRecord;
    decision: PromotionDecision;
  }>;
}

const NEGATIVE_DIRECTIVES = [
  /\bdo not\b/i,
  /\bdon't\b/i,
  /\bnever\b/i,
  /\bmust not\b/i,
  /\bavoid\b/i,
  /\bblock\b/i,
  /\bforbid\b/i,
  /\bprevent\b/i,
  /\bdisallow\b/i,
];

const POSITIVE_DIRECTIVES = [
  /\ballow\b/i,
  /\benable\b/i,
  /\bship\b/i,
  /\brequire\b/i,
  /\bkeep\b/i,
  /\buse\b/i,
  /\bpromote\b/i,
];

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'if',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'we',
  'with',
]);

type DirectiveStance = 'negative' | 'positive' | 'neutral';

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function detectDirectiveStance(value: string): DirectiveStance {
  if (NEGATIVE_DIRECTIVES.some((pattern) => pattern.test(value))) {
    return 'negative';
  }
  if (POSITIVE_DIRECTIVES.some((pattern) => pattern.test(value))) {
    return 'positive';
  }
  return 'neutral';
}

function normalizeConflictTokens(value: string): string[] {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1)
    .filter((token) => !STOP_WORDS.has(token))
    .filter(
      (token) =>
        token !== 'do'
        && token !== 'not'
        && token !== 'dont'
        && token !== 'never'
        && token !== 'must'
        && token !== 'avoid'
        && token !== 'allow'
        && token !== 'enable'
        && token !== 'keep'
        && token !== 'use'
        && token !== 'block'
    );
}

function buildNormalizedConflictKey(category: MemoryCategory, value: string): string {
  const tokens = Array.from(new Set(normalizeConflictTokens(value))).sort((left, right) => left.localeCompare(right));
  return `${category}:${tokens.join(' ')}`;
}

function tokenizeForOverlap(value: string): Set<string> {
  return new Set(normalizeConflictTokens(value));
}

function computeTokenOverlap(left: string, right: string): number {
  const leftTokens = tokenizeForOverlap(left);
  const rightTokens = tokenizeForOverlap(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }
  return intersection / Math.max(leftTokens.size, rightTokens.size);
}

function computeConflictKeyOverlap(left: string, right: string): number {
  const leftKey = left.includes(':') ? left.split(':', 2)[1] : left;
  const rightKey = right.includes(':') ? right.split(':', 2)[1] : right;
  return computeTokenOverlap(leftKey, rightKey);
}

function getApprovedConflictKey(memory: ApprovedMemoryRecord): string {
  return memory.conflict_key?.trim()
    ? memory.conflict_key.trim().toLowerCase()
    : buildNormalizedConflictKey(memory.category, memory.content);
}

function getDraftConflictKey(record: DraftSuggestionRecord): string {
  const explicit = record.conflict_key?.trim();
  if (explicit && explicit !== `${record.category}:${record.content.toLowerCase()}`) {
    return explicit.toLowerCase();
  }
  return buildNormalizedConflictKey(record.category, record.content);
}

function computeRelevanceScore(
  draft: DraftSuggestionRecord,
  approvedMemory: ApprovedMemoryRecord,
  candidateConflictKey: string,
  approvedConflictKey: string
): number {
  let score = 0;
  if (draft.category === approvedMemory.category) {
    score += 0.1;
  }
  if (candidateConflictKey === approvedConflictKey) {
    score += 0.7;
  } else {
    score += computeConflictKeyOverlap(candidateConflictKey, approvedConflictKey) * 0.5;
  }
  score += computeTokenOverlap(draft.content, approvedMemory.content) * 0.4;
  if (draft.title && approvedMemory.title && normalizeWhitespace(draft.title).toLowerCase() === normalizeWhitespace(approvedMemory.title).toLowerCase()) {
    score += 0.1;
  }
  return Number(score.toFixed(4));
}

function describeContradiction(candidate: DraftSuggestionRecord, approvedMemory: ApprovedMemoryRecord): string {
  return `Candidate draft contradicts approved ${approvedMemory.category} memory${approvedMemory.title ? ` "${approvedMemory.title}"` : ''}.`;
}

function isContradiction(candidate: DraftSuggestionRecord, approvedMemory: ApprovedMemoryRecord): boolean {
  if (candidate.category !== approvedMemory.category) {
    return false;
  }
  const candidateConflictKey = getDraftConflictKey(candidate);
  const approvedConflictKey = getApprovedConflictKey(approvedMemory);
  const overlap = computeTokenOverlap(candidate.content, approvedMemory.content);
  if (candidateConflictKey !== approvedConflictKey && overlap < 0.6) {
    return false;
  }
  const candidateStance = detectDirectiveStance(candidate.content);
  const approvedStance = detectDirectiveStance(approvedMemory.content);
  return candidateStance !== 'neutral' && approvedStance !== 'neutral' && candidateStance !== approvedStance;
}

export function findDraftConflicts(
  candidate: DraftSuggestionRecord,
  approvedMemories: ApprovedMemoryRecord[],
  topN: number = 5
): ConflictMatch[] {
  const candidateConflictKey = getDraftConflictKey(candidate);
  return approvedMemories
    .map((approvedMemory, approvedIndex) => {
      const approvedConflictKey = getApprovedConflictKey(approvedMemory);
      return {
        approved_memory: approvedMemory,
        approved_index: approvedIndex,
        relevance_score: computeRelevanceScore(candidate, approvedMemory, candidateConflictKey, approvedConflictKey),
        candidate_conflict_key: candidateConflictKey,
        approved_conflict_key: approvedConflictKey,
        contradiction_reason: describeContradiction(candidate, approvedMemory),
        contradicted: isContradiction(candidate, approvedMemory),
      };
    })
    .sort((left, right) => right.relevance_score - left.relevance_score || left.approved_index - right.approved_index)
    .slice(0, Math.max(1, topN))
    .filter((match) => match.contradicted)
    .map(({ contradicted: _contradicted, ...match }) => match);
}

export function gateDraftPromotion(
  candidate: DraftSuggestionRecord,
  approvedMemories: ApprovedMemoryRecord[],
  options: PromotionGateOptions = {}
): PromotionDecision {
  const topN = options.top_n ?? 5;
  const conflictMatches = findDraftConflicts(candidate, approvedMemories, topN);
  const hasOverrideReason = Boolean(options.override_reason?.trim());
  if (conflictMatches.length === 0) {
    return {
      allowed: true,
      requires_override_reason: false,
      override_applied: false,
      conflict_matches: [],
    };
  }
  if (!hasOverrideReason) {
    return {
      allowed: false,
      requires_override_reason: true,
      override_applied: false,
      conflict_matches: conflictMatches,
    };
  }
  return {
    allowed: true,
    requires_override_reason: true,
    override_applied: true,
    conflict_matches: conflictMatches,
  };
}

export function gateBulkDraftPromotion(
  drafts: DraftSuggestionRecord[],
  approvedMemories: ApprovedMemoryRecord[],
  options: PromotionGateOptions = {}
): BulkPromotionDecision {
  const eligible: DraftSuggestionRecord[] = [];
  const blocked: BulkPromotionDecision['blocked'] = [];

  for (const draft of drafts) {
    const decision = gateDraftPromotion(draft, approvedMemories, options);
    if (decision.allowed) {
      eligible.push(draft);
    } else {
      blocked.push({ draft, decision });
    }
  }

  return { eligible, blocked };
}
