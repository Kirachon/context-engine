import { afterEach, describe, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  resolveIndexFingerprint,
  resolveWorkspaceFingerprint,
} from '../../scripts/ci/bench-provenance.js';

const originalWorkspaceId = process.env.BENCH_WORKSPACE_ID;
const originalIndexFingerprint = process.env.BENCH_INDEX_FINGERPRINT;

afterEach(() => {
  if (originalWorkspaceId === undefined) delete process.env.BENCH_WORKSPACE_ID;
  else process.env.BENCH_WORKSPACE_ID = originalWorkspaceId;

  if (originalIndexFingerprint === undefined) delete process.env.BENCH_INDEX_FINGERPRINT;
  else process.env.BENCH_INDEX_FINGERPRINT = originalIndexFingerprint;
});

describe('benchmark provenance portability', () => {
  it('uses the configured logical workspace identity across checkout paths', () => {
    process.env.BENCH_WORKSPACE_ID = 'Kirachon/context-engine:retrieval-pr-v1';

    expect(resolveWorkspaceFingerprint('C:/runner/_work/context-engine/context-engine')).toBe(
      resolveWorkspaceFingerprint('/home/runner/work/context-engine/context-engine')
    );
  });

  it('uses an explicitly configured stable index identity', () => {
    process.env.BENCH_INDEX_FINGERPRINT = 'context-engine-local-native-index-v1';

    expect(resolveIndexFingerprint('C:/runner/_work/context-engine/context-engine')).toBe(
      'fingerprint:context-engine-local-native-index-v1'
    );
  });

  it('reads the preferred Context Engine index sidecar', () => {
    delete process.env.BENCH_INDEX_FINGERPRINT;
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-bench-provenance-'));
    try {
      fs.writeFileSync(
        path.join(workspace, '.context-engine-index-fingerprint.json'),
        JSON.stringify({ version: 1, fingerprint: 'preferred' }),
        'utf8'
      );
      expect(resolveIndexFingerprint(workspace)).toBe('fingerprint:preferred');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
