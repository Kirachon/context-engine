import * as fs from 'node:fs';
import * as path from 'node:path';

import { getToolManifest } from '../src/mcp/tools/manifest.js';
import {
  sha256Hex,
  type NormalizedUsefulnessCaseReceipt,
  type NormalizedUsefulnessReceipt,
} from './normalizeEvalOutput.js';

interface SelectionProfile {
  intent_tags?: string[];
  preferred_when?: string[];
  avoid_when?: string[];
  selection_signals?: string[];
  operation_risk?: string[];
}

interface DiscoverabilityTool {
  id: string;
  title?: string;
  usage_hint?: string;
  examples?: string[];
  safety_hints?: string[];
  selection_profile?: SelectionProfile;
}

interface ToolSelectionIntentFixture {
  intent: string;
  expected_tools: string[];
}

export interface UsefulnessEvalPaths {
  repoRoot: string;
  intentsFixturePath: string;
}

function metadataText(tool: DiscoverabilityTool): string {
  return [
    tool.title,
    tool.usage_hint,
    ...(tool.examples ?? []),
    ...(tool.safety_hints ?? []),
    ...(tool.selection_profile?.preferred_when ?? []),
    ...(tool.selection_profile?.avoid_when ?? []),
    ...(tool.selection_profile?.selection_signals ?? []),
    ...(tool.selection_profile?.intent_tags ?? []),
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ');
}

export function selectToolsForIntent(intent: string, tools: DiscoverabilityTool[]): string[] {
  const tokens = intent
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .filter((token) => token.length > 2);

  return tools
    .map((tool) => {
      const haystack = metadataText(tool).toLowerCase();
      const tokenScore = tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
      const tagScore = (tool.selection_profile?.intent_tags ?? []).reduce(
        (score, tag) => score + (tokens.some((token) => tag.includes(token) || token.includes(tag)) ? 3 : 0),
        0
      );
      return { id: tool.id, score: tokenScore + tagScore };
    })
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, 3)
    .map((tool) => tool.id);
}

function readJsonFile<T>(filePath: string): T {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Missing fixture file: ${resolved}`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8')) as T;
}

function roundRate(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function buildUsefulnessReceipt(paths: UsefulnessEvalPaths): NormalizedUsefulnessReceipt {
  const intentsFixturePath = path.resolve(paths.repoRoot, paths.intentsFixturePath);
  const fixtures = readJsonFile<ToolSelectionIntentFixture[]>(intentsFixturePath);
  const manifest = getToolManifest() as {
    discoverability?: {
      tools?: DiscoverabilityTool[];
    };
  };
  const tools = manifest.discoverability?.tools ?? [];

  fixtures.sort((left, right) => left.intent.localeCompare(right.intent));

  let topOneMatches = 0;
  const cases: NormalizedUsefulnessCaseReceipt[] = fixtures.map((fixture) => {
    const selectedTools = selectToolsForIntent(fixture.intent, tools);
    const topTool = selectedTools[0] ?? '';
    const topOneMatch = fixture.expected_tools.includes(topTool);
    if (topOneMatch) {
      topOneMatches += 1;
    }
    const expectedTools = [...fixture.expected_tools].sort();
    const matchedExpected = selectedTools.some((tool) => expectedTools.includes(tool));
    return {
      intent_hash: sha256Hex(fixture.intent),
      top_tool: topTool,
      top_one_match: topOneMatch,
      matched_expected: matchedExpected,
      selected_tools: selectedTools,
      expected_tools: expectedTools,
    };
  });

  const topOneRate = fixtures.length === 0 ? 0 : roundRate(topOneMatches / fixtures.length);

  return {
    source_fixture: paths.intentsFixturePath.replace(/\\/g, '/'),
    case_count: cases.length,
    top_one_rate: topOneRate,
    cases,
  };
}

export function resolveDefaultUsefulnessPaths(repoRoot: string): UsefulnessEvalPaths {
  return {
    repoRoot,
    intentsFixturePath: path.join('tests', 'fixtures', 'tool-selection-intents.json'),
  };
}
