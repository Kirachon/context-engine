import { SecretScrubber } from '../reactive/guardrails/secretScrubber.js';
import { validateTrimmedNonEmptyString } from './tooling/validation.js';
import {
  type CreateDraftSuggestionInput,
  type DraftSuggestionMetadata,
  type DraftSuggestionRecord,
  createDraftSuggestionRecord,
} from './memorySuggestions.js';
import { assessDraftSuggestionSafety, getTextSafetyViolations } from './memorySuggestionSafety.js';

export const PHASE_1_MEMORY_SUGGESTION_SOURCES = [
  'plan_outputs',
  'review_outputs',
  'explicit_user_directives',
] as const;

export type MemorySuggestionSourceType = typeof PHASE_1_MEMORY_SUGGESTION_SOURCES[number];

export type DraftSuggestionRejectionReason =
  | 'source_not_allowed'
  | 'contains_secret'
  | 'raw_log'
  | 'brainstorming_fluff'
  | 'implementation_noise'
  | 'unstable_statement'
  | 'low_signal';

export interface DetectDraftSuggestionInput {
  draft_id: string;
  session_id: string;
  source_type: string;
  source_ref: string;
  category: CreateDraftSuggestionInput['category'];
  content: string;
  title?: string;
  metadata?: DraftSuggestionMetadata;
  repetition_count?: number;
  created_at?: string;
  updated_at?: string;
  expires_at?: string;
}

export type DetectDraftSuggestionResult =
  | {
      accepted: true;
      explainability: string;
      record: DraftSuggestionRecord;
    }
  | {
      accepted: false;
      rejection_reason: DraftSuggestionRejectionReason;
    };

const SOURCE_RELIABILITY: Record<MemorySuggestionSourceType, number> = {
  explicit_user_directives: 1,
  review_outputs: 0.92,
  plan_outputs: 0.86,
};

const DIRECTIVE_PATTERNS = [
  /\b(do not|don't|never|must|must not|required|block|keep|avoid|only)\b/i,
  /\bshould\b/i,
];

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}

function isAllowedSourceType(sourceType: string): sourceType is MemorySuggestionSourceType {
  return (PHASE_1_MEMORY_SUGGESTION_SOURCES as readonly string[]).includes(sourceType);
}

function containsSecret(content: string): boolean {
  const scrubber = new SecretScrubber();
  return scrubber.scrub(content).hasSecrets;
}

function computeRepetitionScore(repetitionCount?: number): number {
  const count = repetitionCount ?? 1;
  if (count <= 1) {
    return 0.25;
  }
  if (count === 2) {
    return 0.7;
  }
  return 1;
}

function computeDirectiveStrength(content: string, sourceType: MemorySuggestionSourceType): number {
  if (DIRECTIVE_PATTERNS[0].test(content)) {
    return 1;
  }
  if (DIRECTIVE_PATTERNS[1].test(content)) {
    return 0.75;
  }
  return sourceType === 'explicit_user_directives' ? 0.7 : 0.45;
}

function computeTraceability(
  metadata: DraftSuggestionMetadata | undefined,
  sourceRef: string,
  title?: string
): number {
  let score = 0.2;
  if (title?.trim()) {
    score += 0.1;
  }
  if (sourceRef.trim()) {
    score += 0.2;
  }
  if (metadata?.evidence?.trim()) {
    score += 0.2;
  }
  if ((metadata?.linked_files?.length ?? 0) > 0) {
    score += 0.15;
  }
  if ((metadata?.linked_plans?.length ?? 0) > 0) {
    score += 0.1;
  }
  if (metadata?.source?.trim()) {
    score += 0.05;
  }
  return clampScore(score);
}

function computeStabilityPenalty(content: string): number {
  let penalty = 0;
  const violations = new Set(getTextSafetyViolations(content));
  if (violations.has('unstable_statement')) {
    penalty += 0.45;
  }
  if (violations.has('brainstorming_fluff')) {
    penalty += 0.2;
  }
  if (/\btemporary\b/i.test(content) || /\bwip\b/i.test(content)) {
    penalty += 0.2;
  }
  return clampScore(penalty);
}

function buildExplainability(record: DraftSuggestionRecord): string {
  const reasons: string[] = [];
  if (record.score_breakdown.directive_strength >= 0.75) {
    reasons.push('directive phrasing');
  }
  if (record.score_breakdown.source_reliability >= 0.85) {
    reasons.push('trusted source');
  }
  if (record.score_breakdown.traceability >= 0.7) {
    reasons.push('traceable evidence');
  }
  if (record.score_breakdown.repetition >= 0.7) {
    reasons.push('repeated signal');
  }
  if (reasons.length === 0) {
    reasons.push('high-signal input');
  }
  return `Suggested because ${reasons.join(', ')}.`;
}

export function detectDraftSuggestion(input: DetectDraftSuggestionInput): DetectDraftSuggestionResult {
  const sourceType = validateTrimmedNonEmptyString(input.source_type, 'source_type is required');
  if (!isAllowedSourceType(sourceType)) {
    return {
      accepted: false,
      rejection_reason: 'source_not_allowed',
    };
  }

  const content = validateTrimmedNonEmptyString(input.content, 'content is required');
  if (containsSecret(content)) {
    return {
      accepted: false,
      rejection_reason: 'contains_secret',
    };
  }
  const safetyProbe = createDraftSuggestionRecord({
    draft_id: 'safety-probe',
    session_id: 'safety-probe',
    source_type: sourceType,
    source_ref: input.source_ref,
    category: input.category,
    content,
    title: input.title,
    metadata: input.metadata,
    score_breakdown: {
      repetition: 0,
      directive_strength: 0,
      source_reliability: 0,
      traceability: 0,
      stability_penalty: 0,
    },
    confidence: 0,
    state: 'detected',
  });
  const contentAssessment = assessDraftSuggestionSafety(safetyProbe);
  const highestPriorityViolation = contentAssessment.issues[0]?.violation;
  if (highestPriorityViolation && highestPriorityViolation !== 'contains_secret') {
    return {
      accepted: false,
      rejection_reason: highestPriorityViolation,
    };
  }

  const score_breakdown = {
    repetition: computeRepetitionScore(input.repetition_count),
    directive_strength: computeDirectiveStrength(content, sourceType),
    source_reliability: SOURCE_RELIABILITY[sourceType],
    traceability: computeTraceability(input.metadata, input.source_ref, input.title),
    stability_penalty: computeStabilityPenalty(content),
  };

  const confidence = clampScore(
    (score_breakdown.repetition * 0.18)
    + (score_breakdown.directive_strength * 0.3)
    + (score_breakdown.source_reliability * 0.26)
    + (score_breakdown.traceability * 0.26)
    - (score_breakdown.stability_penalty * 0.45)
  );

  if (confidence < 0.68) {
    return {
      accepted: false,
      rejection_reason: 'low_signal',
    };
  }

  const record = createDraftSuggestionRecord({
    draft_id: input.draft_id,
    session_id: input.session_id,
    source_type: sourceType,
    source_ref: input.source_ref,
    category: input.category,
    content,
    title: input.title,
    metadata: input.metadata,
    score_breakdown,
    confidence,
    created_at: input.created_at,
    updated_at: input.updated_at,
    expires_at: input.expires_at,
  });

  return {
    accepted: true,
    explainability: buildExplainability(record),
    record,
  };
}
