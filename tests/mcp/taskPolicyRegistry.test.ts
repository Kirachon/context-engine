import { describe, expect, it } from '@jest/globals';
import {
  getOpenAITaskPolicy,
  listOpenAITaskPolicyNames,
  resolveOpenAITaskRuntimeOptions,
  resolvePlanningTaskPolicies,
} from '../../src/mcp/taskPolicyRegistry.js';

describe('taskPolicyRegistry', () => {
  it('lists the shared runtime-backed task policies we have centralized', () => {
    expect(listOpenAITaskPolicyNames()).toEqual(
      expect.arrayContaining([
        'enhance_prompt',
        'enhance_prompt_repair',
        'review_changes_llm_synthesis',
        'review_diff_llm_synthesis',
      ])
    );
  });

  it('returns stable metadata for shared review policies', () => {
    expect(getOpenAITaskPolicy('review_changes_llm_synthesis')).toMatchObject({
      taskName: 'review_changes_llm_synthesis',
      responseSchemaVersion: 'review_changes.result.v1',
      priority: 'background',
      runtime: {
        validation: {
          mode: 'allow_degraded_result',
          degradedModeOnValidationFailure: 'degraded',
        },
      },
    });

    expect(getOpenAITaskPolicy('review_diff_llm_synthesis')).toMatchObject({
      taskName: 'review_diff_llm_synthesis',
      responseSchemaVersion: 'enterprise_review.findings.v1',
      priority: 'background',
      runtime: {
        validation: {
          mode: 'allow_degraded_result',
          degradedModeOnValidationFailure: 'degraded',
        },
      },
    });
  });

  it('returns stable metadata for enhancement policies', () => {
    expect(getOpenAITaskPolicy('enhance_prompt')).toMatchObject({
      taskName: 'enhance_prompt',
      promptVersion: 'enhance_prompt.primary.v1',
      responseSchemaVersion: 'enhance_prompt.template.v1',
      templateVersion: '2.1.0',
      priority: 'background',
      runtime: {
        retry: {
          mode: 'env_additive',
          envVar: 'CE_ENHANCE_PROMPT_RETRY_ATTEMPTS',
        },
      },
    });

    expect(getOpenAITaskPolicy('enhance_prompt_repair')).toMatchObject({
      taskName: 'enhance_prompt_repair',
      promptVersion: 'enhance_prompt.repair.v1',
      responseSchemaVersion: 'enhance_prompt.template.v1',
      templateVersion: '2.1.0',
      priority: 'background',
      runtime: {
        retry: {
          mode: 'env_additive',
          envVar: 'CE_ENHANCE_PROMPT_RETRY_ATTEMPTS',
        },
      },
    });
  });

  it('resolves profile-aware planning task policies deterministically', () => {
    expect(resolvePlanningTaskPolicies('deep', 'compact')).toEqual({
      generate: expect.objectContaining({
        taskName: 'planning_generate_plan',
        promptVersion: 'planning.generate.deep.v1',
        responseSchemaVersion: 'planning.plan_result.v1',
        priority: 'background',
        runtime: expect.objectContaining({
          timeout: expect.objectContaining({
            envVar: 'CE_PLAN_AI_REQUEST_TIMEOUT_MS',
          }),
        }),
      }),
      refine: expect.objectContaining({
        taskName: 'planning_refine_plan',
        promptVersion: 'planning.refine.deep.v1',
        responseSchemaVersion: 'planning.plan_result.v1',
        priority: 'background',
      }),
      executeStep: expect.objectContaining({
        taskName: 'planning_execute_step',
        promptVersion: 'planning.execute_step.compact.v1',
        responseSchemaVersion: 'planning.step_execution.v1',
        priority: 'background',
      }),
    });
  });

  it('resolves review timeout and degraded validation semantics from the shared registry', () => {
    const previous = process.env.CE_REVIEW_AI_TIMEOUT_MS;
    process.env.CE_REVIEW_AI_TIMEOUT_MS = '65000';

    try {
      const resolved = resolveOpenAITaskRuntimeOptions(
        getOpenAITaskPolicy('review_changes_llm_synthesis')
      );

      expect(resolved).toEqual(
        expect.objectContaining({
          timeoutMs: 65000,
          allowValidationFailureResult: true,
          degradedModeOnValidationFailure: 'degraded',
          bypassDedupe: false,
          retryPolicy: { maxAttempts: 2 },
        })
      );
    } finally {
      if (previous === undefined) delete process.env.CE_REVIEW_AI_TIMEOUT_MS;
      else process.env.CE_REVIEW_AI_TIMEOUT_MS = previous;
    }
  });

  it('resolves enhancement retry policy centrally from the registry env contract', () => {
    const previous = process.env.CE_ENHANCE_PROMPT_RETRY_ATTEMPTS;
    process.env.CE_ENHANCE_PROMPT_RETRY_ATTEMPTS = '0';

    try {
      const resolved = resolveOpenAITaskRuntimeOptions(
        getOpenAITaskPolicy('enhance_prompt')
      );

      expect(resolved.retryPolicy).toEqual({ maxAttempts: 1 });
      expect(resolved.allowValidationFailureResult).toBe(false);
      expect(resolved.bypassDedupe).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CE_ENHANCE_PROMPT_RETRY_ATTEMPTS;
      else process.env.CE_ENHANCE_PROMPT_RETRY_ATTEMPTS = previous;
    }
  });
});
