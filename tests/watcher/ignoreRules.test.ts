import { describe, expect, it } from '@jest/globals';
import { normalizeIgnoredPatterns } from '../../src/watcher/ignoreRules.js';

describe('normalizeIgnoredPatterns', () => {
  it('translates root-anchored and directory-only patterns for chokidar', () => {
    const patterns = normalizeIgnoredPatterns(
      'D:/repo/workspace',
      ['/.env', 'tmp/', '*.log'],
      ['node_modules', 'dist']
    );

    expect(patterns).toEqual([
      '**/node_modules/**',
      '**/dist/**',
      'D:/repo/workspace/.env',
      '**/tmp/**',
      '**/*.log',
    ]);
  });
});
