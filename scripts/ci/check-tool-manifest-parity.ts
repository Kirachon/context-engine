#!/usr/bin/env node
/**
 * CI-friendly parity check for tool manifest vs runtime inventory.
 *
 * Source of truth:
 * - Runtime inventory: tool names declared in src/mcp/server.ts tool registry
 * - Manifest inventory: tools[] in src/mcp/tools/manifest.ts
 *
 * Exit codes:
 * - 0: manifest and runtime inventories are in parity
 * - 1: parity mismatch or parsing error
 */

import * as fs from 'fs';
import * as path from 'path';

const SERVER_PATH = 'src/mcp/server.ts';
const MANIFEST_PATH = 'src/mcp/tools/manifest.ts';
const TOOL_DIR = 'src/mcp/tools';

function readFileOrThrow(relativePath: string): string {
  const resolvedPath = path.resolve(relativePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Required file not found: ${relativePath}`);
  }
  return fs.readFileSync(resolvedPath, 'utf8');
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function duplicates(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
}

function collectToolConstantNamesFromToolFiles(): Map<string, string> {
  const toolNameByConst = new Map<string, string>();
  const toolDirPath = path.resolve(TOOL_DIR);

  if (!fs.existsSync(toolDirPath)) {
    return toolNameByConst;
  }

  const files = fs.readdirSync(toolDirPath).filter((file) => file.endsWith('.ts'));
  for (const file of files) {
    const source = fs.readFileSync(path.join(toolDirPath, file), 'utf8');
    const matches = [...source.matchAll(/export const\s+([A-Za-z0-9_]+)\s*=\s*\{[\s\S]*?name:\s*'([^']+)'/g)];
    for (const match of matches) {
      toolNameByConst.set(match[1], match[2]);
    }
  }

  return toolNameByConst;
}

function extractRuntimeToolNames(serverSource: string): string[] {
  const fromFindToolByName = [...serverSource.matchAll(/findToolByName\([^,]+,\s*'([^']+)'\)/g)].map((match) => match[1]);

  const directToolConsts = [...serverSource.matchAll(/\{\s*tool:\s*([A-Za-z0-9_]+)\s*,\s*handler:/g)]
    .map((match) => match[1])
    .filter((constName) => constName !== 'findToolByName');

  const toolNameByConst = collectToolConstantNamesFromToolFiles();
  const fromDirectConsts = directToolConsts
    .map((constName) => toolNameByConst.get(constName))
    .filter((name): name is string => Boolean(name));

  return [...fromFindToolByName, ...fromDirectConsts];
}

function extractManifestToolNames(manifestSource: string): string[] {
  const toolsBlockMatch = manifestSource.match(/tools:\s*\[(.*?)\]\s*,\s*features:/s);
  if (!toolsBlockMatch) {
    throw new Error('Unable to parse tools[] block from manifest.ts');
  }
  return [...toolsBlockMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function formatList(title: string, items: string[]): void {
  if (items.length === 0) {
    return;
  }
  // eslint-disable-next-line no-console
  console.log(title);
  for (const item of items) {
    // eslint-disable-next-line no-console
    console.log(`- ${item}`);
  }
}

function main(): void {
  try {
    const serverSource = readFileOrThrow(SERVER_PATH);
    const manifestSource = readFileOrThrow(MANIFEST_PATH);

    const runtimeRaw = extractRuntimeToolNames(serverSource);
    const manifestRaw = extractManifestToolNames(manifestSource);

    const runtime = uniqueSorted(runtimeRaw);
    const manifest = uniqueSorted(manifestRaw);

    const missingInManifest = runtime.filter((name) => !manifest.includes(name));
    const extraInManifest = manifest.filter((name) => !runtime.includes(name));
    const duplicateRuntime = duplicates(runtimeRaw);
    const duplicateManifest = duplicates(manifestRaw);

    // eslint-disable-next-line no-console
    console.log('Tool manifest parity check');
    // eslint-disable-next-line no-console
    console.log(`Runtime tool count: ${runtime.length}`);
    // eslint-disable-next-line no-console
    console.log(`Manifest tool count: ${manifest.length}`);

    formatList('Missing in manifest:', missingInManifest);
    formatList('Extra in manifest:', extraInManifest);
    formatList('Duplicate runtime tool entries:', duplicateRuntime);
    formatList('Duplicate manifest tool entries:', duplicateManifest);

    const hasFailure =
      missingInManifest.length > 0 ||
      extraInManifest.length > 0 ||
      duplicateRuntime.length > 0 ||
      duplicateManifest.length > 0;

    if (hasFailure) {
      // eslint-disable-next-line no-console
      console.error('Tool manifest parity check failed.');
      process.exit(1);
    }

    // eslint-disable-next-line no-console
    console.log('Tool manifest parity check passed.');
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error(`Tool manifest parity check failed: ${message}`);
    process.exit(1);
  }
}

main();
