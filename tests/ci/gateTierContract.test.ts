import { describe, expect, it } from '@jest/globals';
import {
  cloneContract,
  readJson,
  type Contract,
  validateGateTierContract,
} from '../../scripts/ci/lib/gateTierContractValidator';

describe('config/ci/gate-tier-contract.json', () => {
  const contract = readJson<Contract>('config/ci/gate-tier-contract.json');

  it('records truthful tiers separately from workflow and external enforcement facts', () => {
    expect(contract.version).toBe(2);
    expect(contract.lifecycle_tiers).toEqual([
      'report_only',
      'shadow_required_artifact',
      'calibrated',
      'pr_blocker',
    ]);
    expect(Object.fromEntries(contract.gates.map(({ id, declared_tier }) => [id, declared_tier]))).toEqual({
      'stable-local-transport-contract': 'calibrated',
      build: 'calibrated',
      'ci:check:mcp-smoke': 'calibrated',
      'ci:check:retrieval-holdout-fixture': 'calibrated',
      'ci:check:retrieval-quality-gate': 'calibrated',
      'ci:check:retrieval-shadow-canary-gate': 'calibrated',
      'ci:check:required-lane-catch-rate': 'report_only',
      'ci:check:enhancement-error-taxonomy-report': 'report_only',
      'ci:check:enhance-prompt-contract': 'report_only',
      'deterministic-review-quality': 'calibrated',
      'bench:ci:nightly': 'report_only',
      'ci:generate:weekly-retrieval-trend-report': 'report_only',
      'ci:check:weekly-retrieval-trend-report': 'report_only',
      'ci:generate:semantic-latency-report': 'report_only',
      'grader-based-scoring': 'report_only',
    });
    expect(contract.gates.every(({ declared_tier }) => declared_tier !== 'pr_blocker')).toBe(true);
    expect(
      contract.gates.every(
        ({ external_enforcement }) =>
          external_enforcement.status === 'not-verified' &&
          external_enforcement.receipt === null
      )
    ).toBe(true);
  });

  it('reconciles every workflow mapping and package-script chain', () => {
    expect(validateGateTierContract(contract)).toEqual([]);
  });

  it('rejects missing or bad workflow mappings', () => {
    const missing = cloneContract(contract);
    missing.gates.find(({ id }) => id === 'build')?.workflow_mappings.shift();
    expect(validateGateTierContract(missing)).toContain(
      'build: workflow mapping inventory disagrees with live workflows'
    );

    const bad = cloneContract(contract);
    bad.workflow_executions['review-mcp-smoke'].job = 'missing-job';
    const errors = validateGateTierContract(bad);
    expect(errors).toContain('review-mcp-smoke: workflow/job/step mapping does not exist');
    expect(errors).toContain('ci:check:mcp-smoke: workflow mapping inventory disagrees with live workflows');
  });

  it('rejects a missing package script referenced by a gate', () => {
    const missingScript = cloneContract(contract);
    const build = missingScript.gates.find(({ id }) => id === 'build');
    if (build) build.package_script = 'does-not-exist-script';
    expect(validateGateTierContract(missingScript)).toContain('build: package script does not exist');
  });

  it('rejects unproven external enforcement and unverified PR-blocker claims', () => {
    const unproven = cloneContract(contract);
    const build = unproven.gates.find(({ id }) => id === 'build');
    if (build) build.external_enforcement.status = 'verified';
    expect(validateGateTierContract(unproven)).toContain(
      'build: verified external enforcement requires a receipt path'
    );

    const blocker = cloneContract(contract);
    const smoke = blocker.gates.find(({ id }) => id === 'ci:check:mcp-smoke');
    if (smoke) smoke.declared_tier = 'pr_blocker';
    expect(validateGateTierContract(blocker)).toContain(
      'ci:check:mcp-smoke: pr_blocker requires verified external branch protection'
    );
  });

  it('rejects invalid lifecycle transitions', () => {
    const unknownTier = cloneContract(contract);
    const reportOnlyGate = unknownTier.gates.find(({ id }) => id === 'bench:ci:nightly');
    expect(reportOnlyGate).toBeDefined();
    // @ts-expect-error deliberately invalid tier for the mutation fixture
    reportOnlyGate!.declared_tier = 'in_review';
    expect(validateGateTierContract(unknownTier)).toContain(
      'bench:ci:nightly: unknown declared tier'
    );

    const promotedWhileUnwired = cloneContract(contract);
    const unwiredGate = promotedWhileUnwired.gates.find(
      ({ id }) => id === 'ci:check:enhancement-error-taxonomy-report'
    );
    expect(unwiredGate).toBeDefined();
    unwiredGate!.declared_tier = 'calibrated';
    const errors = validateGateTierContract(promotedWhileUnwired);
    expect(errors).toContain(
      'ci:check:enhancement-error-taxonomy-report: invalid lifecycle transition - an unwired gate cannot be promoted past report_only'
    );
    expect(errors).toContain(
      'ci:check:enhancement-error-taxonomy-report: an unwired gate must remain report_only'
    );

    const scrambledOrder = cloneContract(contract);
    scrambledOrder.lifecycle_tiers = [
      'shadow_required_artifact',
      'report_only',
      'calibrated',
      'pr_blocker',
    ];
    expect(validateGateTierContract(scrambledOrder)).toContain(
      'lifecycle_tiers must declare exactly the canonical report_only -> shadow_required_artifact -> calibrated -> pr_blocker promotion order'
    );
  });
});
