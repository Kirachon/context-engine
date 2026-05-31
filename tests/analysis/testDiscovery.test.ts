import { describe, expect, it } from '@jest/globals';

import {
  buildImpactAnalysisEnrichment,
  buildRecommendedValidation,
  buildRuntimeImpact,
  deriveNamingConventionCandidates,
  discoverTestCandidates,
  isTestPath,
  normalizeAnalysisPath,
} from '../../src/analysis/testDiscovery.js';

const definitionFixture = {
  found: true as const,
  symbol: 'targetSymbol',
  file: 'src/target.ts',
  line: 8,
  kind: 'function',
};

const referencesFixture = [
  { path: 'src/caller.ts' },
  { path: 'tests/target.test.ts' },
];

const callersFixture = [
  { file: 'src/caller.ts', callerSymbol: 'runCaller' },
];

const calleesFixture = [
  { file: 'src/callee.ts', calleeSymbol: 'childCall' },
];

describe('testDiscovery', () => {
  it('detects common test path patterns', () => {
    expect(isTestPath('tests/auth/login.test.ts')).toBe(true);
    expect(isTestPath('src/auth/__tests__/login.spec.ts')).toBe(true);
    expect(isTestPath('src/auth/login.ts')).toBe(false);
  });

  it('derives deterministic naming convention candidates for source files', () => {
    const candidates = deriveNamingConventionCandidates('src/auth/login.ts');

    expect(candidates.map((candidate) => candidate.path)).toEqual([
      'src/auth/login.test.ts',
      'src/auth/login.spec.ts',
      'src/auth/__tests__/login.test.ts',
      'src/auth/__tests__/login.spec.ts',
      'tests/auth/login.test.ts',
      'tests/auth/login.spec.ts',
      'test/auth/login.test.ts',
      'test/auth/login.spec.ts',
    ]);
  });

  it('discovers graph-backed and heuristic test candidates for a symbol', () => {
    const candidates = discoverTestCandidates({
      symbol: 'targetSymbol',
      definition: definitionFixture,
      references: referencesFixture,
      callers: callersFixture,
      callees: calleesFixture,
    });

    expect(candidates[0]).toEqual(
      expect.objectContaining({
        path: 'tests/target.test.ts',
        strategy: 'symbol_reference',
        confidence: 'high',
      })
    );
    expect(candidates.some((candidate) => candidate.path === 'tests/target.test.ts')).toBe(true);
    expect(candidates.some((candidate) => candidate.path === 'src/target.test.ts')).toBe(true);
    expect(candidates.some((candidate) => candidate.path === 'tests/caller.test.ts')).toBe(true);
  });

  it('builds runtime impact excluding test files', () => {
    expect(
      buildRuntimeImpact({
        definition: definitionFixture,
        references: referencesFixture,
        callers: callersFixture,
        callees: calleesFixture,
      })
    ).toEqual([
      { path: 'src/callee.ts', role: 'callee', symbol: 'childCall' },
      { path: 'src/caller.ts', role: 'reference' },
      { path: 'src/target.ts', role: 'definition', symbol: 'targetSymbol' },
    ]);
  });

  it('builds enrichment with risks and recommended validation commands', () => {
    const enrichment = buildImpactAnalysisEnrichment({
      symbol: 'targetSymbol',
      definition: definitionFixture,
      references: referencesFixture,
      callers: callersFixture,
      callees: calleesFixture,
      riskLevel: 'low',
      riskReasons: [],
      degraded: false,
      degradedReasons: [],
    });

    expect(enrichment.test_candidates[0]?.path).toBe('tests/target.test.ts');
    expect(enrichment.runtime_impact).toHaveLength(3);
    expect(enrichment.recommended_validation[0]).toEqual(
      expect.objectContaining({
        kind: 'test_command',
        command: 'npm test -- --runInBand tests/target.test.ts',
      })
    );
    expect(enrichment.risks.some((risk) => risk.code === 'test_coverage_gap')).toBe(false);
  });

  it('flags test coverage gaps when no graph-backed tests are found', () => {
    const enrichment = buildImpactAnalysisEnrichment({
      symbol: 'targetSymbol',
      definition: definitionFixture,
      references: [{ path: 'src/caller.ts' }],
      callers: callersFixture,
      callees: calleesFixture,
      riskLevel: 'medium',
      riskReasons: ['many_direct_callers'],
      degraded: true,
      degradedReasons: ['graph_partial'],
    });

    expect(enrichment.risks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'many_direct_callers' }),
        expect.objectContaining({ code: 'graph_degraded' }),
        expect.objectContaining({ code: 'test_coverage_gap' }),
      ])
    );
  });

  it('normalizes Windows-style paths deterministically', () => {
    expect(normalizeAnalysisPath('src\\target.ts')).toBe('src/target.ts');
    expect(
      buildRecommendedValidation({
        symbol: 'targetSymbol',
        testCandidates: [
          {
            path: 'tests/target.test.ts',
            strategy: 'symbol_reference',
            confidence: 'high',
            reason: 'test reference',
          },
        ],
        runtimeImpact: [{ path: 'src/target.ts', role: 'definition', symbol: 'targetSymbol' }],
        riskLevel: 'low',
      })[0]?.command
    ).toBe('npm test -- --runInBand tests/target.test.ts');
  });
});
