#!/usr/bin/env node
/**
 * Retrieval quality gate checker.
 *
 * Exit codes:
 * - 0: gate passed
 * - 1: gate failed
 * - 2: usage/parsing error
 */

import * as fs from 'fs';
import * as path from 'path';

interface CliArgs {
  reportPath: string;
  outPath: string;
}

interface Evaluation {
  id: string;
  status: 'pass' | 'fail' | 'skip';
}

interface RetrievalQualityReport {
  evaluations?: Evaluation[];
  summary?: {
    pass_rate?: number;
  };
  gate_rules?: {
    min_pass_rate?: number;
    required_ids?: string[];
  };
  gate?: {
    status?: string;
    reasons?: string[];
  };
}

interface GateArtifact {
  schema_version: number;
  generated_at: string;
  inputs: {
    report: string;
    out: string;
  };
  summary: {
    total: number;
    pass: number;
    fail: number;
    skip: number;
    pass_rate: number;
  };
  gate: {
    status: 'pass' | 'fail';
    reasons: string[];
  };
}

const DEFAULT_REPORT_PATH = path.join('artifacts', 'bench', 'retrieval-quality-report.json');
const DEFAULT_OUT_PATH = path.join('artifacts', 'bench', 'retrieval-quality-gate.json');

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/check-retrieval-quality-gate.ts [options]

Options:
  --report <path>           Retrieval quality report path (default: ${DEFAULT_REPORT_PATH})
  --out <path>              Output gate artifact path (default: ${DEFAULT_OUT_PATH})
`);
  process.exit(code);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    reportPath: DEFAULT_REPORT_PATH,
    outPath: DEFAULT_OUT_PATH,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    }
    if (arg === '--report') {
      if (!next) throw new Error('Missing value for --report');
      args.reportPath = next;
      i += 1;
      continue;
    }
    if (arg === '--out') {
      if (!next) throw new Error('Missing value for --out');
      args.outPath = next;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readReport(filePath: string): RetrievalQualityReport {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Report not found: ${resolved}`);
  }
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Report must be a JSON object');
  }
  return parsed as RetrievalQualityReport;
}

function run(): number {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = readReport(args.reportPath);
    const evaluations = Array.isArray(report.evaluations) ? report.evaluations : [];
    const pass = evaluations.filter((item) => item.status === 'pass').length;
    const fail = evaluations.filter((item) => item.status === 'fail').length;
    const skip = evaluations.filter((item) => item.status === 'skip').length;
    const total = evaluations.length;
    const passRate = total > 0 ? pass / total : 0;

    const reasons = [...(report.gate?.reasons ?? [])];
    const minPassRate = report.gate_rules?.min_pass_rate ?? 1;
    if (passRate < minPassRate) {
      reasons.push(`pass_rate ${passRate.toFixed(3)} below min_pass_rate ${minPassRate}`);
    }

    for (const metricId of report.gate_rules?.required_ids ?? []) {
      const evalResult = evaluations.find((item) => item.id === metricId);
      if (!evalResult) {
        reasons.push(`required metric missing: ${metricId}`);
        continue;
      }
      if (evalResult.status !== 'pass') {
        reasons.push(`required metric not pass: ${metricId} (${evalResult.status})`);
      }
    }

    if (report.gate?.status === 'fail' && reasons.length === 0) {
      reasons.push('report gate status is fail');
    }

    const status: 'pass' | 'fail' = reasons.length === 0 ? 'pass' : 'fail';
    const artifact: GateArtifact = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      inputs: {
        report: path.resolve(args.reportPath),
        out: path.resolve(args.outPath),
      },
      summary: {
        total,
        pass,
        fail,
        skip,
        pass_rate: passRate,
      },
      gate: {
        status,
        reasons,
      },
    };

    const outPath = path.resolve(args.outPath);
    ensureParentDir(outPath);
    fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf8');

    // eslint-disable-next-line no-console
    console.log(`retrieval_quality_gate status=${status} out=${outPath}`);
    return status === 'pass' ? 0 : 1;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Error: ${(error as Error).message}`);
    return 2;
  }
}

process.exitCode = run();
