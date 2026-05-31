import { buildToolRegistryEntries } from '../src/mcp/server.js';
import { getToolManifest } from '../src/mcp/tools/manifest.js';
import type { NormalizedToolManifestParityReceipt } from './normalizeEvalOutput.js';

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function buildToolManifestParityReceipt(): NormalizedToolManifestParityReceipt {
  const manifest = getToolManifest() as { tools?: string[] };
  const manifestTools = uniqueSorted(manifest.tools ?? []);
  const runtimeTools = uniqueSorted(
    buildToolRegistryEntries({} as never).map((entry) => entry.tool.name)
  );

  const missingInManifest = runtimeTools.filter((name) => !manifestTools.includes(name));
  const extraInManifest = manifestTools.filter((name) => !runtimeTools.includes(name));
  const status =
    missingInManifest.length === 0 && extraInManifest.length === 0 ? 'pass' : 'fail';

  return {
    runtime_count: runtimeTools.length,
    manifest_count: manifestTools.length,
    missing_in_manifest: missingInManifest,
    extra_in_manifest: extraInManifest,
    status,
  };
}
