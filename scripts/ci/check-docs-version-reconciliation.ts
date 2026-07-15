#!/usr/bin/env node
/**
 * D1a — Docs/version reconciliation against live 52-tool manifest.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { getToolManifest, MCP_SERVER_VERSION } from '../../src/mcp/tools/manifest.js';
import { buildToolRegistryEntries } from '../../src/mcp/server.js';
import { listRestApiToolMappings } from '../../src/mcp/tooling/discoverability.js';
import { listConvertedToolsWithOutputSchema } from '../../src/mcp/utils/outputSchemaContract.js';

type Contract = {
  expected: {
    package_version: string;
    mcp_tool_count: number;
    rest_mapping_count: number;
    output_schema_covered_tool_count: number;
  };
  doc_assertions: Array<{ path: string; must_mention_substrings: string[] }>;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')) as T;
}

export function checkDocsVersionReconciliation(root = repoRoot): { errors: string[]; receipt: Record<string, unknown> } {
  const contract = readJson<Contract>('config/ci/docs-version-reconciliation.json');
  const pkg = readJson<{ version: string; name: string }>('package.json');
  const errors: string[] = [];

  if (pkg.version !== contract.expected.package_version) {
    errors.push(`package.json version ${pkg.version} != ${contract.expected.package_version}`);
  }
  if (MCP_SERVER_VERSION !== contract.expected.package_version) {
    errors.push(`MCP_SERVER_VERSION ${MCP_SERVER_VERSION} != ${contract.expected.package_version}`);
  }

  const manifest = getToolManifest() as { tools: string[]; version: string };
  const runtime = buildToolRegistryEntries({} as never).map((e) => e.tool.name);
  const rest = listRestApiToolMappings();
  const schemas = listConvertedToolsWithOutputSchema();

  if (manifest.tools.length !== contract.expected.mcp_tool_count) {
    errors.push(`manifest tool count ${manifest.tools.length} != ${contract.expected.mcp_tool_count}`);
  }
  if (runtime.length !== contract.expected.mcp_tool_count) {
    errors.push(`runtime tool count ${runtime.length} != ${contract.expected.mcp_tool_count}`);
  }
  if (rest.length !== contract.expected.rest_mapping_count) {
    errors.push(`REST mapping count ${rest.length} != ${contract.expected.rest_mapping_count}`);
  }
  if (schemas.length !== contract.expected.output_schema_covered_tool_count) {
    errors.push(
      `output-schema covered count ${schemas.length} != ${contract.expected.output_schema_covered_tool_count}`
    );
  }

  for (const assertion of contract.doc_assertions) {
    const text = fs.readFileSync(path.join(root, assertion.path), 'utf8');
    for (const needle of assertion.must_mention_substrings) {
      if (!text.includes(needle)) {
        errors.push(`${assertion.path} missing substring: ${needle}`);
      }
    }
  }

  const receipt = {
    schema_version: 1,
    task_id: 'D1a',
    package_version: pkg.version,
    mcp_server_version: MCP_SERVER_VERSION,
    mcp_tool_count: manifest.tools.length,
    runtime_tool_count: runtime.length,
    rest_mapping_count: rest.length,
    output_schema_covered_tool_count: schemas.length,
    mcp_tool_names_sha256: crypto
      .createHash('sha256')
      .update([...manifest.tools].sort((a, b) => a.localeCompare(b)).join('|'), 'utf8')
      .digest('hex'),
    errors,
    status: errors.length === 0 ? 'pass' : 'fail',
    generated_at_utc: new Date().toISOString(),
  };

  return { errors, receipt };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { errors, receipt } = checkDocsVersionReconciliation();
  const outPath = path.join(repoRoot, 'artifacts/plan/context-engine-remediation-d1a-docs-version.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(receipt, null, 2));
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ status: 'pass', receipt: path.relative(repoRoot, outPath).replace(/\\/g, '/') }, null, 2));
  process.exit(0);
}
