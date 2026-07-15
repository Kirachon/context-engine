import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { checkEvidenceDateContract } from '../../scripts/ci/check-evidence-date-contract.js';
import { filterDefaultMemories, isArchivedMemory } from '../../src/mcp/memoryQuarantine.js';

const REPO_ROOT = process.cwd();

describe('D1c evidence-date policy + CI contract', () => {
  it('policy file declares fail-closed CI contract and intentional exceptions', () => {
    const policy = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'config/ci/evidence-date-policy.json'), 'utf8')
    ) as {
      task_id: string;
      intentional_exceptions: unknown[];
      ci_contract: { task_id: string; fail_on: string[] };
    };
    expect(policy.task_id).toBe('D1c1');
    expect(policy.ci_contract.task_id).toBe('D1c2');
    expect(policy.intentional_exceptions.length).toBeGreaterThan(0);
    expect(policy.ci_contract.fail_on).toContain('directory_date_not_iso');
  });

  it('checker passes against current rollout-evidence and machine receipts', () => {
    expect(checkEvidenceDateContract(REPO_ROOT)).toEqual([]);
  });
});

describe('D1b memory governance verification', () => {
  it('keeps quarantined facts excluded from default retrieval while archive access remains possible', () => {
    const factsPath = path.join(REPO_ROOT, '.memories/facts.md');
    const text = fs.readFileSync(factsPath, 'utf8');
    expect(text).toContain('[meta] priority: archive');
    expect(text).toContain('[meta] subtype: quarantine');

    const memories = [
      {
        category: 'facts' as const,
        content: 'live architecture fact',
        priority: 'helpful' as const,
      },
      {
        category: 'facts' as const,
        content: 'quarantined auggie claim',
        priority: 'archive' as const,
      },
    ];

    expect(isArchivedMemory(memories[1])).toBe(true);
    const defaultOnly = filterDefaultMemories(memories);
    expect(defaultOnly.map((m) => m.content)).toEqual(['live architecture fact']);
    const withArchive = filterDefaultMemories(memories, { includeArchive: true });
    expect(withArchive).toHaveLength(2);
  });
});

describe('D1a docs/version reconciliation contract', () => {
  it('pins expected 52-tool / 1.9.1 contract fields', () => {
    const contract = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'config/ci/docs-version-reconciliation.json'), 'utf8')
    ) as {
      expected: {
        package_version: string;
        mcp_tool_count: number;
        rest_mapping_count: number;
        output_schema_covered_tool_count: number;
      };
    };
    expect(contract.expected.package_version).toBe('1.9.1');
    expect(contract.expected.mcp_tool_count).toBe(52);
    expect(contract.expected.rest_mapping_count).toBe(20);
    expect(contract.expected.output_schema_covered_tool_count).toBe(14);
  });
});

describe('P1a package files allowlist', () => {
  it('package.json carries files allowlist and engines, and never authorizes publish', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      files?: string[];
      engines?: { node?: string };
      private?: boolean;
    };
    const allowlist = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'config/ci/package-files-allowlist.json'), 'utf8')
    ) as {
      package_json_files_field: string[];
      engines: { node: string };
      publish_authorized: boolean;
    };

    expect(allowlist.publish_authorized).toBe(false);
    expect(pkg.files).toEqual(expect.arrayContaining(allowlist.package_json_files_field));
    expect(pkg.engines?.node).toBe(allowlist.engines.node);
  });
});
