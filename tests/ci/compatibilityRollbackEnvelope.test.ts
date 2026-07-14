import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { parse } from 'yaml';

import { buildToolRegistryEntries } from '../../src/mcp/server.js';
import { getToolManifest } from '../../src/mcp/tools/manifest.js';
import { listRestApiToolMappings } from '../../src/mcp/tooling/discoverability.js';
import { listConvertedToolsWithOutputSchema } from '../../src/mcp/utils/outputSchemaContract.js';
import { getFeatureFlagsFromEnv } from '../../src/config/features.js';

type Envelope = {
  schema_version: number;
  task_id: string;
  baseline_receipt: {
    machine_receipt_path: string;
    human_receipt_path: string;
  };
  mcp_tool_contract: {
    expected_tool_count: number;
    expected_tool_names: string[];
    live_sources: Record<string, string>;
    output_schema_covered_tool_count: number;
    output_schema_covered_tools: string[];
    input_output_error_text_structured_contract: {
      sources: Record<string, string>;
    };
  };
  rest_mapping_contract: {
    mount_prefix: string;
    live_sources: Record<string, string>;
    known_tool_route_paths: string[];
    known_non_tool_routes: Array<{ path: string; source: string }>;
  };
  auth_config_precedence: {
    http_bind_and_port: { cli_flags: string[]; source: string };
    http_auth: {
      enabled_env: string;
      tokens_env: string;
      default_when_unset: string;
      sources: Record<string, string>;
    };
    reactive_and_numeric_env: { source: string; helper_functions: string[] };
    feature_flags: { source: string; kill_switch_env: string; flag_count: number; flag_names: string[]; test: string };
  };
  artifact_format_contract: Record<string, unknown>;
  transport_contract: { live_sources: Record<string, string> };
  node_and_package_matrix: {
    package_json_path: string;
    package_json_version: string;
    package_engines_declared: boolean;
    ci_node_matrix_source: string;
    ci_node_matrix: string[];
    single_pinned_node_version_workflows: Record<string, string>;
  };
  rollback_policy: { source_plan: string; policy: Record<string, string> };
  intentional_deltas: unknown[];
};

type Workflow = {
  jobs?: Record<string, { strategy?: { matrix?: Record<string, unknown[]> } }>;
};

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')) as T;
}

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

/**
 * Recursively collects every string value that looks like a workspace-relative
 * file reference (optionally suffixed with `:exportName`) so the test can prove
 * the envelope resolves to live files rather than aspirational paths.
 */
function collectPathReferences(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    const withoutSuffix = value.includes(':') && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.split(':').pop() ?? '')
      ? value.slice(0, value.lastIndexOf(':'))
      : value;
    const looksLikePath =
      /^(src|tests|scripts|config|artifacts|docs)\//.test(withoutSuffix) ||
      /^\.github\/workflows\//.test(withoutSuffix) ||
      withoutSuffix === 'package.json';
    if (looksLikePath) {
      out.add(withoutSuffix);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectPathReferences(entry, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectPathReferences(entry, out);
    }
  }
}

const envelope = readJson<Envelope>('config/ci/compatibility-rollback-envelope.json');

describe('config/ci/compatibility-rollback-envelope.json', () => {
  it('declares the K0 schema, expected tool count, and empty intentional-delta ledger', () => {
    expect(envelope.schema_version).toBe(1);
    expect(envelope.task_id).toBe('K0');
    expect(envelope.mcp_tool_contract.expected_tool_count).toBe(52);
    expect(envelope.mcp_tool_contract.expected_tool_names).toHaveLength(52);
    expect(new Set(envelope.mcp_tool_contract.expected_tool_names).size).toBe(52);
    expect(envelope.intentional_deltas).toEqual([]);
  });

  it('resolves every referenced path in the envelope to a live file', () => {
    const references = new Set<string>();
    collectPathReferences(envelope, references);

    expect(references.size).toBeGreaterThan(20);

    const missing = [...references].filter(
      (reference) => !fs.existsSync(path.join(process.cwd(), reference))
    );
    expect(missing).toEqual([]);
  });

  it('points the baseline receipt at the live B0 evidence files', () => {
    expect(fs.existsSync(path.join(process.cwd(), envelope.baseline_receipt.machine_receipt_path))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), envelope.baseline_receipt.human_receipt_path))).toBe(true);
    const baseline = readJson<Record<string, unknown>>(envelope.baseline_receipt.machine_receipt_path);
    expect(baseline).toBeTruthy();
  });

  it('matches the live 52-tool name set from the production manifest and runtime registry', () => {
    const manifest = getToolManifest() as { tools: string[] };
    const entries = buildToolRegistryEntries({} as any);
    const runtimeToolNames = entries.map((entry) => entry.tool.name);

    const expectedSorted = [...envelope.mcp_tool_contract.expected_tool_names].sort((a, b) => a.localeCompare(b));
    const manifestSorted = [...manifest.tools].sort((a, b) => a.localeCompare(b));
    const runtimeSorted = [...runtimeToolNames].sort((a, b) => a.localeCompare(b));

    expect(manifest.tools).toHaveLength(52);
    expect(runtimeToolNames).toHaveLength(52);
    expect(manifestSorted).toEqual(expectedSorted);
    expect(runtimeSorted).toEqual(expectedSorted);
  });

  it('matches the live output-schema-covered tool set', () => {
    const liveConverted = listConvertedToolsWithOutputSchema();
    expect(liveConverted).toHaveLength(envelope.mcp_tool_contract.output_schema_covered_tool_count);
    expect([...liveConverted].sort((a, b) => a.localeCompare(b))).toEqual(
      [...envelope.mcp_tool_contract.output_schema_covered_tools].sort((a, b) => a.localeCompare(b))
    );
  });

  it('matches the live REST tool-route mappings produced by discoverability metadata', () => {
    const liveMappings = listRestApiToolMappings();
    const livePaths = liveMappings
      .map((mapping) => mapping.path.replace(envelope.rest_mapping_contract.mount_prefix, ''))
      .sort((a, b) => a.localeCompare(b));
    const declaredPaths = [...envelope.rest_mapping_contract.known_tool_route_paths].sort((a, b) => a.localeCompare(b));

    expect(livePaths).toEqual(declaredPaths);
    expect(liveMappings.every((mapping) => mapping.method === 'POST')).toBe(true);
    expect(liveMappings.every((mapping) => mapping.path.startsWith(envelope.rest_mapping_contract.mount_prefix))).toBe(
      true
    );
  });

  it('confirms declared non-tool REST routes exist in their claimed source files', () => {
    for (const route of envelope.rest_mapping_contract.known_non_tool_routes) {
      expect(fs.existsSync(path.join(process.cwd(), route.source))).toBe(true);
    }
    const statusSource = readText('src/http/routes/status.ts');
    expect(statusSource).toContain("'/status'");
    expect(statusSource).toContain("'/retrieval/status'");
    const healthSource = readText('src/http/routes/health.ts');
    expect(healthSource).toContain("'/health'");
  });

  it('confirms the declared HTTP auth env vars and CLI flags are present in their claimed live sources', () => {
    const authSource = readText(envelope.auth_config_precedence.http_auth.sources.auth_scopes);
    expect(authSource).toContain(envelope.auth_config_precedence.http_auth.enabled_env);
    expect(authSource).toContain(envelope.auth_config_precedence.http_auth.tokens_env);

    const cliSource = readText(envelope.auth_config_precedence.http_bind_and_port.source);
    for (const flag of envelope.auth_config_precedence.http_bind_and_port.cli_flags) {
      expect(cliSource).toContain(flag);
    }
  });

  it('matches the live feature-flag set exposed by src/config/features.ts', () => {
    const liveFlags = Object.keys(getFeatureFlagsFromEnv());
    expect(liveFlags).toHaveLength(envelope.auth_config_precedence.feature_flags.flag_count);
    expect([...liveFlags].sort((a, b) => a.localeCompare(b))).toEqual(
      [...envelope.auth_config_precedence.feature_flags.flag_names].sort((a, b) => a.localeCompare(b))
    );
  });

  it('truthfully records whether package.json declares an engines field', () => {
    const packageJson = readJson<{ version: string; engines?: Record<string, string> }>(
      envelope.node_and_package_matrix.package_json_path
    );
    expect(packageJson.version).toBe(envelope.node_and_package_matrix.package_json_version);
    expect(packageJson.engines === undefined).toBe(envelope.node_and_package_matrix.package_engines_declared === false);
    if (envelope.node_and_package_matrix.package_engines_declared) {
      expect(packageJson.engines).toBeDefined();
    } else {
      expect(packageJson.engines).toBeUndefined();
    }
  });

  it('matches the live CI Node version matrix declared in the workflow file', () => {
    const workflow = parse(readText(envelope.node_and_package_matrix.ci_node_matrix_source)) as Workflow;
    const testJob = workflow.jobs?.test;
    const liveMatrix = (testJob?.strategy?.matrix?.['node-version'] ?? []) as string[];

    expect(liveMatrix).toEqual(envelope.node_and_package_matrix.ci_node_matrix);

    for (const [workflowPath, expectedVersion] of Object.entries(
      envelope.node_and_package_matrix.single_pinned_node_version_workflows
    )) {
      const pinnedWorkflow = parse(readText(workflowPath)) as Workflow;
      const pinnedJobs = Object.values(pinnedWorkflow.jobs ?? {});
      const versions = readText(workflowPath).match(/node-version:\s*['"]?(\d+)['"]?/g) ?? [];
      expect(versions.length).toBeGreaterThan(0);
      for (const line of versions) {
        expect(line).toContain(String(expectedVersion));
      }
      expect(pinnedJobs.length).toBeGreaterThan(0);
    }
  });

  it('carries a non-empty rollback policy pointing at the source remediation plan', () => {
    expect(fs.existsSync(path.join(process.cwd(), envelope.rollback_policy.source_plan))).toBe(true);
    const policyValues = Object.values(envelope.rollback_policy.policy);
    expect(policyValues.length).toBeGreaterThanOrEqual(9);
    expect(policyValues.every((entry) => typeof entry === 'string' && entry.trim().length > 0)).toBe(true);

    const planText = readText(envelope.rollback_policy.source_plan);
    expect(planText).toContain('## Wave-level rollback rules');
    expect(planText).toContain('## Frozen invariants');
  });

  it('fails closed when the envelope claims a path that does not exist', () => {
    const mutated: Envelope = JSON.parse(JSON.stringify(envelope));
    mutated.transport_contract.live_sources.mcp_compatibility_matrix = 'config/ci/does-not-exist-k0.json';

    const references = new Set<string>();
    collectPathReferences(mutated, references);
    const missing = [...references].filter(
      (reference) => !fs.existsSync(path.join(process.cwd(), reference))
    );

    expect(missing).toEqual(['config/ci/does-not-exist-k0.json']);
  });
});
