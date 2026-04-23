import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';

import { getToolManifest } from '../../src/mcp/tools/manifest.js';

describe('graph-native tool registration metadata', () => {
  it('adds new tools to the manifest and discoverability surface', () => {
    const manifest = getToolManifest();

    expect(manifest.tools).toEqual(expect.arrayContaining([
      'find_callers',
      'find_callees',
      'trace_symbol',
      'impact_analysis',
      'why_this_context',
    ]));

    expect(manifest.features.symbol_navigation.tools).toEqual(expect.arrayContaining([
      'find_callers',
      'find_callees',
      'trace_symbol',
      'impact_analysis',
    ]));

    expect(manifest.discoverability.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'find_callers', title: 'Find Callers' }),
      expect.objectContaining({ id: 'find_callees', title: 'Find Callees' }),
      expect.objectContaining({ id: 'trace_symbol', title: 'Trace Symbol' }),
      expect.objectContaining({ id: 'impact_analysis', title: 'Impact Analysis' }),
      expect.objectContaining({ id: 'why_this_context', title: 'Why This Context' }),
    ]));
  });

  it('registers the new handlers in buildToolRegistryEntries', () => {
    const serverSource = fs.readFileSync(
      path.join(process.cwd(), 'src/mcp/server.ts'),
      'utf8'
    );

    expect(serverSource).toContain('findCallersTool');
    expect(serverSource).toContain('findCalleesTool');
    expect(serverSource).toContain('traceSymbolTool');
    expect(serverSource).toContain('impactAnalysisTool');
    expect(serverSource).toContain('whyThisContextTool');
    expect(serverSource).toContain("handler: (args) => handleFindCallers(args as any, serviceClient)");
    expect(serverSource).toContain("handler: (args) => handleFindCallees(args as any, serviceClient)");
    expect(serverSource).toContain("handler: (args) => handleTraceSymbol(args as any, serviceClient)");
    expect(serverSource).toContain("handler: (args) => handleImpactAnalysis(args as any, serviceClient)");
    expect(serverSource).toContain("handler: (args) => handleWhyThisContext(args as any, serviceClient)");
  });
});
