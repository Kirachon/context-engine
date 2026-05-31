#!/usr/bin/env node
/**
 * S9B compatibility release gate: focused MCP compatibility matrix runner.
 *
 * Runs bounded Jest suites and optional gate scripts across structured outputs,
 * resources, policy, tasks, auth, roots, and evals. Records pass/fail evidence
 * without requiring the full test suite.
 *
 * Exit codes:
 * - 0: all matrix surfaces pass (or dry-run/template mode)
 * - 1: one or more surfaces fail
 * - 2: usage or runtime error
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

type MatrixSurface = {
  id: string;
  label: string;
  tests: string[];
  scripts?: string[];
};

export type McpCompatibilityMatrixConfig = {
  version: number;
  default_log_path: string;
  default_json_path: string;
  surfaces: MatrixSurface[];
};

type MatrixCheckResult = {
  name: string;
  kind: 'jest' | 'script';
  status: 'pass' | 'fail';
  detail: string;
  exit_code: number;
};

type MatrixSurfaceResult = {
  id: string;
  label: string;
  status: 'pass' | 'fail';
  checks: MatrixCheckResult[];
};

export type McpCompatibilityMatrixArtifact = {
  status: 'PASS' | 'FAIL';
  version: number;
  generated_at: string;
  repo_root: string;
  summary: {
    surfaces_total: number;
    surfaces_passed: number;
    surfaces_failed: number;
    checks_total: number;
    checks_passed: number;
    checks_failed: number;
  };
  surfaces: MatrixSurfaceResult[];
};

interface CliArgs {
  repoRoot: string;
  configPath: string;
  logPath: string;
  jsonPath: string;
  dryRun: boolean;
  writeTemplate: boolean;
}

const DEFAULT_CONFIG = path.join('config', 'ci', 'mcp-compatibility-matrix.json');

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/run-mcp-compatibility-matrix.ts [options]

Options:
  --config <path>         Matrix config (default: ${DEFAULT_CONFIG})
  --log <path>            Human-readable evidence log output path
  --json <path>           JSON artifact output path
  --dry-run               Print planned checks without executing them
  --write-template        Write a template evidence log without executing checks
  --help, -h              Show this help
`);
  process.exit(code);
}

function parseArgs(argv: string[]): CliArgs {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const args: CliArgs = {
    repoRoot,
    configPath: path.join(repoRoot, DEFAULT_CONFIG),
    logPath: '',
    jsonPath: '',
    dryRun: false,
    writeTemplate: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    }
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--write-template') {
      args.writeTemplate = true;
      continue;
    }
    if (arg === '--config') {
      if (!next) throw new Error('Missing value for --config');
      args.configPath = path.resolve(next);
      index += 1;
      continue;
    }
    if (arg === '--log') {
      if (!next) throw new Error('Missing value for --log');
      args.logPath = path.resolve(next);
      index += 1;
      continue;
    }
    if (arg === '--json') {
      if (!next) throw new Error('Missing value for --json');
      args.jsonPath = path.resolve(next);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

export function loadMcpCompatibilityMatrixConfig(configPath: string): McpCompatibilityMatrixConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Matrix config not found: ${configPath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as McpCompatibilityMatrixConfig;
  if (parsed.version !== 1) {
    throw new Error(`Unsupported matrix config version: ${String(parsed.version)}`);
  }
  if (!Array.isArray(parsed.surfaces) || parsed.surfaces.length === 0) {
    throw new Error('Matrix config must include a non-empty surfaces array.');
  }

  for (const surface of parsed.surfaces) {
    if (!surface.id || !surface.label) {
      throw new Error('Each matrix surface must include id and label.');
    }
    if (!Array.isArray(surface.tests) || surface.tests.length === 0) {
      throw new Error(`Matrix surface ${surface.id} must include at least one test file.`);
    }
  }

  return parsed;
}

function resolveRepoPath(repoRoot: string, relativePath: string): string {
  return path.resolve(repoRoot, relativePath);
}

function runJestGroup(repoRoot: string, tests: string[]): { status: number; detail: string } {
  const jestCli = path.join(repoRoot, 'node_modules', 'jest', 'bin', 'jest.js');
  const result = spawnSync(
    process.execPath,
    ['--experimental-vm-modules', jestCli, '--runInBand', '--silent', ...tests],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        CI: 'true',
      },
      encoding: 'utf8',
    }
  );

  const status = result.status ?? 1;
  const detail =
    status === 0
      ? `jest ${tests.join(' ')}`
      : `jest failed (${tests.join(' ')}): ${(result.stderr || result.stdout || '').trim()}`;

  return { status, detail };
}

function runGateScript(repoRoot: string, scriptPath: string): { status: number; detail: string } {
  const resolvedScript = resolveRepoPath(repoRoot, scriptPath);
  const result = spawnSync(process.execPath, ['--import', 'tsx', resolvedScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CI: 'true',
    },
    encoding: 'utf8',
  });

  const status = result.status ?? 1;
  const detail =
    status === 0
      ? scriptPath
      : `${scriptPath} failed: ${(result.stderr || result.stdout || '').trim()}`;

  return { status, detail };
}

function buildTemplateSurfaceResults(config: McpCompatibilityMatrixConfig): MatrixSurfaceResult[] {
  return config.surfaces.map((surface) => {
    const checks: MatrixCheckResult[] = [
      ...surface.tests.map((testPath) => ({
        name: testPath,
        kind: 'jest' as const,
        status: 'pass' as const,
        detail: 'template: not executed',
        exit_code: 0,
      })),
      ...(surface.scripts ?? []).map((scriptPath) => ({
        name: scriptPath,
        kind: 'script' as const,
        status: 'pass' as const,
        detail: 'template: not executed',
        exit_code: 0,
      })),
    ];

    return {
      id: surface.id,
      label: surface.label,
      status: 'pass',
      checks,
    };
  });
}

function runMatrixSurface(repoRoot: string, surface: MatrixSurface): MatrixSurfaceResult {
  const checks: MatrixCheckResult[] = [];

  const jestResult = runJestGroup(repoRoot, surface.tests);
  checks.push({
    name: surface.tests.join(', '),
    kind: 'jest',
    status: jestResult.status === 0 ? 'pass' : 'fail',
    detail: jestResult.detail,
    exit_code: jestResult.status,
  });

  for (const scriptPath of surface.scripts ?? []) {
    const scriptResult = runGateScript(repoRoot, scriptPath);
    checks.push({
      name: scriptPath,
      kind: 'script',
      status: scriptResult.status === 0 ? 'pass' : 'fail',
      detail: scriptResult.detail,
      exit_code: scriptResult.status,
    });
  }

  const status = checks.every((check) => check.status === 'pass') ? 'pass' : 'fail';
  return {
    id: surface.id,
    label: surface.label,
    status,
    checks,
  };
}

export function buildMatrixArtifact(
  repoRoot: string,
  config: McpCompatibilityMatrixConfig,
  surfaces: MatrixSurfaceResult[]
): McpCompatibilityMatrixArtifact {
  const checks = surfaces.flatMap((surface) => surface.checks);
  const surfacesPassed = surfaces.filter((surface) => surface.status === 'pass').length;
  const checksPassed = checks.filter((check) => check.status === 'pass').length;

  return {
    status: surfaces.every((surface) => surface.status === 'pass') ? 'PASS' : 'FAIL',
    version: config.version,
    generated_at: new Date().toISOString(),
    repo_root: repoRoot,
    summary: {
      surfaces_total: surfaces.length,
      surfaces_passed: surfacesPassed,
      surfaces_failed: surfaces.length - surfacesPassed,
      checks_total: checks.length,
      checks_passed: checksPassed,
      checks_failed: checks.length - checksPassed,
    },
    surfaces,
  };
}

export function formatMatrixLog(
  configPath: string,
  artifact: McpCompatibilityMatrixArtifact,
  options: { template?: boolean } = {}
): string {
  const lines: string[] = [
    'MCP compatibility release gate (S9B)',
    `config=${configPath}`,
    `generated_at=${artifact.generated_at}`,
    `status=${artifact.status}`,
    `surfaces=${artifact.summary.surfaces_passed}/${artifact.summary.surfaces_total}`,
    `checks=${artifact.summary.checks_passed}/${artifact.summary.checks_total}`,
  ];

  if (options.template) {
    lines.push('mode=template');
  }

  lines.push('');

  for (const surface of artifact.surfaces) {
    lines.push(`[surface] ${surface.id}: ${surface.label}`);
    for (const check of surface.checks) {
      const marker = check.status === 'pass' ? 'PASS' : 'FAIL';
      lines.push(`${marker} ${check.kind}:${check.name}: ${check.detail}`);
    }
    lines.push(`surface_status=${surface.status.toUpperCase()}`);
    lines.push('');
  }

  lines.push(artifact.status === 'PASS' ? 'MCP compatibility matrix passed.' : 'MCP compatibility matrix failed.');
  return `${lines.join('\n')}\n`;
}

function writeArtifacts(
  logPath: string,
  jsonPath: string,
  logText: string,
  artifact: McpCompatibilityMatrixArtifact
): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(logPath, logText, 'utf8');
  fs.writeFileSync(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}

function printDryRun(config: McpCompatibilityMatrixConfig): void {
  // eslint-disable-next-line no-console
  console.log('MCP compatibility matrix (dry run)');
  for (const surface of config.surfaces) {
    // eslint-disable-next-line no-console
    console.log(`\n[surface] ${surface.id}: ${surface.label}`);
    for (const testPath of surface.tests) {
      // eslint-disable-next-line no-console
      console.log(`- jest ${testPath}`);
    }
    for (const scriptPath of surface.scripts ?? []) {
      // eslint-disable-next-line no-console
      console.log(`- script ${scriptPath}`);
    }
  }
}

export function runCompatibilityMatrix(args: CliArgs): number {
  const config = loadMcpCompatibilityMatrixConfig(args.configPath);
  const logPath = args.logPath || resolveRepoPath(args.repoRoot, config.default_log_path);
  const jsonPath = args.jsonPath || resolveRepoPath(args.repoRoot, config.default_json_path);

  if (args.dryRun) {
    printDryRun(config);
    return 0;
  }

  const surfaceResults = args.writeTemplate
    ? buildTemplateSurfaceResults(config)
    : config.surfaces.map((surface) => runMatrixSurface(args.repoRoot, surface));

  const artifact = buildMatrixArtifact(args.repoRoot, config, surfaceResults);
  const logText = formatMatrixLog(args.configPath, artifact, { template: args.writeTemplate });
  writeArtifacts(logPath, jsonPath, logText, artifact);

  // eslint-disable-next-line no-console
  console.log(formatMatrixLog(args.configPath, artifact, { template: args.writeTemplate }).trim());

  return artifact.status === 'PASS' ? 0 : 1;
}

function run(): number {
  try {
    const args = parseArgs(process.argv.slice(2));
    return runCompatibilityMatrix(args);
  } catch (error) {
    console.error(
      `[mcp-compatibility-matrix] ${error instanceof Error ? error.message : String(error)}`
    );
    return 2;
  }
}

process.exitCode = run();
