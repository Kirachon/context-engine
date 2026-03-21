export type SlowToolMode = 'enhance_prompt' | 'create_plan' | 'refine_plan' | 'execute_plan';

export type SlowToolCallSample = {
  search_query_chars: number;
  prompt_chars: number;
  timeout_ms: number | null;
  priority: string | null;
};

export type SlowToolRunSample = {
  elapsed_ms: number;
  output_chars: number;
  call_count: number;
  prompt_chars_total: number;
  prompt_chars_max: number;
  prompt_chars_min: number;
  prompt_call_samples: SlowToolCallSample[];
};

type NumericSummary = {
  count: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
};

type MsSummary = {
  count: number;
  avg_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  min_ms: number;
  max_ms: number;
};

type CharSummary = {
  count: number;
  avg_chars: number;
  p50_chars: number;
  p95_chars: number;
  p99_chars: number;
  min_chars: number;
  max_chars: number;
};

export type SlowToolBenchmarkPayload = {
  mode: SlowToolMode;
  tool: SlowToolMode;
  workspace: string;
  cold: boolean;
  iterations: number;
  input: Record<string, unknown>;
  timing: MsSummary;
  repeat: {
    first_ms: number;
    repeat_count: number;
    repeat_avg_ms: number;
    repeat_p95_ms: number;
    repeat_delta_ms: number;
    repeat_delta_pct: number;
  };
  prompt_stats: CharSummary;
  run_prompt_stats: CharSummary;
  call_stats: {
    total_calls: number;
    avg_calls_per_run: number;
    p95_calls_per_run: number;
    max_calls_per_run: number;
  };
  output_stats: CharSummary;
};

interface CompareArgs {
  metricPath?: string;
  maxRegressionPct?: number;
  maxRegressionAbs?: number;
  higherIsBetter: boolean;
  requireSameMode: boolean;
}

interface BenchPayload {
  mode?: string;
  [key: string]: unknown;
}

interface ProvenanceMetadata {
  timestamp_utc?: string;
  commit_sha?: string;
  branch_or_tag?: string;
  workspace_fingerprint?: string;
  index_fingerprint?: string;
  bench_mode?: string;
  dataset_id?: string;
  dataset_hash?: string;
  retrieval_provider?: string;
  feature_flags_snapshot?: string;
  node_version?: string;
  os_version?: string;
  env_fingerprint?: string;
  [key: string]: unknown;
}

interface BenchOutput {
  total_ms?: number;
  payload?: BenchPayload;
  provenance?: ProvenanceMetadata;
  [key: string]: unknown;
}

export interface BenchComparisonResult {
  metricPath: string;
  baselineMetric: number;
  candidateMetric: number;
  regressionAbs: number;
  regressionPct: number;
  breachedPct: boolean;
  breachedAbs: boolean;
  failed: boolean;
}

function summarizeNumbers(samples: number[]): NumericSummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((acc, value) => acc + value, 0);
  const pick = (pct: number): number => {
    if (!sorted.length) {
      return 0;
    }
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
    return sorted[index] ?? 0;
  };

  return {
    count: samples.length,
    avg: samples.length ? sum / samples.length : 0,
    p50: pick(50),
    p95: pick(95),
    p99: pick(99),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function summarizeMs(samplesMs: number[]): MsSummary {
  const summary = summarizeNumbers(samplesMs);
  return {
    count: summary.count,
    avg_ms: summary.avg,
    p50_ms: summary.p50,
    p95_ms: summary.p95,
    p99_ms: summary.p99,
    min_ms: summary.min,
    max_ms: summary.max,
  };
}

function summarizeChars(samples: number[]): CharSummary {
  const summary = summarizeNumbers(samples);
  return {
    count: summary.count,
    avg_chars: summary.avg,
    p50_chars: summary.p50,
    p95_chars: summary.p95,
    p99_chars: summary.p99,
    min_chars: summary.min,
    max_chars: summary.max,
  };
}

export function summarizeSlowToolRuns(samples: SlowToolRunSample[]): SlowToolBenchmarkPayload['timing'] extends MsSummary
  ? {
      timing: MsSummary;
      repeat: SlowToolBenchmarkPayload['repeat'];
      prompt_stats: SlowToolBenchmarkPayload['prompt_stats'];
      run_prompt_stats: SlowToolBenchmarkPayload['run_prompt_stats'];
      call_stats: SlowToolBenchmarkPayload['call_stats'];
      output_stats: SlowToolBenchmarkPayload['output_stats'];
    }
  : never {
  const elapsedMs = samples.map((sample) => sample.elapsed_ms);
  const promptLengths = samples.flatMap((sample) => sample.prompt_call_samples.map((call) => call.prompt_chars));
  const runPromptTotals = samples.map((sample) => sample.prompt_chars_total);
  const outputLengths = samples.map((sample) => sample.output_chars);
  const callCounts = samples.map((sample) => sample.call_count);
  const firstMs = samples[0]?.elapsed_ms ?? 0;
  const repeatSamples = samples.slice(1).map((sample) => sample.elapsed_ms);
  const repeatAvgMs = repeatSamples.length ? repeatSamples.reduce((acc, value) => acc + value, 0) / repeatSamples.length : 0;
  const repeatSummary = summarizeNumbers(repeatSamples);
  const repeatDeltaMs = firstMs - repeatAvgMs;
  const repeatDeltaPct = firstMs > 0 ? (repeatDeltaMs / firstMs) * 100 : 0;

  return {
    timing: summarizeMs(elapsedMs),
    repeat: {
      first_ms: firstMs,
      repeat_count: repeatSamples.length,
      repeat_avg_ms: repeatAvgMs,
      repeat_p95_ms: repeatSummary.p95,
      repeat_delta_ms: repeatDeltaMs,
      repeat_delta_pct: repeatDeltaPct,
    },
    prompt_stats: summarizeChars(promptLengths),
    run_prompt_stats: summarizeChars(runPromptTotals),
    call_stats: {
      total_calls: callCounts.reduce((acc, value) => acc + value, 0),
      avg_calls_per_run: callCounts.length ? callCounts.reduce((acc, value) => acc + value, 0) / callCounts.length : 0,
      p95_calls_per_run: summarizeNumbers(callCounts).p95,
      max_calls_per_run: summarizeNumbers(callCounts).max,
    },
    output_stats: summarizeChars(outputLengths),
  };
}

function getByPath(obj: unknown, pathValue: string): unknown {
  const parts = pathValue.split('.').filter(Boolean);
  let current: unknown = obj;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !(part in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function detectMetricPath(bench: BenchOutput): string {
  const candidates = ['payload.timing.p95_ms', 'payload.timing.avg_ms', 'payload.elapsed_ms', 'total_ms'];
  for (const candidate of candidates) {
    const value = getByPath(bench, candidate);
    if (typeof value === 'number' && Number.isFinite(value)) {
      return candidate;
    }
  }
  throw new Error('Could not auto-detect a numeric metric. Pass --metric <dot.path>.');
}

function asFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Metric "${label}" is missing or non-numeric.`);
  }
  return value;
}

function computeRegressionPct(regressionAbs: number, baselineMetric: number, candidateMetric: number): number {
  const absBaseline = Math.abs(baselineMetric);
  const scale = Math.max(1, absBaseline, Math.abs(candidateMetric));
  const effectivelyZeroBaseline = absBaseline <= Number.EPSILON * scale;
  if (effectivelyZeroBaseline) {
    if (regressionAbs === 0) {
      return 0;
    }
    return regressionAbs > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  }

  const ratio = regressionAbs / baselineMetric;
  if (!Number.isFinite(ratio)) {
    if (ratio === 0) {
      return 0;
    }
    return ratio > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  }

  if (Math.abs(ratio) > Number.MAX_VALUE / 100) {
    return ratio > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  }

  const pct = ratio * 100;
  if (!Number.isFinite(pct)) {
    return pct > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  }
  return pct;
}

function readRequiredProvenanceField(
  provenance: ProvenanceMetadata | undefined,
  field: keyof ProvenanceMetadata,
  label: string
): string {
  const value = provenance?.[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required provenance field "${String(field)}" in ${label} artifact.`);
  }
  return value.trim();
}

function assertProvenanceIntegrity(baseline: BenchOutput, candidate: BenchOutput): void {
  readRequiredProvenanceField(baseline.provenance, 'timestamp_utc', 'baseline');
  readRequiredProvenanceField(candidate.provenance, 'timestamp_utc', 'candidate');
  const baselineMode = readRequiredProvenanceField(baseline.provenance, 'bench_mode', 'baseline');
  const candidateMode = readRequiredProvenanceField(candidate.provenance, 'bench_mode', 'candidate');
  readRequiredProvenanceField(baseline.provenance, 'branch_or_tag', 'baseline');
  readRequiredProvenanceField(candidate.provenance, 'branch_or_tag', 'candidate');
  const baselineWorkspace = readRequiredProvenanceField(baseline.provenance, 'workspace_fingerprint', 'baseline');
  const candidateWorkspace = readRequiredProvenanceField(candidate.provenance, 'workspace_fingerprint', 'candidate');
  const baselineIndex = readRequiredProvenanceField(baseline.provenance, 'index_fingerprint', 'baseline');
  const candidateIndex = readRequiredProvenanceField(candidate.provenance, 'index_fingerprint', 'candidate');
  const baselineDataset = readRequiredProvenanceField(baseline.provenance, 'dataset_id', 'baseline');
  const candidateDataset = readRequiredProvenanceField(candidate.provenance, 'dataset_id', 'candidate');
  const baselineDatasetHash = readRequiredProvenanceField(baseline.provenance, 'dataset_hash', 'baseline');
  const candidateDatasetHash = readRequiredProvenanceField(candidate.provenance, 'dataset_hash', 'candidate');
  const baselineRetrievalProvider = readRequiredProvenanceField(baseline.provenance, 'retrieval_provider', 'baseline');
  const candidateRetrievalProvider = readRequiredProvenanceField(candidate.provenance, 'retrieval_provider', 'candidate');
  const baselineFeatureFlags = readRequiredProvenanceField(baseline.provenance, 'feature_flags_snapshot', 'baseline');
  const candidateFeatureFlags = readRequiredProvenanceField(candidate.provenance, 'feature_flags_snapshot', 'candidate');

  const baselineCommit = readRequiredProvenanceField(baseline.provenance, 'commit_sha', 'baseline');
  const candidateCommit = readRequiredProvenanceField(candidate.provenance, 'commit_sha', 'candidate');
  readRequiredProvenanceField(baseline.provenance, 'node_version', 'baseline');
  readRequiredProvenanceField(candidate.provenance, 'node_version', 'candidate');
  readRequiredProvenanceField(baseline.provenance, 'os_version', 'baseline');
  readRequiredProvenanceField(candidate.provenance, 'os_version', 'candidate');
  readRequiredProvenanceField(baseline.provenance, 'env_fingerprint', 'baseline');
  readRequiredProvenanceField(candidate.provenance, 'env_fingerprint', 'candidate');

  const isCi = String(process.env.CI ?? '').toLowerCase() === 'true';
  if (isCi && baselineCommit === candidateCommit) {
    throw new Error('Invalid baseline: baseline and candidate commit_sha must differ in CI mode.');
  }

  if (baselineMode !== candidateMode) {
    throw new Error(`Provenance mode mismatch: baseline=${baselineMode} candidate=${candidateMode}`);
  }
  if (baselineDataset !== candidateDataset) {
    throw new Error(`Dataset mismatch: baseline=${baselineDataset} candidate=${candidateDataset}`);
  }
  if (baselineDatasetHash !== candidateDatasetHash) {
    throw new Error(`Dataset hash mismatch: baseline=${baselineDatasetHash} candidate=${candidateDatasetHash}`);
  }
  if (baselineWorkspace !== candidateWorkspace) {
    throw new Error(`Workspace fingerprint mismatch: baseline=${baselineWorkspace} candidate=${candidateWorkspace}`);
  }
  if (baselineIndex !== candidateIndex) {
    throw new Error(`Index fingerprint mismatch: baseline=${baselineIndex} candidate=${candidateIndex}`);
  }
  if (baselineRetrievalProvider !== candidateRetrievalProvider) {
    throw new Error(
      `Retrieval provider mismatch: baseline=${baselineRetrievalProvider} candidate=${candidateRetrievalProvider}`
    );
  }
  if (baselineFeatureFlags !== candidateFeatureFlags) {
    throw new Error('Feature-flag snapshot mismatch: baseline and candidate artifacts must share the same snapshot.');
  }
}

export function compareBenchmarks(
  baseline: BenchOutput,
  candidate: BenchOutput,
  args: Pick<CompareArgs, 'metricPath' | 'maxRegressionPct' | 'maxRegressionAbs' | 'higherIsBetter' | 'requireSameMode'>
): BenchComparisonResult {
  assertProvenanceIntegrity(baseline, candidate);

  if (args.requireSameMode) {
    const baselineMode = baseline.payload?.mode ?? baseline.provenance?.bench_mode;
    const candidateMode = candidate.payload?.mode ?? candidate.provenance?.bench_mode;
    if (typeof baselineMode === 'string' && typeof candidateMode === 'string' && baselineMode !== candidateMode) {
      throw new Error(`Mode mismatch: baseline=${baselineMode} candidate=${candidateMode}`);
    }
  }

  const metricPath = args.metricPath ?? detectMetricPath(baseline);
  const baselineMetric = asFiniteNumber(getByPath(baseline, metricPath), `baseline:${metricPath}`);
  const candidateMetric = asFiniteNumber(getByPath(candidate, metricPath), `candidate:${metricPath}`);

  const regressionAbs = args.higherIsBetter ? baselineMetric - candidateMetric : candidateMetric - baselineMetric;
  const regressionPct = computeRegressionPct(regressionAbs, baselineMetric, candidateMetric);
  const breachedPct = args.maxRegressionPct != null && regressionPct > args.maxRegressionPct;
  const breachedAbs = args.maxRegressionAbs != null && regressionAbs > args.maxRegressionAbs;

  return {
    metricPath,
    baselineMetric,
    candidateMetric,
    regressionAbs,
    regressionPct,
    breachedPct,
    breachedAbs,
    failed: breachedPct || breachedAbs,
  };
}
