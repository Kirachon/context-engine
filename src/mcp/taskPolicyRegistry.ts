import { envMs } from '../config/env.js';
import type { RetryPolicy } from './openaiTaskRuntime.js';

export type OpenAITaskPriority = 'interactive' | 'background';
export type PlanningPromptProfile = 'compact' | 'deep';

export interface OpenAITaskTimeoutPolicyDefinition {
  defaultMs: number;
  minMs: number;
  maxMs: number;
  envVar?: string;
  fallbackEnvVar?: string;
}

export type OpenAITaskRetryPolicyDefinition =
  | {
    mode: 'fixed';
    maxAttempts: number;
  }
  | {
    mode: 'env_additive';
    envVar: string;
    defaultRetries: number;
    minRetries: number;
    maxRetries: number;
    maxAttemptsCap: number;
  };

export interface OpenAITaskValidationPolicyDefinition {
  mode: 'strict' | 'allow_degraded_result';
  degradedModeOnValidationFailure: 'degraded';
}

export interface OpenAITaskDedupePolicyDefinition {
  enabled: boolean;
}

export interface OpenAITaskRuntimePolicyDefinition {
  timeout: OpenAITaskTimeoutPolicyDefinition;
  retry: OpenAITaskRetryPolicyDefinition;
  dedupe: OpenAITaskDedupePolicyDefinition;
  validation: OpenAITaskValidationPolicyDefinition;
}

export interface OpenAITaskPolicyDefinition {
  taskName: string;
  promptVersion: string;
  responseSchemaVersion: string;
  templateVersion?: string;
  priority: OpenAITaskPriority;
  runtime: OpenAITaskRuntimePolicyDefinition;
}

export interface ResolveOpenAITaskRuntimeOptionsInput {
  requestedTimeoutMs?: number;
  timeoutCapMs?: number;
  bypassDedupe?: boolean;
}

export interface ResolvedOpenAITaskRuntimeOptions {
  timeoutMs: number;
  retryPolicy: RetryPolicy;
  allowValidationFailureResult: boolean;
  degradedModeOnValidationFailure: 'degraded';
  bypassDedupe: boolean;
}

const STATIC_POLICIES = {
  enhance_prompt: {
    taskName: 'enhance_prompt',
    promptVersion: 'enhance_prompt.primary.v1',
    responseSchemaVersion: 'enhance_prompt.template.v1',
    templateVersion: '2.1.0',
    priority: 'background',
    runtime: {
      timeout: {
        defaultMs: 120_000,
        minMs: 1_000,
        maxMs: 120_000,
        envVar: 'CE_ENHANCE_PROMPT_TIMEOUT_MS',
      },
      retry: {
        mode: 'env_additive',
        envVar: 'CE_ENHANCE_PROMPT_RETRY_ATTEMPTS',
        defaultRetries: 2,
        minRetries: 0,
        maxRetries: 3,
        maxAttemptsCap: 2,
      },
      dedupe: {
        enabled: true,
      },
      validation: {
        mode: 'strict',
        degradedModeOnValidationFailure: 'degraded',
      },
    },
  },
  enhance_prompt_repair: {
    taskName: 'enhance_prompt_repair',
    promptVersion: 'enhance_prompt.repair.v1',
    responseSchemaVersion: 'enhance_prompt.template.v1',
    templateVersion: '2.1.0',
    priority: 'background',
    runtime: {
      timeout: {
        defaultMs: 120_000,
        minMs: 1_000,
        maxMs: 120_000,
        envVar: 'CE_ENHANCE_PROMPT_TIMEOUT_MS',
      },
      retry: {
        mode: 'env_additive',
        envVar: 'CE_ENHANCE_PROMPT_RETRY_ATTEMPTS',
        defaultRetries: 2,
        minRetries: 0,
        maxRetries: 3,
        maxAttemptsCap: 2,
      },
      dedupe: {
        enabled: true,
      },
      validation: {
        mode: 'strict',
        degradedModeOnValidationFailure: 'degraded',
      },
    },
  },
  review_changes_llm_synthesis: {
    taskName: 'review_changes_llm_synthesis',
    promptVersion: 'review_changes.llm.v1',
    responseSchemaVersion: 'review_changes.result.v1',
    priority: 'background',
    runtime: {
      timeout: {
        defaultMs: 120_000,
        minMs: 1_000,
        maxMs: 30 * 60 * 1000,
        envVar: 'CE_REVIEW_AI_TIMEOUT_MS',
      },
      retry: {
        mode: 'fixed',
        maxAttempts: 2,
      },
      dedupe: {
        enabled: true,
      },
      validation: {
        mode: 'allow_degraded_result',
        degradedModeOnValidationFailure: 'degraded',
      },
    },
  },
  review_diff_llm_synthesis: {
    taskName: 'review_diff_llm_synthesis',
    promptVersion: 'review_diff.llm.v1',
    responseSchemaVersion: 'enterprise_review.findings.v1',
    priority: 'background',
    runtime: {
      timeout: {
        defaultMs: 60_000,
        minMs: 1_000,
        maxMs: 30 * 60 * 1000,
        envVar: 'CE_REVIEW_DIFF_LLM_TIMEOUT_MS',
        fallbackEnvVar: 'CE_REVIEW_AI_TIMEOUT_MS',
      },
      retry: {
        mode: 'fixed',
        maxAttempts: 2,
      },
      dedupe: {
        enabled: true,
      },
      validation: {
        mode: 'allow_degraded_result',
        degradedModeOnValidationFailure: 'degraded',
      },
    },
  },
} as const satisfies Record<string, OpenAITaskPolicyDefinition>;

export type StaticOpenAITaskPolicyName = keyof typeof STATIC_POLICIES;

export function listOpenAITaskPolicyNames(): StaticOpenAITaskPolicyName[] {
  return Object.keys(STATIC_POLICIES).sort() as StaticOpenAITaskPolicyName[];
}

export function getOpenAITaskPolicy(name: StaticOpenAITaskPolicyName): OpenAITaskPolicyDefinition {
  return structuredClone(STATIC_POLICIES[name]);
}

export function resolvePlanningTaskPolicies(
  planningProfile: PlanningPromptProfile,
  executionProfile: PlanningPromptProfile
): {
  generate: OpenAITaskPolicyDefinition;
  refine: OpenAITaskPolicyDefinition;
  executeStep: OpenAITaskPolicyDefinition;
} {
  return {
    generate: {
      taskName: 'planning_generate_plan',
      promptVersion: `planning.generate.${planningProfile}.v1`,
      responseSchemaVersion: 'planning.plan_result.v1',
      priority: 'background',
      runtime: {
        timeout: {
          defaultMs: 5 * 60 * 1000,
          minMs: 30_000,
          maxMs: 30 * 60 * 1000,
          envVar: 'CE_PLAN_AI_REQUEST_TIMEOUT_MS',
        },
        retry: {
          mode: 'fixed',
          maxAttempts: 2,
        },
        dedupe: {
          enabled: true,
        },
        validation: {
          mode: 'strict',
          degradedModeOnValidationFailure: 'degraded',
        },
      },
    },
    refine: {
      taskName: 'planning_refine_plan',
      promptVersion: `planning.refine.${planningProfile}.v1`,
      responseSchemaVersion: 'planning.plan_result.v1',
      priority: 'background',
      runtime: {
        timeout: {
          defaultMs: 5 * 60 * 1000,
          minMs: 30_000,
          maxMs: 30 * 60 * 1000,
          envVar: 'CE_PLAN_AI_REQUEST_TIMEOUT_MS',
        },
        retry: {
          mode: 'fixed',
          maxAttempts: 2,
        },
        dedupe: {
          enabled: true,
        },
        validation: {
          mode: 'strict',
          degradedModeOnValidationFailure: 'degraded',
        },
      },
    },
    executeStep: {
      taskName: 'planning_execute_step',
      promptVersion: `planning.execute_step.${executionProfile}.v1`,
      responseSchemaVersion: 'planning.step_execution.v1',
      priority: 'background',
      runtime: {
        timeout: {
          defaultMs: 5 * 60 * 1000,
          minMs: 30_000,
          maxMs: 30 * 60 * 1000,
          envVar: 'CE_PLAN_AI_REQUEST_TIMEOUT_MS',
        },
        retry: {
          mode: 'fixed',
          maxAttempts: 2,
        },
        dedupe: {
          enabled: true,
        },
        validation: {
          mode: 'strict',
          degradedModeOnValidationFailure: 'degraded',
        },
      },
    },
  };
}

function clampTimeoutMs(value: number, policy: OpenAITaskTimeoutPolicyDefinition): number {
  return Math.max(policy.minMs, Math.min(policy.maxMs, Math.floor(value)));
}

function resolveTimeoutDefaultMs(policy: OpenAITaskTimeoutPolicyDefinition): number {
  if (policy.envVar && policy.fallbackEnvVar) {
    return envMs(
      policy.envVar,
      envMs(policy.fallbackEnvVar, policy.defaultMs, {
        min: policy.minMs,
        max: policy.maxMs,
      }),
      {
        min: policy.minMs,
        max: policy.maxMs,
      }
    );
  }

  if (policy.envVar) {
    return envMs(policy.envVar, policy.defaultMs, {
      min: policy.minMs,
      max: policy.maxMs,
    });
  }

  return clampTimeoutMs(policy.defaultMs, policy);
}

function resolveRetryPolicy(policy: OpenAITaskRetryPolicyDefinition): RetryPolicy {
  if (policy.mode === 'fixed') {
    return { maxAttempts: Math.max(1, Math.floor(policy.maxAttempts)) };
  }

  const rawValue = process.env[policy.envVar];
  const parsed = rawValue ? Number(rawValue) : Number.NaN;
  const retries = Number.isFinite(parsed)
    ? Math.max(policy.minRetries, Math.min(policy.maxRetries, Math.floor(parsed)))
    : policy.defaultRetries;
  return {
    maxAttempts: Math.max(1, Math.min(policy.maxAttemptsCap, retries + 1)),
  };
}

export function resolveOpenAITaskRuntimeOptions(
  policy: OpenAITaskPolicyDefinition,
  input: ResolveOpenAITaskRuntimeOptionsInput = {}
): ResolvedOpenAITaskRuntimeOptions {
  const baseTimeoutMs = Number.isFinite(input.requestedTimeoutMs)
    ? clampTimeoutMs(input.requestedTimeoutMs as number, policy.runtime.timeout)
    : resolveTimeoutDefaultMs(policy.runtime.timeout);
  const timeoutMs = Number.isFinite(input.timeoutCapMs)
    ? Math.max(0, Math.min(baseTimeoutMs, Math.floor(input.timeoutCapMs as number)))
    : baseTimeoutMs;

  return {
    timeoutMs,
    retryPolicy: resolveRetryPolicy(policy.runtime.retry),
    allowValidationFailureResult: policy.runtime.validation.mode === 'allow_degraded_result',
    degradedModeOnValidationFailure: policy.runtime.validation.degradedModeOnValidationFailure,
    bypassDedupe: input.bypassDedupe ?? !policy.runtime.dedupe.enabled,
  };
}
