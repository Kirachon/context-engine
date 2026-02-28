import { describe, expect, it } from '@jest/globals';
import {
  handleDeletePlan,
  handleFailStep,
  handleRequestApproval,
  handleRespondApproval,
  handleSavePlan,
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

  it('handleFailStep preserves validation order for step_number before error', async () => {
    await expect(handleFailStep({ plan_id: 'plan_123' })).rejects.toThrow('step_number is required');
  });
});
