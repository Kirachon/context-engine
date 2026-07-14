import { describe, it, expect } from '@jest/globals';
import fs from 'fs';

function readUtf8(path: string): string {
  return fs.readFileSync(path, 'utf-8');
}

function readBanner(path: string): string {
  return readUtf8(path).split(/\r?\n/).slice(0, 24).join('\n');
}

describe('documentation contracts', () => {
  it('docs/archive/API_REFERENCE.md matches current MCP tool names (no legacy tool drift)', () => {
    const text = readUtf8('docs/archive/API_REFERENCE.md');

    // Must mention the current tool names
    expect(text).toContain('`review_changes`');
    expect(text).toContain('`review_git_diff`');
    expect(text).toContain('`reactive_review_pr`');
    expect(text).toContain('`get_review_status`');
    expect(text).toContain('`create_plan`');
    expect(text).toContain('`execute_plan`');

    // Must not reference legacy/renamed tool names
    expect(text).not.toContain('`start_reactive_review`');
    expect(text).not.toContain('`get_reactive_status`');
    expect(text).not.toContain('pause_reactive_review');
    expect(text).not.toContain('resume_reactive_review');
    expect(text).not.toContain('cancel_reactive_review');
    expect(text).not.toContain('get_reactive_findings');

    // MCP review_diff options should match implementation naming
    expect(text).toContain('enable_llm');
    expect(text).not.toContain('enable_llm_review');
    expect(text).toContain('risk_threshold');
    expect(text).not.toContain('llm_risk_threshold');
  });

  it('docs/archive/TECHNICAL_ARCHITECTURE.md matches current tool names', () => {
    const text = readUtf8('docs/archive/TECHNICAL_ARCHITECTURE.md');

    expect(text).toContain('reactive_review_pr');
    expect(text).toContain('get_review_status');
    expect(text).toContain('create_plan');
    expect(text).toContain('execute_plan');

    expect(text).not.toContain('start_reactive_review');
    expect(text).not.toContain('get_reactive_status');
    expect(text).not.toContain('execute_plan_step');
    expect(text).not.toContain('get_plan_status');
    expect(text).not.toContain('generate_plan');
  });

  it('active documentation status points only to the remediation plan and freezes completed ledgers', () => {
    const activePlan = 'context-engine-remediation-plan-2026-07-14.md';
    const architecture = readBanner('ARCHITECTURE.md');
    const remediationPlan = readBanner(activePlan);
    const nextTrancheLedger = readBanner('context-engine-next-tranche-swarm-plan.md');
    const improvementLedger = readBanner('context-engine-improvement-swarm-plan.md');
    const advancedPlan = readBanner('docs/advanced-mcp-ux-and-hosted-maturity-plan.md');
    const governedBanners = [architecture, nextTrancheLedger, improvementLedger, advancedPlan];

    expect(architecture).toContain(`Sole active delivery plan: \`${activePlan}\``);
    expect(remediationPlan).toContain('**Status:**');
    expect(remediationPlan).toMatch(/Execution in progress|CONDITIONAL_GO|Closeout/);
    expect(nextTrancheLedger).toContain('Status: Immutable execution ledger (completed tranche)');
    expect(improvementLedger).toContain('Status: Immutable execution ledger (completed tranche)');
    expect(advancedPlan).toContain('Status: Planning-only reference (not implementation authority)');

    for (const banner of governedBanners) {
      expect(banner).toContain(`Sole active delivery plan: \`${activePlan}\``);
      expect(banner).not.toContain(
        'Active delivery plan: `context-engine-next-tranche-swarm-plan.md`'
      );
      expect(banner).not.toContain(
        '`context-engine-next-tranche-swarm-plan.md` is the active execution plan.'
      );
    }
  });

  it('vibe-coder memory review contract makes checkpoint, batch-cap, undo, and suppression rules explicit', () => {
    const text = readUtf8('docs/VIBE_CODER_MEMORY_REVIEW_CONTRACT.md');

    expect(text).toContain('quiet mode by default');
    expect(text).toContain('closure or idle checkpoints');
    expect(text).toContain('end of task');
    expect(text).toContain('end of review');
    expect(text).toContain('end of plan');
    expect(text).toContain('end of session');
    expect(text).toContain('at most `5` suggestions');
    expect(text).toContain('`3-5` suggestions');
    expect(text).toContain('one-line explanation');
    expect(text).toContain('`save`');
    expect(text).toContain('`dismiss`');
    expect(text).toContain('`inspect`');
    expect(text).toContain('`snooze`');
    expect(text).toContain('`never suggest like this`');
    expect(text).toContain('`undo last batch` is pre-promotion only');
    expect(text).toContain('suppression persists across sessions');
    expect(text).toContain('must not imply rollback of already promoted durable memories');
  });

  it('vibe-coder memory canary runbook keeps phase-1 rollout constraints explicit', () => {
    const text = readUtf8('docs/VIBE_CODER_MEMORY_CANARY_RUNBOOK.md');

    expect(text).toContain('quiet assisted mode only');
    expect(text).toContain('CE_MEMORY_SUGGESTIONS_V1');
    expect(text).toContain('CE_MEMORY_DRAFT_RETRIEVAL_V1');
    expect(text).toContain('CE_MEMORY_AUTOSAVE_V1');
    expect(text).toContain('source allowlist');
    expect(text).toContain('no auto-save in Phase 1');
    expect(text).toContain('no draft indexing into default retrieval');
    expect(text).toContain('promoted_pending_index');
  });
});
