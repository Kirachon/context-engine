import type { EnterpriseFinding } from '../../types.js';
import type { StaticAnalyzerId, StaticAnalyzerInput, StaticAnalyzerResult } from './types.js';
import { runTscAnalyzer } from './tsc.js';
import { runSemgrepAnalyzer } from './semgrep.js';

export async function runStaticAnalyzers(args: {
  input: StaticAnalyzerInput;
  analyzers: StaticAnalyzerId[];
  timeoutMs: number;
  totalTimeoutMs?: number;
  maxFindingsPerAnalyzer: number;
  semgrepArgs?: string[];
}): Promise<{ findings: EnterpriseFinding[]; results: StaticAnalyzerResult[]; warnings: string[] }> {
  const warnings: string[] = [];
  const results: StaticAnalyzerResult[] = [];
  const findings: EnterpriseFinding[] = [];
  const startTime = Date.now();
  const totalTimeoutMs = Math.max(
    0,
    args.totalTimeoutMs ?? Math.max(0, args.timeoutMs) * Math.max(1, args.analyzers.length)
  );

  for (const analyzer of args.analyzers) {
    const elapsedMs = Date.now() - startTime;
    const remainingBudgetMs = totalTimeoutMs - elapsedMs;
    if (remainingBudgetMs <= 0) {
      warnings.push(`static analyzer runtime budget exhausted after ${elapsedMs}ms; skipping remaining analyzers`);
      break;
    }
    const effectiveTimeoutMs = Math.max(1, Math.min(args.timeoutMs, remainingBudgetMs));
    if (effectiveTimeoutMs < args.timeoutMs) {
      warnings.push(`static analyzer ${analyzer} timeout reduced to ${effectiveTimeoutMs}ms due to total runtime budget`);
    }

    try {
      if (analyzer === 'tsc') {
        const r = await runTscAnalyzer(args.input, {
          timeoutMs: effectiveTimeoutMs,
          maxFindings: args.maxFindingsPerAnalyzer,
        });
        results.push(r);
        findings.push(...r.findings);
        warnings.push(...r.warnings);
      } else if (analyzer === 'semgrep') {
        const r = await runSemgrepAnalyzer(args.input, {
          timeoutMs: effectiveTimeoutMs,
          maxFindings: args.maxFindingsPerAnalyzer,
          args: args.semgrepArgs,
        });
        results.push(r);
        findings.push(...r.findings);
        warnings.push(...r.warnings);
      }
    } catch (e) {
      warnings.push(`Static analyzer ${analyzer} failed: ${String(e)}`);
    }
  }

  return { findings, results, warnings };
}
