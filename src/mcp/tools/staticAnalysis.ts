/**
 * Layer 3: MCP Interface Layer - Static Analysis Tool
 *
 * Runs local static analyzers (TypeScript typecheck, optional semgrep) and returns
 * structured findings. This is intentionally opt-in because it can be slow.
 */

import { ContextServiceClient } from '../serviceClient.js';
import { runStaticAnalyzers } from '../../reviewer/checks/adapters/index.js';
import type { StaticAnalyzerId } from '../../reviewer/checks/adapters/types.js';
import { envInt } from '../../config/env.js';
import { normalizeWorkspaceRelativePaths } from '../../workspace/pathValidation.js';
import {
  buildTaskStartResponse,
  getDefaultTaskManager,
  shouldUseTaskMode,
  startStaticAnalysisTask,
} from '../tasks/taskManager.js';

const DEFAULT_SEMGREP_MAX_FILES = 100;

export interface RunStaticAnalysisArgs {
  changed_files?: string[];
  /** Run static analysis without blocking the tool call (default: false) */
  background?: boolean;
  /** Return a task ID and track analysis progress without blocking (default: false) */
  task?: boolean;
  options?: {
    analyzers?: StaticAnalyzerId[];
    timeout_ms?: number;
    max_findings_per_analyzer?: number;
    semgrep_args?: string[];
  };
}

export async function performRunStaticAnalysis(
  args: RunStaticAnalysisArgs,
  serviceClient: ContextServiceClient
): Promise<Record<string, unknown>> {
  const workspacePath = serviceClient.getWorkspacePath();
  const analyzers = (args.options?.analyzers ?? ['tsc']).filter(Boolean) as StaticAnalyzerId[];
  const changedFiles = normalizeWorkspaceRelativePaths(args.changed_files ?? [], 'changed_files', {
    rejectOptionLike: true,
  });
  const analyzerTimeoutInput = args.options?.timeout_ms ?? 60_000;
  const analyzerTimeoutMs = Number.isFinite(analyzerTimeoutInput)
    ? Math.max(1, Math.trunc(analyzerTimeoutInput))
    : 60_000;
  const semgrepMaxFiles = envInt('CE_SEMGREP_MAX_FILES', DEFAULT_SEMGREP_MAX_FILES, { min: 0 });

  const warnings: string[] = [];
  if (analyzers.includes('semgrep') && changedFiles.length === 0) {
    warnings.push('semgrep selected but changed_files is empty; semgrep will be skipped');
  }
  if (analyzers.includes('semgrep') && semgrepMaxFiles > 0 && changedFiles.length > semgrepMaxFiles) {
    const batchCount = Math.ceil(changedFiles.length / semgrepMaxFiles);
    warnings.push(
      `semgrep changed_files contains ${changedFiles.length} entries; execution will be chunked into ${batchCount} batches (max ${semgrepMaxFiles} files each)`
    );
  }

  const run = await runStaticAnalyzers({
    input: { workspace_path: workspacePath, changed_files: changedFiles },
    analyzers,
    timeoutMs: analyzerTimeoutMs,
    totalTimeoutMs: analyzerTimeoutMs * Math.max(1, analyzers.length),
    maxFindingsPerAnalyzer: args.options?.max_findings_per_analyzer ?? 20,
    semgrepArgs: args.options?.semgrep_args,
  });

  return {
    success: true,
    analyzers,
    warnings: [...warnings, ...run.warnings],
    results: run.results,
    findings: run.findings,
  };
}

export async function handleRunStaticAnalysis(
  args: RunStaticAnalysisArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  if (shouldUseTaskMode({ background: args.background, task: args.task })) {
    const taskRecord = startStaticAnalysisTask(
      async (updateProgress) => {
        updateProgress({ message: 'Running static analyzers' });
        return performRunStaticAnalysis(args, serviceClient);
      },
      getDefaultTaskManager()
    );

    return JSON.stringify(
      buildTaskStartResponse('Background static analysis started', taskRecord),
      null,
      2
    );
  }

  const result = await performRunStaticAnalysis(args, serviceClient);
  return JSON.stringify(result, null, 2);
}

export const runStaticAnalysisTool = {
  name: 'run_static_analysis',
  description: 'Run local static analyzers (tsc and optional semgrep) and return structured findings.',
  inputSchema: {
    type: 'object',
    properties: {
      changed_files: { type: 'array', items: { type: 'string' }, description: 'Optional list of file paths to analyze' },
      background: {
        type: 'boolean',
        description: 'Run static analysis without blocking the tool call (default: false)',
        default: false,
      },
      task: {
        type: 'boolean',
        description: 'Return a task ID and track analysis progress without blocking (default: false)',
        default: false,
      },
      options: {
        type: 'object',
        properties: {
          analyzers: {
            type: 'array',
            items: { type: 'string', enum: ['tsc', 'semgrep'] },
            description: 'Which analyzers to run. Default: [\"tsc\"]',
          },
          timeout_ms: { type: 'number', description: 'Timeout per analyzer in milliseconds. Default: 60000', default: 60000 },
          max_findings_per_analyzer: { type: 'number', description: 'Max findings per analyzer. Default: 20', default: 20 },
          semgrep_args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional semgrep args (e.g. [\"--config\",\"p/ci\"]). Only used when semgrep is selected.',
          },
        },
      },
    },
    required: [],
  },
};
