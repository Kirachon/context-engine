#!/usr/bin/env node

/**
 * Setup Verification Script
 * 
 * Checks that all prerequisites are installed and configured correctly
 * for the Context Engine MCP Server.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const checks = [];
let passed = 0;
let failed = 0;

function log(message, type = 'info') {
  const colors = {
    success: '\x1b[32m',
    error: '\x1b[31m',
    warning: '\x1b[33m',
    info: '\x1b[36m',
    reset: '\x1b[0m',
  };
  
  const symbols = {
    success: '✓',
    error: '✗',
    warning: '⚠',
    info: 'ℹ',
  };
  
  console.log(`${colors[type]}${symbols[type]} ${message}${colors.reset}`);
}

function executeCommand(command, args = []) {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { shell: true });
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => stdout += data.toString());
    proc.stderr.on('data', (data) => stderr += data.toString());
    
    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
    
    proc.on('error', (error) => {
      resolve({ code: -1, stdout, stderr: error.message });
    });
  });
}

async function checkNodeVersion() {
  const result = await executeCommand('node', ['--version']);
  if (result.code === 0) {
    const version = result.stdout.trim();
    const majorVersion = parseInt(version.slice(1).split('.')[0]);
    if (majorVersion >= 18) {
      log(`Node.js ${version} installed`, 'success');
      passed++;
      return true;
    } else {
      log(`Node.js ${version} is too old (need 18+)`, 'error');
      failed++;
      return false;
    }
  } else {
    log('Node.js not found', 'error');
    failed++;
    return false;
  }
}

async function checkNpmVersion() {
  const result = await executeCommand('npm', ['--version']);
  if (result.code === 0) {
    log(`npm ${result.stdout.trim()} installed`, 'success');
    passed++;
    return true;
  } else {
    log('npm not found', 'error');
    failed++;
    return false;
  }
}

async function checkRetrievalConfig() {
  const provider = process.env.CE_RETRIEVAL_PROVIDER;
  if (!provider || provider.trim() === '' || provider.trim() === 'local_native') {
    log('Retrieval provider configuration is local_native-compatible', 'success');
    passed++;
    return true;
  }

  log(`Unsupported CE_RETRIEVAL_PROVIDER value: ${provider}`, 'error');
  failed++;
  return false;
}

async function checkDependencies() {
  const packageJsonPath = path.join(__dirname, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    log('package.json not found', 'error');
    failed++;
    return false;
  }
  
  const nodeModulesPath = path.join(__dirname, 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) {
    log('node_modules not found - run: npm install', 'error');
    failed++;
    return false;
  }
  
  log('Dependencies installed', 'success');
  passed++;
  return true;
}

async function checkBuild() {
  const distPath = path.join(__dirname, 'dist', 'index.js');
  if (!fs.existsSync(distPath)) {
    log('Build not found - run: npm run build', 'error');
    failed++;
    return false;
  }
  
  log('Project built successfully', 'success');
  passed++;
  return true;
}

async function checkTypeScript() {
  const result = await executeCommand('npx', ['tsc', '--version']);
  if (result.code === 0) {
    log(`TypeScript ${result.stdout.trim()} available`, 'success');
    passed++;
    return true;
  } else {
    log('TypeScript not found', 'error');
    failed++;
    return false;
  }
}

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('Context Engine MCP Server - Setup Verification');
  console.log('='.repeat(60) + '\n');
  
  log('Checking prerequisites...', 'info');
  console.log('');
  
  await checkNodeVersion();
  await checkNpmVersion();
  await checkTypeScript();
  await checkRetrievalConfig();
  await checkDependencies();
  await checkBuild();
  
  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60) + '\n');
  
  if (failed === 0) {
    log('All checks passed! You\'re ready to run the server.', 'success');
    console.log('\nNext steps:');
    console.log('  1. node dist/index.js --help');
    console.log('  2. node dist/index.js --workspace /path/to/project --index');
    console.log('  3. Configure Codex CLI (see QUICKSTART.md)');
  } else {
    log('Some checks failed. Please fix the issues above.', 'error');
    console.log('\nFor help, see:');
    console.log('  - QUICKSTART.md for setup instructions');
    console.log('  - TROUBLESHOOTING.md for common issues');
  }
  
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Verification failed:', error);
  process.exit(1);
});
