import type { ContextServiceClient, IndexResult, IndexStatus } from '../../mcp/serviceClient.js';

export function internalIndexStatus(serviceClient: ContextServiceClient): IndexStatus {
  return serviceClient.getIndexStatus();
}

export async function internalReadFile(
  serviceClient: ContextServiceClient,
  filePath: string
): Promise<string> {
  return serviceClient.getFile(filePath);
}

export async function internalIndexWorkspace(
  serviceClient: ContextServiceClient
): Promise<IndexResult> {
  return serviceClient.indexWorkspace();
}

export async function internalClearIndex(serviceClient: ContextServiceClient): Promise<void> {
  return serviceClient.clearIndex();
}
