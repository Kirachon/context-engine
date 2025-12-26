import type { ContextServiceClient } from '../../mcp/serviceClient.js';
import { CodeReviewService } from '../../mcp/services/codeReviewService.js';

let cachedReviewService: CodeReviewService | null = null;
let cachedServiceClientRef: WeakRef<ContextServiceClient> | null = null;

export function internalCodeReviewService(serviceClient: ContextServiceClient): CodeReviewService {
  const cachedClient = cachedServiceClientRef?.deref();
  if (cachedReviewService && cachedClient === serviceClient) {
    return cachedReviewService;
  }

  cachedReviewService = new CodeReviewService(serviceClient);
  cachedServiceClientRef = new WeakRef(serviceClient);

  return cachedReviewService;
}

export function resetInternalCodeReviewServiceCacheForTests(): void {
  cachedReviewService = null;
  cachedServiceClientRef = null;
}

