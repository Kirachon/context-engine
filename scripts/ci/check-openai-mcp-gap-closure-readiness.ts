#!/usr/bin/env node
/**
 * Final T13 readiness gate for the OpenAI MCP gap-closure program.
 *
 * Aggregates completed-wave receipts, validates required evidence artifacts,
 * optionally runs focused live test suites, and writes both a machine-readable
 * gate artifact and a human-readable readiness pack.
 *
 * Exit codes:
 * - 0: gate passed
 * - 1: gate failed
 * - 2: usage/parsing error
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

type GateStatus = 'pass' | 'fail' | 'skip';

interface CliArgs {
  contractPath: string;
  planPath?: string;
  outPath?: string;
  readinessPackPath?: string;
  workspace: string;
  skipLiveTests: boolean;
}

interface LiveTestGroupContract {
  label: string;
  tests: string[];
  fixtures?: string[];
}

interface ReadinessContract {
  version: number;
  plan_path: string;
  readiness_pack_path: string;
  gate_artifact_path: string;
  required_completed_tasks: string[];
  required_docs: string[];
  live_test_groups: Record<string, LiveTestGroupContract>;
  artifact_checks: {
    retrieval_provenance: {
      quality_report: string;
      quality_gate: string;
      telemetry: string;
      routing_receipts: string;
      shadow_canary_gate: string;
      min_routing_receipt_coverage_pct: number;
    };
    malformed_output_accounting: {
      taxonomy_report: string;
      max_malformed_event_count: number;
    };
  };
}

interface PlanTaskStatus {
  task_id: string;
  status: string;
  ok: boolean;
}

interface LiveTestGroupResult {
  label: string;
  tests: string[];
  fixtures: string[];
  command: string[];
  status: GateStatus;
  exit_code: number | null;
  duration_ms: number;
  reasons: string[];
}

interface ArtifactCheckResult {
  label: string;
  status: GateStatus;
  paths: Record<string, string>;
  metrics: Record<string, number | string | boolean | null>;
  reasons: string[];
}

interface GateArtifact {
  schema_version: 1;
  generated_at: string;
  mode: 'dry_run';
  inputs: {
    contract: string;
    plan: string;
    workspace: string;
    out: string;
    readiness_pack: string;
    skip_live_tests: boolean;
  };
  dependencies: {
    required_docs: Array<{ path: string; exists: boolean }>;
    required_completed_tasks: PlanTaskStatus[];
  };
  live_test_groups: Record<string, LiveTestGroupResult>;
  artifact_checks: {
    retrieval_provenance: ArtifactCheckResult;
    malformed_output_accounting: ArtifactCheckResult;
  };
  overall: {
    status: GateStatus;
    reasons: string[];
  };
}

const DEFAULT_CONTRACT_PATH = path.join(
  'config',
  'ci',
  'openai-mcp-gap-closure-readiness-contract.json'
);

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/check-openai-mcp-gap-closure-readiness.ts [options]

Options:
  --contract <path>         Readiness contract path (default: ${DEFAULT_CONTRACT_PATH})
  --plan <path>             Override plan path from contract
  --out <path>              Override output gate artifact path
  --readiness-pack <path>   Override output readiness pack path
  --workspace <path>        Workspace root (default: cwd)
  --skip-live-tests         Validate file/artifact receipts only; do not run focused Jest suites
`);
  process.exit(code);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    contractPath: DEFAULT_CONTRACT_PATH,
    workspace: process.cwd(),
    skipLiveTests: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    }
    if (arg === '--contract') {
      if (!next) throw new Error('Missing value for --contract');
      args.contractPath = next;
      index += 1;
      continue;
    }
    if (arg === '--plan') {
      if (!next) throw new Error('Missing value for --plan');
      args.planPath = next;
      index += 1;
      continue;
    }
    if (arg === '--out') {
      if (!next) throw new Error('Missing value for --out');
      args.outPath = next;
      index += 1;
      continue;
    }
    if (arg === '--readiness-pack') {
      if (!next) throw new Error('Missing value for --readiness-pack');
      args.readinessPackPath = next;
      index += 1;
      continue;
    }
    if (arg === '--workspace') {
      if (!next) throw new Error('Missing value for --workspace');
      args.workspace = next;
      index += 1;
      continue;
    }
    if (arg === '--skip-live-tests') {
      args.skipLiveTests = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function readJsonFile<T>(filePath: string): T {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Missing JSON file: ${resolvedPath}`);
  }
  return JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as T;
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function statusFromReasons(reasons: string[]): GateStatus {
  return reasons.length === 0 ? 'pass' : 'fail';
}

function validateRequiredDocs(workspace: string, requiredDocs: string[]): Array<{ path: string; exists: boolean }> {
  return requiredDocs.map((relativePath) => ({
    path: relativePath,
    exists: fs.existsSync(path.join(workspace, relativePath)),
  }));
}

function readPlanStatuses(planPath: string, taskIds: string[]): PlanTaskStatus[] {
  const resolvedPath = path.resolve(planPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Plan file not found: ${resolvedPath}`);
  }
  const planContents = fs.readFileSync(resolvedPath, 'utf8');
  return taskIds.map((taskId) => {
    const match = planContents.match(
      new RegExp(`### ${taskId}:[\\s\\S]*?- \\*\\*status\\*\\*: ([^\\r\\n]+)`, 'm')
    );
    const status = match?.[1]?.trim() ?? 'Missing';
    return {
      task_id: taskId,
      status,
      ok: status === 'Completed',
    };
  });
}

function runJestGroup(workspace: string, group: LiveTestGroupContract): LiveTestGroupResult {
  const command = [process.execPath, '--experimental-vm-modules'];
  const args = [
    ...command.slice(1),
    path.join(workspace, 'node_modules', 'jest', 'bin', 'jest.js'),
    ...group.tests,
    '--runInBand',
  ];
  const start = Date.now();
  const result = spawnSync(command[0], args, {
    cwd: workspace,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const durationMs = Date.now() - start;
  const reasons: string[] = [];
  if ((result.status ?? 1) !== 0) {
    reasons.push(
      `Focused live tests failed for ${group.label}: exit=${result.status ?? -1} stderr=${(result.stderr ?? '')
        .trim()
        .slice(0, 400)}`
    );
  }
  return {
    label: group.label,
    tests: [...group.tests],
    fixtures: [...(group.fixtures ?? [])],
    command: [command[0], ...args],
    status: statusFromReasons(reasons),
    exit_code: result.status,
    duration_ms: durationMs,
    reasons,
  };
}

function buildSkippedLiveTestGroup(group: LiveTestGroupContract): LiveTestGroupResult {
  return {
    label: group.label,
    tests: [...group.tests],
    fixtures: [...(group.fixtures ?? [])],
    command: [],
    status: 'skip',
    exit_code: null,
    duration_ms: 0,
    reasons: ['Live test execution skipped by --skip-live-tests'],
  };
}

function validateLiveTestGroupFiles(workspace: string, group: LiveTestGroupContract): string[] {
  const reasons: string[] = [];
  for (const testPath of group.tests) {
    if (!fs.existsSync(path.join(workspace, testPath))) {
      reasons.push(`Missing live test file: ${testPath}`);
    }
  }
  for (const fixturePath of group.fixtures ?? []) {
    if (!fs.existsSync(path.join(workspace, fixturePath))) {
      reasons.push(`Missing referenced fixture: ${fixturePath}`);
    }
  }
  return reasons;
}

function validateRetrievalProvenanceArtifacts(
  workspace: string,
  contract: ReadinessContract['artifact_checks']['retrieval_provenance']
): ArtifactCheckResult {
  const resolvedPaths = {
    quality_report: path.join(workspace, contract.quality_report),
    quality_gate: path.join(workspace, contract.quality_gate),
    telemetry: path.join(workspace, contract.telemetry),
    routing_receipts: path.join(workspace, contract.routing_receipts),
    shadow_canary_gate: path.join(workspace, contract.shadow_canary_gate),
  };
  const reasons: string[] = [];

  const qualityReport = readJsonFile<Record<string, any>>(resolvedPaths.quality_report);
  const qualityGate = readJsonFile<Record<string, any>>(resolvedPaths.quality_gate);
  const telemetry = readJsonFile<Record<string, any>>(resolvedPaths.telemetry);
  const routingReceipts = readJsonFile<Record<string, any>>(resolvedPaths.routing_receipts);
  const shadowGate = readJsonFile<Record<string, any>>(resolvedPaths.shadow_canary_gate);

  if (qualityGate.gate?.status !== 'pass') {
    reasons.push('retrieval quality gate is not PASS');
  }
  if (shadowGate.gate?.status !== 'pass') {
    reasons.push('retrieval shadow canary gate is not PASS');
  }
  if (qualityReport.gate?.status !== 'pass') {
    reasons.push('retrieval quality report gate is not PASS');
  }

  const reproLocks = [
    ['quality_report.commit_sha', qualityReport.reproducibility_lock?.commit_sha],
    ['quality_report.dataset_hash', qualityReport.reproducibility_lock?.dataset_hash],
    ['quality_gate.commit_sha', qualityGate.reproducibility_lock?.commit_sha],
    ['quality_gate.dataset_hash', qualityGate.reproducibility_lock?.dataset_hash],
    ['telemetry.commit_sha', telemetry.reproducibility_lock?.commit_sha],
    ['telemetry.dataset_hash', telemetry.reproducibility_lock?.dataset_hash],
    ['routing_receipts.commit_sha', routingReceipts.reproducibility_lock?.commit_sha],
    ['routing_receipts.dataset_hash', routingReceipts.reproducibility_lock?.dataset_hash],
    ['shadow_gate.commit_sha', shadowGate.reproducibility_lock?.commit_sha],
    ['shadow_gate.dataset_hash', shadowGate.reproducibility_lock?.dataset_hash],
  ];
  for (const [label, value] of reproLocks) {
    if (!isNonEmptyString(value)) {
      reasons.push(`Missing reproducibility value: ${label}`);
    }
  }

  const receiptCoverage = Number(
    routingReceipts.routing_diagnostics?.receipt_coverage_pct ??
      shadowGate.observed?.routing_receipts?.receipt_coverage_pct ??
      Number.NaN
  );
  if (!Number.isFinite(receiptCoverage)) {
    reasons.push('Missing routing receipt coverage percentage');
  } else if (receiptCoverage < contract.min_routing_receipt_coverage_pct) {
    reasons.push(
      `Routing receipt coverage ${receiptCoverage} below ${contract.min_routing_receipt_coverage_pct}`
    );
  }

  if (!routingReceipts.reproducibility_lock?.feature_flags_snapshot) {
    reasons.push('Routing receipts missing feature flag snapshot');
  }

  return {
    label: 'retrieval provenance',
    status: statusFromReasons(reasons),
    paths: {
      quality_report: contract.quality_report,
      quality_gate: contract.quality_gate,
      telemetry: contract.telemetry,
      routing_receipts: contract.routing_receipts,
      shadow_canary_gate: contract.shadow_canary_gate,
    },
    metrics: {
      quality_gate_pass_rate: Number(qualityGate.summary?.pass_rate ?? Number.NaN),
      routing_receipt_coverage_pct: receiptCoverage,
      shadow_gate_status_pass: shadowGate.gate?.status === 'pass',
      quality_report_status_pass: qualityReport.gate?.status === 'pass',
    },
    reasons,
  };
}

function validateMalformedOutputAccounting(
  workspace: string,
  contract: ReadinessContract['artifact_checks']['malformed_output_accounting']
): ArtifactCheckResult {
  const resolvedPath = path.join(workspace, contract.taxonomy_report);
  const reasons: string[] = [];
  const report = readJsonFile<Record<string, any>>(resolvedPath);
  const malformedCount = Number(report.summary?.malformed_event_count ?? Number.NaN);

  if (report.status !== 'PASS') {
    reasons.push(`Enhancement error taxonomy report status is not PASS: ${String(report.status)}`);
  }
  if (!Number.isFinite(malformedCount)) {
    reasons.push('Malformed event count is missing');
  } else if (malformedCount > contract.max_malformed_event_count) {
    reasons.push(
      `Malformed event count ${malformedCount} exceeds max ${contract.max_malformed_event_count}`
    );
  }

  return {
    label: 'malformed output accounting',
    status: statusFromReasons(reasons),
    paths: {
      taxonomy_report: contract.taxonomy_report,
    },
    metrics: {
      malformed_event_count: malformedCount,
      status_pass: report.status === 'PASS',
      total_events: Number(report.summary?.total_events ?? Number.NaN),
    },
    reasons,
  };
}

function renderMarkdownPack(artifact: GateArtifact): string {
  const dependencyRows = artifact.dependencies.required_completed_tasks
    .map(
      (task) =>
        `| ${task.task_id} | ${task.status} | ${task.ok ? 'PASS' : 'FAIL'} |`
    )
    .join('\n');

  const docRows = artifact.dependencies.required_docs
    .map((doc) => `| ${doc.path} | ${doc.exists ? 'PASS' : 'FAIL'} |`)
    .join('\n');

  const liveTestSections = Object.entries(artifact.live_test_groups)
    .map(([groupId, result]) => {
      const command = result.command.length > 0 ? `\`${result.command.join(' ')}\`` : '`skipped`';
      const reasons =
        result.reasons.length > 0 ? result.reasons.map((reason) => `- ${reason}`).join('\n') : '- none';
      return [
        `### ${groupId}`,
        `- Status: \`${result.status.toUpperCase()}\``,
        `- Command: ${command}`,
        `- Tests: ${result.tests.map((entry) => `\`${entry}\``).join(', ')}`,
        result.fixtures.length > 0
          ? `- Fixtures: ${result.fixtures.map((entry) => `\`${entry}\``).join(', ')}`
          : `- Fixtures: none`,
        `- Duration: \`${result.duration_ms}ms\``,
        `- Reasons:`,
        reasons,
      ].join('\n');
    })
    .join('\n\n');

  const retrieval = artifact.artifact_checks.retrieval_provenance;
  const malformed = artifact.artifact_checks.malformed_output_accounting;
  const overallReasons =
    artifact.overall.reasons.length > 0
      ? artifact.overall.reasons.map((reason) => `- ${reason}`).join('\n')
      : '- none';

  return `# OpenAI MCP Gap Closure Final Readiness Pack

- Report type: \`T13 readiness pack\`
- Generated at: \`${artifact.generated_at}\`
- Mode: \`${artifact.mode}\`
- Overall status: \`${artifact.overall.status.toUpperCase()}\`
- Gate artifact: \`${artifact.inputs.out}\`

## Dependency Completion

| Task | Status | Verdict |
| --- | --- | --- |
${dependencyRows}

## Required Docs

| Path | Verdict |
| --- | --- |
${docRows}

## Live Test Receipts

${liveTestSections}

## Retrieval Provenance Evidence

- Status: \`${retrieval.status.toUpperCase()}\`
- Quality report: \`${retrieval.paths.quality_report}\`
- Quality gate: \`${retrieval.paths.quality_gate}\`
- Telemetry: \`${retrieval.paths.telemetry}\`
- Routing receipts: \`${retrieval.paths.routing_receipts}\`
- Shadow canary gate: \`${retrieval.paths.shadow_canary_gate}\`
- Receipt coverage pct: \`${String(retrieval.metrics.routing_receipt_coverage_pct)}\`
- Reasons:
${retrieval.reasons.length > 0 ? retrieval.reasons.map((reason) => `- ${reason}`).join('\n') : '- none'}

## Malformed Output Accounting

- Status: \`${malformed.status.toUpperCase()}\`
- Taxonomy report: \`${malformed.paths.taxonomy_report}\`
- Malformed event count: \`${String(malformed.metrics.malformed_event_count)}\`
- Reasons:
${malformed.reasons.length > 0 ? malformed.reasons.map((reason) => `- ${reason}`).join('\n') : '- none'}

## Final Verdict

- PASS threshold:
  - required docs present
  - required dependency tasks completed in the plan
  - focused graph/review/tracing checks pass when live tests are enabled
  - retrieval provenance artifacts remain PASS with reproducibility receipts intact
  - malformed output accounting stays at or below the frozen threshold
- Result:
${overallReasons}
`;
}

function run(): number {
  try {
    const args = parseArgs(process.argv.slice(2));
    const workspace = path.resolve(args.workspace);
    const contractPath = path.resolve(args.contractPath);
    const contract = readJsonFile<ReadinessContract>(contractPath);
    const planPath = path.resolve(workspace, args.planPath ?? contract.plan_path);
    const outPath = path.resolve(workspace, args.outPath ?? contract.gate_artifact_path);
    const readinessPackPath = path.resolve(
      workspace,
      args.readinessPackPath ?? contract.readiness_pack_path
    );

    const requiredDocs = validateRequiredDocs(workspace, contract.required_docs);
    const taskStatuses = readPlanStatuses(planPath, contract.required_completed_tasks);

    const liveTestGroups: Record<string, LiveTestGroupResult> = {};
    const liveTestFailures: string[] = [];
    for (const [groupId, group] of Object.entries(contract.live_test_groups)) {
      const pathFailures = validateLiveTestGroupFiles(workspace, group);
      let result = args.skipLiveTests ? buildSkippedLiveTestGroup(group) : runJestGroup(workspace, group);
      if (pathFailures.length > 0) {
        result = {
          ...result,
          status: 'fail',
          reasons: [...pathFailures, ...result.reasons],
        };
      }
      if (result.status === 'fail') {
        liveTestFailures.push(...result.reasons.map((reason) => `${groupId}: ${reason}`));
      }
      liveTestGroups[groupId] = result;
    }

    const retrievalProvenance = validateRetrievalProvenanceArtifacts(
      workspace,
      contract.artifact_checks.retrieval_provenance
    );
    const malformedOutputAccounting = validateMalformedOutputAccounting(
      workspace,
      contract.artifact_checks.malformed_output_accounting
    );

    const overallReasons: string[] = [];
    for (const doc of requiredDocs) {
      if (!doc.exists) {
        overallReasons.push(`Missing required documentation: ${doc.path}`);
      }
    }
    for (const task of taskStatuses) {
      if (!task.ok) {
        overallReasons.push(`Required dependency task not completed: ${task.task_id} (${task.status})`);
      }
    }
    overallReasons.push(...liveTestFailures);
    if (retrievalProvenance.status !== 'pass') {
      overallReasons.push(...retrievalProvenance.reasons.map((reason) => `retrieval_provenance: ${reason}`));
    }
    if (malformedOutputAccounting.status !== 'pass') {
      overallReasons.push(
        ...malformedOutputAccounting.reasons.map((reason) => `malformed_output_accounting: ${reason}`)
      );
    }

    const artifact: GateArtifact = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      mode: 'dry_run',
      inputs: {
        contract: contractPath,
        plan: planPath,
        workspace,
        out: outPath,
        readiness_pack: readinessPackPath,
        skip_live_tests: args.skipLiveTests,
      },
      dependencies: {
        required_docs: requiredDocs,
        required_completed_tasks: taskStatuses,
      },
      live_test_groups: liveTestGroups,
      artifact_checks: {
        retrieval_provenance: retrievalProvenance,
        malformed_output_accounting: malformedOutputAccounting,
      },
      overall: {
        status: statusFromReasons(overallReasons),
        reasons: overallReasons,
      },
    };

    ensureParentDir(outPath);
    ensureParentDir(readinessPackPath);
    fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf8');
    fs.writeFileSync(readinessPackPath, renderMarkdownPack(artifact), 'utf8');

    // eslint-disable-next-line no-console
    console.log(`openai_mcp_gap_closure_readiness status=${artifact.overall.status} out=${outPath}`);
    // eslint-disable-next-line no-console
    console.log(`readiness_pack=${readinessPackPath}`);
    return artifact.overall.status === 'pass' ? 0 : 1;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Error: ${(error as Error).message}`);
    return 2;
  }
}

process.exitCode = run();
