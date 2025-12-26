import { describe, it, expect } from '@jest/globals';
import fs from 'fs';

function readUtf8(path: string): string {
  return fs.readFileSync(path, 'utf-8');
}

describe('documentation contracts', () => {
  it('API_REFERENCE.md matches current MCP tool names (no legacy tool drift)', () => {
    const text = readUtf8('API_REFERENCE.md');

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

  it('TECHNICAL_ARCHITECTURE.md matches current tool names', () => {
    const text = readUtf8('TECHNICAL_ARCHITECTURE.md');

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
});

