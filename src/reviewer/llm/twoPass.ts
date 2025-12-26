import { extractJsonFromResponse } from '../../mcp/prompts/codeReview.js';
import type { EnterpriseFinding } from '../types.js';
import type { EnterpriseLLMClient, LLMCallResult } from './types.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseFindingsObject(raw: unknown): { findings: EnterpriseFinding[]; warnings: string[] } {
  const warnings: string[] = [];
  if (!isObject(raw)) return { findings: [], warnings: ['LLM response JSON is not an object'] };

  const findingsRaw = raw.findings;
  if (!Array.isArray(findingsRaw)) return { findings: [], warnings: ['LLM response missing findings[]'] };

  const findings: EnterpriseFinding[] = [];
  for (const item of findingsRaw) {
    if (!isObject(item)) continue;

    const id = asString(item.id);
    const severity = asString(item.severity);
    const category = asString(item.category);
    const confidence = asNumber(item.confidence);
    const title = asString(item.title);
    const locationRaw = item.location;
    const evidenceRaw = item.evidence;
    const impact = asString(item.impact);
    const recommendation = asString(item.recommendation);
    const suggestedPatch = asString(item.suggested_patch);

    if (!id || !severity || !category || confidence === null || !title || !impact || !recommendation) continue;
    if (!isObject(locationRaw)) continue;
    const file = asString(locationRaw.file);
    const startLine = asNumber(locationRaw.startLine);
    const endLine = asNumber(locationRaw.endLine ?? locationRaw.startLine);
    if (!file || startLine === null || endLine === null) continue;

    const evidence =
      Array.isArray(evidenceRaw) ? evidenceRaw.filter(e => typeof e === 'string').slice(0, 5) : [];

    findings.push({
      id,
      severity: severity as EnterpriseFinding['severity'],
      category: category as EnterpriseFinding['category'],
      confidence,
      title,
      location: { file, startLine, endLine },
      evidence,
      impact,
      recommendation,
      suggested_patch: suggestedPatch ?? undefined,
    });
  }

  return { findings, warnings };
}

async function callAndParse(llm: EnterpriseLLMClient, searchQuery: string, prompt: string): Promise<LLMCallResult> {
  const warnings: string[] = [];
  const response = await llm.call(searchQuery, prompt);
  const jsonStr = extractJsonFromResponse(response);
  if (!jsonStr) {
    return { findings: [], warnings: ['Failed to extract JSON from LLM response'] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { findings: [], warnings: ['Failed to parse JSON from LLM response'], raw_json: jsonStr };
  }

  const { findings, warnings: parseWarnings } = parseFindingsObject(parsed);
  warnings.push(...parseWarnings);
  return { findings, warnings, raw_json: jsonStr };
}

export interface TwoPassOptions {
  enabled: boolean;
  twoPass: boolean;
  riskThreshold: number;
}

export async function runTwoPassReview(args: {
  llm: EnterpriseLLMClient;
  options: TwoPassOptions;
  riskScore: number;
  buildStructuralPrompt: () => string;
  buildDetailedPrompt: (structuralJson: string) => string;
}): Promise<{ findings: EnterpriseFinding[]; warnings: string[]; passes_executed: number }> {
  const warnings: string[] = [];
  if (!args.options.enabled) {
    return { findings: [], warnings, passes_executed: 0 };
  }

  const structural = await callAndParse(args.llm, 'Enterprise code review (structural)', args.buildStructuralPrompt());
  warnings.push(...structural.warnings);

  let findings: EnterpriseFinding[] = structural.findings;
  let passes = 1;

  const shouldRunDetailed =
    args.options.twoPass &&
    (args.riskScore >= args.options.riskThreshold || structural.findings.some(f => f.severity === 'CRITICAL' || f.severity === 'HIGH'));

  if (shouldRunDetailed) {
    const detailedPrompt = args.buildDetailedPrompt(structural.raw_json ?? JSON.stringify({ findings: structural.findings }));
    const detailed = await callAndParse(args.llm, 'Enterprise code review (detailed)', detailedPrompt);
    warnings.push(...detailed.warnings);
    findings = [...findings, ...detailed.findings];
    passes = 2;
  }

  return { findings, warnings, passes_executed: passes };
}

