import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function runBoundaryCheck(): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'ci', 'check-retrieval-provider-boundary.ts');
  const result = spawnSync(process.execPath, [tsxCli, script], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function writeSourceFile(relativePath: string, content: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, 'utf8');
  return absolutePath;
}

function removeFileIfExists(filePath: string): void {
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
}

describe('scripts/ci/check-retrieval-provider-boundary.ts', () => {
  it('scans provider runtime files only (serviceClient is no longer an owned runtime file)', () => {
    const result = runBoundaryCheck();
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('src/mcp/serviceClient.ts');
  });

  it('passes for the current provider/runtime boundary', () => {
    const result = runBoundaryCheck();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Retrieval provider boundary check passed.');
  });

  it('ignores non-provider retrieval files when checking provider runtime ownership', () => {
    const fixtureRelativePath = `src/retrieval/__boundary-outside-provider-scope-${Date.now()}.ts`;
    const fixtureAbsolutePath = writeSourceFile(
      fixtureRelativePath,
      "import '@augmentcode/auggie-sdk';\nexport const marker = true;\n"
    );

    try {
      const result = runBoundaryCheck();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Retrieval provider boundary check passed.');
    } finally {
      removeFileIfExists(fixtureAbsolutePath);
    }
  });

  it('fails when an unapproved retrieval provider file imports @augmentcode/auggie-sdk', () => {
    const fixtureRelativePath = `src/retrieval/providers/__boundary-sdk-violation-${Date.now()}.ts`;
    const fixtureAbsolutePath = writeSourceFile(
      fixtureRelativePath,
      "import '@augmentcode/auggie-sdk';\nexport const marker = true;\n"
    );

    try {
      const result = runBoundaryCheck();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Retrieval provider boundary check failed.');
      expect(result.stderr).toContain('Allowed legacy runtime owner files:');
      expect(result.stderr).toContain(' - src/retrieval/providers/legacyRuntime.ts');
      expect(result.stderr).toContain(
        `${fixtureRelativePath}: unexpected @augmentcode/auggie-sdk reference outside allowlist`
      );
    } finally {
      removeFileIfExists(fixtureAbsolutePath);
    }
  });

  it('fails when an unapproved retrieval provider file uses DirectContext', () => {
    const fixtureRelativePath = `src/retrieval/providers/__boundary-direct-context-violation-${Date.now()}.ts`;
    const fixtureAbsolutePath = writeSourceFile(
      fixtureRelativePath,
      'export function leakDirectContextName(): string { return "DirectContext"; }\n'
    );

    try {
      const result = runBoundaryCheck();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Retrieval provider boundary check failed.');
      expect(result.stderr).toContain('Allowed DirectContext files:');
      expect(result.stderr).toContain(' - src/retrieval/providers/legacyRuntime.ts');
      expect(result.stderr).toContain(
        `${fixtureRelativePath}: unexpected DirectContext usage outside allowlist`
      );
    } finally {
      removeFileIfExists(fixtureAbsolutePath);
    }
  });
});
