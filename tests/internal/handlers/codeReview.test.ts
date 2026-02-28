import { describe, expect, it } from '@jest/globals';
import {
  internalCodeReviewService,
  resetInternalCodeReviewServiceCacheForTests,
} from '../../../src/internal/handlers/codeReview.js';

describe('internal/handlers/codeReview', () => {
  it('reuses service for the same service client instance', () => {
    resetInternalCodeReviewServiceCacheForTests();
    const serviceClient = {} as any;

    const first = internalCodeReviewService(serviceClient);
    const second = internalCodeReviewService(serviceClient);

    expect(first).toBe(second);
  });

  it('creates a new service when service client identity changes', () => {
    resetInternalCodeReviewServiceCacheForTests();
    const serviceClientA = {} as any;
    const serviceClientB = {} as any;

    const first = internalCodeReviewService(serviceClientA);
    const second = internalCodeReviewService(serviceClientB);

    expect(first).not.toBe(second);
  });

  it('creates a new service after explicit cache reset', () => {
    resetInternalCodeReviewServiceCacheForTests();
    const serviceClient = {} as any;
    const first = internalCodeReviewService(serviceClient);

    resetInternalCodeReviewServiceCacheForTests();
    const second = internalCodeReviewService(serviceClient);

    expect(first).not.toBe(second);
  });
});
