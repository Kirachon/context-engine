import { describe, it, expect } from '@jest/globals';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = process.cwd();
const GATE_PATH = join(REPO_ROOT, 'config', 'ci', 'provider-contract-gate.json');

interface ProviderContractGate {
  version: string;
  contract_version: string;
  documentation: Record<string, string>;
  providers: Record<string, unknown>;
  fence_tests: Record<string, string>;
  error_taxonomy: {
    required_codes: string[];
    retryable_defaults: Record<string, boolean>;
  };
  cancellation_contract: Record<string, boolean>;
  privacy_contract: {
    local_only_surfaces: string[];
    egress_allowlist: string[];
    every_response_must_carry_privacy_class: boolean;
  };
  rollback_triggers: string[];
  ci_wiring: {
    advisory_in: string[];
    blocking_in: string[];
    test_command: string;
  };
}

function loadGate(): ProviderContractGate {
  return JSON.parse(readFileSync(GATE_PATH, 'utf8')) as ProviderContractGate;
}

describe('provider contract eval gate', () => {
  it('config file is present and parses as JSON', () => {
    expect(existsSync(GATE_PATH)).toBe(true);
    const gate = loadGate();
    expect(gate.contract_version).toBe('v1');
  });

  it('every documentation path referenced by the gate exists on disk', () => {
    const gate = loadGate();
    for (const [, relPath] of Object.entries(gate.documentation)) {
      const abs = join(REPO_ROOT, relPath);
      expect(existsSync(abs)).toBe(true);
    }
  });

  it('every fence test referenced by the gate exists on disk', () => {
    const gate = loadGate();
    for (const [, relPath] of Object.entries(gate.fence_tests)) {
      const abs = join(REPO_ROOT, relPath);
      expect(existsSync(abs)).toBe(true);
    }
  });

  it('error taxonomy lists every AIProviderErrorCode declared in src/ai/providers/errors.ts', () => {
    const gate = loadGate();
    const errorsSource = readFileSync(
      join(REPO_ROOT, 'src', 'ai', 'providers', 'errors.ts'),
      'utf8'
    );
    for (const code of gate.error_taxonomy.required_codes) {
      expect(errorsSource).toContain(`'${code}'`);
    }
    for (const code of gate.error_taxonomy.required_codes) {
      expect(gate.error_taxonomy.retryable_defaults).toHaveProperty(code);
      expect(typeof gate.error_taxonomy.retryable_defaults[code]).toBe('boolean');
    }
  });

  it('declares a reference provider with the openai_session adapter', () => {
    const gate = loadGate();
    expect(gate.providers).toHaveProperty('openai_session');
  });

  it('cancellation contract pins the invariants that 393c9ba shipped', () => {
    const gate = loadGate();
    expect(gate.cancellation_contract.must_honor_signal).toBe(true);
    expect(gate.cancellation_contract.must_honor_deadline_ms).toBe(true);
    expect(gate.cancellation_contract.deadline_includes_queue_wait).toBe(true);
    expect(gate.cancellation_contract.subprocess_terminated_on_abort).toBe(true);
    expect(gate.cancellation_contract.health_must_not_throw).toBe(true);
  });

  it('privacy contract declares at least one local-only surface and an explicit allowlist', () => {
    const gate = loadGate();
    expect(gate.privacy_contract.local_only_surfaces.length).toBeGreaterThan(0);
    expect(Array.isArray(gate.privacy_contract.egress_allowlist)).toBe(true);
    expect(gate.privacy_contract.every_response_must_carry_privacy_class).toBe(true);
  });

  it('CI wiring identifies advisory and blocking profiles', () => {
    const gate = loadGate();
    expect(gate.ci_wiring.advisory_in).toContain('pr');
    expect(gate.ci_wiring.blocking_in).toContain('quality');
    expect(gate.ci_wiring.test_command).toContain('tests/ai/contract');
  });

  it('lists actionable rollback triggers', () => {
    const gate = loadGate();
    expect(gate.rollback_triggers.length).toBeGreaterThanOrEqual(3);
  });
});
