import { describe, expect, it } from '@jest/globals';
import {
  buildProbeFailureMessage,
  resolveModeProbeOrder,
  resolveScanFallbackAllowed,
} from '../../src/ci/benchSuiteModePolicy';

describe('benchSuiteModePolicy', () => {
  it('locks scan fallback by default for PR mode', () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(resolveScanFallbackAllowed('pr', env)).toBe(false);
    expect(resolveModeProbeOrder('pr', env)).toEqual(['retrieve', 'search']);
  });

  it('allows scan fallback in PR mode only when explicitly enabled', () => {
    const env = { BENCH_SUITE_ALLOW_SCAN_FALLBACK: 'true' } as NodeJS.ProcessEnv;
    expect(resolveScanFallbackAllowed('pr', env)).toBe(true);
    expect(resolveModeProbeOrder('pr', env)).toEqual(['retrieve', 'search', 'scan']);
  });

  it('includes probe timeout and lock hint in PR diagnostics when scan fallback is not enabled', () => {
    const env = { BENCH_SUITE_ALLOW_SCAN_FALLBACK: 'false' } as NodeJS.ProcessEnv;
    const message = buildProbeFailureMessage('pr', 2345, ['retrieve: unavailable', 'search: unavailable'], env);
    expect(message).toContain('probe timeout 2345ms');
    expect(message).toContain('Scan fallback is mode-locked for PR KPI runs.');
  });

  it('omits lock hint when scan fallback override is enabled', () => {
    const env = { BENCH_SUITE_ALLOW_SCAN_FALLBACK: 'true' } as NodeJS.ProcessEnv;
    const message = buildProbeFailureMessage('pr', 3456, ['retrieve: unavailable', 'search: unavailable'], env);
    expect(message).toContain('probe timeout 3456ms');
    expect(message).not.toContain('mode-locked for PR KPI runs');
  });
});
