import { SecretScrubber } from '../reactive/guardrails/secretScrubber.js';
import { type DraftSuggestionRecord } from './memorySuggestions.js';
import { type AddMemoryArgs } from './tools/memory.js';

export type MemorySuggestionSafetyViolation =
  | 'contains_secret'
  | 'raw_log'
  | 'brainstorming_fluff'
  | 'implementation_noise'
  | 'unstable_statement';

export interface MemorySuggestionSafetyIssue {
  violation: MemorySuggestionSafetyViolation;
  field: string;
}

export interface MemorySuggestionSafetyAssessment {
  safe: boolean;
  issues: MemorySuggestionSafetyIssue[];
}

const UNSTABLE_PATTERNS = [
  /\bmaybe\b/i,
  /\bperhaps\b/i,
  /\bprobably\b/i,
  /\bi think\b/i,
  /\blet'?s try\b/i,
  /\bif it works\b/i,
  /\bfor now\b/i,
  /\blater\b/i,
  /\bexperiment\b/i,
  /\bfeels right\b/i,
];

const IMPLEMENTATION_NOISE_PATTERNS = [
  /\bconsole\.log\b/i,
  /\bdebug\b/i,
  /\btypo\b/i,
  /\bwhitespace\b/i,
  /\bformat(?:ting)?\b/i,
  /\btemp\w*\b/i,
  /\bvariable\b/i,
];

const BRAINSTORMING_FLUFF_PATTERNS = [
  /\bwhat if\b/i,
  /\bnice to have\b/i,
  /\bkind of\b/i,
  /\bjust thinking\b/i,
  /\bcould be cool\b/i,
];

const RAW_LOG_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/m,
  /^\s*at\s.+:\d+:\d+\)?$/m,
  /\b(ERROR|WARN|INFO|DEBUG|TRACE)\b/,
  /node:internal\//,
];

function looksLikeRawLog(content: string): boolean {
  return RAW_LOG_PATTERNS.filter((pattern) => pattern.test(content)).length >= 2;
}

function looksLikeImplementationNoise(content: string): boolean {
  if (/\brename\b/i.test(content) && /\b(temp\w*|variable|field|prop)\b/i.test(content)) {
    return true;
  }
  return IMPLEMENTATION_NOISE_PATTERNS.some((pattern) => pattern.test(content));
}

function looksLikeBrainstormingFluff(content: string): boolean {
  return BRAINSTORMING_FLUFF_PATTERNS.some((pattern) => pattern.test(content));
}

function looksUnstable(content: string): boolean {
  return UNSTABLE_PATTERNS.some((pattern) => pattern.test(content));
}

function assessTextField(field: string, value: string | undefined, scrubber: SecretScrubber): MemorySuggestionSafetyIssue[] {
  if (!value?.trim()) {
    return [];
  }

  const issues: MemorySuggestionSafetyIssue[] = [];
  if (scrubber.scrub(value).hasSecrets) {
    issues.push({ violation: 'contains_secret', field });
  }
  if (looksLikeRawLog(value)) {
    issues.push({ violation: 'raw_log', field });
  }
  if (looksLikeImplementationNoise(value)) {
    issues.push({ violation: 'implementation_noise', field });
  }
  if (looksUnstable(value)) {
    issues.push({ violation: 'unstable_statement', field });
  }
  if (looksLikeBrainstormingFluff(value)) {
    issues.push({ violation: 'brainstorming_fluff', field });
  }
  return issues;
}

export function getTextSafetyViolations(value: string | undefined): MemorySuggestionSafetyViolation[] {
  if (!value?.trim()) {
    return [];
  }
  const scrubber = new SecretScrubber();
  return dedupeIssues(assessTextField('value', value, scrubber)).map((issue) => issue.violation);
}

function dedupeIssues(issues: MemorySuggestionSafetyIssue[]): MemorySuggestionSafetyIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.field}:${issue.violation}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function assessDraftSuggestionSafety(record: DraftSuggestionRecord): MemorySuggestionSafetyAssessment {
  const scrubber = new SecretScrubber();
  const issues = dedupeIssues([
    ...assessTextField('content', record.content, scrubber),
    ...assessTextField('title', record.title, scrubber),
    ...assessTextField('metadata.source', record.metadata.source, scrubber),
    ...assessTextField('metadata.evidence', record.metadata.evidence, scrubber),
    ...(record.metadata.tags ?? []).flatMap((tag) => assessTextField('metadata.tags', tag, scrubber)),
  ]);

  return {
    safe: issues.length === 0,
    issues,
  };
}

export function assessPromotionPayloadSafety(payload: AddMemoryArgs): MemorySuggestionSafetyAssessment {
  const scrubber = new SecretScrubber();
  const issues = dedupeIssues([
    ...assessTextField('content', payload.content, scrubber),
    ...assessTextField('title', payload.title, scrubber),
    ...assessTextField('source', payload.source, scrubber),
    ...assessTextField('evidence', payload.evidence, scrubber),
    ...(payload.tags ?? []).flatMap((tag) => assessTextField('tags', tag, scrubber)),
  ]);

  return {
    safe: issues.length === 0,
    issues,
  };
}

export function assertDraftSuggestionSafeForPersistence(record: DraftSuggestionRecord): void {
  const assessment = assessDraftSuggestionSafety(record);
  if (!assessment.safe) {
    const summary = assessment.issues
      .map((issue) => `${issue.field}:${issue.violation}`)
      .join(', ');
    throw new Error(`Draft suggestion blocked by safety pipeline: ${summary}`);
  }
}

export function assertPromotionPayloadSafeForPersistence(payload: AddMemoryArgs): void {
  const assessment = assessPromotionPayloadSafety(payload);
  if (!assessment.safe) {
    const summary = assessment.issues
      .map((issue) => `${issue.field}:${issue.violation}`)
      .join(', ');
    throw new Error(`Memory promotion blocked by safety pipeline: ${summary}`);
  }
}
