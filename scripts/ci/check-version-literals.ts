#!/usr/bin/env node
/**
 * Deterministic CI check to prevent inconsistent release version literals.
 *
 * Canonical source: package.json version
 *
 * Exit codes:
 * - 0: all required literals match package.json version
 * - 1: mismatch, parse error, or missing required file/value
 */

import * as fs from 'fs';
import * as path from 'path';

const PACKAGE_JSON_PATH = 'package.json';

type VersionCheckTarget = {
  file: string;
  label: string;
  regex: RegExp;
};

const REQUIRED_VERSION_TARGETS: VersionCheckTarget[] = [
  {
    file: 'src/mcp/tools/manifest.ts',
    label: 'MCP_SERVER_VERSION',
    regex: /export const\s+MCP_SERVER_VERSION\s*=\s*['"]([^'"]+)['"]\s*;/,
  },
  {
    file: 'src/reviewer/reviewDiff.ts',
    label: 'TOOL_VERSION',
    regex: /const\s+TOOL_VERSION\s*=\s*['"]([^'"]+)['"]\s*;/,
  },
];

function readFileOrThrow(relativePath: string): string {
  const resolved = path.resolve(relativePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Required file not found: ${relativePath}`);
  }
  return fs.readFileSync(resolved, 'utf8');
}

function extractPackageVersion(packageJsonSource: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonSource);
  } catch {
    throw new Error('Unable to parse package.json');
  }

  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== 'string' || version.trim().length === 0) {
    throw new Error('package.json is missing a non-empty string version');
  }

  return version.trim();
}

function extractTargetVersion(source: string, target: VersionCheckTarget): string {
  const match = source.match(target.regex);
  if (!match) {
    throw new Error(`Unable to locate ${target.label} in ${target.file}`);
  }
  return match[1].trim();
}

function main(): void {
  try {
    const packageJsonSource = readFileOrThrow(PACKAGE_JSON_PATH);
    const canonicalVersion = extractPackageVersion(packageJsonSource);

    // eslint-disable-next-line no-console
    console.log('Version literal consistency check');
    // eslint-disable-next-line no-console
    console.log(`Canonical version (package.json): ${canonicalVersion}`);

    const mismatches: Array<{ target: VersionCheckTarget; actual: string }> = [];

    for (const target of REQUIRED_VERSION_TARGETS) {
      const source = readFileOrThrow(target.file);
      const actual = extractTargetVersion(source, target);

      // eslint-disable-next-line no-console
      console.log(`${target.file} (${target.label}): ${actual}`);

      if (actual !== canonicalVersion) {
        mismatches.push({ target, actual });
      }
    }

    if (mismatches.length > 0) {
      // eslint-disable-next-line no-console
      console.error('Version literal consistency check failed.');
      for (const mismatch of mismatches) {
        // eslint-disable-next-line no-console
        console.error(
          `- ${mismatch.target.file} (${mismatch.target.label}) expected ${canonicalVersion} but found ${mismatch.actual}`
        );
      }
      process.exit(1);
    }

    // eslint-disable-next-line no-console
    console.log('Version literal consistency check passed.');
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error(`Version literal consistency check failed: ${message}`);
    process.exit(1);
  }
}

main();
