import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  computeIndexGenerationFingerprint,
  evaluateCorpusFreshness,
} from '../../src/mcp/tooling/corpusFreshness.js';

const { ContextServiceClient } = await import('../../src/mcp/serviceClient.js');
const { FEATURE_FLAGS } = await import('../../src/config/features.js');

describe('corpusFreshness (R4)', () => {
  it('classifies generation/content/add/delete causes without using age', () => {
    const indexed = {
      'a.ts': { hash: 'aaa' },
      'b.ts': { hash: 'bbb' },
    };
    const current = {
      'a.ts': { hash: 'aaa-changed' },
      'c.ts': { hash: 'ccc' },
    };

    const assessment = evaluateCorpusFreshness({
      lastIndexed: new Date().toISOString(),
      ageIsStale: false,
      indexedGenerationFingerprint: computeIndexGenerationFingerprint(indexed),
      indexedFiles: indexed,
      currentFiles: current,
    });

    expect(assessment.isStale).toBe(true);
    expect(assessment.staleCauses).toEqual(
      expect.arrayContaining(['generation_changed', 'files_added', 'files_deleted', 'content_changed'])
    );
    expect(assessment.filesAdded).toBe(1);
    expect(assessment.filesDeleted).toBe(1);
    expect(assessment.filesContentChanged).toBe(1);
    expect(assessment.currentGenerationFingerprint).not.toBe(assessment.indexedGenerationFingerprint);
  });

  it('remains healthy when path+hash generation matches and age is fresh', () => {
    const files = {
      'a.ts': { hash: 'aaa' },
      'b.ts': { hash: 'bbb' },
    };
    const fingerprint = computeIndexGenerationFingerprint(files);

    const assessment = evaluateCorpusFreshness({
      lastIndexed: new Date().toISOString(),
      ageIsStale: false,
      indexedGenerationFingerprint: fingerprint,
      indexedFiles: files,
      currentFiles: files,
    });

    expect(assessment.isStale).toBe(false);
    expect(assessment.staleCauses).toEqual([]);
    expect(assessment.indexedGenerationFingerprint).toBe(fingerprint);
    expect(assessment.currentGenerationFingerprint).toBe(fingerprint);
  });

  it('marks stale on timestamp-preserving content mutation via getIndexStatus', async () => {
    const previousProvider = process.env.CE_RETRIEVAL_PROVIDER;
    process.env.CE_RETRIEVAL_PROVIDER = 'local_native';
    FEATURE_FLAGS.index_state_store = true;

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-r4-freshness-'));
    const sourcePath = path.join(tempDir, 'src');
    fs.mkdirSync(sourcePath, { recursive: true });
    const filePath = path.join(sourcePath, 'widget.ts');
    fs.writeFileSync(filePath, 'export const value = 1;\n', 'utf-8');

    try {
      const client = new ContextServiceClient(tempDir);
      const indexResult = await client.indexWorkspace();
      expect(indexResult.errors).toEqual([]);
      expect(indexResult.indexed).toBeGreaterThan(0);

      const before = client.getIndexStatus();
      expect(before.fileCount).toBeGreaterThan(0);
      expect(before.isStale).toBe(false);
      expect(before.indexedGenerationFingerprint).toBeTruthy();
      expect(before.currentGenerationFingerprint).toBe(before.indexedGenerationFingerprint);

      const priorStat = fs.statSync(filePath);
      fs.writeFileSync(filePath, 'export const value = 2;\n', 'utf-8');
      // Preserve mtime so age/mtime-based checks alone would stay healthy.
      fs.utimesSync(filePath, priorStat.atime, priorStat.mtime);

      const after = client.getIndexStatus();
      expect(after.isStale).toBe(true);
      expect(after.staleCauses).toEqual(
        expect.arrayContaining(['generation_changed', 'content_changed'])
      );
      expect(after.currentGenerationFingerprint).not.toBe(after.indexedGenerationFingerprint);
    } finally {
      if (previousProvider === undefined) {
        delete process.env.CE_RETRIEVAL_PROVIDER;
      } else {
        process.env.CE_RETRIEVAL_PROVIDER = previousProvider;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('marks stale when an eligible file is added without touching lastIndexed age', async () => {
    const previousProvider = process.env.CE_RETRIEVAL_PROVIDER;
    process.env.CE_RETRIEVAL_PROVIDER = 'local_native';
    FEATURE_FLAGS.index_state_store = true;

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-r4-add-'));
    const sourcePath = path.join(tempDir, 'src');
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.writeFileSync(path.join(sourcePath, 'alpha.ts'), 'export const a = 1;\n', 'utf-8');

    try {
      const client = new ContextServiceClient(tempDir);
      await client.indexWorkspace();
      expect(client.getIndexStatus().isStale).toBe(false);

      fs.writeFileSync(path.join(sourcePath, 'beta.ts'), 'export const b = 2;\n', 'utf-8');

      const after = client.getIndexStatus();
      expect(after.isStale).toBe(true);
      expect(after.staleCauses).toEqual(
        expect.arrayContaining(['generation_changed', 'files_added'])
      );
    } finally {
      if (previousProvider === undefined) {
        delete process.env.CE_RETRIEVAL_PROVIDER;
      } else {
        process.env.CE_RETRIEVAL_PROVIDER = previousProvider;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 60_000);
});
