import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  selectCanaryProvider,
  type CanaryDecisionInput,
} from '../../../src/ai/providers/canarySelector.js';
import type { ProviderEnvConfig } from '../../../src/ai/providers/env.js';

function envOf(overrides: Partial<ProviderEnvConfig> = {}): ProviderEnvConfig {
  return {
    providerId: 'openai_session',
    experimentalEnabled: true,
    shadowEnabled: false,
    canaryEnabled: true,
    ...overrides,
  };
}

describe('selectCanaryProvider — gating', () => {
  it('returns disabled when experimental flag is off', () => {
    const d = selectCanaryProvider({ env: envOf({ experimentalEnabled: false, canaryEnabled: false }) });
    expect(d.mode).toBe('disabled');
    expect(d.providerId).toBe('openai_session');
    expect(d.rollbackProviderId).toBe('openai_session');
  });

  it('returns disabled when canary flag is off (experimental on)', () => {
    const d = selectCanaryProvider({ env: envOf({ canaryEnabled: false }) });
    expect(d.mode).toBe('disabled');
    expect(d.providerId).toBe('openai_session');
  });
});

describe('selectCanaryProvider — target resolution', () => {
  it('falls back to rollback when no target is provided', () => {
    const d = selectCanaryProvider({ env: envOf() });
    expect(d.mode).toBe('rollback_default');
    expect(d.providerId).toBe('openai_session');
  });

  it('falls back to rollback when target is whitespace only', () => {
    const d = selectCanaryProvider({ env: envOf(), canaryTargetId: '   ' });
    expect(d.mode).toBe('rollback_default');
    expect(d.providerId).toBe('openai_session');
  });

  it('falls back to rollback when target equals openai_session (target == rollback, no real canary)', () => {
    const d = selectCanaryProvider({ env: envOf(), canaryTargetId: 'openai_session' });
    expect(d.mode).toBe('rollback_default');
    expect(d.providerId).toBe('openai_session');
  });

  it('returns invalid_target when target is not in registry, with id embedded in reason', () => {
    const d = selectCanaryProvider({ env: envOf(), canaryTargetId: 'unknown_xyz' });
    expect(d.mode).toBe('invalid_target');
    expect(d.providerId).toBe('openai_session');
    expect(d.reason).toContain('unknown_xyz');
  });

  it('overlap case: target=openai_session with samplePercent=100 still routes via rollback (case 5 wins)', () => {
    const d = selectCanaryProvider({
      env: envOf(),
      canaryTargetId: 'openai_session',
      canarySamplePercent: 100,
    });
    expect(d.mode).toBe('rollback_default');
  });
});

describe('selectCanaryProvider — sampling (with injected isKnownIdOverride)', () => {
  const baseInput = (
    overrides: Partial<CanaryDecisionInput> = {},
  ): CanaryDecisionInput => ({
    env: envOf(),
    canaryTargetId: 'canary_test',
    isKnownIdOverride: () => true,
    ...overrides,
  });

  it('samplePercent=0 → rollback_default with reason mentioning 0%', () => {
    const d = selectCanaryProvider(baseInput({ canarySamplePercent: 0 }));
    expect(d.mode).toBe('rollback_default');
    expect(d.reason).toContain('0%');
  });

  it('samplePercent=100 → canary_selected, providerId is the target, reason mentions 100%', () => {
    const d = selectCanaryProvider(baseInput({ canarySamplePercent: 100 }));
    expect(d.mode).toBe('canary_selected');
    expect(d.providerId).toBe('canary_test');
    expect(d.reason).toContain('100%');
  });

  it('default samplePercent (undefined) → coerced to 100 → canary_selected', () => {
    const d = selectCanaryProvider(baseInput({}));
    expect(d.mode).toBe('canary_selected');
    expect(d.providerId).toBe('canary_test');
  });

  it('samplePercent=50 with requestKey is deterministic across repeated calls', () => {
    const a = selectCanaryProvider(baseInput({ canarySamplePercent: 50, requestKey: 'r1' }));
    const b = selectCanaryProvider(baseInput({ canarySamplePercent: 50, requestKey: 'r1' }));
    expect(a.mode).toBe(b.mode);
    expect(a.providerId).toBe(b.providerId);

    const c = selectCanaryProvider(baseInput({ canarySamplePercent: 50, requestKey: 'r2' }));
    const d = selectCanaryProvider(baseInput({ canarySamplePercent: 50, requestKey: 'r2' }));
    expect(c.mode).toBe(d.mode);
  });

  it('samplePercent=50 with randomSeed=()=>0.1 → canary_selected', () => {
    const d = selectCanaryProvider(baseInput({ canarySamplePercent: 50, randomSeed: () => 0.1 }));
    expect(d.mode).toBe('canary_selected');
    expect(d.providerId).toBe('canary_test');
  });

  it('samplePercent=50 with randomSeed=()=>0.9 → rollback_default', () => {
    const d = selectCanaryProvider(baseInput({ canarySamplePercent: 50, randomSeed: () => 0.9 }));
    expect(d.mode).toBe('rollback_default');
    expect(d.providerId).toBe('openai_session');
  });

  it('samplePercent=NaN → coerced to 0 → rollback_default', () => {
    const d = selectCanaryProvider(baseInput({ canarySamplePercent: Number.NaN }));
    expect(d.mode).toBe('rollback_default');
  });

  it('samplePercent=-10 → clamped to 0 → rollback_default', () => {
    const d = selectCanaryProvider(baseInput({ canarySamplePercent: -10 }));
    expect(d.mode).toBe('rollback_default');
  });

  it('samplePercent=999 → clamped to 100 → canary_selected', () => {
    const d = selectCanaryProvider(baseInput({ canarySamplePercent: 999 }));
    expect(d.mode).toBe('canary_selected');
    expect(d.providerId).toBe('canary_test');
  });

  it('isKnownIdOverride=()=>false routes through invalid_target branch', () => {
    const d = selectCanaryProvider(
      baseInput({ canaryTargetId: 'whatever', isKnownIdOverride: () => false }),
    );
    expect(d.mode).toBe('invalid_target');
    expect(d.providerId).toBe('openai_session');
    expect(d.reason).toContain('whatever');
  });
});

describe('selectCanaryProvider — invariants', () => {
  it('rollbackProviderId is always "openai_session" regardless of mode', () => {
    const cases: CanaryDecisionInput[] = [
      { env: envOf({ experimentalEnabled: false, canaryEnabled: false }) },
      { env: envOf() },
      { env: envOf(), canaryTargetId: 'unknown_xyz' },
      { env: envOf(), canaryTargetId: 'canary_test', isKnownIdOverride: () => true, canarySamplePercent: 100 },
      { env: envOf(), canaryTargetId: 'canary_test', isKnownIdOverride: () => true, canarySamplePercent: 0 },
      { env: envOf(), canaryTargetId: 'canary_test', isKnownIdOverride: () => true, canarySamplePercent: 50, randomSeed: () => 0.1 },
      { env: envOf(), canaryTargetId: 'canary_test', isKnownIdOverride: () => true, canarySamplePercent: 50, randomSeed: () => 0.9 },
    ];
    for (const c of cases) {
      const d = selectCanaryProvider(c);
      expect(d.rollbackProviderId).toBe('openai_session');
    }
  });

  it('does not mutate input env', () => {
    const env = envOf();
    const before = Object.keys(env).sort();
    const beforeJson = JSON.stringify(env);
    selectCanaryProvider({
      env,
      canaryTargetId: 'canary_test',
      isKnownIdOverride: () => true,
      canarySamplePercent: 50,
      randomSeed: () => 0.1,
    });
    expect(Object.keys(env).sort()).toEqual(before);
    expect(JSON.stringify(env)).toBe(beforeJson);
  });
});

describe('selectCanaryProvider — safety scan of source file', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sourcePath = resolve(here, '../../../src/ai/providers/canarySelector.ts');
  const source = readFileSync(sourcePath, 'utf8');
  // Strip the leading safety-invariant comment block before scanning, so words
  // appearing in documentation (e.g. "never auto-falls-back") don't trip the scan.
  const withoutLeadingComments = source.replace(/^(?:\s*\/\/.*\r?\n)+/, '');

  const forbidden: Array<{ label: string; pattern: RegExp }> = [
    { label: 'try', pattern: /\btry\b/ },
    { label: 'catch', pattern: /\bcatch\b/ },
    { label: 'await', pattern: /\bawait\b/ },
    { label: 'Promise', pattern: /\bPromise\b/ },
    { label: '.generate(', pattern: /\.generate\(/ },
    { label: '.call(', pattern: /\.call\(/ },
  ];
  for (const { label, pattern } of forbidden) {
    it(`source must not contain ${JSON.stringify(label)}`, () => {
      expect(withoutLeadingComments).not.toMatch(pattern);
    });
  }
});

describe('selectCanaryProvider — future scenarios', () => {
  it.todo('exercise canary_selected branch against a second real registry entry (prov-copilot-later)');
});
