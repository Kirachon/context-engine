import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const runTscAnalyzer = jest.fn();
const runSemgrepAnalyzer = jest.fn();

jest.unstable_mockModule('../../src/reviewer/checks/adapters/tsc.js', () => ({
  runTscAnalyzer,
}));

jest.unstable_mockModule('../../src/reviewer/checks/adapters/semgrep.js', () => ({
  runSemgrepAnalyzer,
}));

const { runStaticAnalyzers } = await import('../../src/reviewer/checks/adapters/index.js');
const { handleRunStaticAnalysis } = await import('../../src/mcp/tools/staticAnalysis.js');

describe('runStaticAnalyzers', () => {
  let now = 0;
  let dateNowSpy: jest.SpiedFunction<typeof Date.now>;

  beforeEach(() => {
    runTscAnalyzer.mockReset();
    runSemgrepAnalyzer.mockReset();
    now = 0;
    dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
    delete process.env.CE_SEMGREP_MAX_FILES;
  });

  it('keeps deterministic analyzer order and enforces total runtime budget', async () => {
    (runTscAnalyzer as jest.Mock).mockImplementation(async (...args: any[]) => {
      const opts = args[1] as { timeoutMs: number; maxFindings: number };
      expect(opts.timeoutMs).toBe(100);
      now += 120;
      return { analyzer: 'tsc', duration_ms: 120, findings: [], warnings: [] };
    });

    const result = await runStaticAnalyzers({
      input: { workspace_path: process.cwd(), changed_files: ['a.ts'] },
      analyzers: ['tsc', 'semgrep'],
      timeoutMs: 100,
      totalTimeoutMs: 100,
      maxFindingsPerAnalyzer: 20,
    });

    expect(runTscAnalyzer).toHaveBeenCalledTimes(1);
    expect(runSemgrepAnalyzer).not.toHaveBeenCalled();
    expect(result.results).toHaveLength(1);
    expect(result.warnings.some((w: string) => w.includes('runtime budget exhausted'))).toBe(true);
  });

  it('reduces per-analyzer timeout when remaining total budget is smaller', async () => {
    (runTscAnalyzer as jest.Mock).mockImplementation(async () => {
      now += 80;
      return { analyzer: 'tsc', duration_ms: 80, findings: [], warnings: [] };
    });
    (runSemgrepAnalyzer as jest.Mock).mockImplementation(async (...args: any[]) => {
      const opts = args[1] as { timeoutMs: number; maxFindings: number };
      expect(opts.timeoutMs).toBe(70);
      now += 20;
      return { analyzer: 'semgrep', duration_ms: 20, findings: [], warnings: [] };
    });

    const result = await runStaticAnalyzers({
      input: { workspace_path: process.cwd(), changed_files: ['a.ts'] },
      analyzers: ['tsc', 'semgrep'],
      timeoutMs: 100,
      totalTimeoutMs: 150,
      maxFindingsPerAnalyzer: 20,
    });

    expect(runTscAnalyzer).toHaveBeenCalledTimes(1);
    expect(runSemgrepAnalyzer).toHaveBeenCalledTimes(1);
    expect(result.results).toHaveLength(2);
    expect(result.warnings.some((w: string) => w.includes('timeout reduced to 70ms'))).toBe(true);
  });
});

describe('run_static_analysis tool', () => {
  beforeEach(() => {
    runTscAnalyzer.mockReset();
    runSemgrepAnalyzer.mockReset();
  });

  afterEach(() => {
    delete process.env.CE_SEMGREP_MAX_FILES;
  });

  it('runs with empty analyzer list (no-op)', async () => {
    const resultStr = await handleRunStaticAnalysis(
      { changed_files: [], options: { analyzers: [] } },
      { getWorkspacePath: () => process.cwd() } as any
    );
    const result = JSON.parse(resultStr);
    expect(result.success).toBe(true);
    expect(Array.isArray(result.analyzers)).toBe(true);
    expect(result.analyzers).toHaveLength(0);
    expect(Array.isArray(result.findings)).toBe(true);
  });

  it('warns when semgrep is selected with empty changed_files', async () => {
    (runSemgrepAnalyzer as jest.Mock).mockImplementation(async () => ({
      analyzer: 'semgrep',
      duration_ms: 1,
      findings: [],
      warnings: [],
    }));

    const resultStr = await handleRunStaticAnalysis(
      { changed_files: [], options: { analyzers: ['semgrep'] } },
      { getWorkspacePath: () => process.cwd() } as any
    );
    const result = JSON.parse(resultStr);

    expect(result.warnings).toContain('semgrep selected but changed_files is empty; semgrep will be skipped');
  });

  it('warns when semgrep changed_files list is large and will be chunked', async () => {
    process.env.CE_SEMGREP_MAX_FILES = '2';
    (runSemgrepAnalyzer as jest.Mock).mockImplementation(async () => ({
      analyzer: 'semgrep',
      duration_ms: 1,
      findings: [],
      warnings: [],
    }));

    const resultStr = await handleRunStaticAnalysis(
      { changed_files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], options: { analyzers: ['semgrep'] } },
      { getWorkspacePath: () => process.cwd() } as any
    );
    const result = JSON.parse(resultStr);

    expect(result.warnings).toContain(
      'semgrep changed_files contains 5 entries; execution will be chunked into 3 batches (max 2 files each)'
    );
  });
});
