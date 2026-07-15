import { describe, expect, it } from '@jest/globals';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { buildToolRegistryEntries } from '../../src/mcp/server.js';
import { getToolManifest } from '../../src/mcp/tools/manifest.js';
import { listRestApiToolMappings } from '../../src/mcp/tooling/discoverability.js';
import { listConvertedToolsWithOutputSchema } from '../../src/mcp/utils/outputSchemaContract.js';

type ParityFamily = {
  description: string;
  suites?: string[];
  live_sources?: string[];
  task_owners?: string[];
};

type Inventory = {
  schema_version: number;
  task_id: string;
  depends_on: string[];
  hard_gate_for: string[];
  validation_matrix: {
    dimensions: string[];
    coverage: Record<string, string[]>;
  };
  parity_families: Record<string, ParityFamily>;
  task_parity_map: Record<
    string,
    {
      required_families: string[];
      must_pass_suites: string[];
    }
  >;
  intentional_deltas: unknown[];
  rollback_policy: { t1_requires_green_q4b: boolean };
};

const REPO_ROOT = process.cwd();
const REQUIRED_TASK_IDS = ['R1c', 'R2', 'R6', 'T1_gate'];
const REQUIRED_DIMENSIONS = [
  'cancellation',
  'session_lifecycle',
  'health_additions',
  'auth',
  'errors',
  'metrics',
  'structured_results',
];

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')) as T;
}

function resolvesToRealFile(relativePath: string): boolean {
  const withoutExportSuffix =
    relativePath.includes(':') && /^[A-Za-z_][A-Za-z0-9_]*$/.test(relativePath.split(':').pop() ?? '')
      ? relativePath.slice(0, relativePath.lastIndexOf(':'))
      : relativePath;
  return fs.existsSync(path.join(REPO_ROOT, withoutExportSuffix));
}

function collectFamilyPaths(family: ParityFamily): string[] {
  return [...(family.suites ?? []), ...(family.live_sources ?? [])];
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function sha256EolVariants(input: string): string[] {
  const normalized = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return [...new Set([
    sha256(input),
    sha256(normalized),
    sha256(normalized.replace(/\n/g, '\r\n')),
  ])];
}

const inventory = readJson<Inventory>('config/ci/q4b-postchange-parity.json');

describe('config/ci/q4b-postchange-parity.json', () => {
  it('declares Q4b deps on R1c/R2/R6 and hard-gates T1*', () => {
    expect(inventory.schema_version).toBe(1);
    expect(inventory.task_id).toBe('Q4b');
    expect(inventory.depends_on).toEqual(['R1c', 'R2', 'R6']);
    expect(inventory.hard_gate_for).toEqual([
      'T1a',
      'T1b1',
      'T1b2',
      'T1c1',
      'T1c2',
      'T1c3',
      'T1d1',
      'T1d2',
    ]);
    expect(inventory.rollback_policy.t1_requires_green_q4b).toBe(true);
    expect(inventory.intentional_deltas).toEqual([]);
  });

  it('references Q4a/K0 receipts by path', () => {
    const upstream = readJson<{
      upstream_receipts: Record<string, string>;
    }>('config/ci/q4b-postchange-parity.json');
    for (const relative of Object.values(upstream.upstream_receipts)) {
      expect(resolvesToRealFile(relative)).toBe(true);
    }
  });

  it('every parity family path resolves on disk', () => {
    const missing: string[] = [];
    for (const [name, family] of Object.entries(inventory.parity_families)) {
      for (const reference of collectFamilyPaths(family)) {
        if (!resolvesToRealFile(reference)) missing.push(`${name} -> ${reference}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('covers all seven post-change validation dimensions', () => {
    expect([...inventory.validation_matrix.dimensions].sort()).toEqual([...REQUIRED_DIMENSIONS].sort());
    for (const dimension of REQUIRED_DIMENSIONS) {
      const suites = inventory.validation_matrix.coverage[dimension];
      expect(Array.isArray(suites)).toBe(true);
      expect(suites.length).toBeGreaterThan(0);
      for (const suite of suites) {
        expect(resolvesToRealFile(suite)).toBe(true);
      }
    }
  });

  it('maps R1c/R2/R6/T1_gate with non-empty required families and suites', () => {
    for (const taskId of REQUIRED_TASK_IDS) {
      const entry = inventory.task_parity_map[taskId];
      expect(entry).toBeDefined();
      expect(entry.required_families.length).toBeGreaterThan(0);
      expect(entry.must_pass_suites.length).toBeGreaterThan(0);
      for (const family of entry.required_families) {
        expect(inventory.parity_families[family]).toBeDefined();
      }
      for (const suite of entry.must_pass_suites) {
        expect(resolvesToRealFile(suite)).toBe(true);
      }
    }
  });

  it('T1_gate inventory includes cancellation, session, health, auth, error, and structured suites', () => {
    const suites = new Set(inventory.task_parity_map.T1_gate.must_pass_suites);
    expect(suites.has('tests/integration/httpCancellation.test.ts')).toBe(true);
    expect(suites.has('tests/integration/mcpHttpTransport.test.ts')).toBe(true);
    expect(suites.has('tests/mcp/compositeHealth.test.ts')).toBe(true);
    expect(suites.has('tests/integration/httpHardening.test.ts')).toBe(true);
    expect(suites.has('tests/mcp/outputSchemaContract.test.ts')).toBe(true);
  });
});

describe('Q4b live fingerprint cross-check (inherits Q4a frozen hashes)', () => {
  it('matches Q4a frozen MCP/REST/output-schema fingerprints (no undeclared drift)', () => {
    const q4a = readJson<{
      fingerprints: {
        mcp_tool_count: number;
        mcp_tool_names_sha256: string;
        runtime_tool_count: number;
        runtime_tool_names_sha256: string;
        rest_mapping_count: number;
        rest_mapping_paths_sha256: string;
        output_schema_covered_tool_count: number;
        output_schema_covered_tools_sha256: string;
      };
    }>('artifacts/plan/context-engine-remediation-q4a-goldens.json');

    const manifest = getToolManifest() as { tools: string[] };
    const runtimeToolNames = buildToolRegistryEntries({} as never).map((entry) => entry.tool.name);
    const restMappings = listRestApiToolMappings();
    const liveConverted = listConvertedToolsWithOutputSchema();

    expect(manifest.tools.length).toBe(q4a.fingerprints.mcp_tool_count);
    expect(runtimeToolNames.length).toBe(q4a.fingerprints.runtime_tool_count);
    expect(sha256([...manifest.tools].sort((a, b) => a.localeCompare(b)).join('|'))).toBe(
      q4a.fingerprints.mcp_tool_names_sha256
    );
    expect(sha256([...runtimeToolNames].sort((a, b) => a.localeCompare(b)).join('|'))).toBe(
      q4a.fingerprints.runtime_tool_names_sha256
    );
    expect(restMappings.length).toBe(q4a.fingerprints.rest_mapping_count);
    expect(
      sha256(
        [...restMappings]
          .sort((a, b) => a.path.localeCompare(b.path))
          .map((m) => `${m.method} ${m.path}`)
          .join('|')
      )
    ).toBe(q4a.fingerprints.rest_mapping_paths_sha256);
    expect(liveConverted.length).toBe(q4a.fingerprints.output_schema_covered_tool_count);
    expect(sha256([...liveConverted].sort((a, b) => a.localeCompare(b)).join('|'))).toBe(
      q4a.fingerprints.output_schema_covered_tools_sha256
    );
  });

  it('receipt records the sha256 of the Q4b inventory file', () => {
    const receipt = readJson<{ parity_inventory_path: string; parity_inventory_sha256: string }>(
      'artifacts/plan/context-engine-remediation-q4b-parity.json'
    );
    const text = fs.readFileSync(path.join(REPO_ROOT, receipt.parity_inventory_path), 'utf8');
    expect(sha256EolVariants(text)).toContain(receipt.parity_inventory_sha256);
  });
});
