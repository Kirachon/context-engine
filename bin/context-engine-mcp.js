#!/usr/bin/env node
/**
 * CLI wrapper for context-engine-mcp server
 * Uses tsx to handle ESM resolution for the built ESM entry point
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the main entry point
const mainScript = join(__dirname, '..', 'dist', 'index.js');

// Spawn node with tsx loader
const child = spawn(
  process.execPath,
  ['--import', 'tsx', mainScript, ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    cwd: process.cwd(),
  }
);

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
