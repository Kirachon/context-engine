import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function runGuard(cwd: string): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const scriptPath = path.join(process.cwd(), 'scripts', 'ci', 'check-stale-cache-guards.ts');
  const res = spawnSync(process.execPath, [tsxCli, scriptPath], {
    cwd,
    env: { ...process.env },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

function seedGuardFixture(tmpRoot: string, options: { omitServiceClientAnchor?: boolean } = {}): void {
  writeFile(
    path.join(tmpRoot, 'tests', 'tools', 'status.test.ts'),
    [
      "it('should surface stale index guidance', async () => {});",
      "it('should surface error guidance for unhealthy index status', async () => {});",
      "expect(result).toContain('reindex_workspace');",
      '',
    ].join('\n')
  );

  writeFile(
    path.join(tmpRoot, 'tests', 'tools', 'search.test.ts'),
    [
      "it('should include freshness warning in no-results output when index is stale', async () => {});",
      "it('should include freshness warning when index is unhealthy', async () => {});",
      "expect(result).toContain('index is stale');",
      '',
    ].join('\n')
  );

  writeFile(
    path.join(tmpRoot, 'tests', 'tools', 'context.test.ts'),
    [
      "it('should include freshness warning when index is stale', async () => {});",
      "it('should include freshness warning when index is unhealthy', async () => {});",
      "expect(result).toContain('reindexing succeeds');",
      '',
    ].join('\n')
  );

  writeFile(
    path.join(tmpRoot, 'tests', 'tools', 'codebaseRetrieval.test.ts'),
    [
      "it('adds freshness warning metadata when index is stale', async () => {});",
      "it('adds freshness warning metadata when index is unhealthy', async () => {});",
      "expect(parsed.metadata.freshnessWarning).toMatch(/index status is error/i);",
      '',
    ].join('\n')
  );

  const serviceClientLines = [
    "it('should cache search results', async () => {});",
    "it('should clear cache when clearCache is called', async () => {});",
  ];

  if (!options.omitServiceClientAnchor) {
    serviceClientLines.push("it('should clear cache after indexing', async () => {});");
  }

  writeFile(
    path.join(tmpRoot, 'tests', 'serviceClient.test.ts'),
    [...serviceClientLines, ''].join('\n')
  );
}

describe('scripts/ci/check-stale-cache-guards.ts', () => {
  it('passes when stale/unhealthy index and cache safeguard anchors are present', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-stale-cache-guards-pass-'));
    seedGuardFixture(tmp);

    const result = runGuard(tmp);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Stale-cache guard coverage check passed.');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when required coverage anchors are missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-stale-cache-guards-fail-'));
    seedGuardFixture(tmp, { omitServiceClientAnchor: true });

    const result = runGuard(tmp);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Stale-cache guard coverage check failed.');
    expect(result.stderr).toContain('tests/serviceClient.test.ts is missing required coverage anchors');
    expect(result.stderr).toContain("it('should clear cache after indexing'");

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
