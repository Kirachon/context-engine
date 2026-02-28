import type { ContextServiceClient } from '../../mcp/serviceClient.js';
import { CodeReviewService } from '../../mcp/services/codeReviewService.js';
import { createClientBoundFactory } from '../../mcp/tooling/serviceFactory.js';

const codeReviewServiceFactory = createClientBoundFactory<CodeReviewService, ContextServiceClient>(
  (serviceClient) => new CodeReviewService(serviceClient)
);

export function internalCodeReviewService(serviceClient: ContextServiceClient): CodeReviewService {
  return codeReviewServiceFactory.get(serviceClient);
}

export function resetInternalCodeReviewServiceCacheForTests(): void {
  codeReviewServiceFactory.reset();
}
