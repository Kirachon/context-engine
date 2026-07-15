import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  applyIncrementalDiscovery,
  produceDiscoveryManifest,
  runFullDiscovery,
  type DiscoveryManifest,
} from '../../../src/internal/discovery/discoveryManifest.js';

describe('discoveryManifest', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const next = tempDirs.pop();
      if (next) fs.rmSync(next, { recursive: true, force: true });
    }
  });

  function createTempWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-discovery-manifest-'));
    tempDirs.push(dir);
    return dir;
  }

  function writeFile(workspacePath: string, relativePath: string, contents: string): void {
    const fullPath = path.join(workspacePath, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, contents, 'utf-8');
  }

  function stripGeneratedAt(manifest: DiscoveryManifest): Omit<DiscoveryManifest, 'generated_at'> {
    const { generated_at: _generatedAt, ...rest } = manifest;
    return rest;
  }

  it('includes eligible files and excludes default-excluded directories/patterns', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, 'src/index.ts', 'export const a = 1;\n');
    writeFile(workspacePath, 'node_modules/pkg/index.js', 'module.exports = {};\n');
    writeFile(workspacePath, 'dist/index.js', 'console.log(1);\n');
    writeFile(workspacePath, 'notes.log', 'debug output\n');

    const manifest = await produceDiscoveryManifest({ workspacePath });

    expect(manifest.files.map((entry) => entry.path)).toEqual(['src/index.ts']);
    expect(manifest.file_count).toBe(1);
    expect(manifest.manifest_version).toBe(1);
  });

  it('honors negation to re-include a file excluded by an earlier pattern', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, '.gitignore', ['*.log', '!keep.log'].join('\n'));
    writeFile(workspacePath, 'debug.log', 'debug\n');
    writeFile(workspacePath, 'keep.log', 'keep\n');

    // .log is not an eligible extension by default, so use a custom pattern
    // scenario via additionalPatterns/eligible name instead: rely on a
    // recognized extension so eligibility does not mask the ignore-rule result.
    writeFile(workspacePath, 'debug.md', 'debug\n');
    writeFile(workspacePath, 'keep.md', 'keep\n');
    fs.writeFileSync(
      path.join(workspacePath, '.gitignore'),
      ['*.md', '!keep.md'].join('\n'),
      'utf-8'
    );

    const manifest = await produceDiscoveryManifest({ workspacePath });

    const paths = manifest.files.map((entry) => entry.path);
    expect(paths).toContain('keep.md');
    expect(paths).not.toContain('debug.md');
  });

  it('anchors rooted patterns to the workspace root only', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, '.gitignore', '/root-only.md\n');
    writeFile(workspacePath, 'root-only.md', 'root\n');
    writeFile(workspacePath, 'nested/root-only.md', 'nested\n');

    const manifest = await produceDiscoveryManifest({ workspacePath });
    const paths = manifest.files.map((entry) => entry.path);

    expect(paths).not.toContain('root-only.md');
    expect(paths).toContain('nested/root-only.md');
  });

  it('excludes an entire directory subtree for directory-only patterns', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, '.gitignore', 'generated/\n');
    writeFile(workspacePath, 'generated/deep/output.md', 'generated\n');
    writeFile(workspacePath, 'kept/output.md', 'kept\n');

    const manifest = await produceDiscoveryManifest({ workspacePath });
    const paths = manifest.files.map((entry) => entry.path);

    expect(paths).not.toContain('generated/deep/output.md');
    expect(paths).toContain('kept/output.md');
  });

  it('reads a custom ignore file when requested', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, '.customignore', 'secret-*.md\n');
    writeFile(workspacePath, 'secret-notes.md', 'secret\n');
    writeFile(workspacePath, 'public-notes.md', 'public\n');

    const withoutCustom = await produceDiscoveryManifest({ workspacePath });
    const withCustom = await produceDiscoveryManifest({
      workspacePath,
      ignore: { extraIgnoreFileNames: ['.customignore'] },
    });

    expect(withoutCustom.files.map((entry) => entry.path)).toContain('secret-notes.md');
    expect(withCustom.files.map((entry) => entry.path)).not.toContain('secret-notes.md');
    expect(withCustom.files.map((entry) => entry.path)).toContain('public-notes.md');
  });

  it('excludes hidden files/directories by default and keeps the allowlist', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, '.hidden-secrets.md', 'secret\n');
    writeFile(workspacePath, '.hidden-dir/nested.md', 'nested\n');
    writeFile(workspacePath, '.editorconfig', 'root = true\n');
    writeFile(workspacePath, 'visible.md', 'visible\n');

    const manifest = await produceDiscoveryManifest({ workspacePath });
    const paths = manifest.files.map((entry) => entry.path);

    expect(paths).not.toContain('.hidden-secrets.md');
    expect(paths).not.toContain('.hidden-dir/nested.md');
    expect(paths).toContain('.editorconfig');
    expect(paths).toContain('visible.md');
  });

  it('never follows or indexes symlinked files or directories', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, 'real/target.md', 'real content\n');
    writeFile(workspacePath, 'real-dir/inner.md', 'inner content\n');

    fs.symlinkSync(path.join(workspacePath, 'real', 'target.md'), path.join(workspacePath, 'link.md'));
    fs.symlinkSync(path.join(workspacePath, 'real-dir'), path.join(workspacePath, 'link-dir'), 'dir');

    const manifest = await produceDiscoveryManifest({ workspacePath });
    const paths = manifest.files.map((entry) => entry.path);

    expect(paths).toContain('real/target.md');
    expect(paths).toContain('real-dir/inner.md');
    expect(paths).not.toContain('link.md');
    expect(paths).not.toContain('link-dir/inner.md');
  });

  it('scopes discovery to explicit subroots while keeping workspace-relative paths', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, 'src/inside.md', 'inside\n');
    writeFile(workspacePath, 'docs/outside.md', 'outside\n');

    const { files } = await runFullDiscovery({
      workspacePath,
      indexingRoots: [path.join(workspacePath, 'src')],
    });

    expect(files.map((entry) => entry.path)).toEqual(['src/inside.md']);
  });

  it('produces deterministic fingerprints for an unchanged workspace', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, 'src/a.md', 'a\n');
    writeFile(workspacePath, 'src/b.md', 'b\n');

    const first = await produceDiscoveryManifest({ workspacePath });
    const second = await produceDiscoveryManifest({ workspacePath });

    expect(stripGeneratedAt(first)).toEqual(stripGeneratedAt(second));
  });

  it('changes the generation fingerprint (but not schema/source) when file content mutates', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, 'src/a.md', 'original\n');

    const before = await produceDiscoveryManifest({ workspacePath });
    writeFile(workspacePath, 'src/a.md', 'mutated\n');
    const after = await produceDiscoveryManifest({ workspacePath });

    expect(after.schema_fingerprint).toBe(before.schema_fingerprint);
    expect(after.source_fingerprint).toBe(before.source_fingerprint);
    expect(after.generation_fingerprint).not.toBe(before.generation_fingerprint);
    expect(after.files.map((f) => f.path)).toEqual(before.files.map((f) => f.path));
  });

  describe('applyIncrementalDiscovery', () => {
    it('matches a full re-discovery after an add', async () => {
      const workspacePath = createTempWorkspace();
      writeFile(workspacePath, 'src/a.md', 'a\n');
      const baseline = await produceDiscoveryManifest({ workspacePath });

      writeFile(workspacePath, 'src/b.md', 'b\n');
      const viaFull = await produceDiscoveryManifest({ workspacePath });
      const viaIncremental = await applyIncrementalDiscovery(baseline, workspacePath, {
        added: ['src/b.md'],
      });

      expect(stripGeneratedAt(viaIncremental)).toEqual(stripGeneratedAt(viaFull));
    });

    it('matches a full re-discovery after a delete', async () => {
      const workspacePath = createTempWorkspace();
      writeFile(workspacePath, 'src/a.md', 'a\n');
      writeFile(workspacePath, 'src/b.md', 'b\n');
      const baseline = await produceDiscoveryManifest({ workspacePath });

      fs.rmSync(path.join(workspacePath, 'src', 'b.md'));
      const viaFull = await produceDiscoveryManifest({ workspacePath });
      const viaIncremental = await applyIncrementalDiscovery(baseline, workspacePath, {
        removed: ['src/b.md'],
      });

      expect(stripGeneratedAt(viaIncremental)).toEqual(stripGeneratedAt(viaFull));
    });

    it('matches a full re-discovery after a mutate', async () => {
      const workspacePath = createTempWorkspace();
      writeFile(workspacePath, 'src/a.md', 'original\n');
      const baseline = await produceDiscoveryManifest({ workspacePath });

      writeFile(workspacePath, 'src/a.md', 'mutated content\n');
      const viaFull = await produceDiscoveryManifest({ workspacePath });
      const viaIncremental = await applyIncrementalDiscovery(baseline, workspacePath, {
        mutated: ['src/a.md'],
      });

      expect(stripGeneratedAt(viaIncremental)).toEqual(stripGeneratedAt(viaFull));
      expect(viaIncremental.generation_fingerprint).not.toBe(baseline.generation_fingerprint);
    });

    it('drops an added path that is not eligible (e.g. ignored) rather than including it', async () => {
      const workspacePath = createTempWorkspace();
      writeFile(workspacePath, 'src/a.md', 'a\n');
      const baseline = await produceDiscoveryManifest({ workspacePath });

      writeFile(workspacePath, 'dist/build.md', 'build\n');
      const viaIncremental = await applyIncrementalDiscovery(baseline, workspacePath, {
        added: ['dist/build.md'],
      });

      expect(viaIncremental.files.map((f) => f.path)).not.toContain('dist/build.md');
    });
  });
});
