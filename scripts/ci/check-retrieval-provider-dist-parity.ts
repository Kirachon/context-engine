import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, 'src', 'retrieval', 'providers');
const DIST_DIR = path.join(ROOT, 'dist', 'retrieval', 'providers');

if (!fs.existsSync(SRC_DIR)) {
  throw new Error('Missing source directory: src/retrieval/providers');
}

if (!fs.existsSync(DIST_DIR)) {
  throw new Error('Missing dist directory: dist/retrieval/providers. Run npm run build first.');
}

const srcModules = listModuleBasenames(SRC_DIR, '.ts');
const distModules = listModuleBasenames(DIST_DIR, '.js');

const missingDistModules = srcModules.filter((moduleName) => !distModules.includes(moduleName));
const extraDistModules = distModules.filter((moduleName) => !srcModules.includes(moduleName));
const exportMismatches: string[] = [];

for (const moduleName of srcModules) {
  if (!distModules.includes(moduleName)) {
    continue;
  }

  const srcPath = path.join(SRC_DIR, `${moduleName}.ts`);
  const distPath = path.join(DIST_DIR, `${moduleName}.js`);
  const srcExports = await loadRuntimeExports(srcPath);
  const distExports = await loadRuntimeExports(distPath);

  if (!sameList(srcExports, distExports)) {
    exportMismatches.push(
      `${moduleName}: src exports [${srcExports.join(', ')}], dist exports [${distExports.join(', ')}]`
    );
  }
}

if (missingDistModules.length > 0 || extraDistModules.length > 0 || exportMismatches.length > 0) {
  console.error('Retrieval provider dist/source parity check failed.');
  if (missingDistModules.length > 0) {
    console.error(`Missing dist modules: ${missingDistModules.join(', ')}`);
  }
  if (extraDistModules.length > 0) {
    console.error(`Unexpected dist modules: ${extraDistModules.join(', ')}`);
  }
  if (exportMismatches.length > 0) {
    console.error('Export parity mismatches:');
    for (const mismatch of exportMismatches) {
      console.error(` - ${mismatch}`);
    }
  }
  process.exit(1);
}

console.log('Retrieval provider dist/source parity check passed.');
console.log(`Checked ${srcModules.length} retrieval provider module(s).`);

function listModuleBasenames(directory: string, extension: string): string[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => entry.name.slice(0, -extension.length))
    .sort();
}

async function loadRuntimeExports(modulePath: string): Promise<string[]> {
  const moduleUrl = pathToFileURL(modulePath).href;
  const loaded = await import(moduleUrl);
  return Object.keys(loaded).sort();
}

function sameList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}
