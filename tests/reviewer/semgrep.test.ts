import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const runCommand = jest.fn();

jest.unstable_mockModule('../../src/reviewer/checks/adapters/exec.js', () => ({
  runCommand,
  devNullPath: () => '/dev/null',
}));

const { runSemgrepAnalyzer } = await import('../../src/reviewer/checks/adapters/semgrep.js');

describe('runSemgrepAnalyzer', () => {
  beforeEach(() => {
    runCommand.mockReset();
    process.env.CE_SEMGREP_MAX_FILES = '2';
  });

  afterEach(() => {
    delete process.env.CE_SEMGREP_MAX_FILES;
  });

  it('chunks large file lists and merges results', async () => {
    (runCommand as jest.Mock).mockImplementation(async (args: any) => {
      const commandArgs = (args?.commandArgs ?? []) as string[];
      const quietIndex = commandArgs.indexOf('--quiet');
      const files = quietIndex === -1 ? [] : commandArgs.slice(quietIndex + 1);
      return {
        stdout: JSON.stringify({
          results: files.map((file: string) => ({
            check_id: `chk-${file}`,
            path: file,
            start: { line: 1 },
            end: { line: 1 },
            extra: { message: `msg-${file}`, severity: 'WARNING' },
          })),
        }),
        stderr: '',
        exitCode: 0,
        duration_ms: 5,
      };
    });

    const input = {
      workspace_path: process.cwd(),
      changed_files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
    };

    const result = await runSemgrepAnalyzer(input, { timeoutMs: 1000, maxFindings: 10 });

    expect(runCommand).toHaveBeenCalledTimes(3);
    const calls = (runCommand as jest.Mock).mock.calls as Array<[any]>;
    const calledFiles = calls.map((call) => {
      const args = (call?.[0]?.commandArgs ?? []) as string[];
      const quietIndex = args.indexOf('--quiet');
      return quietIndex === -1 ? [] : args.slice(quietIndex + 1);
    });
    expect(calledFiles).toEqual([['a.ts', 'b.ts'], ['c.ts', 'd.ts'], ['e.ts']]);
    expect(result.findings).toHaveLength(5);
    expect(result.warnings.some(w => w.includes('chunked into 3 batches'))).toBe(true);
  });

  it('skips when changed_files is empty', async () => {
    const input = {
      workspace_path: process.cwd(),
      changed_files: [],
    };

    const result = await runSemgrepAnalyzer(input, { timeoutMs: 1000, maxFindings: 10 });

    expect(runCommand).not.toHaveBeenCalled();
    expect(result.findings).toHaveLength(0);
    expect(result.skipped_reason).toBe('semgrep_no_changed_files');
    expect(result.warnings).toContain('semgrep selected with empty changed_files; skipping to avoid scanning the full workspace');
  });
});
