import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EnterpriseFinding } from '../../types.js';
import type { StaticAnalyzerInput, StaticAnalyzerResult } from './types.js';
import { envBool } from '../../../config/env.js';
import { devNullPath, runCommand } from './exec.js';

export interface TscError {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}

function getTscBuildInfoPath(workspacePath: string): string | null {
  if (!envBool('CE_TSC_INCREMENTAL', true)) {
    return null;
  }

  const overrideDir = process.env.CE_TSC_BUILDINFO_DIR?.trim();
  const baseDir = overrideDir && overrideDir.length > 0
    ? overrideDir
    : path.join(os.tmpdir(), 'context-engine', 'tsc');
  const workspaceHash = crypto
    .createHash('sha256')
    .update(workspacePath)
    .digest('hex')
    .slice(0, 12);
  const buildDir = path.join(baseDir, workspaceHash);

  try {
    fs.mkdirSync(buildDir, { recursive: true });
  } catch {
    return null;
  }

  return path.join(buildDir, 'tsconfig.tsbuildinfo');
}

export function parseTscOutput(output: string): TscError[] {
  const errors: TscError[] = [];
  const lines = output.split(/\r?\n/);
  const re = /^(?<file>.+?)\((?<line>\d+),(?<col>\d+)\):\s+error\s+TS(?<code>\d+):\s+(?<msg>.*)$/;
  for (const line of lines) {
    const m = re.exec(line.trim());
    if (!m?.groups) continue;
    const file = m.groups.file;
    const lineNum = Number(m.groups.line);
    const colNum = Number(m.groups.col);
    const code = `TS${m.groups.code}`;
    const msg = m.groups.msg.trim();
    if (!file || !Number.isFinite(lineNum) || !Number.isFinite(colNum) || !msg) continue;
    errors.push({ file, line: lineNum, column: colNum, code, message: msg });
  }
  return errors;
}

export async function runTscAnalyzer(
  input: StaticAnalyzerInput,
  opts: { timeoutMs: number; maxFindings: number }
): Promise<StaticAnalyzerResult> {
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const args = ['--no-install', 'tsc', '--noEmit', '--pretty', 'false'];
  const buildInfoPath = getTscBuildInfoPath(input.workspace_path);
  if (buildInfoPath) {
    args.push('--incremental', '--tsBuildInfoFile', buildInfoPath);
  } else {
    args.push('--tsBuildInfoFile', devNullPath());
  }

  const result = await runCommand({
    command,
    commandArgs: args,
    cwd: input.workspace_path,
    timeoutMs: opts.timeoutMs,
  });

  const combined = `${result.stdout}\n${result.stderr}`.trim();
  if (combined.length === 0 && result.exitCode !== 0) {
    return {
      analyzer: 'tsc',
      duration_ms: result.duration_ms,
      findings: [],
      warnings: ['tsc failed but produced no output'],
      skipped_reason: 'tsc_failed_no_output',
    };
  }

  const errors = parseTscOutput(combined);

  const findings: EnterpriseFinding[] = errors.slice(0, Math.max(0, opts.maxFindings)).map((e, idx) => {
    const relFile = path.normalize(e.file);
    return {
      id: `TSC${e.code}-${idx + 1}`,
      severity: 'HIGH',
      category: 'correctness',
      confidence: 0.95,
      title: `TypeScript ${e.code}: ${e.message}`,
      location: { file: relFile, startLine: e.line, endLine: e.line },
      evidence: [`${e.file}(${e.line},${e.column})`],
      impact: 'Type errors can cause runtime failures or broken builds.',
      recommendation: 'Fix the TypeScript error or adjust types so the project type-checks cleanly.',
    };
  });

  const warnings: string[] = [];
  if (result.exitCode === 0 && errors.length === 0) {
    // clean
  } else if (result.exitCode !== 0 && errors.length === 0) {
    warnings.push('tsc exited non-zero but no parseable TypeScript errors were found in output');
  }

  return {
    analyzer: 'tsc',
    duration_ms: result.duration_ms,
    findings,
    warnings,
  };
}
