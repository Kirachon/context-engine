import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertNonEmptyRetrievalArtifact,
  classifyBenchmarkCompareExit,
} from '../../scripts/ci/run-bench-suite.js';

describe('scripts/ci/run-bench-suite.ts', () => {
  it('threads suite mode into bench-compare arguments', () => {
    const scriptPath = path.resolve(process.cwd(), 'scripts/ci/run-bench-suite.ts');
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toMatch(/function runCompare\(\r?\n\s+mode: SuiteMode,/);
    expect(source).toContain("'--suite-mode', mode");
    expect(source).toContain('runCompare(args.mode, baselinePath, candidatePath, runConfig.metricPath, runConfig.thresholds);');
  });

  it('allows only nightly threshold breaches as report-only', () => {
    expect(classifyBenchmarkCompareExit('nightly', 1)).toBe('report_only_regression');
    expect(classifyBenchmarkCompareExit('pr', 1)).toBe('error');
    expect(classifyBenchmarkCompareExit('nightly', 2)).toBe('error');
    expect(classifyBenchmarkCompareExit('nightly', null)).toBe('error');
    expect(classifyBenchmarkCompareExit('nightly', 0)).toBe('pass');
  });

  it('rejects empty semantic benchmark artifacts but permits scan artifacts', () => {
    const empty = { payload: { last_result_count: 0, last_unique_files: 0 } };
    expect(() => assertNonEmptyRetrievalArtifact('candidate', 'retrieve', empty)).toThrow(
      'candidate retrieve benchmark returned no comparable retrieval results'
    );
    expect(() => assertNonEmptyRetrievalArtifact('baseline', 'search', empty)).toThrow(
      'baseline search benchmark returned no comparable retrieval results'
    );
    expect(() => assertNonEmptyRetrievalArtifact('baseline', 'search', {
      payload: { last_result_count: 1 },
    } as any)).not.toThrow();
    expect(() => assertNonEmptyRetrievalArtifact('candidate', 'scan', empty)).not.toThrow();
  });
});
