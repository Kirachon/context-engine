import * as fs from 'node:fs';
import * as path from 'node:path';

type Violation = {
  file: string;
  reason: string;
};

const ROOT = process.cwd();
const RETRIEVAL_PROVIDER_RUNTIME_ROOT = path.join(ROOT, 'src', 'retrieval', 'providers');
const SOURCE_FILE_PATTERN = /\.(ts|tsx|js|mjs|cjs)$/i;

// Approved runtime ownership boundary for legacy retrieval internals after extraction.
// Keep this list narrow: only files that are allowed to touch legacy SDK/runtime internals.
const LEGACY_RUNTIME_OWNER_ALLOWLIST = new Set<string>([
  // Extracted legacy runtime module.
  normalizeRelative('src/retrieval/providers/legacyRuntime.ts'),
]);

const SDK_ALLOWLIST = new Set<string>(LEGACY_RUNTIME_OWNER_ALLOWLIST);
const DIRECT_CONTEXT_ALLOWLIST = new Set<string>(LEGACY_RUNTIME_OWNER_ALLOWLIST);

const SDK_IMPORT_PATTERN =
  /\bfrom\s+['"]@augmentcode\/auggie-sdk['"]|\bimport\s+['"]@augmentcode\/auggie-sdk['"]|\bimport\s*\(\s*['"]@augmentcode\/auggie-sdk['"]\s*\)|\brequire\s*\(\s*['"]@augmentcode\/auggie-sdk['"]\s*\)/;
const DIRECT_CONTEXT_PATTERN = /\bDirectContext\b/;

const filesToScan = collectRuntimeFiles();
const violations: Violation[] = [];

for (const filePath of filesToScan) {
  const relativePath = normalizeRelative(path.relative(ROOT, filePath));
  const source = fs.readFileSync(filePath, 'utf8');

  if (SDK_IMPORT_PATTERN.test(source) && !SDK_ALLOWLIST.has(relativePath)) {
    violations.push({
      file: relativePath,
      reason: 'unexpected @augmentcode/auggie-sdk reference outside allowlist',
    });
  }

  if (DIRECT_CONTEXT_PATTERN.test(source) && !DIRECT_CONTEXT_ALLOWLIST.has(relativePath)) {
    violations.push({
      file: relativePath,
      reason: 'unexpected DirectContext usage outside allowlist',
    });
  }
}

if (violations.length > 0) {
  console.error('Retrieval provider boundary check failed.');
  console.error('Allowed legacy runtime owner files:');
  for (const allowed of Array.from(LEGACY_RUNTIME_OWNER_ALLOWLIST).sort()) {
    console.error(` - ${allowed}`);
  }
  console.error('Allowed SDK files:');
  for (const allowed of Array.from(SDK_ALLOWLIST).sort()) {
    console.error(` - ${allowed}`);
  }
  console.error('Allowed DirectContext files:');
  for (const allowed of Array.from(DIRECT_CONTEXT_ALLOWLIST).sort()) {
    console.error(` - ${allowed}`);
  }
  console.error('Violations:');
  for (const violation of violations) {
    console.error(` - ${violation.file}: ${violation.reason}`);
  }
  process.exit(1);
}

console.log('Retrieval provider boundary check passed.');
console.log(`Scanned ${filesToScan.length} runtime retrieval file(s).`);

function collectRuntimeFiles(): string[] {
  const files = new Set<string>();

  if (fs.existsSync(RETRIEVAL_PROVIDER_RUNTIME_ROOT)) {
    walkDirectory(RETRIEVAL_PROVIDER_RUNTIME_ROOT, files);
  }

  return Array.from(files).sort();
}

function walkDirectory(dirPath: string, collector: Set<string>): void {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkDirectory(fullPath, collector);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!SOURCE_FILE_PATTERN.test(entry.name)) {
      continue;
    }
    collector.add(path.resolve(fullPath));
  }
}

function normalizeRelative(filePath: string): string {
  return filePath.split(path.sep).join('/');
}
