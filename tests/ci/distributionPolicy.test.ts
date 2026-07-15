import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';

type DistributionPolicy = {
  version: number;
  decision: string;
  owner_lane: string;
  package_name: string;
  package_version: string;
  closure_task: string;
  rejected_task: string;
  node_matrix: string[];
  publish_authorized: boolean;
  deployment_authorized: boolean;
  rationale: string;
  receipts: {
    decision_record: string;
    node_matrix_source: string;
    package_manifest: string;
  };
};

function readJson<T>(relativePath: string): T {
  const absolutePath = path.join(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, 'utf8')) as T;
}

describe('config/ci/distribution-policy.json', () => {
  const contract = readJson<DistributionPolicy>('config/ci/distribution-policy.json');

  it('records exactly one of the two policy-authorized decisions', () => {
    expect(['supported', 'unsupported']).toContain(contract.decision);
  });

  it('never authorizes publishing or deployment', () => {
    expect(contract.publish_authorized).toBe(false);
    expect(contract.deployment_authorized).toBe(false);
  });

  it('maps the decision to exactly one executable P1 branch and one rejected-by-policy branch', () => {
    if (contract.decision === 'supported') {
      expect(contract.closure_task).toBe('P1a');
      expect(contract.rejected_task).toBe('P1b');
    } else {
      expect(contract.closure_task).toBe('P1b');
      expect(contract.rejected_task).toBe('P1a');
    }
    expect(contract.closure_task).not.toBe(contract.rejected_task);
  });

  it('pins the supported Node matrix to the live CI workflow', () => {
    const workflowPath = path.join(process.cwd(), contract.receipts.node_matrix_source);
    expect(fs.existsSync(workflowPath)).toBe(true);
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    for (const nodeVersion of contract.node_matrix) {
      expect(workflow).toContain(nodeVersion);
    }
    expect(contract.node_matrix).toEqual(['18.x', '20.x', '22.x']);
  });

  it('resolves owner lane and receipts to real, existing files', () => {
    expect(contract.owner_lane).toBe('Release engineering / F8');
    expect(fs.existsSync(path.join(process.cwd(), contract.receipts.decision_record))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), contract.receipts.package_manifest))).toBe(true);
  });

  it('matches the live package.json name and version', () => {
    const packageJson = readJson<{ name: string; version: string }>(contract.receipts.package_manifest);
    expect(contract.package_name).toBe(packageJson.name);
    expect(contract.package_version).toBe(packageJson.version);
  });
});
