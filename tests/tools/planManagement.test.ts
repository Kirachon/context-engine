import { describe, expect, it } from '@jest/globals';
import {
  handleComparePlanVersions,
  handleDeletePlan,
  handleFailStep,
  handleRollbackPlan,
  handleRequestApproval,
  handleRespondApproval,
  handleSavePlan,
  handleStartStep,
} from '../../src/mcp/tools/planManagement.js';

describe('planManagement tool handlers validation', () => {
  it('handleSavePlan rejects missing plan with existing error message', async () => {
    await expect(handleSavePlan({})).rejects.toThrow('plan is required and must be a JSON string');
  });

  it('handleSavePlan rejects invalid JSON with existing error message', async () => {
    await expect(handleSavePlan({ plan: '{oops}' })).rejects.toThrow('plan must be valid JSON');
  });

  it('handleDeletePlan rejects missing plan_id with existing error message', async () => {
    await expect(handleDeletePlan({})).rejects.toThrow('plan_id is required');
  });

  it('handleDeletePlan rejects non-string plan_id with existing error message', async () => {
    await expect(handleDeletePlan({ plan_id: 123 as unknown as string })).rejects.toThrow(
      'plan_id is required'
    );
  });

  it('handleRequestApproval rejects missing plan_id with existing error message', async () => {
    await expect(handleRequestApproval({})).rejects.toThrow('plan_id is required');
  });

  it('handleRespondApproval rejects missing request_id with existing error message', async () => {
    await expect(handleRespondApproval({ action: 'approve' })).rejects.toThrow(
      'request_id is required'
    );
  });

  it('handleRespondApproval rejects missing action with existing error message', async () => {
    await expect(handleRespondApproval({ request_id: 'req_123' })).rejects.toThrow(
      'action is required'
    );
  });

  it('handleRespondApproval rejects non-string action with existing error message', async () => {
    await expect(
      handleRespondApproval({ request_id: 'req_123', action: true as unknown as string })
    ).rejects.toThrow('action is required');
  });

  it('handleFailStep preserves validation order for step_number before error', async () => {
    await expect(handleFailStep({ plan_id: 'plan_123' })).rejects.toThrow('step_number is required');
  });

  it('handleStartStep rejects missing step_number with existing error message', async () => {
    await expect(handleStartStep({ plan_id: 'plan_123' })).rejects.toThrow('step_number is required');
  });

  it('handleComparePlanVersions rejects missing from_version with existing error message', async () => {
    await expect(handleComparePlanVersions({ plan_id: 'plan_123', to_version: 2 })).rejects.toThrow(
      'from_version is required'
    );
  });

  it('handleRollbackPlan rejects missing target_version with existing error message', async () => {
    await expect(handleRollbackPlan({ plan_id: 'plan_123' })).rejects.toThrow(
      'target_version is required'
    );
  });
});
