import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';

type GateTierContract = {
  version: number;
  pr_blockers: {
    stable_local_transport_contract: string;
    scripts: string[];
    deterministic_review_quality: {
      receipt_type: string;
      corpus: string;
      tests: string[];
    };
  };
  nightly_report_only: {
    scripts: string[];
    grader_based_scoring: {
      mode: string;
      activation: string;
    };
  };
};

function readJson<T>(relativePath: string): T {
  const absolutePath = path.join(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, 'utf8')) as T;
}

describe('config/ci/gate-tier-contract.json', () => {
  it('pins explicit blocker vs nightly gates to existing repo scripts and deterministic review receipts', () => {
    const contract = readJson<GateTierContract>('config/ci/gate-tier-contract.json');
    const packageJson = readJson<{ scripts?: Record<string, string> }>('package.json');
    const scripts = packageJson.scripts ?? {};

    expect(contract.version).toBe(1);
    expect(contract.pr_blockers.stable_local_transport_contract).toBe(
      'config/ci/local-transport-contract.json'
    );
    expect(contract.pr_blockers.scripts).toEqual([
      'build',
      'ci:check:mcp-smoke',
      'ci:check:retrieval-holdout-fixture',
      'ci:check:retrieval-quality-gate',
      'ci:check:retrieval-shadow-canary-gate',
      'ci:check:enhancement-error-taxonomy-report',
      'ci:check:enhance-prompt-contract',
    ]);
    expect(contract.nightly_report_only.scripts).toEqual([
      'bench:ci:nightly',
      'ci:generate:weekly-retrieval-trend-report',
      'ci:check:weekly-retrieval-trend-report',
      'ci:generate:semantic-latency-report',
    ]);

    for (const scriptName of [
      ...contract.pr_blockers.scripts,
      ...contract.nightly_report_only.scripts,
    ]) {
      expect(scripts[scriptName]).toEqual(expect.any(String));
    }

    expect(contract.pr_blockers.deterministic_review_quality).toEqual({
      receipt_type: 'jest',
      corpus: 'config/ci/review-quality-corpus.json',
      tests: [
        'tests/tools/reviewDiff.test.ts',
        'tests/ci/reviewDiffArtifacts.test.ts',
      ],
    });
    expect(contract.nightly_report_only.grader_based_scoring).toEqual({
      mode: 'report_only',
      activation: 'post-calibration',
    });

    for (const relativePath of contract.pr_blockers.deterministic_review_quality.tests) {
      expect(fs.existsSync(path.join(process.cwd(), relativePath))).toBe(true);
    }
    expect(
      fs.existsSync(
        path.join(process.cwd(), contract.pr_blockers.deterministic_review_quality.corpus)
      )
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(process.cwd(), contract.pr_blockers.stable_local_transport_contract)
      )
    ).toBe(true);
  });
});
