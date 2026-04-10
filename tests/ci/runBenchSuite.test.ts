import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

describe('scripts/ci/run-bench-suite.ts', () => {
  it('threads suite mode into bench-compare arguments', () => {
    const scriptPath = path.resolve(process.cwd(), 'scripts/ci/run-bench-suite.ts');
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain('function runCompare(\n  mode: SuiteMode,');
    expect(source).toContain("'--suite-mode', mode");
    expect(source).toContain('runCompare(args.mode, baselinePath, candidatePath, runConfig.metricPath, runConfig.thresholds);');
  });
});
