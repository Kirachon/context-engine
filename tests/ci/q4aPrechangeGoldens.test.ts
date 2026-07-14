import { describe, expect, it } from '@jest/globals';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { buildToolRegistryEntries } from '../../src/mcp/server.js';
import { getToolManifest } from '../../src/mcp/tools/manifest.js';
import { listRestApiToolMappings } from '../../src/mcp/tooling/discoverability.js';
import { listConvertedToolsWithOutputSchema } from '../../src/mcp/utils/outputSchemaContract.js';

type GoldenFamily = {
  description: string;
  suites?: string[];
  fixtures?: string[];
  live_sources?: string[];
  characterization_gap?: boolean;
};

type TaskGoldenEntry = {
  task_title: string;
  owner_lock: string;
  allowed_goldens: string[];
  allowed_to_change: string[];
  must_not_change_without_delta?: string[];
  may_add_new_suite?: string;
  rationale: string;
};

type Inventory = {
  schema_version: number;
  task_id: string;
  depends_on: string[];
  upstream_receipts: {
    k0_envelope_path: string;
    k0_receipt_path: string;
    b0_baseline_machine_receipt: string;
  };
  validation_matrix: {
    dimensions: string[];
    coverage: Record<string, string[]>;
  };
  golden_families: Record<string, GoldenFamily>;
  task_golden_map: Record<string, TaskGoldenEntry>;
  inheritance_note: {
    inherits_via_q4b: string[];
  };
  intentional_deltas: unknown[];
};

const REQUIRED_TASK_IDS = ['S1', 'S2', 'C2a', 'C1', 'C0a', 'C3', 'C4', 'R1a', 'R2'];

const REPO_ROOT = process.cwd();

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

function collectFamilyPaths(family: GoldenFamily): string[] {
  return [...(family.suites ?? []), ...(family.fixtures ?? []), ...(family.live_sources ?? [])];
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

const inventory = readJson<Inventory>('config/ci/q4a-prechange-goldens.json');

describe('config/ci/q4a-prechange-goldens.json', () => {
  it('declares the Q4a task id and its K0/Q0/G0b dependency set', () => {
    expect(inventory.schema_version).toBe(1);
    expect(inventory.task_id).toBe('Q4a');
    expect(inventory.depends_on).toEqual(['K0', 'Q0', 'G0b']);
    expect(inventory.intentional_deltas).toEqual([]);
  });

  it('references K0/B0 receipts by path without duplicating their contents', () => {
    expect(resolvesToRealFile(inventory.upstream_receipts.k0_envelope_path)).toBe(true);
    expect(resolvesToRealFile(inventory.upstream_receipts.k0_receipt_path)).toBe(true);
    expect(resolvesToRealFile(inventory.upstream_receipts.b0_baseline_machine_receipt)).toBe(true);
  });

  it('every golden family suite/fixture/live-source path resolves to a real file on disk', () => {
    const missing: string[] = [];
    for (const [familyName, family] of Object.entries(inventory.golden_families)) {
      for (const reference of collectFamilyPaths(family)) {
        if (!resolvesToRealFile(reference)) {
          missing.push(`${familyName} -> ${reference}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('fails closed when a golden family claims a path that does not exist', () => {
    const mutated: Inventory = JSON.parse(JSON.stringify(inventory));
    mutated.golden_families.rest_mappings.suites = [
      ...(mutated.golden_families.rest_mappings.suites ?? []),
      'tests/integration/does-not-exist-q4a.test.ts',
    ];

    const missing: string[] = [];
    for (const family of Object.values(mutated.golden_families)) {
      for (const reference of collectFamilyPaths(family)) {
        if (!resolvesToRealFile(reference)) {
          missing.push(reference);
        }
      }
    }
    expect(missing).toEqual(['tests/integration/does-not-exist-q4a.test.ts']);
  });

  it('declares every required Wave 1/2 task id with a non-empty allowed_goldens list', () => {
    for (const taskId of REQUIRED_TASK_IDS) {
      const entry = inventory.task_golden_map[taskId];
      expect(entry).toBeDefined();
      expect(Array.isArray(entry.allowed_goldens)).toBe(true);
      expect(entry.allowed_goldens.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.allowed_to_change)).toBe(true);
      expect(entry.allowed_to_change.length).toBeGreaterThan(0);
      expect(typeof entry.rationale).toBe('string');
      expect(entry.rationale.trim().length).toBeGreaterThan(0);
    }
  });

  it('every allowed_goldens reference names a real golden family', () => {
    const familyNames = new Set(Object.keys(inventory.golden_families));
    for (const [taskId, entry] of Object.entries(inventory.task_golden_map)) {
      for (const familyName of entry.allowed_goldens) {
        expect(familyNames.has(familyName)).toBe(true);
      }
      for (const suite of [...entry.allowed_to_change, ...(entry.must_not_change_without_delta ?? [])]) {
        expect(resolvesToRealFile(suite)).toBe(true);
      }
      if (entry.may_add_new_suite) {
        // A not-yet-created suite is allowed (the task itself creates it); only
        // assert it is a plausible tests/ path rather than requiring existence.
        expect(entry.may_add_new_suite.startsWith('tests/')).toBe(true);
      }
      expect(taskId).toBe(taskId);
    }
  });

  it('every allowed_to_change suite for a task also belongs to one of its allowed golden families', () => {
    for (const entry of Object.values(inventory.task_golden_map)) {
      const familyPaths = new Set(
        entry.allowed_goldens.flatMap((familyName) => collectFamilyPaths(inventory.golden_families[familyName]))
      );
      for (const suite of entry.allowed_to_change) {
        expect(familyPaths.has(suite)).toBe(true);
      }
    }
  });

  it('covers all seven validation-matrix dimensions with at least one existing suite each', () => {
    const dimensions = ['success', 'invalid_input', 'handler_error', 'legacy_text', 'structured_output', 'auth_decision', 'degraded_behavior'];
    expect(inventory.validation_matrix.dimensions.sort()).toEqual([...dimensions].sort());

    for (const dimension of dimensions) {
      const suites = inventory.validation_matrix.coverage[dimension];
      expect(Array.isArray(suites)).toBe(true);
      expect(suites.length).toBeGreaterThan(0);
      for (const suite of suites) {
        expect(resolvesToRealFile(suite)).toBe(true);
      }
    }
  });

  it('records later Wave 2/3/4 tasks as inheriting via Q4b rather than re-deriving a Q4a entry', () => {
    const inherited = new Set(inventory.inheritance_note.inherits_via_q4b);
    for (const taskId of Object.keys(inventory.task_golden_map)) {
      expect(inherited.has(taskId)).toBe(false);
    }
    expect(inherited.size).toBeGreaterThan(0);
  });

  it('flags the reactive_numeric_config family as a known characterization gap rather than a fabricated golden', () => {
    expect(inventory.golden_families.reactive_numeric_config.characterization_gap).toBe(true);
  });
});

describe('Q4a live fingerprint cross-check (fails closed on undeclared drift before Wave 1)', () => {
  it('matches the frozen 52-tool manifest/runtime-registry fingerprint', () => {
    const receipt = readJson<{
      fingerprints: {
        mcp_tool_count: number;
        mcp_tool_names_sha256: string;
        runtime_tool_count: number;
        runtime_tool_names_sha256: string;
      };
    }>('artifacts/plan/context-engine-remediation-q4a-goldens.json');

    const manifest = getToolManifest() as { tools: string[] };
    const entries = buildToolRegistryEntries({} as any);
    const runtimeToolNames = entries.map((entry) => entry.tool.name);

    const manifestSorted = [...manifest.tools].sort((a, b) => a.localeCompare(b));
    const runtimeSorted = [...runtimeToolNames].sort((a, b) => a.localeCompare(b));

    expect(manifest.tools.length).toBe(receipt.fingerprints.mcp_tool_count);
    expect(runtimeToolNames.length).toBe(receipt.fingerprints.runtime_tool_count);
    expect(sha256(manifestSorted.join('|'))).toBe(receipt.fingerprints.mcp_tool_names_sha256);
    expect(sha256(runtimeSorted.join('|'))).toBe(receipt.fingerprints.runtime_tool_names_sha256);
  });

  it('matches the frozen REST mapping count/path fingerprint', () => {
    const receipt = readJson<{
      fingerprints: { rest_mapping_count: number; rest_mapping_paths_sha256: string };
    }>('artifacts/plan/context-engine-remediation-q4a-goldens.json');

    const restMappings = listRestApiToolMappings();
    const restSorted = [...restMappings].sort((a, b) => a.path.localeCompare(b.path));
    const canonical = restSorted.map((mapping) => `${mapping.method} ${mapping.path}`).join('|');

    expect(restMappings.length).toBe(receipt.fingerprints.rest_mapping_count);
    expect(sha256(canonical)).toBe(receipt.fingerprints.rest_mapping_paths_sha256);
  });

  it('matches the frozen output-schema-covered tool fingerprint', () => {
    const receipt = readJson<{
      fingerprints: { output_schema_covered_tool_count: number; output_schema_covered_tools_sha256: string };
    }>('artifacts/plan/context-engine-remediation-q4a-goldens.json');

    const liveConverted = listConvertedToolsWithOutputSchema();
    const sorted = [...liveConverted].sort((a, b) => a.localeCompare(b));

    expect(liveConverted.length).toBe(receipt.fingerprints.output_schema_covered_tool_count);
    expect(sha256(sorted.join('|'))).toBe(receipt.fingerprints.output_schema_covered_tools_sha256);
  });

  it('the receipt records the exact sha256 of the frozen golden inventory file', () => {
    const receipt = readJson<{ golden_inventory_path: string; golden_inventory_sha256: string }>(
      'artifacts/plan/context-engine-remediation-q4a-goldens.json'
    );
    const inventoryText = fs.readFileSync(path.join(REPO_ROOT, receipt.golden_inventory_path), 'utf8');
    expect(sha256(inventoryText)).toBe(receipt.golden_inventory_sha256);
  });
});
