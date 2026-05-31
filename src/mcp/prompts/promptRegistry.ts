import {
  ErrorCode,
  McpError,
  type GetPromptResult,
  type Prompt,
  type PromptMessage,
} from '@modelcontextprotocol/sdk/types.js';

import { applyPromptDiscoverability } from '../tooling/discoverability.js';
import { validateExternalSources, validatePathScopeGlobs } from '../tooling/validation.js';
import { CODE_REVIEW_SYSTEM_PROMPT, buildCodeReviewPrompt } from './codeReview.js';
import {
  ENHANCE_REQUEST_SYSTEM_PROMPT,
  PLANNING_SYSTEM_PROMPT,
  REFINEMENT_SYSTEM_PROMPT,
  buildCreatePlanPromptRequest,
  buildEnhanceRequestPrompt,
  buildRefinePlanPromptRequest,
  getCreatePlanPromptArguments,
  getEnhanceRequestPromptArguments,
} from './planning.js';

type PromptArgumentsMap = Record<string, string>;

type PromptDescriptor = Prompt & {
  name: string;
};

export const PROMPT_DEFINITIONS: PromptDescriptor[] = [
  applyPromptDiscoverability({
    name: 'create-plan',
    description: 'Build a planning request using the repo planning templates.',
    arguments: getCreatePlanPromptArguments(),
  }),
  applyPromptDiscoverability({
    name: 'refine-plan',
    description: 'Build a plan-refinement request using the repo refinement templates.',
    arguments: [
      { name: 'current_plan', description: 'Existing plan JSON string.', required: true },
      { name: 'feedback', description: 'Optional refinement feedback text.' },
      { name: 'clarifications', description: 'Optional JSON object string of clarification answers.' },
    ],
  }),
  applyPromptDiscoverability({
    name: 'review-diff',
    description: 'Build a code-review request for a diff using the repo review templates.',
    arguments: [
      { name: 'diff', description: 'Unified diff to review.', required: true },
      { name: 'categories', description: 'Optional comma-separated category list.' },
      { name: 'custom_instructions', description: 'Optional extra review instructions.' },
    ],
  }),
  applyPromptDiscoverability({
    name: 'enhance-request',
    description: 'Build a request-enhancement prompt using the repo prompt-enhancement templates.',
    arguments: getEnhanceRequestPromptArguments(),
  }),
];

function buildPromptTextMessage(role: 'assistant' | 'user', text: string): PromptMessage {
  return {
    role,
    content: {
      type: 'text',
      text,
    },
  };
}

function buildPromptResult(description: string, messages: PromptMessage[]): GetPromptResult {
  return {
    description,
    messages,
  };
}

function parseRequiredPromptString(args: PromptArgumentsMap, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new McpError(ErrorCode.InvalidParams, `Prompt argument "${key}" is required`);
  }
  return value.trim();
}

function parseOptionalBooleanPromptString(args: PromptArgumentsMap, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }

  throw new McpError(ErrorCode.InvalidParams, `Prompt argument "${key}" must be "true" or "false"`);
}

function parseOptionalPositiveIntegerPromptString(
  args: PromptArgumentsMap,
  key: string
): number | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new McpError(ErrorCode.InvalidParams, `Prompt argument "${key}" must be a positive integer`);
  }

  return parsed;
}

function parseOptionalClarifications(args: PromptArgumentsMap): Record<string, string> | undefined {
  const raw = args.clarifications;
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Clarifications must be a JSON object');
    }

    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, typeof value === 'string' ? value : String(value)])
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new McpError(ErrorCode.InvalidParams, `Prompt argument "clarifications" must be valid JSON: ${message}`);
  }
}

function parseOptionalPromptPathList(args: PromptArgumentsMap, key: 'include_paths' | 'exclude_paths'): string[] | undefined {
  const raw = args[key];
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }

  const parsed = raw
    .split(/[\r\n,]+/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return validatePathScopeGlobs(parsed, key);
}

function parseOptionalPromptExternalSources(args: PromptArgumentsMap) {
  const raw = args.external_sources;
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return validateExternalSources(parsed, 'external_sources');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new McpError(
      ErrorCode.InvalidParams,
      `Prompt argument "external_sources" must be valid JSON: ${message}`
    );
  }
}

function parseOptionalReviewCategories(args: PromptArgumentsMap): string[] | undefined {
  const raw = args.categories;
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }

  const parsed = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return parsed.length > 0 ? parsed : undefined;
}

function getPromptByName(name: string): PromptDescriptor {
  const prompt = PROMPT_DEFINITIONS.find((entry) => entry.name === name);
  if (!prompt) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
  }
  return prompt;
}

export function buildPromptByName(name: string, rawArgs: PromptArgumentsMap = {}): GetPromptResult {
  switch (name) {
    case 'create-plan': {
      const task = parseRequiredPromptString(rawArgs, 'task');
      const autoScope = parseOptionalBooleanPromptString(rawArgs, 'auto_scope');
      const mvpOnly = parseOptionalBooleanPromptString(rawArgs, 'mvp_only');
      const maxContextFiles = parseOptionalPositiveIntegerPromptString(rawArgs, 'max_context_files');
      const contextTokenBudget = parseOptionalPositiveIntegerPromptString(rawArgs, 'context_token_budget');
      const includePaths = parseOptionalPromptPathList(rawArgs, 'include_paths');
      const excludePaths = parseOptionalPromptPathList(rawArgs, 'exclude_paths');
      const prompt = getPromptByName(name);
      return buildPromptResult(prompt.description ?? '', [
        buildPromptTextMessage('assistant', PLANNING_SYSTEM_PROMPT),
        buildPromptTextMessage(
          'user',
          buildCreatePlanPromptRequest({
            task,
            auto_scope: autoScope,
            mvp_only: mvpOnly,
            max_context_files: maxContextFiles,
            context_token_budget: contextTokenBudget,
            include_paths: includePaths,
            exclude_paths: excludePaths,
            profile: mvpOnly ? 'compact' : 'deep',
          })
        ),
      ]);
    }
    case 'refine-plan': {
      const currentPlan = parseRequiredPromptString(rawArgs, 'current_plan');
      const feedback = rawArgs.feedback?.trim();
      const clarifications = parseOptionalClarifications(rawArgs);
      const prompt = getPromptByName(name);
      return buildPromptResult(prompt.description ?? '', [
        buildPromptTextMessage('assistant', REFINEMENT_SYSTEM_PROMPT),
        buildPromptTextMessage(
          'user',
          buildRefinePlanPromptRequest({
            currentPlan,
            feedback,
            clarifications,
            profile: 'deep',
          })
        ),
      ]);
    }
    case 'review-diff': {
      const diff = parseRequiredPromptString(rawArgs, 'diff');
      const categories = parseOptionalReviewCategories(rawArgs);
      const customInstructions = rawArgs.custom_instructions?.trim();
      const prompt = getPromptByName(name);
      return buildPromptResult(prompt.description ?? '', [
        buildPromptTextMessage('assistant', CODE_REVIEW_SYSTEM_PROMPT),
        buildPromptTextMessage(
          'user',
          buildCodeReviewPrompt(diff, {}, {
            categories: categories as any,
            custom_instructions: customInstructions,
          })
        ),
      ]);
    }
    case 'enhance-request': {
      const requestPrompt = parseRequiredPromptString(rawArgs, 'prompt');
      const autoScope = parseOptionalBooleanPromptString(rawArgs, 'auto_scope');
      const includePaths = parseOptionalPromptPathList(rawArgs, 'include_paths');
      const excludePaths = parseOptionalPromptPathList(rawArgs, 'exclude_paths');
      const externalSources = parseOptionalPromptExternalSources(rawArgs);
      const prompt = getPromptByName(name);
      return buildPromptResult(prompt.description ?? '', [
        buildPromptTextMessage('assistant', ENHANCE_REQUEST_SYSTEM_PROMPT),
        buildPromptTextMessage(
          'user',
          buildEnhanceRequestPrompt(requestPrompt, {
            autoScope,
            includePaths,
            excludePaths,
            externalSourcesJson: externalSources
              ? JSON.stringify(
                  externalSources.map((source) => ({
                    type: source.type,
                    url: source.url,
                    ...(source.label ? { label: source.label } : {}),
                  })),
                  null,
                  2
                )
              : undefined,
          })
        ),
      ]);
    }
    default:
      throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
  }
}
