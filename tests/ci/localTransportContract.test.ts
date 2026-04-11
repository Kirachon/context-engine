import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';

type LocalTransportContract = {
  version: number;
  transport: {
    endpoint: string;
    verbs: string[];
    session_header: string;
    request_id_header: string;
  };
  session_contract: {
    initialize_required_without_session: boolean;
    non_initialize_without_session_status: number;
    unknown_session_status: number;
    delete_success_status: number;
  };
  origin_policy: {
    allowed_local_origins: string[];
    denied_origin_status: number;
  };
  auth_hook: {
    status: string;
    default_mode: string;
    configured_scope: string;
    unauthorized_status: number;
  };
  receipts: {
    smoke_script: string;
    integration_test: string;
    capability_parity_test: string;
  };
};

function readJson<T>(relativePath: string): T {
  const absolutePath = path.join(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, 'utf8')) as T;
}

describe('config/ci/local-transport-contract.json', () => {
  it('pins the stable local MCP transport contract to existing receipts', () => {
    const contract = readJson<LocalTransportContract>('config/ci/local-transport-contract.json');
    const packageJson = readJson<{ scripts?: Record<string, string> }>('package.json');
    const scripts = packageJson.scripts ?? {};

    expect(contract.version).toBe(1);
    expect(contract.transport).toEqual({
      endpoint: '/mcp',
      verbs: ['GET', 'POST', 'DELETE'],
      session_header: 'mcp-session-id',
      request_id_header: 'x-context-engine-request-id',
    });
    expect(contract.session_contract).toEqual({
      initialize_required_without_session: true,
      non_initialize_without_session_status: 400,
      unknown_session_status: 404,
      delete_success_status: 204,
    });
    expect(contract.origin_policy.denied_origin_status).toBe(403);
    expect(contract.origin_policy.allowed_local_origins).toEqual([
      'http://localhost',
      'https://localhost',
      'http://127.0.0.1',
      'https://127.0.0.1',
      'vscode-webview://*',
    ]);
    expect(contract.auth_hook).toEqual({
      status: 'provisional_local_plumbing_only',
      default_mode: 'disabled',
      configured_scope: 'all_mcp_verbs',
      unauthorized_status: 401,
    });
    expect(scripts[contract.receipts.smoke_script]).toEqual(expect.any(String));
    expect(fs.existsSync(path.join(process.cwd(), contract.receipts.integration_test))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), contract.receipts.capability_parity_test))).toBe(true);
  });
});
