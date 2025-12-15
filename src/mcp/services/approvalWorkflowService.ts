/**
 * Approval Workflow Service
 *
 * Manages user approval requests for plans and steps.
 * Handles approval, rejection, and modification request workflows.
 */

import {
  EnhancedPlanOutput,
  EnhancedPlanStep,
  ApprovalRequest,
  ApprovalResponse,
  ApprovalResult,
  ApprovalStatus,
} from '../types/planning.js';

// ============================================================================
// ID Generation
// ============================================================================

function generateApprovalId(): string {
  return `approval_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// ============================================================================
// ApprovalWorkflowService
// ============================================================================

export class ApprovalWorkflowService {
  private pendingApprovals: Map<string, ApprovalRequest> = new Map();
  private approvalHistory: ApprovalRequest[] = [];

  // ============================================================================
  // Approval Request Creation
  // ============================================================================

  /**
   * Create an approval request for a full plan
   */
  createPlanApprovalRequest(plan: EnhancedPlanOutput): ApprovalRequest {
    // Safely handle undefined arrays - ensure they are arrays before processing
    const planSteps = Array.isArray(plan.steps) ? plan.steps : [];
    const planRisks = Array.isArray(plan.risks) ? plan.risks : [];

    // Collect all affected files
    const affectedFiles = this.collectAffectedFiles(planSteps);

    // Collect risks
    const risks = planRisks.map(r => `${r?.issue || 'Unknown'} (${r?.likelihood || 'unknown'} likelihood)`);

    const request: ApprovalRequest = {
      id: generateApprovalId(),
      plan_id: plan.id,
      type: 'full_plan',
      status: 'pending',
      summary: `Approve plan: ${plan.goal}`,
      details: this.generatePlanApprovalDetails(plan),
      affected_files: affectedFiles,
      risks,
      created_at: new Date().toISOString(),
    };

    this.pendingApprovals.set(request.id, request);
    return request;
  }

  /**
   * Create an approval request for a single step
   */
  createStepApprovalRequest(
    plan: EnhancedPlanOutput,
    stepNumber: number
  ): ApprovalRequest {
    // Safely handle undefined steps array
    const planSteps = Array.isArray(plan.steps) ? plan.steps : [];
    const step = planSteps.find(s => s.step_number === stepNumber);
    if (!step) {
      throw new Error(`Step ${stepNumber} not found in plan ${plan.id || 'unknown'}`);
    }

    const affectedFiles = this.collectStepFiles(step);

    const request: ApprovalRequest = {
      id: generateApprovalId(),
      plan_id: plan.id || `plan_${Date.now()}`,
      step_number: stepNumber,
      type: 'step',
      status: 'pending',
      summary: `Approve step ${stepNumber}: ${step.title || 'Untitled'}`,
      details: this.generateStepApprovalDetails(step),
      affected_files: affectedFiles,
      risks: step.rollback_strategy ? [`Rollback: ${step.rollback_strategy}`] : [],
      created_at: new Date().toISOString(),
    };

    this.pendingApprovals.set(request.id, request);
    return request;
  }

  /**
   * Create an approval request for a group of steps
   */
  createStepGroupApprovalRequest(
    plan: EnhancedPlanOutput,
    stepNumbers: number[]
  ): ApprovalRequest {
    // Safely handle undefined steps array
    const planSteps = Array.isArray(plan.steps) ? plan.steps : [];
    const steps = planSteps.filter(s => stepNumbers.includes(s.step_number));
    if (steps.length === 0) {
      throw new Error(`No valid steps found for numbers: ${stepNumbers.join(', ')}`);
    }

    const affectedFiles = this.collectAffectedFiles(steps);
    
    const request: ApprovalRequest = {
      id: generateApprovalId(),
      plan_id: plan.id,
      type: 'step_group',
      status: 'pending',
      summary: `Approve steps ${stepNumbers.join(', ')}: ${steps.map(s => s.title).join(', ')}`,
      details: this.generateStepGroupApprovalDetails(steps),
      affected_files: affectedFiles,
      risks: [],
      created_at: new Date().toISOString(),
    };

    this.pendingApprovals.set(request.id, request);
    return request;
  }

  // ============================================================================
  // Approval Response Handling
  // ============================================================================

  /**
   * Process an approval response
   */
  processApprovalResponse(response: ApprovalResponse): ApprovalResult {
    const request = this.pendingApprovals.get(response.request_id);
    
    if (!request) {
      return {
        success: false,
        error: `Approval request ${response.request_id} not found`,
      };
    }

    if (request.status !== 'pending') {
      return {
        success: false,
        error: `Approval request ${response.request_id} is already ${request.status}`,
        request,
      };
    }

    // Update request based on action
    switch (response.action) {
      case 'approve':
        request.status = 'approved';
        request.response = response.comment;
        break;
      case 'reject':
        request.status = 'rejected';
        request.response = response.comment;
        break;
      case 'request_modification':
        request.status = 'modification_requested';
        request.modification_notes = response.modifications;
        request.response = response.comment;
        break;
    }

    request.resolved_at = new Date().toISOString();

    // Move to history
    this.pendingApprovals.delete(response.request_id);
    this.approvalHistory.push(request);

    // Determine next steps
    const nextSteps = this.determineNextSteps(request);

    return {
      success: true,
      request,
      next_steps: nextSteps,
    };
  }

  /**
   * Approve a request (convenience method)
   */
  approve(requestId: string, comment?: string): ApprovalResult {
    return this.processApprovalResponse({
      request_id: requestId,
      action: 'approve',
      comment,
    });
  }

  /**
   * Reject a request (convenience method)
   */
  reject(requestId: string, comment?: string): ApprovalResult {
    return this.processApprovalResponse({
      request_id: requestId,
      action: 'reject',
      comment,
    });
  }

  /**
   * Request modifications (convenience method)
   */
  requestModification(requestId: string, modifications: string, comment?: string): ApprovalResult {
    return this.processApprovalResponse({
      request_id: requestId,
      action: 'request_modification',
      comment,
      modifications,
    });
  }

  // ============================================================================
  // Query Methods
  // ============================================================================

  /**
   * Get a pending approval request
   */
  getPendingApproval(requestId: string): ApprovalRequest | undefined {
    return this.pendingApprovals.get(requestId);
  }

  /**
   * Get all pending approvals for a plan
   */
  getPendingApprovalsForPlan(planId: string): ApprovalRequest[] {
    return Array.from(this.pendingApprovals.values()).filter(
      r => r.plan_id === planId
    );
  }

  /**
   * Get all pending approvals
   */
  getAllPendingApprovals(): ApprovalRequest[] {
    return Array.from(this.pendingApprovals.values());
  }

  /**
   * Get approval history for a plan
   */
  getApprovalHistory(planId: string): ApprovalRequest[] {
    return this.approvalHistory.filter(r => r.plan_id === planId);
  }

  /**
   * Check if a plan is fully approved
   */
  isPlanApproved(planId: string): boolean {
    const planApprovals = this.approvalHistory.filter(
      r => r.plan_id === planId && r.type === 'full_plan'
    );
    return planApprovals.some(r => r.status === 'approved');
  }

  /**
   * Check if a step is approved
   */
  isStepApproved(planId: string, stepNumber: number): boolean {
    // Check if plan is fully approved
    if (this.isPlanApproved(planId)) {
      return true;
    }

    // Check specific step approval
    const stepApprovals = this.approvalHistory.filter(
      r => r.plan_id === planId && r.step_number === stepNumber
    );
    return stepApprovals.some(r => r.status === 'approved');
  }

  /**
   * Cancel a pending approval request
   */
  cancelApproval(requestId: string): boolean {
    return this.pendingApprovals.delete(requestId);
  }

  /**
   * Clear all pending approvals for a plan
   */
  clearPlanApprovals(planId: string): number {
    let count = 0;
    for (const [id, request] of this.pendingApprovals) {
      if (request.plan_id === planId) {
        this.pendingApprovals.delete(id);
        count++;
      }
    }
    return count;
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Collect all files affected by a set of steps
   */
  private collectAffectedFiles(steps: EnhancedPlanStep[]): string[] {
    const files = new Set<string>();

    // Handle undefined/null steps array
    if (!steps || !Array.isArray(steps)) {
      return [];
    }

    for (const step of steps) {
      // Safely handle undefined file arrays
      const filesToModify = step.files_to_modify || [];
      const filesToCreate = step.files_to_create || [];
      const filesToDelete = step.files_to_delete || [];

      for (const file of filesToModify) {
        if (file?.path) files.add(file.path);
      }
      for (const file of filesToCreate) {
        if (file?.path) files.add(file.path);
      }
      for (const file of filesToDelete) {
        if (file) files.add(file);
      }
    }

    return Array.from(files).sort();
  }

  /**
   * Collect files from a single step
   */
  private collectStepFiles(step: EnhancedPlanStep): string[] {
    return this.collectAffectedFiles([step]);
  }

  /**
   * Generate detailed description for plan approval
   */
  private generatePlanApprovalDetails(plan: EnhancedPlanOutput): string {
    // Safely access plan properties
    const goal = plan.goal || 'No goal specified';
    const version = plan.version || 1;
    const steps = plan.steps || [];
    const confidenceScore = plan.confidence_score || 0;
    const scope = plan.scope || { included: [], excluded: [], assumptions: [], constraints: [] };
    const included = scope.included || [];
    const excluded = scope.excluded || [];
    const risks = plan.risks || [];

    const lines: string[] = [
      `## Plan: ${goal}`,
      '',
      `**Version:** ${version}`,
      `**Steps:** ${steps.length}`,
      `**Confidence:** ${(confidenceScore * 100).toFixed(0)}%`,
      '',
      '### Scope',
      '**Included:**',
      ...included.map(i => `- ${i}`),
      '',
      '**Excluded:**',
      ...excluded.map(e => `- ${e}`),
      '',
      '### Steps Overview',
      ...steps.map(s => `${s.step_number || '?'}. **${s.title || 'Untitled'}** (${s.priority || 'medium'} priority, ${s.estimated_effort || 'unknown'})`),
    ];

    if (risks.length > 0) {
      lines.push('', '### Risks');
      for (const risk of risks) {
        lines.push(`- **${risk.issue || 'Unknown risk'}** (${risk.likelihood || 'unknown'}): ${risk.mitigation || 'No mitigation'}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Generate detailed description for step approval
   */
  private generateStepApprovalDetails(step: EnhancedPlanStep): string {
    // Safely access step properties
    const stepNumber = step.step_number || '?';
    const title = step.title || 'Untitled Step';
    const description = step.description || 'No description';
    const priority = step.priority || 'medium';
    const estimatedEffort = step.estimated_effort || 'unknown';
    const filesToModify = step.files_to_modify || [];
    const filesToCreate = step.files_to_create || [];
    const filesToDelete = step.files_to_delete || [];
    const acceptanceCriteria = step.acceptance_criteria || [];

    const lines: string[] = [
      `## Step ${stepNumber}: ${title}`,
      '',
      description,
      '',
      `**Priority:** ${priority}`,
      `**Estimated Effort:** ${estimatedEffort}`,
    ];

    if (filesToModify.length > 0) {
      lines.push('', '### Files to Modify');
      for (const file of filesToModify) {
        if (file?.path) {
          lines.push(`- ${file.path} (${file.complexity || 'unknown'}): ${file.reason || 'No reason'}`);
        }
      }
    }

    if (filesToCreate.length > 0) {
      lines.push('', '### Files to Create');
      for (const file of filesToCreate) {
        if (file?.path) {
          lines.push(`- ${file.path} (${file.complexity || 'unknown'}): ${file.reason || 'No reason'}`);
        }
      }
    }

    if (filesToDelete.length > 0) {
      lines.push('', '### Files to Delete');
      for (const file of filesToDelete) {
        if (file) lines.push(`- ${file}`);
      }
    }

    if (acceptanceCriteria.length > 0) {
      lines.push('', '### Acceptance Criteria');
      for (const criterion of acceptanceCriteria) {
        if (criterion) lines.push(`- ${criterion}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Generate details for step group approval
   */
  private generateStepGroupApprovalDetails(steps: EnhancedPlanStep[]): string {
    const lines: string[] = [
      `## Steps: ${steps.map(s => s.step_number).join(', ')}`,
      '',
    ];

    for (const step of steps) {
      lines.push(`### Step ${step.step_number}: ${step.title}`);
      lines.push(step.description);
      lines.push(`**Priority:** ${step.priority}, **Effort:** ${step.estimated_effort}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Determine next steps after approval action
   */
  private determineNextSteps(request: ApprovalRequest): string[] {
    switch (request.status) {
      case 'approved':
        if (request.type === 'full_plan') {
          return [
            'Plan approved - ready for execution',
            'Use complete_step tool to mark steps as done',
            'Use view_progress tool to track execution',
          ];
        } else {
          return [
            `Step ${request.step_number || 'group'} approved`,
            'Proceed with implementation',
            'Mark step complete when done',
          ];
        }
      case 'rejected':
        return [
          'Plan/step rejected',
          'Review rejection reason',
          'Use refine_plan tool to address concerns',
          'Create new approval request after refinement',
        ];
      case 'modification_requested':
        return [
          'Modifications requested',
          'Review modification notes',
          'Use refine_plan to incorporate changes',
          'Submit new approval request',
        ];
      default:
        return [];
    }
  }
}

