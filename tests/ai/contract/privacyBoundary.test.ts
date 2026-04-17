/**
 * Static-analysis fence for the privacy + network-egress boundary documented
 * in `docs/providers/privacy-boundary.md`. These tests read source files
 * directly from disk (no runtime network or AI calls) and assert that the
 * local-by-default surfaces stay local.
 *
 * Allow-listed egress points are declared explicitly below. New entries here
 * MUST be mirrored in `docs/providers/privacy-boundary.md` §5 ("Known egress
 * points").
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { ProviderPrivacyClass } from '../../../src/ai/providers/capabilities.js';

const REPO_ROOT = process.cwd();
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const DOC_PATH = path.join(REPO_ROOT, 'docs', 'providers', 'privacy-boundary.md');

const EGRESS_PATTERN =
  /\bfetch\s*\(|\bhttp\.request\b|\bhttps\.request\b|\baxios\b|\bnode-fetch\b|\bundici\b/;

/**
 * Files that are intentionally allowed to perform in-process egress.
 * Paths are POSIX-style relative to the repo root so that they round-trip on
 * Windows + POSIX.
 */
const EGRESS_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // External grounding helper: caller-opted fetch of `external_sources` URLs
  // (github_url / docs_url) for `enhance_prompt`, `get_context_for_prompt`
  // and `codebase-retrieval`. See privacy-boundary.md §5.
  'src/mcp/tooling/externalGrounding.ts',
]);

function toPosixRelative(absPath: string): string {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        stack.push(full);
      } else if (entry.isFile() && /\.(ts|tsx|mts|cts)$/.test(entry.name)) {
        if (entry.name.endsWith('.d.ts')) continue;
        out.push(full);
      }
    }
  }
  return out;
}

interface EgressHit {
  file: string;
  line: number;
  text: string;
}

function findEgressHits(files: string[]): EgressHit[] {
  const hits: EgressHit[] = [];
  for (const absFile of files) {
    const rel = toPosixRelative(absFile);
    if (EGRESS_ALLOWLIST.has(rel)) continue;
    const content = fs.readFileSync(absFile, 'utf8');
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      // Skip pure-comment lines so doc-comments mentioning fetch don't trip.
      const trimmed = raw.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      if (EGRESS_PATTERN.test(raw)) {
        hits.push({ file: rel, line: i + 1, text: trimmed });
      }
    }
  }
  return hits;
}

function formatHits(hits: EgressHit[]): string {
  return hits.map((h) => `  ${h.file}:${h.line}  ${h.text}`).join('\n');
}

describe('privacy boundary (static-analysis fence)', () => {
  describe('local-by-default surfaces have no in-process network egress', () => {
    const surfaces: ReadonlyArray<{ name: string; dir: string }> = [
      { name: 'src/internal/retrieval', dir: path.join(SRC_ROOT, 'internal', 'retrieval') },
      { name: 'src/retrieval', dir: path.join(SRC_ROOT, 'retrieval') },
      { name: 'src/http', dir: path.join(SRC_ROOT, 'http') },
      { name: 'src/watcher', dir: path.join(SRC_ROOT, 'watcher') },
      { name: 'src/worker', dir: path.join(SRC_ROOT, 'worker') },
      { name: 'src/telemetry', dir: path.join(SRC_ROOT, 'telemetry') },
    ];

    for (const surface of surfaces) {
      it(`${surface.name} contains no fetch/http.request/https.request/axios/node-fetch/undici`, () => {
        const files = walkTsFiles(surface.dir);
        const hits = findEgressHits(files);
        if (hits.length > 0) {
          throw new Error(
            `Unexpected egress points found under ${surface.name}.\n` +
              `If a hit is legitimate, add the file to EGRESS_ALLOWLIST in this test ` +
              `AND add a row to docs/providers/privacy-boundary.md §5.\n` +
              formatHits(hits)
          );
        }
        expect(hits).toEqual([]);
      });
    }

    it('src/mcp contains no in-process egress outside the allow-listed external-grounding helper', () => {
      const files = walkTsFiles(path.join(SRC_ROOT, 'mcp'));
      const hits = findEgressHits(files);
      if (hits.length > 0) {
        throw new Error(
          `Unexpected egress points found under src/mcp.\n` +
            `If a hit is legitimate, add the file to EGRESS_ALLOWLIST in this test ` +
            `AND add a row to docs/providers/privacy-boundary.md §5.\n` +
            formatHits(hits)
        );
      }
      expect(hits).toEqual([]);
    });

    it('every allow-listed egress file actually exists and still contains an egress call', () => {
      for (const rel of EGRESS_ALLOWLIST) {
        const abs = path.join(REPO_ROOT, ...rel.split('/'));
        expect(fs.existsSync(abs)).toBe(true);
        const content = fs.readFileSync(abs, 'utf8');
        // Sanity: if the egress is gone, the allow-list entry is stale and
        // should be removed (otherwise it silently weakens future checks).
        expect(EGRESS_PATTERN.test(content)).toBe(true);
      }
    });
  });

  describe('ProviderPrivacyClass enum is frozen', () => {
    it('exposes exactly Local, SelfHosted, Hosted, Unsupported', () => {
      const keys = Object.keys(ProviderPrivacyClass).sort();
      expect(keys).toEqual(['Hosted', 'Local', 'SelfHosted', 'Unsupported']);
      expect(ProviderPrivacyClass.Local).toBe('local');
      expect(ProviderPrivacyClass.SelfHosted).toBe('self-hosted');
      expect(ProviderPrivacyClass.Hosted).toBe('hosted');
      expect(ProviderPrivacyClass.Unsupported).toBe('unsupported');
    });

    it('source file declares the same four members', () => {
      const src = fs.readFileSync(
        path.join(SRC_ROOT, 'ai', 'providers', 'capabilities.ts'),
        'utf8'
      );
      for (const member of ['Local', 'SelfHosted', 'Hosted', 'Unsupported']) {
        expect(src).toMatch(new RegExp(`\\b${member}\\s*=\\s*'`));
      }
    });
  });

  describe('docs/providers/privacy-boundary.md mentions every privacy class', () => {
    it('contains each ProviderPrivacyClass enum member name', () => {
      const doc = fs.readFileSync(DOC_PATH, 'utf8');
      for (const member of Object.keys(ProviderPrivacyClass)) {
        expect(doc).toEqual(expect.stringContaining(member));
      }
    });

    it('lists each allow-listed egress file under §5', () => {
      const doc = fs.readFileSync(DOC_PATH, 'utf8');
      for (const rel of EGRESS_ALLOWLIST) {
        expect(doc).toEqual(expect.stringContaining(rel));
      }
    });
  });
});
