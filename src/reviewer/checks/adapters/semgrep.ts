import path from 'node:path';
import type { EnterpriseFinding, FindingSeverity } from '../../types.js';
import type { StaticAnalyzerInput, StaticAnalyzerResult } from './types.js';
import { envInt } from '../../../config/env.js';
import { runCommand } from './exec.js';

const DEFAULT_SEMGREP_MAX_FILES = 100;

function mapSeverity(raw: unknown): FindingSeverity {
  const s = typeof raw === 'string' ? raw.toUpperCase() : '';
  if (s === 'ERROR' || s === 'CRITICAL') return 'CRITICAL';
  if (s === 'WARNING' || s === 'HIGH') return 'HIGH';
  if (s === 'MEDIUM') return 'MEDIUM';
  if (s === 'INFO' || s === 'LOW') return 'LOW';
  return 'MEDIUM';
}

export async function runSemgrepAnalyzer(
  input: StaticAnalyzerInput,
  opts: { timeoutMs: number; maxFindings: number; args?: string[] }
): Promise<StaticAnalyzerResult> {
  const startTime = Date.now();
  const command = process.platform === 'win32' ? 'semgrep.exe' : 'semgrep';
  const baseArgs = ['--json', ...(opts.args ?? ['--config', 'auto']), '--quiet'];
  const maxFiles = envInt('CE_SEMGREP_MAX_FILES', DEFAULT_SEMGREP_MAX_FILES, { min: 0 });
  const files = input.changed_files ?? [];
  if (files.length === 0) {
    return {
      analyzer: 'semgrep',
      duration_ms: Date.now() - startTime,
      findings: [],
      warnings: ['semgrep selected with empty changed_files; skipping to avoid scanning the full workspace'],
      skipped_reason: 'semgrep_no_changed_files',
    };
  }

  const chunks: string[][] = [];

  if (maxFiles > 0 && files.length > maxFiles) {
    for (let i = 0; i < files.length; i += maxFiles) {
      chunks.push(files.slice(i, i + maxFiles));
    }
  } else {
    chunks.push(files);
  }

  const warnings: string[] = [];
  if (chunks.length > 1) {
    warnings.push(`semgrep file list chunked into ${chunks.length} batches (max ${maxFiles} files each)`);
  }

  const findings: EnterpriseFinding[] = [];
  let totalResults: any[] = [];
  let skippedInvalidJson = 0;
  let combinedExitCode = 0;
  let findingIndex = 0;
  let anyParsed = false;

  for (const chunk of chunks) {
    const commandArgs = [...baseArgs, ...chunk];
    const result = await runCommand({
      command,
      commandArgs,
      cwd: input.workspace_path,
      timeoutMs: opts.timeoutMs,
    });

    const combined = `${result.stdout}\n${result.stderr}`.trim();
    if (result.exitCode !== 0 && /not recognized|ENOENT|No such file or directory/i.test(combined)) {
      return {
        analyzer: 'semgrep',
        duration_ms: Date.now() - startTime,
        findings: [],
        warnings: ['semgrep not found on PATH; skipping'],
        skipped_reason: 'semgrep_missing',
      };
    }

    combinedExitCode = combinedExitCode || result.exitCode;

    let parsed: any;
    try {
      parsed = combined.length > 0 ? JSON.parse(combined) : null;
    } catch {
      skippedInvalidJson += 1;
      continue;
    }

    anyParsed = true;
    const results = Array.isArray(parsed?.results) ? parsed.results : [];
    totalResults = totalResults.concat(results);
  }

  if (!anyParsed) {
    return {
      analyzer: 'semgrep',
      duration_ms: Date.now() - startTime,
      findings: [],
      warnings: ['semgrep did not return valid JSON; skipping'],
      skipped_reason: 'semgrep_invalid_json',
    };
  }

  if (skippedInvalidJson > 0) {
    warnings.push(`semgrep returned invalid JSON for ${skippedInvalidJson} batch${skippedInvalidJson > 1 ? 'es' : ''}`);
  }

  for (const r of totalResults.slice(0, Math.max(0, opts.maxFindings))) {
    const checkId = typeof r?.check_id === 'string' ? r.check_id : `unknown-${findingIndex + 1}`;
    const file = typeof r?.path === 'string' ? r.path : '(unknown file)';
    const startLine = Number(r?.start?.line ?? 1);
    const endLine = Number(r?.end?.line ?? startLine);
    const message = typeof r?.extra?.message === 'string' ? r.extra.message : 'Semgrep finding';
    const severity = mapSeverity(r?.extra?.severity);
    findingIndex += 1;
    findings.push({
      id: `SEMGREP-${checkId}-${findingIndex}`,
      severity,
      category: 'security',
      confidence: 0.85,
      title: message,
      location: { file: path.normalize(file), startLine, endLine },
      evidence: [checkId],
      impact: 'Semgrep detected a pattern that may indicate a bug or security issue.',
      recommendation: 'Review the finding and either fix the code or suppress it with a documented justification.',
    });
  }

  if (combinedExitCode !== 0 && findings.length === 0) {
    warnings.push('semgrep exited non-zero and produced no parseable results');
  }

  return {
    analyzer: 'semgrep',
    duration_ms: Date.now() - startTime,
    findings,
    warnings,
  };
}
