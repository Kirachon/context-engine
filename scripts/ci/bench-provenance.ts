import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { FEATURE_FLAGS } from '../../src/config/features.js';

export type BenchMode = 'scan' | 'search' | 'retrieve';
export type RetrievalProvider = 'local_native';

export interface BenchProvenanceInput {
  benchMode: BenchMode;
  workspace: string;
  retrievalProvider: RetrievalProvider;
  datasetId: string;
  datasetHash: string;
}

export interface BenchProvenance {
  timestamp_utc: string;
  commit_sha: string;
  branch_or_tag: string;
  workspace_fingerprint: string;
  index_fingerprint: string;
  bench_mode: BenchMode;
  feature_flags_snapshot: string;
  node_version: string;
  os_version: string;
  env_fingerprint: string;
  dataset_id: string;
  dataset_hash: string;
  retrieval_provider: RetrievalProvider;
}

function normalizeWorkspacePath(workspace: string): string {
  return path.resolve(workspace).replace(/\\/g, '/');
}

export function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function runGit(args: string[]): string | undefined {
  try {
    const result = spawnSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0) return undefined;
    const trimmed = (result.stdout ?? '').trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}

export function resolveCommitSha(): string {
  const fromEnv = (
    process.env.GITHUB_SHA ||
    process.env.CI_COMMIT_SHA ||
    process.env.BUILD_SOURCEVERSION ||
    process.env.BUILDKITE_COMMIT ||
    process.env.CIRCLE_SHA1 ||
    process.env.TRAVIS_COMMIT
  )?.trim();
  if (fromEnv) return fromEnv;

  const fromGit = runGit(['rev-parse', 'HEAD']);
  return fromGit ?? 'unknown';
}

export function resolveBranchOrTag(): string {
  const envCandidates = [
    process.env.GITHUB_REF_NAME,
    process.env.CI_COMMIT_REF_NAME,
    process.env.BUILD_SOURCEBRANCHNAME,
  ];
  for (const candidate of envCandidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }

  const githubRef = process.env.GITHUB_REF?.trim();
  if (githubRef) {
    const match = githubRef.match(/^refs\/(?:heads|tags)\/(.+)$/);
    if (match?.[1]) return match[1];
  }

  const fromGit = runGit(['branch', '--show-current']);
  if (fromGit && fromGit !== 'HEAD') return fromGit;

  const tag = runGit(['describe', '--tags', '--exact-match']);
  if (tag) return tag;

  return 'detached-head';
}

export function resolveWorkspaceFingerprint(workspace: string): string {
  return `workspace:${hashString(normalizeWorkspacePath(workspace))}`;
}

export function resolveIndexFingerprint(workspace: string): string {
  const resolvedWorkspace = path.resolve(workspace);
  const fingerprintPath = path.join(resolvedWorkspace, '.augment-index-fingerprint.json');
  if (fs.existsSync(fingerprintPath)) {
    try {
      const raw = fs.readFileSync(fingerprintPath, 'utf8');
      const parsed = JSON.parse(raw) as {
        version?: number;
        fingerprint?: unknown;
      };
      if (parsed?.version === 1 && typeof parsed.fingerprint === 'string' && parsed.fingerprint.trim()) {
        return `fingerprint:${parsed.fingerprint.trim()}`;
      }
    } catch {
      // Fall back to a deterministic workspace-based fingerprint.
    }
  }

  return `index-fallback:${hashString(normalizeWorkspacePath(workspace))}`;
}

export function resolveFeatureFlagsSnapshot(): string {
  const snapshot = Object.fromEntries(
    Object.entries(FEATURE_FLAGS).sort(([left], [right]) => left.localeCompare(right))
  );
  return JSON.stringify(snapshot);
}

export function resolveOsVersion(): string {
  return `${os.type()} ${os.release()} (${os.arch()})`;
}

export function resolveEnvFingerprint(): string {
  const keys = [
    'CI',
    'GITHUB_ACTIONS',
    'RUNNER_OS',
    'RUNNER_ARCH',
    'CE_RETRIEVAL_PROVIDER',
    'CE_AI_PROVIDER',
    'CE_SEARCH_AND_ASK_QUEUE_MAX',
    'CE_SEARCH_AND_ASK_QUEUE_MAX_BACKGROUND',
    'CE_SEARCH_AND_ASK_QUEUE_REJECT_MODE',
    'CE_METRICS',
    'npm_config_user_agent',
  ];
  const canonical = keys
    .slice()
    .sort()
    .map((key) => `${key}=${(process.env[key] ?? '').replace(/\\/g, '/')}`)
    .join('|');
  return hashString(canonical).slice(0, 16);
}

export function makeBenchProvenance(input: BenchProvenanceInput): BenchProvenance {
  return {
    timestamp_utc: new Date().toISOString(),
    commit_sha: resolveCommitSha(),
    branch_or_tag: resolveBranchOrTag(),
    workspace_fingerprint: resolveWorkspaceFingerprint(input.workspace),
    index_fingerprint: resolveIndexFingerprint(input.workspace),
    bench_mode: input.benchMode,
    dataset_id: input.datasetId,
    dataset_hash: input.datasetHash,
    retrieval_provider: input.retrievalProvider,
    feature_flags_snapshot: resolveFeatureFlagsSnapshot(),
    node_version: process.version,
    os_version: resolveOsVersion(),
    env_fingerprint: resolveEnvFingerprint(),
  };
}
