#!/usr/bin/env tsx
/**
 * Extract MCP tool inventory from server/tool sources.
 *
 * Usage:
 *   tsx scripts/extract-tool-inventory.ts
 */

import * as fs from 'fs';
import * as path from 'path';

type ToolRecord = {
  toolName: string;
  toolSymbol?: string;
  toolFile?: string;
  handlerSymbol?: string;
  handlerFile?: string;
  inListTools: boolean;
  inManifest: boolean;
  inputSchema?: 'inline' | 'none' | 'unknown';
};

const ROOT = process.cwd();
const TOOLS_DIR = path.join(ROOT, 'src', 'mcp', 'tools');
const SERVER_PATH = path.join(ROOT, 'src', 'mcp', 'server.ts');
const MANIFEST_PATH = path.join(TOOLS_DIR, 'manifest.ts');
const OUTPUT_PATH = path.join(ROOT, 'docs', 'PHASE2_TOOL_INVENTORY.md');

function readText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

function normalizeImportPath(importPath: string): string {
  const normalized = importPath.replace(/\.js$/i, '.ts');
  return path.normalize(path.join(path.dirname(SERVER_PATH), normalized));
}

function parseImports(content: string): Map<string, string> {
  const map = new Map<string, string>();
  const importRegex = /import\s+\{([^}]+)\}\s+from\s+'([^']+)';/g;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(content)) !== null) {
    const rawNames = match[1].split(',').map((name) => name.trim()).filter(Boolean);
    const importPath = normalizeImportPath(match[2]);
    for (const name of rawNames) {
      if (!name) continue;
      map.set(name, importPath);
    }
  }
  return map;
}

function extractArrayBlock(content: string, marker: string): string | null {
  const index = content.indexOf(marker);
  if (index < 0) return null;
  const start = content.indexOf('[', index);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === '[') depth += 1;
    if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        return content.slice(start + 1, i);
      }
    }
  }
  return null;
}

function parseListToolsSymbols(content: string): string[] {
  const block = extractArrayBlock(content, 'tools: [');
  if (!block) return [];
  const cleaned = block
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .join(' ');
  const tokens = cleaned.match(/[A-Za-z0-9_]+/g) ?? [];
  return tokens;
}

function parseCaseHandlers(content: string): Map<string, string> {
  const map = new Map<string, string>();
  const caseRegex = /case\s+'([^']+)':[\s\S]*?result\s*=\s*await\s+([A-Za-z0-9_]+)/g;
  let match: RegExpExecArray | null;
  while ((match = caseRegex.exec(content)) !== null) {
    map.set(match[1], match[2]);
  }
  return map;
}

function parseManifestToolNames(content: string): string[] {
  const block = extractArrayBlock(content, 'tools: [');
  if (!block) return [];
  const names: string[] = [];
  const nameRegex = /'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = nameRegex.exec(block)) !== null) {
    names.push(match[1]);
  }
  return names;
}

function parseToolDefinitions(filePath: string): Map<string, { toolSymbol: string; inputSchema: ToolRecord['inputSchema'] }> {
  const content = readText(filePath);
  const lines = content.split('\n');
  const map = new Map<string, { toolSymbol: string; inputSchema: ToolRecord['inputSchema'] }>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/export\s+const\s+(\w+Tool)\b/);
    if (!match) continue;
    const toolSymbol = match[1];
    let toolName: string | undefined;
    let inputSchema: ToolRecord['inputSchema'] = 'unknown';
    for (let j = i; j < Math.min(lines.length, i + 60); j += 1) {
      const nameMatch = lines[j].match(/name:\s*'([^']+)'/);
      if (nameMatch && !toolName) {
        toolName = nameMatch[1];
      }
      if (lines[j].includes('inputSchema')) {
        inputSchema = 'inline';
      }
      if (lines[j].includes('};')) {
        break;
      }
    }
    if (toolName) {
      map.set(toolName, { toolSymbol, inputSchema });
    }
  }
  return map;
}

function readToolFiles(): string[] {
  return fs.readdirSync(TOOLS_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join(TOOLS_DIR, name));
}

function formatPath(filePath?: string): string {
  if (!filePath) return '';
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function buildInventory(): ToolRecord[] {
  const serverContent = readText(SERVER_PATH);
  const manifestContent = readText(MANIFEST_PATH);

  const importMap = parseImports(serverContent);
  const listToolSymbols = new Set(parseListToolsSymbols(serverContent));
  const manifestTools = new Set(parseManifestToolNames(manifestContent));
  const caseHandlers = parseCaseHandlers(serverContent);

  const toolNameToSymbol = new Map<string, { toolSymbol: string; inputSchema: ToolRecord['inputSchema']; toolFile: string }>();
  const toolFiles = readToolFiles();
  for (const toolFile of toolFiles) {
    const defs = parseToolDefinitions(toolFile);
    for (const [toolName, info] of defs.entries()) {
      toolNameToSymbol.set(toolName, { toolSymbol: info.toolSymbol, inputSchema: info.inputSchema, toolFile });
    }
  }

  const allToolNames = new Set<string>([
    ...manifestTools,
    ...Array.from(caseHandlers.keys()),
    ...Array.from(toolNameToSymbol.keys()),
  ]);

  const listToolsNames = new Set<string>();
  for (const symbol of listToolSymbols) {
    if (symbol === 'planManagementTools') {
      for (const [toolName, info] of toolNameToSymbol.entries()) {
        if (info.toolFile.endsWith(`${path.sep}planManagement.ts`)) {
          listToolsNames.add(toolName);
        }
      }
      continue;
    }
    for (const [toolName, info] of toolNameToSymbol.entries()) {
      if (info.toolSymbol === symbol) {
        listToolsNames.add(toolName);
        break;
      }
    }
  }

  const records: ToolRecord[] = [];
  for (const toolName of Array.from(allToolNames).sort()) {
    const toolInfo = toolNameToSymbol.get(toolName);
    const handlerSymbol = caseHandlers.get(toolName);
    const handlerFile = handlerSymbol ? importMap.get(handlerSymbol) : undefined;
    const toolSymbol = toolInfo?.toolSymbol;
    const toolFile = toolInfo?.toolFile || (toolSymbol ? importMap.get(toolSymbol) : undefined);
    records.push({
      toolName,
      toolSymbol,
      toolFile,
      handlerSymbol,
      handlerFile,
      inListTools: listToolsNames.has(toolName),
      inManifest: manifestTools.has(toolName),
      inputSchema: toolInfo?.inputSchema ?? 'unknown',
    });
  }
  return records;
}

function renderMarkdown(records: ToolRecord[]): string {
  const lines: string[] = [];
  lines.push('# Phase 2 Tool Inventory');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`Total tools discovered: ${records.length}`);
  lines.push('');
  lines.push('| Tool Name | Tool Symbol | Handler | Tool File | Handler File | In ListTools | In Manifest | Input Schema |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const record of records) {
    lines.push(`| ${record.toolName} | ${record.toolSymbol ?? ''} | ${record.handlerSymbol ?? ''} | ${formatPath(record.toolFile)} | ${formatPath(record.handlerFile)} | ${record.inListTools ? 'yes' : 'no'} | ${record.inManifest ? 'yes' : 'no'} | ${record.inputSchema ?? ''} |`);
  }
  lines.push('');
  lines.push('Notes:');
  lines.push('- Tool symbols and handlers are parsed from source and may require manual verification for edge cases.');
  lines.push('- `planManagementTools` is expanded heuristically based on tool name patterns.');
  lines.push('');
  return lines.join('\n');
}

function main() {
  const records = buildInventory();
  const markdown = renderMarkdown(records);
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, markdown, 'utf-8');
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main();
