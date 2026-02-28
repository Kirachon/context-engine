import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

function runValidator(checklistPath: string): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'ci', 'validate-master-plan.ts');
  const res = spawnSync(process.execPath, [tsxCli, script, checklistPath], {
    cwd: process.cwd(),
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

function writeChecklist(filePath: string, body: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf-8');
}

describe('scripts/ci/validate-master-plan.ts', () => {
  it('passes for a structurally valid checklist', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-master-plan-valid-'));
    const checklistPath = path.join(tmp, 'MASTER_PLAN_CHECKLIST.md');
    writeChecklist(
      checklistPath,
      [
        '# Master Plan Checklist',
        '## A) Completed Foundation Waves (Already Implemented)',
        '- [x] done',
        '## B) Remaining Master Roadmap (Implement All)',
        '- [ ] todo',
        '## B1) Shared Foundations (Cross-Tool Standardization)',
        '- [ ] todo',
        '## B2) Tool Family Completion Batches',
        '- [ ] todo',
        'Progress notes:',
        '- 2026-02-28: note',
        '## C) Global Validation Gates (Must Pass Before “All Done”)',
        '- [ ] gate',
        '## D) Definition of Done (Master)',
        '- [ ] final',
        '## Changelog',
        '- 2026-02-28: entry',
      ].join('\n')
    );

    const result = runValidator(checklistPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Master plan validation passed.');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when a required heading is missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-master-plan-missing-heading-'));
    const checklistPath = path.join(tmp, 'MASTER_PLAN_CHECKLIST.md');
    writeChecklist(
      checklistPath,
      [
        '# Master Plan Checklist',
        '## A) Completed Foundation Waves (Already Implemented)',
        '- [x] done',
        '## B) Remaining Master Roadmap (Implement All)',
        '- [ ] todo',
        'Progress notes:',
        '- 2026-02-28: note',
        '## C) Global Validation Gates (Must Pass Before “All Done”)',
        '- [ ] gate',
        '## D) Definition of Done (Master)',
        '- [ ] final',
        '## Changelog',
        '- 2026-02-28: entry',
      ].join('\n')
    );

    const result = runValidator(checklistPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing required heading');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails for malformed checkbox syntax', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-master-plan-bad-checkbox-'));
    const checklistPath = path.join(tmp, 'MASTER_PLAN_CHECKLIST.md');
    writeChecklist(
      checklistPath,
      [
        '# Master Plan Checklist',
        '## A) Completed Foundation Waves (Already Implemented)',
        '- [x] done',
        '## B) Remaining Master Roadmap (Implement All)',
        '- [z] bad',
        '## B1) Shared Foundations (Cross-Tool Standardization)',
        '- [ ] todo',
        '## B2) Tool Family Completion Batches',
        '- [ ] todo',
        'Progress notes:',
        '- 2026-02-28: note',
        '## C) Global Validation Gates (Must Pass Before “All Done”)',
        '- [ ] gate',
        '## D) Definition of Done (Master)',
        '- [ ] final',
        '## Changelog',
        '- 2026-02-28: entry',
      ].join('\n')
    );

    const result = runValidator(checklistPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Malformed checkbox line');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
