#!/usr/bin/env node
/**
 * M1/M2/M3 — Cheap measurement gate against Q3a frozen corpora.
 *
 * Does not implement experimental treatments. Records dispositions based on
 * whether a live treatment measurement was possible and whether frozen
 * thresholds are already satisfied by available offline evidence.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  readJson,
  sha256Hex,
  type FrozenCorpusContract,
} from './lib/frozenCorpusContract.js';

type ExperimentId = 'M1' | 'M2' | 'M3';

type ExperimentDisposition =
  | 'rejected-by-threshold'
  | 'not-verified'
  | 'implemented';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function measureLane(lane: 'duplicate' | 'ambiguity' | 'performance', experimentId: ExperimentId): {
  disposition: ExperimentDisposition;
  rationale: string;
  metrics: Record<string, unknown>;
} {
  const contract = readJson<FrozenCorpusContract>(
    path.join(repoRoot, 'config/ci/q3a-frozen-corpus-contract.json')
  );
  const laneContract = contract.lanes?.[lane];
  if (!laneContract) {
    return {
      disposition: 'not-verified',
      rationale: `Q3a contract missing ${lane} lane`,
      metrics: {},
    };
  }

  const corpusPath = path.join(repoRoot, laneContract.corpus_path);
  const corpusText = fs.readFileSync(corpusPath, 'utf8');
  const corpusSha = sha256Hex(corpusText);
  if (corpusSha !== laneContract.content_sha256) {
    return {
      disposition: 'not-verified',
      rationale: `corpus sha mismatch for ${lane}: expected ${laneContract.content_sha256}, got ${corpusSha}`,
      metrics: { corpus_sha256: corpusSha },
    };
  }

  const corpus = JSON.parse(corpusText) as { cases: unknown[] };
  const caseCount = Array.isArray(corpus.cases) ? corpus.cases.length : 0;
  if (caseCount !== laneContract.expected.case_count) {
    return {
      disposition: 'not-verified',
      rationale: `case_count mismatch for ${lane}: ${caseCount} != ${laneContract.expected.case_count}`,
      metrics: { case_count: caseCount },
    };
  }

  // No cheap live retrieval/index event-loop treatment runner is wired for these
  // measurement-gated hypotheses in closeout. Threshold contracts are frozen and
  // corpora hash-stable, but treatment deltas were not executed.
  return {
    disposition: 'not-verified',
    rationale:
      `${experimentId}: frozen ${lane} corpus/thresholds are intact, but no treatment measurement run was executed against a live index/event-loop harness in this closeout pass; speculative implementation is forbidden.`,
    metrics: {
      case_count: caseCount,
      thresholds: laneContract.thresholds,
      treatment_executed: false,
    },
  };
}

function main(): void {
  const experiments: Array<{ id: ExperimentId; lane: 'duplicate' | 'ambiguity' | 'performance' }> = [
    { id: 'M1', lane: 'duplicate' },
    { id: 'M2', lane: 'ambiguity' },
    { id: 'M3', lane: 'performance' },
  ];

  const results = experiments.map(({ id, lane }) => {
    const measured = measureLane(lane, id);
    return {
      task_id: id,
      lane,
      disposition: measured.disposition,
      rationale: measured.rationale,
      metrics: measured.metrics,
    };
  });

  const receipt = {
    schema_version: 1,
    task_id: 'M1-M3',
    generated_at_utc: new Date().toISOString(),
    experiments: results,
  };
  const outPath = path.join(repoRoot, 'artifacts/plan/context-engine-remediation-m1-m3-measurement.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ status: 'recorded', receipt: path.relative(repoRoot, outPath).replace(/\\/g, '/'), experiments: results }, null, 2));
}

main();
