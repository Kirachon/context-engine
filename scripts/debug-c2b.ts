import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContextServiceClient } from '../src/mcp/serviceClient.js';

process.env.CE_RETRIEVAL_PROVIDER = 'local_native';

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-debug-c2b-'));
  fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, 'src', 'provider.ts'),
    ['export function resolveAIProviderId() {', '  return "openai_session";', '}', ''].join('\n'),
    'utf-8'
  );

  const indexingClient = new ContextServiceClient(tempDir);
  await indexingClient.indexWorkspace();

  const graphMetaPath = path.join(tempDir, '.context-engine-graph-index.json');
  const indexStatePath = path.join(tempDir, '.context-engine-index-state.json');
  console.log('graph metadata:', fs.readFileSync(graphMetaPath, 'utf-8'));
  console.log('index state:', fs.readFileSync(indexStatePath, 'utf-8'));

  fs.rmSync(tempDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
