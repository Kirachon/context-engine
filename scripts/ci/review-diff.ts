#!/usr/bin/env node
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { reviewDiff } from '../../src/reviewer/reviewDiff.js';
import { ContextServiceClient } from '../../src/mcp/serviceClient.js';

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v !== 'false' && v !== '0' && v !== '';
}

function git(args: string[]): string {
  return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf-8');
}

function tryGit(args: string[]): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function fileExists(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isAllZeroSha(value: string | undefined): boolean {
  if (!value) return false;
  return /^0+$/.test(value.trim());
}

function resolveDiffRange(baseShaEnv: string | undefined, headShaEnv: string | undefined): { baseSha: string; headSha: string } {
  const headSha = headShaEnv?.trim() || tryGit(['rev-parse', 'HEAD'])?.trim() || '';
  if (!headSha) {
    throw new Error('Unable to resolve HEAD SHA for review diff.');
  }

  const baseFromEnv = baseShaEnv?.trim() || '';
  if (baseFromEnv && !isAllZeroSha(baseFromEnv) && tryGit(['cat-file', '-e', `${baseFromEnv}^{commit}`]) !== null) {
    return { baseSha: baseFromEnv, headSha };
  }

  const fallbackBase = tryGit(['rev-parse', `${headSha}^`])?.trim();
  if (fallbackBase) {
    return { baseSha: fallbackBase, headSha };
  }

  // Initial-commit fallback: diff empty tree to HEAD.
  return { baseSha: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', headSha };
}

async function main(): Promise<void> {
  const workspace = process.cwd();
  const { baseSha, headSha } = resolveDiffRange(process.env.BASE_SHA, process.env.HEAD_SHA);

  const diff = git(['diff', '--no-color', '--unified=3', baseSha, headSha]);
  const changedFiles = git(['diff', '--name-only', baseSha, headSha])
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  const invariantsPathCandidate = path.join(workspace, '.review-invariants.yml');
  const invariantsPath = fileExists(invariantsPathCandidate) ? '.review-invariants.yml' : undefined;

  const enableLlm = envBool('CE_REVIEW_ENABLE_LLM', false);
  const includeSarif = envBool('CE_REVIEW_INCLUDE_SARIF', true);
  const includeMarkdown = envBool('CE_REVIEW_INCLUDE_MARKDOWN', true);

  const serviceClient = enableLlm ? new ContextServiceClient(workspace) : null;

  const result = await reviewDiff({
    diff,
    changed_files: changedFiles,
    workspace_path: workspace,
    options: {
      invariants_path: invariantsPath,
      enable_llm: enableLlm,
      include_sarif: includeSarif,
      include_markdown: includeMarkdown,
      fail_on_severity: (process.env.CE_REVIEW_FAIL_ON_SEVERITY as any) ?? 'CRITICAL',
    },
    runtime: {
      readFile: async (filePath: string) => {
        // Prefer the same path validation used by the server.
        if (serviceClient) return serviceClient.getFile(filePath);
        return fs.promises.readFile(path.join(workspace, filePath), 'utf-8');
      },
      ...(serviceClient
        ? {
            llm: {
              call: (searchQuery: string, prompt: string) => serviceClient.searchAndAsk(searchQuery, prompt),
              model: serviceClient.getActiveAIModelLabel(),
            },
          }
        : {}),
    },
  });

  fs.mkdirSync(path.join(workspace, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'artifacts', 'review_diff_result.json'), JSON.stringify(result, null, 2), 'utf-8');
  if (result.sarif) {
    fs.writeFileSync(path.join(workspace, 'artifacts', 'review_diff.sarif'), JSON.stringify(result.sarif, null, 2), 'utf-8');
  }
  if (result.markdown) {
    fs.writeFileSync(path.join(workspace, 'artifacts', 'review_diff.md'), result.markdown, 'utf-8');
  }

  // GitHub Actions summary (best-effort)
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath && result.markdown) {
    fs.appendFileSync(summaryPath, result.markdown + '\n', 'utf-8');
  }

  if (result.should_fail) {
    console.error('review_diff: CI gate FAIL');
    process.exitCode = 1;
  } else {
    console.error('review_diff: CI gate PASS');
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 2;
});
